import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { blockedOnYou, type SessionState } from '../session'
import type { Tab } from '../tabs'
import { baseName, relPath } from '../lib'
import { setAppearance, useAppearance } from '../appearance'
import { Select } from '../components/Select'
import { IconButton } from '../components/ui'
import type { HoldPolicy } from '../../../shared/events'
import { tr } from '../../../shared/i18n'
import {
  ago,
  assumptions,
  changedFiles,
  changedRanges,
  circles,
  clock,
  collision,
  duration,
  ledger,
  lanes as buildLanes,
  offPlan,
  readRanges,
  skillsUsed,
  stage as buildStage,
  unreadChanged,
  type Flag,
  type Lane,
  type Ledger,
  type Stage
} from './model'
import './live.css'

/** Where Live sends you to look at something, and how "Tell Claude" reaches the message box. */
export type LiveNav = {
  show: (target: { view: 'diff' | 'file' | 'ripple'; path: string }) => void
  /** Put text in the message box for you to edit and send. */
  tell: (text: string) => void
  /** Send Claude a message now. */
  send: (text: string) => void
}

type Props = { tab: Tab; s: SessionState; nav: LiveNav; active: boolean }

/**
 * Live: what Claude is doing right now, and whether to trust it. Three panes when there's room:
 * what needs you, the stage (who's doing what, and the edit being written), and the checks.
 */
export function LiveScreen({ tab, s, nav, active }: Props) {
  // Times ("20s ago", the lanes' right edge) move every two seconds; the wait timer ticks on its own.
  const now = useTick(active, 2000)
  const rel = useCallback((p: string) => relPath(tab.cwd, p), [tab.cwd])
  // Each pane gets the session as it last changed for that pane, so text streaming in (which only
  // the top bar shows) doesn't redraw the rest.
  const forLanes = useMemo(() => s, [s.toolCalls, s.agents, s.thinking, s.backgroundTasks, s.status, s.permissions, s.userQuestions, s.checkins, s.held]) // eslint-disable-line react-hooks/exhaustive-deps
  const forStage = useMemo(() => s, [s.writing, s.writingNow, s.held, s.toolCalls, s.agents, s.permissions, s.userQuestions, s.checkins]) // eslint-disable-line react-hooks/exhaustive-deps
  const forLooked = useMemo(() => s, [s.toolCalls, s.files, s.instructions]) // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = blockedOnYou(s)
  const looked = useLookedAt(tab.cwd, s)
  const flags = useFlags(s, looked, rel, now)
  const [dismissed, dismiss] = useDismissed(s.sessionId ?? tab.id)
  const [asked, ask] = useAsked(s.sessionId ?? tab.id)
  // A check you asked Claude for clears once Claude's turn after it has finished.
  const lastResult = s.timeline.findLast((i) => i.kind === 'result')?.at ?? 0
  const open = flags.filter((f) => !dismissed.has(f.id) && !(asked[f.id] && lastResult > asked[f.id]))
  const rows = useMemo(() => ledger(s, now), [s.files, s.toolCalls, Math.floor(now / 10_000)]) // eslint-disable-line react-hooks/exhaustive-deps
  const failing = rows.filter((r) => r.state === 'failing').length
  // Mid width: the three lists share one column; this picks which shows.
  const [pick, setPick] = useState<Pick>('needs')
  const switcher = useMemo(() => <PaneSwitch pick={pick} onPick={setPick} needs={open.length} failing={failing} />, [pick, open.length, failing])

  return (
    <div className="live-screen">
      {blocked ? <WaitBanner s={s} /> : <NowStrip s={s} />}
      <div className="live-shell" data-pick={pick}>
        <section className="live-pane live-needs" aria-label={tr('live.needs.title')}>
          {switcher}
          <header className="live-pane-h">
            <h2 className="switchable">{tr('live.needs.title')}</h2>
            {open.length > 0 && <span className="live-count">{open.length}</span>}
            <span className="grow" />
            {open.length > 1 && <span className="live-note">{tr('live.needs.riskiest')}</span>}
          </header>
          <div className="live-scroll">
            {open.length === 0 && <p className="live-empty">{tr('live.needs.none')}</p>}
            {open.map((f) => (
              <FlagRow key={f.id} f={f} now={now} nav={nav} asked={asked[f.id]} onAsk={() => ask(f.id)} onDismiss={() => dismiss(f.id)} />
            ))}
          </div>
        </section>

        <div className="live-stage">
          <Lanes s={forLanes} now={now} />
          {blocked && !Object.keys(s.held ?? {}).length ? <WaitCard tab={tab} s={s} /> : <EditStage tab={tab} s={forStage} nav={nav} now={now} />}
        </div>

        <div className="live-trust">
          <Checked rows={rows} rel={rel} nav={nav} failing={failing} switcher={switcher} />
          <LookedAt s={forLooked} looked={looked} rel={rel} nav={nav} switcher={switcher} />
        </div>
      </div>
    </div>
  )
}

/* ── Mid width: one column for the three lists ── */

type Pick = 'needs' | 'checked' | 'looked'

function PaneSwitch({ pick, onPick, needs, failing }: { pick: Pick; onPick: (p: Pick) => void; needs: number; failing: number }) {
  const item = (p: Pick, label: string, extra?: React.ReactNode) => (
    <button role="tab" aria-selected={pick === p} className={pick === p ? 'live-switch-item on' : 'live-switch-item'} onClick={() => onPick(p)}>
      {label}
      {extra}
    </button>
  )
  return (
    <div className="live-switch" role="tablist" aria-label={tr('live.switch.label')}>
      {item('needs', tr('live.needs.title'), needs > 0 && <span className="live-count">{needs}</span>)}
      {item('checked', tr('live.switch.checked'), failing > 0 && <span className="live-switch-bad">{tr('live.checked.failingCount', { count: failing })}</span>)}
      {item('looked', tr('live.switch.looked'))}
    </div>
  )
}

/* ── Top ── */

function NowStrip({ s }: { s: SessionState }) {
  const steps = s.task?.steps ?? []
  const current = steps.findIndex((x) => x.status === 'active')
  const doneCount = steps.filter((x) => x.status === 'done').length
  // Re-checked every couple of seconds, so a finished thought clears once it's stale.
  const tick = useTick(s.status === 'running', 2000)
  const thought = useMemo(() => currentThought(s, Date.now()), [s.drafts, s.timeline, s.status, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const headline = s.task?.summary || (s.status === 'running' ? tr('live.now.working') : s.status === 'ready' && s.timeline.some((i) => i.kind === 'result') ? tr('live.now.finished') : s.status === 'ready' ? tr('live.now.ready') : tr('live.now.idle'))
  const used = (s.context?.categories ?? []).filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const total = s.context?.maxTokens ?? 0
  const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  return (
    <section className="live-now" aria-label={tr('live.now.label')}>
      {/* One line: the step and what's happening; what Claude is thinking gets its own lines below. */}
      <div className="live-now-row">
      <div className="live-now-main">
        {steps.length > 0 && (
          <span className="live-steps" title={current >= 0 ? steps[current].label : undefined}>
            <span className="live-step-bars" aria-hidden>
              {steps.map((x, i) => (
                <span key={i} className={`live-step ${x.status}`} />
              ))}
            </span>
            <span className="live-note">{tr('live.now.step', { n: current >= 0 ? current + 1 : Math.min(doneCount + 1, steps.length), total: steps.length })}</span>
          </span>
        )}
        <span className={s.status === 'running' ? 'live-headline' : 'live-headline quiet'}>{headline}</span>
      </div>
      {s.context && total > 0 && (
        <div className="live-context" title={used.map((c) => `${c.name}: ${k(c.tokens)}`).join('\n')}>
          <span>{tr('live.now.context')}</span>
          <span className="live-context-bar" aria-hidden>
            {used.map((c, i) => (
              <span key={c.name} className={`cat-${(i % 6) + 1}`} style={{ width: `${(c.tokens / total) * 100}%` }} />
            ))}
          </span>
          <span className="live-context-num">{tr('live.now.contextOf', { used: k(s.context.totalTokens), total: k(total) })}</span>
        </div>
      )}
      </div>
      {thought && (
        <div className={thought.live ? 'live-thinking live' : 'live-thinking'} title={thought.full}>
          <span className="live-thinking-label">{thought.live ? tr('live.now.thinkingNow') : tr('live.now.thoughtLast')}</span>
          <span key={thought.text.slice(0, 40)} className="live-thinking-text">
            {thought.text}
          </span>
        </div>
      )}
    </section>
  )
}

/** A thought stays up this long after Claude moved on to doing something, then clears. */
const THOUGHT_KEEP_MS = 8000

/**
 * What Claude is thinking about: its summarised thinking as it streams, or, for a few seconds after,
 * the thought it just finished. Once it has moved on (a tool, a reply) the old thought goes, so
 * this only ever shows what's current. The newest heading if the summary has them, with the
 * sentence after it; otherwise its last sentence or two.
 */
function currentThought(s: SessionState, now: number): { text: string; full: string; live: boolean } | null {
  if (s.status !== 'running') return null
  const draft = s.drafts.main
  const live = draft?.kind === 'thinking'
  let full = ''
  if (live) full = draft.text
  else {
    // The finished thought only while nothing has happened since, and only for a moment.
    const lastIndex = s.timeline.findLastIndex((i) => i.kind !== 'note' && (!('agentId' in i) || i.agentId === null))
    const last = s.timeline[lastIndex]
    if (!last || last.kind !== 'thinking' || now - last.at > THOUGHT_KEEP_MS) return null
    full = last.text
  }
  full = full.trim()
  if (!full) return null
  const plain = full.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  const headings = [...full.matchAll(/\*\*([^*\n]{3,120})\*\*/g)]
  let text: string
  if (headings.length) {
    // The newest heading, and the start of what follows it.
    const h = headings.at(-1)!
    const after = full.slice((h.index ?? 0) + h[0].length).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
    text = after ? `${h[1].trim()}: ${after}` : h[1].trim()
  } else {
    const sentences = plain.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 3)
    text = sentences.slice(-2).join(' ') || plain
  }
  // Two lines' worth, cut at a word.
  if (text.length > 260) text = text.slice(0, 260).replace(/\s+\S*$/, '') + '…'
  return { text, full: plain.slice(-1200), live }
}

function WaitBanner({ s }: { s: SessionState }) {
  const now = useTick(true, 1000)
  const why = Object.keys(s.held ?? {}).length
    ? tr('live.wait.held')
    : s.permissions.length
      ? tr('live.wait.permission')
      : s.userQuestions?.length
        ? tr('live.wait.question')
        : tr('live.wait.checkin')
  return (
    <section className="live-wait" role="status" aria-label={tr('live.wait.title')}>
      <span className="live-ping" aria-hidden />
      <div className="grow">
        <div className="live-wait-title">{tr('live.wait.title')}</div>
        <div className="live-wait-why">{why}</div>
      </div>
      <div className="live-wait-timer">
        <span>{tr('live.wait.waiting')}</span>
        <strong>{clock(now - (s.waitSince ?? now))}</strong>
      </div>
    </section>
  )
}

/* ── Needs you ── */

const FLAG_ORDER: Flag['kind'][] = ['blind', 'circles', 'clash', 'unread', 'offplan', 'assumption']

function useFlags(s: SessionState, looked: LookedAtData, rel: (p: string) => string, now: number): Flag[] {
  return useMemo(() => {
    const out: Flag[] = []
    for (const b of looked.blind)
      out.push({
        id: `blind:${b.path}`,
        kind: 'blind',
        at: b.at,
        title: tr('live.flags.blindTitle', { file: baseName(b.path), count: b.callers.length }),
        detail: tr('live.flags.blindDetail', { callers: b.callers.slice(0, 3).map((c) => baseName(c)).join(', ') + (b.callers.length > 3 ? tr('live.flags.andMore', { n: b.callers.length - 3 }) : '') }),
        show: { label: tr('live.flags.showCallers'), target: { view: 'ripple', path: b.path } },
        tell: tr('live.flags.blindTell', { file: rel(b.path), callers: b.callers.map(rel).join(', ') })
      })
    for (const u of looked.files.filter((f) => f.unread >= 3))
      out.push({
        id: `unread:${u.path}`,
        kind: 'unread',
        at: u.at,
        title: tr('live.flags.unreadTitle', { file: baseName(u.path) }),
        detail: tr('live.flags.unreadDetail', { count: u.unread }),
        show: { label: tr('live.flags.viewChange'), target: { view: 'diff', path: u.path } },
        tell: tr('live.flags.unreadTell', { file: rel(u.path) })
      })
    const c = circles(s)
    if (c) out.push(c)
    out.push(...offPlan(s, rel), ...assumptions(s))
    const clash = collision(s, now)
    if (clash)
      out.push({
        id: `clash:${clash.path}`,
        kind: 'clash',
        at: now,
        title: tr('live.flags.clashTitle', { file: baseName(clash.path) }),
        detail: tr('live.flags.clashDetail', { a: clash.a, b: clash.b, gap: duration(clash.gap) }),
        show: { label: tr('live.flags.viewChange'), target: { view: 'diff', path: clash.path } },
        tell: tr('live.flags.clashTell', { file: rel(clash.path), a: clash.a, b: clash.b })
      })
    return out.sort((a, b) => FLAG_ORDER.indexOf(a.kind) - FLAG_ORDER.indexOf(b.kind) || b.at - a.at)
    // `now` moves every second; the flags only need the minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.toolCalls, s.files, s.decisions, s.task, s.agents, looked, Math.floor(now / 60_000)])
}

/** Risks in the code are Claude's to check; scope and assumptions are yours to answer. */
const CLAUDE_CHECKS: Flag['kind'][] = ['blind', 'unread', 'clash', 'circles']

function FlagRow({ f, now, nav, asked, onAsk, onDismiss }: { f: Flag; now: number; nav: LiveNav; asked?: number; onAsk: () => void; onDismiss: () => void }) {
  const forClaude = CLAUDE_CHECKS.includes(f.kind)
  return (
    <article className={asked ? 'live-flag asked' : 'live-flag'}>
      <div className="live-flag-head">
        <span className={`live-badge ${f.kind}`}>{tr(`live.flags.kind.${f.kind}`)}</span>
        <span className="live-note grow">{ago(now - f.at)}</span>
        <IconButton icon="close" title={tr('live.flags.fineTitle')} onClick={onDismiss} />
      </div>
      <div className="live-flag-title">{f.title}</div>
      <div className="live-flag-detail">{f.detail}</div>
      {asked ? (
        <div className="live-flag-asked">{tr('live.flags.asked', { ago: ago(now - asked) })}</div>
      ) : (
        <div className="live-flag-actions">
          {forClaude ? (
            <button className="primary" onClick={() => (nav.send(f.tell), onAsk())} title={tr('live.flags.askTitle')}>
              {tr('live.flags.ask')}
            </button>
          ) : (
            <button className="primary" onClick={() => nav.tell(f.tell)} title={tr('live.flags.answerTitle')}>
              {tr('live.flags.answer')}
            </button>
          )}
          {f.show && (
            <button className="quiet" onClick={() => nav.show(f.show!.target)}>
              {tr('live.flags.showMe')}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

/* ── Who's doing what ── */

const Lanes = memo(function Lanes({ s, now }: { s: SessionState; now: number }) {
  const list = useMemo(() => buildLanes(s, now), [s.toolCalls, s.agents, s.thinking, s.backgroundTasks, s.status, s.permissions, s.userQuestions, s.checkins, s.held, Math.floor(now / 2000)])
  const blocked = blockedOnYou(s)
  const working = list.filter((l) => l.id !== 'main' && l.state === 'running').length
  return (
    <section className="live-pane live-lanes" aria-label={tr('live.lanes.title')}>
      <header className="live-pane-h">
        <h2>{tr('live.lanes.title')}</h2>
        <span className="live-note">{blocked ? (working ? tr('live.lanes.pausedNote', { count: working }) : tr('live.lanes.pausedAlone')) : tr('live.lanes.window')}</span>
      </header>
      <div className="live-lane-list">
        {list.map((l) => (
          <LaneRow key={l.id} l={l} />
        ))}
      </div>
      <div className="live-axis" aria-hidden>
        <span />
        <span>
          <span>{tr('live.lanes.tenAgo')}</span>
          <span>{tr('live.lanes.fiveAgo')}</span>
          <span>{tr('live.lanes.now')}</span>
        </span>
      </div>
      <div className="live-key" aria-hidden>
        <span className="live-legend">
          {(['read', 'edit', 'run', 'think', 'wait'] as const).map((k) => (
            <span key={k}>
              <i className={`seg-${k}`} />
              {tr(`live.lanes.kind.${k}`)}
            </span>
          ))}
        </span>
      </div>
    </section>
  )
})

function LaneRow({ l }: { l: Lane }) {
  return (
    <div className={l.state === 'done' || l.state === 'error' ? 'live-lane ended' : 'live-lane'}>
      <div className="live-lane-who">
        <span className={`live-lane-dot ${l.state}`} aria-hidden />
        <span className="live-lane-name" title={l.name}>
          {l.name}
        </span>
        <span className="live-lane-meta">{l.meta}</span>
      </div>
      <div className="live-lane-track">
        <div className="live-bar" role="img" aria-label={l.summary || l.name}>
          {l.segs.map((g, i) => (
            <span key={i} className={l.state === 'paused' ? `seg-${g.kind} dim` : `seg-${g.kind}`} style={{ left: `${g.from * 100}%`, width: `${(g.to - g.from) * 100}%` }} />
          ))}
          {l.state === 'paused' && <span className="seg-you" style={{ left: '96%', width: '4%' }} />}
        </div>
        <div className={l.state === 'paused' ? 'live-lane-summary you' : 'live-lane-summary'}>{l.summary}</div>
      </div>
    </div>
  )
}

/* ── The edit on stage ── */

const EditStage = memo(function EditStage({ tab, s, nav, now }: { tab: Tab; s: SessionState; nav: LiveNav; now: number }) {
  const st = useMemo(() => buildStage(s), [s])
  const [late, setLate] = useState<string | null>(null)
  const [holding, setHolding] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const path = st.kind === 'none' ? '' : st.path
  const who = st.kind === 'writing' || st.kind === 'held' ? (st.w.agentId ? s.agents[st.w.agentId]?.description || tr('live.lanes.anAgent') : tr('live.lanes.main')) : ''
  const text = useFileText(tab.cwd, path, st.kind === 'landed' ? st.at : 0)
  if (st.kind === 'none')
    return (
      <section className="live-pane live-edit idle" aria-label={tr('live.edit.label')}>
        <p className="live-empty">{tr('live.edit.none')}</p>
      </section>
    )
  const hold = async () => {
    if (st.kind !== 'writing') return
    setHolding(st.w.id)
    if (!(await window.glassbox.session.hold(tab.id, st.w.id))) setLate(st.w.id)
  }
  const release = (allow: boolean) => {
    if (st.kind !== 'held') return
    void window.glassbox.session.releaseHold(tab.id, st.w.id, allow, allow ? undefined : reason.trim() || undefined)
    setReason('')
  }
  const asked = st.kind === 'writing' && holding === st.w.id
  const landedAt = st.kind === 'landed' ? st.at : 0
  return (
    <section className={`live-pane live-edit ${st.kind}`} aria-label={tr('live.edit.label')}>
      <header className="live-edit-h">
        <span className="live-edit-dot" aria-hidden />
        <span className="live-edit-title">
          {st.kind === 'held' ? tr('live.edit.held') : st.kind === 'writing' ? tr('live.edit.writing', { who }) : tr('live.edit.landed', { ago: ago(now - landedAt) })}
        </span>
        <button className="live-edit-path" onClick={() => nav.show({ view: st.kind === 'landed' ? 'diff' : 'file', path })} title={tr('live.edit.openTitle')}>
          {relPath(tab.cwd, path) || '…'}
        </button>
        <span className="grow" />
        {st.kind === 'writing' && (
          <>
            <span className="live-note">{late === st.w.id ? tr('live.edit.tooLate') : asked ? tr('live.edit.willHold') : tr('live.edit.lands')}</span>
            {!asked && (
              <button onClick={() => void hold()} title={tr('live.edit.holdTitle')}>
                {tr('live.edit.hold')}
              </button>
            )}
          </>
        )}
      </header>
      <Diff text={text} before={st.before} after={st.after} landed={st.kind === 'landed'} streaming={st.kind === 'writing'} />
      {st.kind !== 'held' && <HoldPolicyPicker />}
      {st.kind === 'held' && (
        <footer className="live-edit-held">
          <button className="primary" onClick={() => release(true)}>
            {tr('live.edit.letLand')}
          </button>
          <label className="sr-only" htmlFor={`hold-reason-${tab.id}`}>
            {tr('live.edit.reasonLabel')}
          </label>
          <input id={`hold-reason-${tab.id}`} className="grow" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('live.edit.reasonPlaceholder')} onKeyDown={(e) => e.key === 'Enter' && release(false)} />
          <button onClick={() => release(false)}>{tr('live.edit.dontMake')}</button>
        </footer>
      )}
    </section>
  )
})

/** The change with the code around it: before the edit lands its old text, after it the new. */
function Diff({ text, before: rawBefore, after: rawAfter, landed, streaming }: { text: string | null; before: string; after: string; landed: boolean; streaming: boolean }) {
  // An edit that ends at a line break on both sides doesn't change that break: don't show it as a line.
  const shared = rawBefore.endsWith('\n') && rawAfter.endsWith('\n')
  const before = shared ? rawBefore.slice(0, -1) : rawBefore
  const after = shared ? rawAfter.slice(0, -1) : rawAfter
  // While it's written the newest line stays in view (pinned to the bottom); otherwise it reads from the top.
  const anchor = landed ? after : before
  const at = text && anchor ? text.indexOf(anchor) : -1
  const startLine = at >= 0 ? text!.slice(0, at).split('\n').length : 0
  const lines = text ? text.split('\n') : []
  const ctxFrom = Math.max(0, startLine - 1 - 14)
  const context = at >= 0 ? lines.slice(ctxFrom, startLine - 1) : []
  const anchorLines = anchor ? anchor.split('\n').length : 0
  const tail = at >= 0 ? lines.slice(startLine - 1 + anchorLines, startLine - 1 + anchorLines + 3) : []
  const minus = before ? before.split('\n') : []
  const plus = after ? after.split('\n') : []
  let n = ctxFrom + 1
  return (
    <div className={streaming ? 'live-diff follow' : 'live-diff'} tabIndex={0} aria-label={tr('live.edit.diffLabel')}>
      <div className="live-diff-inner">
        {context.map((l, i) => (
          <div key={`c${i}`} className="ln">
            <span className="no">{n++}</span>
            <span className="mk"> </span>
            {l}
          </div>
        ))}
        {minus.map((l, i) => (
          <div key={`m${i}`} className="ln del">
            <span className="no">{at >= 0 ? startLine + i : ''}</span>
            <span className="mk">-</span>
            {l}
          </div>
        ))}
        {plus.map((l, i) => (
          <div key={`p${i}`} className="ln add">
            <span className="no">{at >= 0 ? startLine + i : ''}</span>
            <span className="mk">+</span>
            {l}
            {streaming && i === plus.length - 1 && <span className="live-caret" aria-hidden />}
          </div>
        ))}
        {!streaming &&
          tail.map((l, i) => (
            <div key={`t${i}`} className="ln">
              <span className="no">{startLine + (landed ? plus.length : minus.length) + i}</span>
              <span className="mk"> </span>
              {l}
            </div>
          ))}
      </div>
    </div>
  )
}

/** When an edit waits for you before it lands (the same setting as in Automation). */
function HoldPolicyPicker() {
  const a = useAppearance()
  const value = a.automation.holdEdits ?? 'ask'
  return (
    <footer className="live-hold-policy">
      <span>{tr('live.edit.policyLabel')}</span>
      <Select<HoldPolicy>
        value={value}
        aria-label={tr('live.edit.policyLabel')}
        onChange={(holdEdits) => setAppearance({ automation: { ...a.automation, holdEdits } })}
        options={[
          { value: 'ask', label: tr('live.edit.policy.ask') },
          { value: 'offplan', label: tr('live.edit.policy.offplan') },
          { value: 'all', label: tr('live.edit.policy.all') }
        ]}
      />
    </footer>
  )
}

/* ── Waiting on you ── */

function WaitCard({ tab, s }: { tab: Tab; s: SessionState }) {
  const q = s.userQuestions?.[0]
  const c = s.checkins.find((x) => x.answer === undefined)
  const p = s.permissions[0]
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [other, setOther] = useState('')
  if (q) {
    const ready = q.questions.every((x) => picked[x.question]) || other.trim()
    const send = () => {
      const answers = other.trim() ? Object.fromEntries(q.questions.map((x) => [x.question, picked[x.question] ?? other.trim()])) : picked
      void window.glassbox.session.answerQuestions(tab.id, q.id, answers)
    }
    return (
      <section className="live-pane live-ask" aria-label={tr('live.wait.questionLabel')}>
        <div className="live-ask-scroll">
          {q.questions.map((x, qi) => (
            <div key={qi} className="live-ask-q">
              <span className="live-badge question">{x.header || tr('live.wait.questionBadge')}</span>
              <h2>{x.question}</h2>
              <div className="live-options">
                {x.options.map((o, i) => (
                  <button key={o.label} className={picked[x.question] === o.label ? 'live-option on' : 'live-option'} aria-pressed={picked[x.question] === o.label} onClick={() => setPicked((m) => ({ ...m, [x.question]: o.label }))}>
                    <span className="live-option-n">{i + 1}</span>
                    <span>
                      <span className="live-option-label">{o.label}</span>
                      {o.description && <span className="live-option-desc">{o.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="live-ask-row">
            <input aria-label={tr('live.wait.otherLabel')} className="grow" value={other} onChange={(e) => setOther(e.target.value)} placeholder={tr('live.wait.other')} />
            <button className="primary" disabled={!ready} onClick={send}>
              {tr('live.wait.send')}
            </button>
          </div>
        </div>
      </section>
    )
  }
  if (c)
    return (
      <section className="live-pane live-ask" aria-label={tr('live.wait.checkinLabel')}>
        <div className="live-ask-scroll">
          <div className="live-ask-q">
            <span className="live-badge question">{tr('live.wait.checkinBadge')}</span>
            <h2>{c.about}</h2>
            {c.reason && <p className="live-ask-detail">{c.reason}</p>}
            <div className="live-options">
              {(c.options ?? []).map((o, i) => (
                <button key={o} className="live-option" onClick={() => void window.glassbox.session.respondCheckin(tab.id, c.id, o)}>
                  <span className="live-option-n">{i + 1}</span>
                  <span className="live-option-label">{o}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="live-ask-row">
            <input aria-label={tr('live.wait.otherLabel')} className="grow" value={other} onChange={(e) => setOther(e.target.value)} placeholder={tr('live.wait.other')} onKeyDown={(e) => e.key === 'Enter' && other.trim() && void window.glassbox.session.respondCheckin(tab.id, c.id, other.trim())} />
            <button className="primary" disabled={!other.trim()} onClick={() => void window.glassbox.session.respondCheckin(tab.id, c.id, other.trim())}>
              {tr('live.wait.send')}
            </button>
          </div>
        </div>
      </section>
    )
  if (p)
    return (
      <section className="live-pane live-ask" aria-label={tr('live.wait.permissionLabel')}>
        <div className="live-ask-scroll">
          <div className="live-ask-q">
            <span className="live-badge question">{tr('live.wait.permissionBadge')}</span>
            <h2>{p.guard ? tr('live.wait.guard', { label: p.guard }) : tr('live.wait.wantsTool', { tool: p.toolName })}</h2>
            <pre className="live-ask-input">{String(p.input.command ?? p.input.file_path ?? JSON.stringify(p.input, null, 2)).slice(0, 2000)}</pre>
            <p className="live-ask-detail">{tr('live.wait.permissionInApp')}</p>
          </div>
        </div>
      </section>
    )
  return null
}

/* ── Checked since the last edit? ── */

const Checked = memo(function Checked({ rows, rel, nav, failing, switcher }: { rows: Ledger[]; rel: (p: string) => string; nav: LiveNav; failing: number; switcher: React.ReactNode }) {
  const [limit, setLimit] = useState(ROWS)
  return (
    <section className="live-pane live-checked" aria-label={tr('live.checked.title')}>
      {switcher}
      <header className="live-pane-h">
        <h2 className="switchable">{tr('live.checked.title')}</h2>
        {failing > 0 && <span className="live-badge circles">{tr('live.checked.failingCount', { count: failing })}</span>}
      </header>
      <div className="live-scroll">
        {rows.length === 0 && <p className="live-empty">{tr('live.checked.empty')}</p>}
        {rows.slice(0, limit).map((r) => (
          <div key={r.path} className="live-check">
            <button className="live-file" onClick={() => nav.show({ view: 'diff', path: r.path })} title={rel(r.path)}>
              {baseName(r.path)}
            </button>
            <span className={`live-state ${r.state}`}>{tr(`live.checked.state.${r.state}`)}</span>
            <span className="live-check-detail">{r.detail}</span>
          </div>
        ))}
        {rows.length > limit && <MoreRows hidden={rows.length - limit} onMore={() => setLimit((n) => n + ROWS * 3)} />}
      </div>
    </section>
  )
})

/** Long lists show this many rows first; the rest are a click away. */
const ROWS = 30

function MoreRows({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  return (
    <button className="quiet live-more" onClick={onMore}>
      {tr('live.more', { count: hidden })}
    </button>
  )
}

/* ── What Claude has looked at ── */

type LookedFile = { path: string; at: number; total: number; read: [number, number][]; changed: [number, number][]; unread: number; written: boolean }
type LookedAtData = { files: LookedFile[]; readOnly: { path: string; ranges: [number, number][] }[]; blind: { path: string; at: number; callers: string[] }[]; searches: number }

/**
 * What Live has already worked out, kept between visits (Live is rebuilt each time you open it):
 * each changed file's text as of its last edit, and who depends on the changed files. Reading files
 * and searching the project for dependents are the slow parts on a big repo, so neither repeats
 * unless something changed.
 */
const fileTexts = new Map<string, string>() // `${cwd}|${path}@${editedAt}` -> text
const dependents = new Map<string, Record<string, string[]>>() // `${cwd}|${paths}` -> dependents by file

function useLookedAt(cwd: string, s: SessionState): LookedAtData {
  const reads = useMemo(() => readRanges(s), [s.toolCalls])
  const changed = useMemo(() => changedFiles(s), [s.files, s.toolCalls])
  const wanted = [...changed].slice(0, 16)
  const textKey = (p: string, at: number) => `${cwd}|${p}@${at}`
  const textsNow = () => Object.fromEntries(wanted.flatMap(([p, at]) => (fileTexts.has(textKey(p, at)) ? [[p, fileTexts.get(textKey(p, at))!]] : [])))
  const key = wanted.map(([p, at]) => `${p}@${at}`).join('|')
  const depsKey = `${cwd}|${wanted.map(([p]) => p).join('|')}`
  const [texts, setTexts] = useState<Record<string, string>>(textsNow)
  const [deps, setDeps] = useState<Record<string, string[]>>(() => dependents.get(depsKey) ?? {})
  // The changed files as they are now (for where the changes sit and how long each file is): only
  // the ones edited since Live last read them.
  useEffect(() => {
    const missing = wanted.filter(([p, at]) => !fileTexts.has(textKey(p, at)))
    if (!missing.length) return setTexts(textsNow())
    let live = true
    const t = setTimeout(async () => {
      for (const [p, at] of missing) {
        const r = await window.glassbox.fs.read(cwd, p).catch(() => null)
        if (r?.content !== undefined) fileTexts.set(textKey(p, at), r.content)
      }
      if (fileTexts.size > 400) for (const k of [...fileTexts.keys()].slice(0, 100)) fileTexts.delete(k)
      if (live) setTexts(textsNow())
    }, 400)
    return () => ((live = false), clearTimeout(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, key])
  // Who depends on the changed files (the same graph as Ripple): again only when the set of changed
  // files is new, not on every visit or every edit.
  useEffect(() => {
    const known = dependents.get(depsKey)
    if (known) return setDeps(known)
    if (!wanted.length) return
    let live = true
    const t = setTimeout(async () => {
      const r = await window.glassbox.deps.find(cwd, wanted.map(([p]) => p)).catch(() => null)
      if (!r) return
      const found = Object.fromEntries(r.files.map((f) => [f.path, [...new Set(f.dependents.map((d) => d.path))]]))
      dependents.set(depsKey, found)
      if (live) setDeps(found)
    }, 1500)
    return () => ((live = false), clearTimeout(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey])
  return useMemo(() => {
    const norm = (p: string) => relPath(cwd, p).replace(/\\/g, '/').toLowerCase()
    const readKeys = new Set([...reads.keys()].map(norm))
    const files: LookedFile[] = [...changed].map(([path, at]) => {
      const text = texts[path]
      const total = text ? text.split('\n').length : 0
      const read = reads.get(path) ?? []
      const ch = text ? changedRanges(s, path, text) : []
      const written = Object.values(s.toolCalls).some((c) => c.name === 'Write' && c.input.file_path === path) && !read.length
      return { path, at, total, read, changed: ch, unread: written ? 0 : unreadChanged(read, ch), written }
    })
    const changedKeys = new Set([...changed.keys()].map(norm))
    const blind = [...changed]
      .map(([path, at]) => {
        const callers = Object.entries(deps).find(([p]) => norm(p) === norm(path))?.[1] ?? []
        return { path, at, callers: callers.filter((c) => !readKeys.has(norm(c)) && !changedKeys.has(norm(c))) }
      })
      .filter((b) => b.callers.length)
    const readOnly = [...reads].filter(([p]) => !changedKeys.has(norm(p))).map(([path, ranges]) => ({ path, ranges }))
    const searches = Object.values(s.toolCalls).filter((c) => c.name === 'Grep' || c.name === 'Glob').length
    return { files, readOnly, blind, searches }
  }, [reads, changed, texts, deps, cwd, s.toolCalls, s.files])
}

const LookedAt = memo(function LookedAt({ s, looked, rel, nav, switcher }: { s: SessionState; looked: LookedAtData; rel: (p: string) => string; nav: LiveNav; switcher: React.ReactNode }) {
  const [limit, setLimit] = useState(ROWS)
  const callers = looked.blind.flatMap((b) => b.callers.map((c) => ({ path: c, of: b.path })))
  const uniqueCallers = [...new Map(callers.map((c) => [c.path, c])).values()]
  const skills = skillsUsed(s)
  const instructions = s.instructions ?? []
  const pct = (ranges: [number, number][], total: number) => {
    if (!total) return null
    const seen = new Set<number>()
    for (const [a, b] of ranges) for (let l = a; l <= Math.min(b, total); l++) seen.add(l)
    return Math.round((seen.size / total) * 100)
  }
  return (
    <section className="live-pane live-looked" aria-label={tr('live.looked.title')}>
      {switcher}
      <header className="live-pane-h">
        <h2 className="switchable">{tr('live.looked.title')}</h2>
      </header>
      <div className="live-looked-sum">
        <span className="live-note">{tr('live.looked.summary', { read: looked.files.filter((f) => f.read.length).length + looked.readOnly.length, searches: looked.searches, changed: looked.files.length })}</span>
        <span className="live-legend" aria-hidden>
          <span>
            <i className="seg-read" />
            {tr('live.looked.read')}
          </span>
          <span>
            <i className="seg-edit" />
            {tr('live.looked.changed')}
          </span>
        </span>
      </div>
      <div className="live-scroll">
        {uniqueCallers.map((c) => (
          <div key={`caller:${c.path}`} className="live-looked-row">
            <div className="live-looked-name">
              <button className="live-file" onClick={() => nav.show({ view: 'file', path: c.path })} title={rel(c.path)}>
                {baseName(c.path)}
              </button>
              <span className="live-tag warn">{tr('live.looked.callerNotOpened')}</span>
            </div>
            <div className="live-cover" aria-hidden />
          </div>
        ))}
        {looked.files.slice(0, limit).map((f) => {
          const p = pct(f.read, f.total)
          return (
            <div key={f.path} className="live-looked-row">
              <div className="live-looked-name">
                <button className="live-file" onClick={() => nav.show({ view: 'diff', path: f.path })} title={rel(f.path)}>
                  {baseName(f.path)}
                </button>
                <span className={f.unread ? 'live-tag warn' : 'live-tag'}>
                  {f.written ? tr('live.looked.written') : f.unread ? tr('live.looked.unread', { count: f.unread }) : p === null ? tr('live.looked.changedTag') : p >= 99 ? tr('live.looked.readAll') : tr('live.looked.readPct', { pct: p })}
                </span>
              </div>
              <Cover total={f.total} read={f.read} changed={f.changed} />
            </div>
          )
        })}
        {looked.files.length > limit && <MoreRows hidden={looked.files.length - limit} onMore={() => setLimit((n) => n + ROWS * 3)} />}
        {looked.readOnly.slice(0, 12).map((f) => (
          <div key={f.path} className="live-looked-row quiet">
            <div className="live-looked-name">
              <button className="live-file" onClick={() => nav.show({ view: 'file', path: f.path })} title={rel(f.path)}>
                {baseName(f.path)}
              </button>
              <span className="live-tag">{tr('live.looked.readOnly')}</span>
            </div>
          </div>
        ))}
        {(instructions.length > 0 || skills.length > 0) && (
          <div className="live-instructions">
            <h3>{tr('live.looked.instructions')}</h3>
            <div className="live-chips">
              {instructions.map((i) => (
                <span key={i.path} className="live-chip" title={i.path}>
                  <span className="live-note">{tr(`live.looked.memory.${i.type}`)}</span>
                  {rel(i.path)}
                </span>
              ))}
              {skills.map((k) => (
                <span key={k} className="live-chip">
                  <span className="live-note">{tr('live.looked.skill')}</span>
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
})

function Cover({ total, read, changed }: { total: number; read: [number, number][]; changed: [number, number][] }) {
  if (!total) return <div className="live-cover" aria-hidden />
  const pos = ([a, b]: [number, number]) => ({ left: `${((a - 1) / total) * 100}%`, width: `${Math.max(0.6, ((Math.min(b, total) - a + 1) / total) * 100)}%` })
  return (
    <div className="live-cover" aria-hidden>
      {read.map((r, i) => (
        <span key={`r${i}`} className="seg-read" style={pos(r)} />
      ))}
      {changed.map((r, i) => (
        <span key={`c${i}`} className="seg-edit" style={pos(r)} />
      ))}
    </div>
  )
}

/* ── Hooks ── */

/** Now, moving once a second while Live is on screen. */
function useTick(active: boolean, every: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [active, every])
  return now
}

/** A file's current text, read again when `version` changes. */
const fileCache = new Map<string, string>()
function useFileText(cwd: string, path: string, version: number): string | null {
  const key = `${cwd}|${path}|${version}`
  const [text, setText] = useState<string | null>(fileCache.get(key) ?? null)
  useEffect(() => {
    if (!path) return setText(null)
    const hit = fileCache.get(key)
    if (hit !== undefined) return setText(hit)
    let live = true
    void window.glassbox.fs.read(cwd, path).catch(() => null).then((r) => {
      if (r?.content === undefined) return
      fileCache.set(key, r.content)
      if (fileCache.size > 40) fileCache.delete(fileCache.keys().next().value!)
      if (live) setText(r.content)
    })
    return () => void (live = false)
  }, [key])
  return text
}

/** Checks you asked Claude for, by flag, with when (kept across restarts). */
function useAsked(id: string): [Record<string, number>, (flag: string) => void] {
  const storeKey = `glassbox.live.asked.${id}`
  const [map, setMap] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  const add = (flag: string) =>
    setMap((prev) => {
      const next = { ...prev, [flag]: Date.now() }
      try {
        localStorage.setItem(storeKey, JSON.stringify(next))
      } catch {
        /* storage full or blocked: it's only a convenience */
      }
      return next
    })
  return [map, add]
}

/** Flags you said are fine, per session (kept across restarts). */
function useDismissed(id: string): [Set<string>, (flag: string) => void] {
  const storeKey = `glassbox.live.dismissed.${id}`
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storeKey) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const add = (flag: string) =>
    setSet((prev) => {
      const next = new Set(prev).add(flag)
      try {
        localStorage.setItem(storeKey, JSON.stringify([...next].slice(-200)))
      } catch {
        /* storage full or blocked: it's only a convenience */
      }
      return next
    })
  return [set, add]
}
