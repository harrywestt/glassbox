import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useActions } from '../App'
import { money, useFx } from '../money'
import { CHANGE_TOOLS, isClaudeOwnFile, type SessionState } from '../session'
import { tabTitle, type Tab } from '../tabs'
import { checkOf } from '../review'
import { backgroundWork, liveVerb, tallyOf } from '../tally'
import { ticketKeyFromBranch } from '../../../shared/ticket'
import './FleetBoard.css'

const COLUMNS = ['Plan', 'Build', 'Test', 'Review', 'Ready'] as const
type Column = (typeof COLUMNS)[number]

const CARD_H = 74
const GAP = 8
const HEAD_H = 28
const GUTTER = 8
const RECENT_MS = 15 * 60_000
const SEEN_KEY = 'glassbox.fleetSeen'

// ── When you last looked at each tab, so a finished turn you haven't read waits in Review ──

const seen: Record<string, number> = (() => {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
})()

function markSeen(tabId: string) {
  seen[tabId] = Date.now()
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* storage unavailable: keep it in memory */
  }
}

/** When the last turn finished, if it has: a result after the last user message. */
function finishedAt(s: SessionState): number | null {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const item = s.timeline[i]
    if (item.kind === 'user') {
      // A resumed session's history has no result lines: Claude replied after your last message and
      // the session isn't working now, so that turn finished (when its last reply landed).
      const after = s.timeline.slice(i + 1).filter((x) => x.kind === 'text')
      return s.status === 'ready' && after.length ? after[after.length - 1].at : null
    }
    if (item.kind === 'result') return item.at
  }
  return null
}

function columnOf(tabId: string, s: SessionState | undefined): Column {
  if (!s) return 'Plan'
  // Agents still working in the background mean the work isn't finished, whatever the last turn said.
  const done = s.status !== 'running' && backgroundWork(s) === 0 ? finishedAt(s) : null
  // Waiting on you (a question, a check-in, a permission) is never Ready.
  if (done !== null) return tallyOf(s) === 'wait' || (seen[tabId] ?? 0) < done ? 'Review' : 'Ready'
  const running = Object.values(s.toolCalls)
    .filter((c) => c.status === 'running')
    .sort((a, b) => b.at - a.at)[0]
  if (running && checkOf(running)) return 'Test'
  if (s.mode === 'plan' || s.permissionMode === 'plan') return 'Plan'
  const hasSteps = !!s.task?.steps?.length
  const hasEdits = s.files.some((f) => CHANGE_TOOLS.has(f.tool))
  return hasSteps || hasEdits ? 'Build' : 'Plan'
}

// ── Collisions: two sessions editing the same top-level folder of the same repo ──

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Top-level folders (keyed lowercase, with a display label) this session edited recently, and its repo root key. */
function recentFolders(tab: Tab, s: SessionState | undefined, now: number): { root: string; folders: Map<string, string> } {
  const rootPath = norm(s?.git?.root ?? tab.cwd)
  const root = rootPath.toLowerCase()
  const folders = new Map<string, string>()
  for (const f of s?.files ?? []) {
    if (!CHANGE_TOOLS.has(f.tool) || now - f.at > RECENT_MS || isClaudeOwnFile(f.path)) continue
    const path = norm(f.path)
    if (!path.toLowerCase().startsWith(root + '/')) continue
    const dirs = path.slice(rootPath.length + 1).split('/').filter(Boolean).slice(0, -1)
    if (!dirs.length) continue
    const label = dirs[0].toLowerCase() === 'src' && dirs.length > 1 ? `${dirs[0]}/${dirs[1]}` : dirs[0]
    folders.set(label.toLowerCase(), label)
  }
  return { root, folders }
}

type Collision = { a: string; b: string; folder: string }

function collisions(tabs: Tab[], sessions: Record<string, SessionState>, now: number): Collision[] {
  const info = tabs.map((t) => ({ id: t.id, ...recentFolders(t, sessions[t.id], now) }))
  const out: Collision[] = []
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const x = info[i]
      const y = info[j]
      if (x.root !== y.root) continue
      const shared = [...x.folders.keys()].filter((k) => y.folders.has(k)).sort()[0]
      if (shared) out.push({ a: x.id, b: y.id, folder: x.folders.get(shared)! })
    }
  }
  return out
}

/** Every open session on one board, moving left to right from planning to ready for you. */
export function SessionsOverview({ tabs, sessions, active }: { tabs: Tab[]; sessions: Record<string, SessionState>; active?: string }) {
  const actions = useActions()
  const fx = useFx()
  const [now, setNow] = useState(Date.now())
  const [, bump] = useState(0)
  const boardRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  // The tab you're looking at counts as seen, including anything that finishes while you watch.
  const activeSession = active ? sessions[active] : undefined
  useEffect(() => {
    if (!active || !tabs.some((t) => t.id === active)) return
    markSeen(active)
    bump((n) => n + 1)
  }, [active, activeSession, tabs])

  useLayoutEffect(() => {
    const el = boardRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length > 0])

  const open = (id: string) => {
    markSeen(id)
    bump((n) => n + 1)
    actions.activate(id)
  }

  const colW = width / COLUMNS.length
  const counts: Record<Column, number> = { Plan: 0, Build: 0, Test: 0, Review: 0, Ready: 0 }
  const placed = tabs.map((t) => {
    const s = sessions[t.id]
    const col = columnOf(t.id, s)
    const row = counts[col]++
    const x = COLUMNS.indexOf(col) * colW + GUTTER
    const y = HEAD_H + row * (CARD_H + GAP)
    return { t, s, col, x, y }
  })
  const tallest = Math.max(1, ...Object.values(counts))
  const height = HEAD_H + tallest * (CARD_H + GAP)
  const cardW = Math.max(0, colW - GUTTER * 2)
  const byId = new Map(placed.map((p) => [p.t.id, p]))
  const lines = collisions(tabs, sessions, now)

  return (
    <section className="card sessions-overview fleet">
      <div className="fleet-title">Sessions</div>
      {!tabs.length ? (
        <div className="fleet-empty">No sessions open. Start one with New session.</div>
      ) : (
        <div className="fleet-board" ref={boardRef} style={{ height }}>
          {COLUMNS.map((c, i) => (
            <div key={c} className="fleet-col" style={{ left: `${(i * 100) / COLUMNS.length}%`, width: `${100 / COLUMNS.length}%` }}>
              <div className="fleet-col-head">{c}</div>
            </div>
          ))}
          {width > 0 &&
            placed.map(({ t, s, x, y }) => {
              const tally = tallyOf(s)
              const steps = s?.task?.steps ?? []
              const doneSteps = steps.filter((st) => st.status === 'done').length
              const ticket = ticketKeyFromBranch(s?.git?.branch)
              const cost = s?.usage.costUsd ? money(s.usage.costUsd, 'USD', fx) : null
              return (
                <button
                  key={t.id}
                  className={`fleet-card${tally === 'wait' ? ' fleet-wait' : ''}`}
                  style={{ width: cardW, transform: `translate(${x}px, ${y}px)` }}
                  onClick={() => open(t.id)}
                  title={`${t.cwd}\nClick to open`}
                >
                  <span className="fleet-card-head">
                    <span className={`tally-lamp tally-${tally}`} />
                    <span className="fleet-card-title">{tabTitle(t, s)}</span>
                  </span>
                  <span className="fleet-card-verb">{liveVerb(s)}</span>
                  <span className="fleet-card-foot">
                    {steps.length > 0 && (
                      <span>
                        {doneSteps} of {steps.length} steps
                      </span>
                    )}
                    {ticket && <span>{ticket}</span>}
                    {cost && (
                      <span className="fleet-cost" title={cost.title}>
                        {cost.text}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          {width > 0 && lines.length > 0 && (
            <svg className="fleet-lines" width={width} height={height} aria-hidden="true">
              {lines.map(({ a, b, folder }) => {
                const p = byId.get(a)!
                const q = byId.get(b)!
                // Cards in different columns join edge to edge; in the same column, round the right side.
                const [l, r] = p.x <= q.x ? [p, q] : [q, p]
                const same = Math.abs(p.x - q.x) < 1
                const x1 = same ? p.x + cardW : l.x + cardW
                const y1 = (same ? p : l).y + CARD_H / 2
                const x2 = same ? q.x + cardW : r.x
                const y2 = (same ? q : r).y + CARD_H / 2
                const bulge = same ? 24 : Math.max(12, (x2 - x1) / 2)
                // The curve's midpoint; the label sits just right of it, or left of it near the board's edge.
                const mx = (x1 + x2) / 2 + bulge * 0.75
                const my = (y1 + y2) / 2
                const flip = mx + 110 > width
                return (
                  <g key={`${a}|${b}`}>
                    <path className="fleet-line" style={{ d: same ? `path("M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}")` : `path("M${x1},${y1} C${x1 + bulge},${y1} ${x2 - bulge},${y2} ${x2},${y2}")` } as CSSProperties} />
                    <text className="fleet-line-label" textAnchor={flip ? 'end' : 'start'} style={{ transform: `translate(${flip ? mx - 6 : mx + 6}px, ${my + 4}px)` }}>
                      both in {folder}
                    </text>
                  </g>
                )
              })}
            </svg>
          )}
        </div>
      )}
    </section>
  )
}
