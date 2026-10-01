import { Fragment, memo, useEffect, useRef, useState } from 'react'
import { useActions } from '../App'
import { useSession, type AgentFilter } from '../views/SessionView'
import { withoutBangs, CHANGE_TOOLS, toolSummary, type DecisionEntry, type SessionState, type TimelineItem, type ToolCall } from '../session'
import { renderMarkdown, baseName, relPath, mediaKind, mediaUrl, absPath, formatDuration } from '../lib'
import { targetLabel, toolTarget } from '../review'
import { CommentBox } from '../components/CommentBox'
import { CheckInCard, FindingCard } from './Signals'
import { describeTool, summarizeTools } from './describe'
import { EditCard } from './EditCard'
import { Icon } from '../components/ui'
import { Logo } from '../components/Logo'
import { TestCard } from './TestSignals'
import { isTestCall } from '../tests'
import { FileCard } from '../components/FileCard'
import { Select } from '../components/Select'
import { fileKind, KIND_ICON, splitAttachments } from '../attachments'

const TOOL_ICONS: Record<string, string> = {
  Read: 'file', Write: 'new-file', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'notebook', Bash: 'terminal', PowerShell: 'terminal-powershell',
  Grep: 'search', Glob: 'file-submodule', WebFetch: 'globe', WebSearch: 'search-fuzzy', Agent: 'organization', Task: 'organization',
  Skill: 'sparkle', TodoWrite: 'checklist', ToolSearch: 'tools', ExitPlanMode: 'checklist', mcp__glassbox__run_as_admin: 'shield'
}
export const toolIcon = (name: string) => TOOL_ICONS[name] ?? (name.startsWith('mcp__') ? 'plug' : 'tools')
/** Tool name for display; MCP tools become "tool (server)". */
export function toolLabel(name: string): string {
  const m = name.match(/^mcp__(?:claude_ai_)?(.+?)__(.+)$/)
  return m ? `${m[2].replace(/_/g, ' ')} (${m[1].replace(/_/g, ' ')})` : name
}

const agentOf = (item: TimelineItem): string | null => ('agentId' in item ? item.agentId : null)

function visible(item: TimelineItem, filter: AgentFilter): boolean {
  if (filter === 'all' || item.kind === 'user' || item.kind === 'comment' || item.kind === 'result' || item.kind === 'note' || item.kind === 'guard' || item.kind === 'finding' || item.kind === 'checkin') return true
  const agentId = agentOf(item)
  if (filter === 'main') return agentId === null
  return agentId === filter || (item.kind === 'tool' && item.toolId === filter)
}

export function Timeline() {
  const { s, tab, filter, setFilter } = useSession()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const items = s.timeline.filter((i) => visible(i, filter))
  // Each image shows once, where it first comes up (again only if it has changed since).
  const seenMedia = new Set<string>()
  const drafts = Object.entries(s.drafts).filter(([key]) => filter === 'all' || (filter === 'main' ? key === 'main' : key === filter))
  const draftLength = drafts.reduce((n, [, d]) => n + d.text.length, 0)

  const content = useRef<HTMLDivElement>(null)
  const userScroll = useRef(0)
  const lastItem = items.at(-1)

  // Scrolled up to read: offer a way back down, and to what you last sent if that's out of view.
  const [jump, setJump] = useState<{ latest: boolean; sent: 'above' | 'below' | null }>({ latest: false, sent: null })
  const lastSent = () => {
    const all = scroller.current?.querySelectorAll<HTMLElement>('.msg.user')
    return all?.[all.length - 1]
  }
  const updateJump = () => {
    const el = scroller.current
    if (!el) return
    const latest = !stick.current && el.scrollHeight - el.scrollTop - el.clientHeight > 200
    let sent: 'above' | 'below' | null = null
    const msg = latest ? lastSent() : undefined
    if (msg) {
      const box = el.getBoundingClientRect()
      const r = msg.getBoundingClientRect()
      sent = r.bottom < box.top ? 'above' : r.top > box.bottom ? 'below' : null
    }
    setJump((j) => (j.latest === latest && j.sent === sent ? j : { latest, sent }))
  }
  // A jump you asked for (sending, Jump to latest) glides down; following Claude as it writes pins
  // instantly, so the text flows in rather than lagging behind. While gliding, growth retargets the
  // glide instead of snapping.
  const gliding = useRef(false)
  const toLatest = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    const far = el.scrollHeight - el.scrollTop - el.clientHeight
    if (far > 4) {
      gliding.current = !matchMedia('(prefers-reduced-motion: reduce)').matches
      if (gliding.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      else el.scrollTop = el.scrollHeight
    }
    setJump({ latest: false, sent: null })
  }
  const toLatestRef = useRef(toLatest)
  toLatestRef.current = toLatest
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === tab.id && toLatestRef.current()
    window.addEventListener('glassbox:to-latest', on)
    return () => window.removeEventListener('glassbox:to-latest', on)
  }, [tab.id])
  const toSent = () => {
    const el = scroller.current
    const msg = lastSent()
    if (!el || !msg) return
    el.scrollTo({ top: el.scrollTop + msg.getBoundingClientRect().top - el.getBoundingClientRect().top - 16, behavior: 'smooth' })
  }

  // Sending a message always jumps to the bottom, even if you'd scrolled up.
  useEffect(() => {
    if (lastItem?.kind === 'user') toLatestRef.current()
  }, [lastItem])

  // Follow the bottom while Claude writes: any growth of the content (new text, a diff card
  // rendering, a group expanding) keeps it pinned, unless you've scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const follow = () => {
      if (!stick.current) return
      if (gliding.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      else el.scrollTop = el.scrollHeight
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(inner)
    ro.observe(el) // the timeline shrinking (composer or ask dock growing) mustn't leave it short of the bottom
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = scroller.current
    if (!el || !stick.current) return
    if (gliding.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [items.length, s.toolCalls, draftLength])

  return (
    <div className="timeline-wrap">
      <AgentSwitcher />
      <div
        className="timeline"
        ref={scroller}
        // Only you scrolling up stops the follow; layout changes that move the scroll position don't.
        onWheel={(e) => e.deltaY < 0 && (userScroll.current = Date.now())}
        onPointerDown={(e) => e.target === e.currentTarget && (userScroll.current = Date.now())} // the scrollbar
        onKeyDown={(e) => ['ArrowUp', 'PageUp', 'Home'].includes(e.key) && (userScroll.current = Date.now())}
        onScroll={(e) => {
          const el = e.currentTarget
          const far = el.scrollHeight - el.scrollTop - el.clientHeight
          if (far < 4) gliding.current = false
          if (far < 80) stick.current = true
          // Scrolling up yourself mid-glide cancels it.
          else if (Date.now() - userScroll.current < 800) (stick.current = false), (gliding.current = false)
          updateJump()
        }}
      >
        <div className="timeline-content" ref={content}>
        {items.length === 0 && !drafts.length ? (
          <Welcome />
        ) : (
          groupTools(items).map((g, i, all) => {
            // In the everything view, one quiet line says where an agent's run starts (no indents).
            const agentId = Array.isArray(g) ? g[0].agentId : agentOf(g)
            const before = i > 0 ? (Array.isArray(all[i - 1]) ? (all[i - 1] as ToolItem[])[0].agentId : agentOf(all[i - 1] as TimelineItem)) : null
            const agent = filter === 'all' && agentId && agentId !== before ? s.agents[agentId] : undefined
            return (
              <Fragment key={i}>
                {agent && (
                  <button className="agent-run" onClick={() => setFilter(agent.id)} title="Show only this agent">
                    <Icon name="organization" /> {agent.type}
                    {agent.description && <span className="agent-run-what">{agent.description}</span>}
                  </button>
                )}
                {Array.isArray(g) ? (
                  <>
                    <ToolGroup items={g} s={s} />
                    <MediaStrip items={g} s={s} seen={seenMedia} />
                  </>
                ) : (
                  <Row item={g} s={s} />
                )}
              </Fragment>
            )
          })
        )}
        {/* An empty draft (thinking or reply) says nothing the working line doesn't, and would only add a gap. */}
        {drafts.filter(([, d]) => d.text.trim()).map(([key, d]) => (
          <div key={key} className="row">
            {d.kind === 'thinking' ? (
              <div className="thinking live">
                <div className="live-label"><Icon name="lightbulb" /> Thinking</div>
                <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.text, tab.cwd) }} />
              </div>
            ) : (
              <div className="msg assistant markdown live" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.text, tab.cwd) + '<span class="caret"></span>' }} />
            )}
          </div>
        ))}
        <Working />
        </div>
      </div>
      {(jump.latest || jump.sent) && (
        <div className="timeline-jump">
          {jump.sent && (
            <button className="jump-btn" onClick={toSent} title="Scroll to the last message you sent">
              <Icon name={jump.sent === 'above' ? 'arrow-up' : 'arrow-down'} /> Your last message
            </button>
          )}
          {jump.latest && (
            <button className="jump-btn" onClick={toLatest} title="Scroll to the bottom and follow Claude again">
              <Icon name="arrow-down" /> Jump to latest
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Said in turn while Claude works, like the CLI does, so a long run never looks stuck.
const WORKING_WORDS = ['Working', 'Thinking', 'Pondering', 'Mulling it over', 'Tinkering', 'Crunching', 'Figuring it out', 'Piecing it together', 'Checking', 'Brewing', 'Noodling', 'Getting there']

/**
 * The line at the bottom while Claude is working: a turning spark, a word that changes every few
 * seconds, how long this has been going, and (when nothing new has shown for a while) that it's
 * still going, so a long quiet stretch never looks like a hang.
 */
function Working() {
  const { s } = useSession()
  const [now, setNow] = useState(Date.now())
  // Agents still working in the background keep the line going after Claude's own turn ends.
  const background = Object.values(s.agents).filter((a) => a.status === 'running')
  const on = (s.status === 'running' || (s.status === 'ready' && background.length > 0)) && !s.permissions.length && !s.checkins.some((c) => c.answer === undefined)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  if (!on) return null
  const since = s.busySince ?? Math.min(...background.map((a) => a.at), now)
  const took = Math.max(0, Math.floor((now - since) / 1000))
  const last = Math.max(since, s.timeline.at(-1)?.at ?? 0, ...Object.values(s.toolCalls).map((c) => c.endedAt ?? c.at))
  const quiet = Math.floor((now - last) / 1000)
  const word = WORKING_WORDS[Math.floor(took / 6) % WORKING_WORDS.length]
  const clock = (n: number) => (n < 60 ? `${n}s` : formatDuration(n * 1000))
  const running = Object.values(s.toolCalls).filter((c) => c.status === 'running').length
  return (
    <div className="row">
      <div className="working" role="status" aria-live="off">
        {/* A six-spoked spark, turning slowly while Claude works. */}
        <svg className="working-spark" viewBox="0 0 14 14" aria-hidden>
          {[0, 60, 120].map((a) => (
            <line key={a} x1="7" y1="1.5" x2="7" y2="12.5" transform={`rotate(${a} 7 7)`} />
          ))}
        </svg>
        <span className="working-word">{word}…</span>
        <span className="working-meta">
          {clock(took)}
          {s.status !== 'running'
            ? `, ${background.length === 1 ? `${background[0].type} working in the background${background[0].progress ? `: ${background[0].progress}` : ''}` : `${background.length} agents working in the background`}`
            : quiet >= 45
              ? `, still going (${running ? `${running} step${running > 1 ? 's' : ''} running` : 'thinking'}, nothing new for ${clock(quiet)})`
              : ''}
        </span>
      </div>
    </div>
  )
}

function Welcome() {
  const { tab, s } = useSession()
  return (
    <div className="welcome">
      <span className="welcome-icon"><Logo size={44} /></span>
      <h2>New session</h2>
      <p className="muted">
        in <span className="mono">{tab.cwd}</span>
      </p>
      <p className="muted small">
        {s.status === 'ready'
          ? `${s.commands.length} skills and ${s.mcp.filter((m) => m.status === 'connected').length} connectors ready.`
          : 'Starting Claude Code…'}
      </p>
    </div>
  )
}

const Row = memo(function Row({ item, s }: { item: TimelineItem; s: SessionState }) {
  return (
    <div className="row">
      <Item item={item} s={s} />
    </div>
  )
})

/**
 * Which thread the conversation shows: the main one (agents appear there as the step that started
 * them), one agent's own work, or everything interleaved. Only there once Claude has used agents.
 */
function AgentSwitcher() {
  const { s, filter, setFilter } = useSession()
  const agents = Object.values(s.agents).sort((a, b) => a.at - b.at)
  const running = agents.filter((a) => a.status === 'running')
  const value = filter === 'main' || filter === 'all' || s.agents[filter] ? filter : 'main'
  // Finished agents leave the switcher (their line in the conversation still opens their work);
  // it shows while one is running, or while you're looking at one.
  if (!running.length && value === 'main') return null
  const listed = agents.filter((a) => a.status === 'running' || a.id === value)
  return (
    <div className="agent-switch">
      <span className="agent-switch-label small">Showing</span>
      <Select<string>
        value={value}
        onChange={setFilter}
        aria-label="Which agent's work to show"
        options={[
          { value: 'main', label: 'Main conversation' },
          ...listed.map((a) => ({ value: a.id, label: `${a.type}: ${a.description || 'agent'}`, hint: a.status === 'running' ? 'running' : 'finished' })),
          { value: 'all', label: 'Everything, interleaved' }
        ]}
      />
      {running.length > 0 && <span className="agent-switch-meta small">{running.length} running</span>}
      {value !== 'main' && (
        <button className="link small" onClick={() => setFilter('main')}>
          Back to the main conversation
        </button>
      )}
    </div>
  )
}

function Item({ item, s }: { item: TimelineItem; s: SessionState }) {
  const { tab } = useSession()
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} uuid={item.uuid} turn={item.turn} />
    case 'comment': {
      // Your message, as normal, with a quiet line above saying what it replies to.
      const target = item.target
      const question = target.kind === 'decision' && s.decisions.find((d) => d.id === target.id)?.kind === 'question'
      return (
        <div className="reply">
          <div className="reply-to small">
            <Icon name={question ? 'question' : 'reply'} />
            <span className="reply-verb">{question ? 'Answering' : 'Replying to'}</span>
            <span className="reply-target">{targetLabel(target)}</span>
          </div>
          <div className="msg user">{item.text}</div>
        </div>
      )
    }
    case 'text':
      return <AssistantMessage text={item.text} />
    case 'thinking':
      return (
        <details className="thinking">
          <summary>
            <Icon name="lightbulb" /> Thinking
          </summary>
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
        </details>
      )
    case 'decision': {
      const d = s.decisions.find((x) => x.id === item.id)
      if (!d) return null
      // An open question is asked in full in the box under the conversation; here it's one quiet
      // line, so it isn't shown three times over. Answered, it becomes a normal card.
      if (d.kind === 'question' && !d.challenged)
        return (
          <div className="decision-pending">
            <span className="tally-lamp tally-wait" aria-hidden />
            <span className="grow">Asked you: {d.title}</span>
            <span className="muted small">Answer it below</span>
          </div>
        )
      return <DecisionCard d={d} />
    }
    case 'present': {
      const p = s.presented?.find((x) => x.id === item.id)
      return p ? <FileCard path={absPath(tab.cwd, p.path)} title={p.title} why={p.why} /> : null
    }
    case 'guard':
      return (
        <div className={`guard-note guard-${item.hit.action}`}>
          <Icon name={item.hit.action === 'block' ? 'shield' : 'question'} />
          <span className="grow">
            <strong>{item.hit.action === 'block' ? 'Blocked' : 'Needs your approval'}:</strong> {item.hit.label}
            <span className="guard-detail mono">{item.hit.detail}</span>
          </span>
        </div>
      )
    case 'commits':
      return <CommitsCard item={item} />
    case 'service-error':
      return <ServiceErrorCard item={item} />
    case 'bang':
      return <BangCard id={item.id} />
    case 'note':
      return (
        <div className={`note note-${item.tone}`}>
          <Icon name={item.tone === 'error' ? 'error' : item.tone === 'warn' ? 'warning' : 'info'} /> {item.text}
        </div>
      )
    case 'result':
      return (
        <div className={item.isError ? 'turn-end error' : 'turn-end'}>
          <span title={`Finished ${new Date(item.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. The time includes any wait for your answers or approvals.`}>
            {item.isError ? 'Stopped with an error after ' : 'Done in '}
            {formatDuration(item.durationMs)}
            {/* Past a minute, the clock time says more than the length alone. */}
            {item.durationMs >= 60_000 && <span className="turn-end-at">, at {new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          </span>
        </div>
      )
    case 'finding': {
      const f = s.findings.find((x) => x.id === item.id)
      return f ? <FindingCard f={f} compact /> : null
    }
    case 'checkin':
      return <CheckInCard id={item.id} />
    case 'tool':
      return null
  }
}

function UserMessage({ text: sent, uuid, turn }: { text: string; uuid?: string; turn: number }) {
  const { showPanel, setCheckpoint, openAttachment } = useSession()
  // What you wrote, and the files you attached to it (shown as thumbnails and names, not paths).
  // Without the output of commands you ran ("! command"): those show as their own cards.
  const { text, paths } = splitAttachments(withoutBangs(sent))
  return (
    <div className="user-wrap">
      {uuid && (
        <button
          className="icon-btn hover-action"
          title="Rewind files to before this message"
          onClick={() => {
            setCheckpoint(uuid)
            showPanel('review')
          }}
        >
          <Icon name="discard" />
        </button>
      )}
      <div className="user-stack">
        {paths.length > 0 && (
          <div className="msg-attachments">
            {paths.map((p) =>
              fileKind(p) === 'image' ? (
                <button key={p} className="msg-attachment thumb checker" onClick={() => openAttachment(p)} title={p}>
                  <img src={mediaUrl(p)} alt={baseName(p)} />
                </button>
              ) : (
                <button key={p} className="msg-attachment" onClick={() => openAttachment(p)} title={p}>
                  <Icon name={KIND_ICON[fileKind(p)]} /> <span className="ellipsis">{baseName(p)}</span>
                </button>
              )
            )}
          </div>
        )}
        {text && <div className="msg user" data-turn={turn}>{text}</div>}
      </div>
    </div>
  )
}

function AssistantMessage({ text }: { text: string }) {
  const { tab } = useSession()
  const [commenting, setCommenting] = useState<string | null>(null)
  return (
    <div className="assistant-wrap">
      <div className="msg assistant markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text, tab.cwd) }} />
      {commenting === null ? (
        <button
          className="icon-btn hover-action"
          title="Comment on this (select text first to quote part of it)"
          onClick={() => setCommenting(window.getSelection()?.toString().trim() || text.slice(0, 280))}
        >
          <Icon name="comment" />
        </button>
      ) : (
        <CommentBox target={{ kind: 'message', excerpt: commenting }} onDone={() => setCommenting(null)} />
      )}
    </div>
  )
}

const DECISION_META = {
  decision: { icon: 'milestone', label: 'Decided' },
  assumption: { icon: 'warning', label: 'Assumed' },
  question: { icon: 'question', label: 'Question' }
} as const

export function DecisionCard({ d }: { d: DecisionEntry }) {
  // An open question starts expanded; anything else (including an answered question) starts folded.
  // Folded by default: an open question is answered from the box docked under the message box.
  const [open, setOpen] = useState(false)
  const awaiting = d.kind === 'question' && !d.challenged
  const [commenting, setCommenting] = useState(false)
  useEffect(() => {
    if (d.challenged) setOpen(false)
  }, [d.challenged])
  const meta = DECISION_META[d.kind]
  const hasBody = !!(d.detail || d.alternatives?.length || d.files?.length || d.reply)
  return (
    <div className={`decision decision-${d.kind}${d.challenged ? ' answered' : ''}${d.dismissed ? ' dismissed' : ''}`}>
      <div className={hasBody ? 'decision-head' : 'decision-head flat'} onClick={() => hasBody && setOpen(!open)} aria-expanded={hasBody ? open : undefined}>
        <Icon name={hasBody ? (open ? 'chevron-down' : 'chevron-right') : 'blank'} className="decision-chevron muted" />
        <div className="decision-main">
          <span className="decision-title">{d.title}</span>
          <span className="decision-meta">
            <span className="decision-kind">{d.kind === 'question' && d.dismissed ? 'Dismissed' : d.kind === 'question' && d.challenged ? 'Answered' : meta.label}</span>
            <span className="decision-time" title={new Date(d.at).toLocaleString()}>
              {new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
            {d.challenged && d.kind !== 'question' && <span>You commented</span>}
          </span>
        </div>
        {!commenting && !awaiting && (
          <button className="btn quiet decision-action" onClick={(e) => (e.stopPropagation(), setCommenting(true))}>
            {d.kind === 'question' ? (d.challenged ? 'Reply' : 'Answer') : 'Challenge'}
          </button>
        )}
      </div>
      {open && hasBody ? (
        <div className="decision-body small">
          {d.detail && <p>{d.detail}</p>}
          {d.reply && (
            <p className="decision-reply">
              <span className="muted">{d.kind === 'question' ? 'You answered: ' : 'You said: '}</span>
              {d.reply}
            </p>
          )}
          {d.alternatives?.length && d.kind !== 'question' ? (
            <p className="muted">
              Considered: {d.alternatives.join('; ')}
            </p>
          ) : null}
          {d.files?.length ? <p className="muted mono">{d.files.map((f) => baseName(f)).join(', ')}</p> : null}
        </div>
      ) : null}
      {commenting && (
        <CommentBox
          target={{ kind: 'decision', id: d.id, title: d.title }}
          placeholder={d.kind === 'question' ? 'Your answer' : 'Why this might be wrong, or what to do instead'}
          onDone={() => setCommenting(false)}
        />
      )}
    </div>
  )
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

/** Consecutive tool calls from the same thread render as one grouped list. */
function groupTools(items: TimelineItem[]): (TimelineItem | ToolItem[])[] {
  const out: (TimelineItem | ToolItem[])[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (item.kind === 'tool' && Array.isArray(last) && last[0].agentId === item.agentId) last.push(item)
    else out.push(item.kind === 'tool' ? [item] : item)
  }
  return out
}

/**
 * Images (and video, audio) the steps above touched: files Claude read, created or showed you.
 * Kept outside the folded step list, so a screenshot is seen without opening anything.
 */
function MediaStrip({ items, s, seen }: { items: ToolItem[]; s: SessionState; seen: Set<string> }) {
  const { tab, openFile } = useSession()
  const ids = new Set(items.map((i) => i.toolId))
  const paths: string[] = []
  // One file, however it was written (relative, absolute, either slash).
  const same = (p: string) => absPath(tab.cwd, p).replace(/\\/g, '/').toLowerCase()
  const add = (p: unknown) => {
    if (typeof p !== 'string' || !mediaKind(p)) return
    if (!paths.some((x) => same(x) === same(p))) paths.push(absPath(tab.cwd, p))
  }
  for (const id of ids) {
    const c = s.toolCalls[id]
    if (!c) continue
    if (c.name === 'Read' || c.name === 'Write' || c.name === 'mcp__glassbox__open_file') add(c.input.file_path ?? c.input.path)
  }
  // Files a shell command made (a screenshot script, an image export).
  for (const f of s.files) if (ids.has(f.toolId)) add(f.path)
  // Re-read an image Claude has regenerated since.
  const version = (p: string) => s.files.filter((f) => same(f.path) === same(p) && CHANGE_TOOLS.has(f.tool)).length
  const fresh = paths.filter((p) => {
    const k = `${same(p)}@${version(p)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!fresh.length) return null
  return (
    <div className="media-strip">
      {fresh.slice(0, 8).map((p) => {
        const kind = mediaKind(p)
        const src = `${mediaUrl(p)}?v=${version(p)}`
        // Video and audio play right here; the name opens the file full size.
        return kind === 'audio' || kind === 'video' ? (
          <div key={p} className={`media-thumb ${kind}`}>
            {kind === 'video' ? <video src={src} controls preload="metadata" /> : <audio src={src} controls preload="metadata" />}
            <button className="media-thumb-open" onClick={() => openFile(p)} title={`${relPath(tab.cwd, p)} (open full size)`}>
              {baseName(p)}
            </button>
          </div>
        ) : (
          <button key={p} className="media-thumb" onClick={() => openFile(p)} title={`${relPath(tab.cwd, p)} (open full size)`}>
            <img src={src} alt={baseName(p)} loading="lazy" />
            <span className="media-thumb-name">{baseName(p)}</span>
          </button>
        )
      })}
    </div>
  )
}

function ToolGroup({ items, s }: { items: ToolItem[]; s: SessionState }) {
  return (
    <div className="row">
      <ToolGroupBody items={items} s={s} />
    </div>
  )
}

const EDIT_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * A run of tool calls. Edits always show as inline diffs, so you see changes as they happen; the
 * reads, searches and commands between them collapse into one summary line each.
 */
function ToolGroupBody({ items, s }: { items: ToolItem[]; s: SessionState }) {
  const calls = items.map((i) => s.toolCalls[i.toolId]).filter((c): c is ToolCall => !!c)
  const segments: ({ kind: 'edit'; call: ToolCall } | { kind: 'test'; call: ToolCall } | { kind: 'agent'; call: ToolCall } | { kind: 'plan'; call: ToolCall } | { kind: 'steps'; calls: ToolCall[] })[] = []
  for (const c of calls) {
    const last = segments.at(-1)
    // An agent is its own line, with the way into its work.
    if (s.agents[c.id]) {
      segments.push({ kind: 'agent', call: c })
      continue
    }
    // A plan Claude presented: its own line, so you can open it again later.
    if (c.name === 'ExitPlanMode') {
      segments.push({ kind: 'plan', call: c })
      continue
    }
    const shellEdits = s.files.some((f) => f.toolId === c.id && f.tool === 'ShellEdit')
    if (EDIT_NAMES.has(c.name) && c.name !== 'NotebookEdit') segments.push({ kind: 'edit', call: c })
    else if (shellEdits || isTestCall(c)) {
      // One command can both change files and run the tests: show both.
      if (shellEdits) segments.push({ kind: 'edit', call: c })
      if (isTestCall(c)) segments.push({ kind: 'test', call: c })
    } else if (last?.kind === 'steps') last.calls.push(c)
    else segments.push({ kind: 'steps', calls: [c] })
  }
  return (
    <div className="tool-group">
      {segments.map((seg, i) =>
        seg.kind === 'edit' ? (
          EDIT_NAMES.has(seg.call.name) ? <EditCard key={seg.call.id} call={seg.call} /> : <ShellEditCard key={seg.call.id} call={seg.call} s={s} />
        ) : seg.kind === 'test' ? (
          <TestCard key={seg.call.id} call={seg.call} />
        ) : seg.kind === 'agent' ? (
          <AgentStep key={seg.call.id} call={seg.call} s={s} />
        ) : seg.kind === 'plan' ? (
          <PlanStep key={seg.call.id} call={seg.call} s={s} />
        ) : (
          <Steps key={seg.calls[0].id + i} calls={seg.calls} s={s} />
        )
      )}
    </div>
  )
}

/** A plan Claude presented, with a way back into it (waiting for you, or to read again). */
function PlanStep({ call, s }: { call: ToolCall; s: SessionState }) {
  const { openPlan } = useSession()
  const text = String(call.input.plan ?? '')
  const latest = s.plan?.text === text
  const waiting = call.status === 'running' && s.permissions.some((p) => p.toolName === 'ExitPlanMode')
  const status = latest ? s.plan?.status : call.status === 'error' ? 'changes-requested' : undefined
  const title = (text.match(/^#+\s*(.+)$/m)?.[1]?.trim() ?? text.split('\n').find((l) => l.trim())?.trim().slice(0, 100))?.replace(/^plan\s*[:\-–]\s*/i, '')
  return (
    <div className="plan-step">
      <Icon name="checklist" className={waiting ? 'accent' : 'muted'} />
      <span className="grow ellipsis">
        <strong>Plan</strong> {title}
      </span>
      <span className="muted small">{waiting ? 'waiting for you' : status === 'approved' ? 'approved' : status === 'changes-requested' ? 'changes requested' : ''}</span>
      <button className="btn quiet small" onClick={() => (waiting ? openPlan() : openPlan({ text, status }))}>
        Open plan
      </button>
    </div>
  )
}

/** An agent Claude started: what it's doing, how far it's got, and a way to follow just its work. */
function AgentStep({ call, s }: { call: ToolCall; s: SessionState }) {
  const { setFilter } = useSession()
  const a = s.agents[call.id]
  if (!a) return null
  const running = a.status === 'running'
  return (
    <div className="agent-step">
      {running ? <Icon name="loading" className="codicon-modifier-spin accent" /> : <Icon name="organization" className="muted" />}
      <span className="agent-step-text">
        <span className="agent-step-type">{a.type}</span> {a.description}
        <span className="muted">
          {' '}
          ({a.toolCalls} step{a.toolCalls === 1 ? '' : 's'}
          {running ? ' so far' : ''}
          {running && a.background ? ', in the background' : ''})
        </span>
        {running && a.progress && <span className="agent-step-now">{a.progress}</span>}
      </span>
      <button className="btn quiet" onClick={() => setFilter(a.id)} title="Show only this agent's work">
        {running ? 'Follow it' : 'See its work'}
      </button>
    </div>
  )
}

/** Files Claude changed through a shell command (a script, sed, a generator) rather than the Edit tool. */
function ShellEditCard({ call, s }: { call: ToolCall; s: SessionState }) {
  const { tab, openDiff } = useSession()
  const files = [...new Set(s.files.filter((f) => f.toolId === call.id && f.tool === 'ShellEdit').map((f) => f.path))]
  return (
    <div className="edit-card shell-edit">
      <div className="edit-head-row">
        <span className="edit-head static">
          <Icon name="terminal" className="warn" />
          <span className="edit-verb">Changed {files.length} file{files.length > 1 ? 's' : ''} with a command:</span>
          <span className="muted small mono ellipsis" title={String(call.input.command ?? '')}>{String(call.input.description ?? call.input.command ?? '').split('\n')[0]}</span>
        </span>
      </div>
      {files.map((p) => (
        <button key={p} className="commit-card-row" onClick={() => openDiff({ path: p, base: null, diffMode: 'merge-base', source: 'branch' })} title={`${p}\nOpen the diff`}>
          <Icon name="edit" className="muted" />
          <span className="edit-file">{baseName(p)}</span>
          <span className="muted small ellipsis grow">{relPath(tab.cwd, p).split('/').slice(0, -1).join('/')}</span>
          <Icon name="link-external" className="muted" />
        </button>
      ))}
    </div>
  )
}

function Steps({ calls, s }: { calls: ToolCall[]; s: SessionState }) {
  const [open, setOpen] = useState(false)
  const rows = calls.map((call) => <ToolRow key={call.id} call={call} isAgent={!!s.agents[call.id]} guarded={s.guardHits.find((h) => h.toolUseId === call.id)?.action} />)
  if (calls.length < 2) return <>{rows}</>
  const running = calls.find((c) => c.status === 'running')
  const failed = calls.filter((c) => c.status === 'error').length
  return (
    <div className={open ? 'steps open' : 'steps'}>
      <div className="tool-summary-row" onClick={() => setOpen(!open)} title={open ? 'Hide the steps' : 'Show each step'}>
        {running ? <Icon name="loading" className="codicon-modifier-spin accent" /> : <Icon name={failed ? 'warning' : 'list-flat'} className={failed ? 'warn' : 'muted'} />}
        <span className="grow ellipsis">
          {running ? <>{describeTool(running)}<span className="muted"> ({calls.length} steps so far)</span></> : summarizeTools(calls)}
          {failed > 0 && <span className="err"> {failed} failed</span>}
        </span>
        <span className="muted small">{calls.length} steps</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="muted" />
      </div>
      {open && rows}
    </div>
  )
}

const CODE_TOOLS = new Set(['Bash', 'PowerShell', 'Grep', 'Glob'])

function ToolRow({ call, isAgent, guarded }: { call: ToolCall; isAgent: boolean; guarded?: 'block' | 'ask' }) {
  const { openFile, setFilter, showPanel } = useSession()
  const [open, setOpen] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const path = call.input.file_path ?? call.input.notebook_path
  const isPath = typeof path === 'string'

  return (
    <div className={`tool tool-${call.status}${open ? ' open' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        {call.status === 'running' ? (
          <Icon name="loading" className="codicon-modifier-spin tool-icon accent" />
        ) : call.status === 'error' ? (
          <Icon name="error" className="tool-icon err" />
        ) : (
          <Icon name={toolIcon(call.name)} className="tool-icon" />
        )}
        <span className="tool-text" title={isPath ? path : CODE_TOOLS.has(call.name) ? String(call.input.command ?? call.input.pattern ?? '') : toolSummary(call)}>
          {describeTool(call)}
        </span>
        {guarded && <Icon name="shield" className={guarded === 'block' ? 'err' : 'warn'} title={guarded === 'block' ? 'Blocked by a guardrail' : 'Stopped for your approval by a guardrail'} />}
        <span className="tool-actions">
          <button className="icon-btn" title="Comment on this step" onClick={(e) => (e.stopPropagation(), setCommenting(true))}>
            <Icon name="comment" />
          </button>
          {isPath && (
            <button className="icon-btn" title="Open file" onClick={(e) => (e.stopPropagation(), openFile(path))}>
              <Icon name="go-to-file" />
            </button>
          )}
          {isAgent && (
            <button className="icon-btn" title="Follow this agent" onClick={(e) => (e.stopPropagation(), setFilter(call.id), showPanel('agents'))}>
              <Icon name="eye" />
            </button>
          )}
        </span>
        <Icon name="chevron-down" className="tool-chevron" />
      </div>
      {commenting && <CommentBox target={toolTarget(call)} onDone={() => setCommenting(false)} />}
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {call.result !== undefined && <ToolResult result={call.result} />}
        </div>
      )}
    </div>
  )
}

/** How much of a result shows before "Show all": enough to read, without a huge block slowing the conversation. */
const RESULT_PREVIEW = 20_000

/**
 * A step's result. When the output was too big, Claude Code gave Claude a preview and saved the
 * whole thing to a file; that file is loaded here so you see all of it, not just the preview.
 */
function ToolResult({ result }: { result: string }) {
  const saved = /<persisted-output>[\s\S]*?saved to:\s*(.+?)\s*\n/.exec(result)?.[1]
  const [full, setFull] = useState<{ text?: string; error?: string } | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (!saved) return
    let live = true
    window.glassbox.toolOutput(saved).then(
      (r) => live && setFull(r),
      () => live && setFull({ error: 'Couldn’t load the full output' })
    )
    return () => {
      live = false
    }
  }, [saved])
  const text = saved ? (full?.text ?? (full ? result : '')) : result
  const long = text.length > RESULT_PREVIEW
  return (
    <>
      <div className="label">
        Result
        {saved && !full && <span className="muted"> (loading the full output…)</span>}
        {saved && full?.error && <span className="muted"> (only a preview: {full.error.toLowerCase()})</span>}
      </div>
      {/* The preview stops at the end of a line, not partway through one. */}
      <pre>{long && !all ? text.slice(0, Math.max(text.lastIndexOf('\n', RESULT_PREVIEW), RESULT_PREVIEW / 2)) : text}</pre>
      {long && (
        <button className="link small" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all (${Math.round(text.length / 1024)} KB)`}
        </button>
      )}
    </>
  )
}

/** A command you ran yourself ("! command"): what you typed, its output as it comes, how it ended. */
function BangCard({ id }: { id: string }) {
  const { s } = useSession()
  const actions = useActions()
  const b = s.bangs?.[id]
  const out = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = out.current
    if (el && b?.status === 'running') el.scrollTop = el.scrollHeight
  }, [b?.output, b?.status])
  if (!b) return null
  const text = b.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '')
  return (
    <div className={`bang-card ${b.status}`}>
      <div className="bang-head">
        <Icon name="terminal" className="muted" />
        <code className="bang-cmd" title={b.command}>
          <span className="bang-mark">!</span> {b.command}
        </code>
        <span className="spacer" />
        {b.status === 'running' ? (
          <>
            <Icon name="loading" className="codicon-modifier-spin accent" />
            <button className="btn quiet small" onClick={() => actions.stopShell(b.id)}>Stop</button>
          </>
        ) : (
          <span className={b.status === 'failed' ? 'small err' : 'small muted'}>
            {b.status === 'failed' ? `Failed${b.code != null ? ` (exit ${b.code})` : ''}` : 'Done'}
            {b.sent ? ', sent to Claude' : ', goes to Claude with your next message'}
          </span>
        )}
      </div>
      {text.trim() && (
        <pre className="bang-out" ref={out}>
          {text.trimEnd()}
        </pre>
      )}
    </div>
  )
}

/** Commits are listed in the Git panel; the timeline only mentions a commit that failed. */
function CommitsCard({ item }: { item: Extract<TimelineItem, { kind: 'commits' }> }) {
  if (!item.error) return null
  return (
    <div className="note note-error">
      <Icon name="error" /> {item.error}
    </div>
  )
}

/** A running service logged an error, shown next to the edit that most likely caused it. */
function ServiceErrorCard({ item }: { item: Extract<TimelineItem, { kind: 'service-error' }> }) {
  const { send, showPanel, s } = useSession()
  const secs = item.after ? Math.max(1, Math.round((item.at - item.after.at) / 1000)) : 0
  const canSend = s.status === 'ready' || s.status === 'running'
  return (
    <div className="service-error">
      <div className="service-error-head">
        <Icon name="bug" className="err" />
        <span className="grow">
          <strong>{item.service}</strong> logged an error
          {item.after && (
            <span className="muted">
              {' '}
              {secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`} after Claude edited <span className="mono">{baseName(item.after.path)}</span>
            </span>
          )}
        </span>
        <button className="chip-btn" onClick={() => showPanel('services')}>
          <Icon name="output" /> Logs
        </button>
        <button
          className="chip-btn"
          disabled={!canSend}
          onClick={() =>
            void send(
              `The ${item.service} service just logged this error${item.after ? ` shortly after you edited ${item.after.path}` : ''}. Work out whether your change caused it and fix it if so:\n\n\`\`\`\n${item.text}\n\`\`\``,
              `Look at the ${item.service} error`
            )
          }
        >
          <Icon name="comment" /> Ask Claude
        </button>
      </div>
      <pre className="service-error-text">{item.text}</pre>
    </div>
  )
}
