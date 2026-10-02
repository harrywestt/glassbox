import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, Segmented } from '../components/ui'
import type { Flow, FlowHop } from '../session'
import './FlowTab.css'

type View = 'before' | 'after'

const STAGGER = 500
const DRAW = 420

const HEAD_H = 28
const TOP = HEAD_H + 28
const ROW = 44
const PAD = 16

/** How a request or user action moves through the system, before and after Claude's change. */
export function FlowTab() {
  const { s, composerRef } = useSession()
  const list = useMemo(() => Object.values(s.flows).sort((a, b) => b.at - a.at), [s.flows])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<View>('after')
  // Bumped by Replay: the diagram draws itself once when it opens, and again only when you ask.
  const [run, setRun] = useState(0)
  const current = (selected && s.flows[selected]) || list[0]
  const hasBefore = !!current?.before?.length
  const shown: View = hasBefore ? view : 'after'

  // Segmented has no per-option disabled flag, so disable the Before button directly.
  const switchRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const first = switchRef.current?.querySelector('button')
    if (first) {
      first.disabled = !hasBefore
      first.title = hasBefore ? '' : 'This flow is new, so there is no before'
    }
  })

  const stats = useMemo(() => (current ? summarise(current) : null), [current])

  if (!current || !stats) {
    return (
      <div className="flow flow-empty-wrap">
        <div className="flow-empty">No flows yet. Claude shows one when a change alters how a request moves through the system.</div>
      </div>
    )
  }

  const hops = (shown === 'before' ? current.before : current.after) ?? []

  return (
    <div className="flow">
      <div className="flow-main">
        <div className="flow-toolbar">
          {list.length > 1 && (
            <div className="flow-picker">
              <Segmented value={current.id} onChange={setSelected} options={list.map((f) => ({ value: f.id, label: f.title }))} />
            </div>
          )}
          <span className="flow-spacer" />
          <button className="btn quiet" onClick={() => setRun((n) => n + 1)} title="Draw the flow again, one hop at a time">
            <Icon name="debug-restart" /> Replay
          </button>
          <div ref={switchRef}>
            <Segmented<View>
              value={shown}
              onChange={(v) => (v === 'after' || hasBefore) && setView(v)}
              options={[
                { value: 'before', label: 'Before' },
                { value: 'after', label: 'After' }
              ]}
            />
          </div>
        </div>
        <FlowSequence key={`${current.id}:${current.at}:${shown}:${run}`} lanes={current.lanes} hops={hops} />
      </div>
      <aside className="flow-side">
        <div className="flow-title">{current.title}</div>
        <div className="flow-counts">
          <CountRow tone="ok" label="New" n={stats.added} />
          <CountRow tone="warn" label="Changed" n={stats.changed} />
          <CountRow tone="err" label="Removed" n={stats.removed} />
        </div>
        {(stats.added + stats.changed + stats.removed === 0 || !current.before?.length) && <div className="flow-summary">{stats.sentence}</div>}
        <button className="btn" onClick={() => composerRef.current?.insert(`About the "${current.title}" flow you showed (${shown} your change): `)}>
          Ask Claude about this flow
        </button>
      </aside>
    </div>
  )
}

function CountRow({ tone, label, n }: { tone: 'ok' | 'warn' | 'err'; label: string; n: number }) {
  return (
    <div className="flow-count">
      <span className={`flow-dot flow-dot-${tone}`} />
      <span className="flow-count-label">{label}</span>
      <span className="flow-count-n">{n}</span>
    </div>
  )
}

/** The SVG sequence diagram; owns the animation so only it re-renders each frame. */
const FlowSequence = memo(function FlowSequence({ lanes, hops }: { lanes: string[]; hops: FlowHop[] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const reduced = useReducedMotion()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Plays once, hop by hop, then stays drawn (looping made it hard to read). Replay remounts it.
  const cycle = hops.length ? (hops.length - 1) * STAGGER + DRAW : 0
  useEffect(() => {
    if (reduced || !cycle) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = now - start
      setElapsed(Math.min(t, cycle))
      if (t < cycle) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced, cycle])

  // Always the width it has: lanes narrow (and labels clip) rather than scroll sideways.
  const w = Math.max(width - PAD * 2, lanes.length * 56)
  const col = w / lanes.length
  const x = (lane: string) => PAD + col * (Math.max(0, lanes.indexOf(lane)) + 0.5)
  const height = TOP + Math.max(1, hops.length) * ROW + PAD
  const headW = Math.min(col - 12, 160)

  return (
    <div className="flow-canvas" ref={boxRef}>
      {width > 0 && (
        <svg className="flow-svg" width={w + PAD * 2} height={height} role="img" aria-label={`Sequence: ${hops.map((h) => `${h.from} to ${h.to}, ${h.label}`).join('; ')}`}>
          {lanes.map((lane) => {
            const cx = x(lane)
            return (
              <g key={lane}>
                <line className="flow-lifeline" x1={cx} x2={cx} y1={HEAD_H} y2={height - 4} />
                <rect className="flow-lane-box" x={cx - headW / 2} y={0} width={headW} height={HEAD_H} rx={4} />
                <text className="flow-lane-name" x={cx} y={HEAD_H / 2} textAnchor="middle" dominantBaseline="central" data-tip={lane}>
                  {clip(lane, headW - 12)}
                </text>
              </g>
            )
          })}
          {hops.map((hop, i) => {
            const p = reduced ? 1 : ease(Math.min(1, Math.max(0, (elapsed - i * STAGGER) / DRAW)))
            if (p <= 0) return null
            return <Hop key={i} hop={hop} x1={x(hop.from)} x2={x(hop.to)} y={TOP + i * ROW + 16} p={p} span={col} />
          })}
        </svg>
      )}
    </div>
  )
})

function Hop({ hop, x1, x2, y, p, span }: { hop: FlowHop; x1: number; x2: number; y: number; p: number; span: number }) {
  const cls = `flow-hop flow-hop-${hop.kind ?? 'plain'}`
  const label = (
    <text className="flow-hop-label" x={x1 === x2 ? x1 + 8 : (x1 + x2) / 2} y={y - 8} textAnchor={x1 === x2 ? 'start' : 'middle'} style={{ opacity: p }} data-tip={hop.label}>
      {clip(hop.label, Math.max(Math.abs(x2 - x1), span) * 1.7)}
    </text>
  )
  if (x1 === x2) {
    // A call a participant makes to itself: a small loop out to the right.
    const d = `M ${x1} ${y - 4} h 28 v 14 h -24`
    return (
      <g className={cls} style={{ opacity: p }}>
        <path className="flow-hop-line" d={d} fill="none" />
        <polygon className="flow-hop-head" points={`${x1 + 1},${y + 10} ${x1 + 8},${y + 6} ${x1 + 8},${y + 14}`} />
        {label}
      </g>
    )
  }
  const dir = x2 > x1 ? 1 : -1
  const tip = x1 + (x2 - x1) * p
  return (
    <g className={cls}>
      <line className="flow-hop-line" x1={x1} x2={tip - dir * 6} y1={y} y2={y} />
      <polygon className="flow-hop-head" points={`${tip},${y} ${tip - dir * 8},${y - 4} ${tip - dir * 8},${y + 4}`} />
      {label}
    </g>
  )
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3)

/** Rough fit for 12px text: about 6.5px a character. */
function clip(text: string, px: number) {
  const max = Math.max(4, Math.floor(px / 6.5))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function summarise(flow: Flow) {
  const lane = (n: string) => flow.lanes.indexOf(n)
  // A hop going back to an earlier lane is a response; everything else is a call.
  const what = (h: FlowHop) => (lane(h.to) < lane(h.from) ? 'response' : 'call')
  const key = (h: FlowHop) => `${h.from}\u0000${h.to}\u0000${h.label}`
  const removedMap = new Map<string, FlowHop>()
  for (const h of [...(flow.before ?? []), ...flow.after]) if (h.kind === 'removed') removedMap.set(key(h), h)
  // A flow with no "before" is new, so every hop in it is new, marked or not.
  const added = flow.after.filter((h) => h.kind === 'new' || (!flow.before?.length && h.kind !== 'changed' && h.kind !== 'removed'))
  const changed = flow.after.filter((h) => h.kind === 'changed')
  const removed = [...removedMap.values()]

  const parts: string[] = []
  const describe = (hs: FlowHop[], adj: string) => {
    if (!hs.length) return
    const calls = hs.filter((h) => what(h) === 'call').length
    const responses = hs.length - calls
    if (calls && responses) parts.push(`${hs.length} ${adj} ${plural(hs.length, 'hop')}`)
    else parts.push(`${hs.length} ${adj} ${plural(hs.length, calls ? 'call' : 'response')}`)
  }
  describe(added, 'new')
  describe(changed, 'changed')
  describe(removed, 'removed')

  let sentence: string
  if (!flow.before?.length) sentence = `A new flow: ${flow.after.length} ${plural(flow.after.length, 'hop')} across ${flow.lanes.length} participants.`
  else if (!parts.length) sentence = 'The path is the same before and after.'
  else sentence = `${capitalise(join(parts))}.`

  return { added: added.length, changed: changed.length, removed: removed.length, sentence }
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`)
const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
const join = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`)
