import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS, toolSummary, type TimelineItem } from '../session'
import { baseName, renderMarkdown } from '../lib'
import { targetLabel } from '../review'
import { DiffView } from '../components/Code'
import { Empty, Icon, IconButton, PanelHeader } from '../components/ui'
import { describeTool } from '../session-ui/describe'

const SKIP = new Set<TimelineItem['kind']>(['note', 'result'])

/** Step through the session event by event, with what was true at each point. */
export function ReplayPanel() {
  const { s } = useSession()
  const events = useMemo(() => s.timeline.filter((i) => !SKIP.has(i.kind)), [s.timeline])
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (follow) setPos(Math.max(0, events.length - 1))
  }, [events.length, follow])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setPos((p) => (p + 1 < events.length ? p + 1 : (setPlaying(false), p))), 900)
    return () => clearInterval(t)
  }, [playing, events.length])

  if (!events.length) return <div className="panel"><PanelHeader title="Replay" /><Empty icon="history" title="Nothing to replay yet" /></div>

  const item = events[Math.min(pos, events.length - 1)]
  const at = item.at
  const start = Math.min(...events.map((e) => e.at))
  const upTo = s.timeline.filter((i) => i.at <= at)
  const toolIds = new Set(upTo.filter((i) => i.kind === 'tool').map((i) => (i as { toolId: string }).toolId))
  const edited = [...new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && f.at <= at).map((f) => f.path))]
  const decisions = s.decisions.filter((d) => d.at <= at)
  const task = Object.values(s.toolCalls)
    .filter((c) => c.name === 'mcp__glassbox__set_current_task' && c.at <= at)
    .sort((a, b) => b.at - a.at)[0]

  const step = (d: number) => {
    setFollow(false)
    setPlaying(false)
    setPos((p) => Math.min(events.length - 1, Math.max(0, p + d)))
  }

  return (
    <div className="panel">
      <PanelHeader title="Replay">
        <span className="muted small">{pos + 1} of {events.length}</span>
      </PanelHeader>
      <div className="replay-controls">
        <IconButton icon="debug-step-back" title="Previous" onClick={() => step(-1)} />
        <IconButton icon={playing ? 'debug-pause' : 'play'} title={playing ? 'Pause' : 'Play from here'} onClick={() => (setFollow(false), setPlaying(!playing))} />
        <IconButton icon="debug-step-over" title="Next" onClick={() => step(1)} />
        <input
          className="scrubber grow"
          type="range"
          min={0}
          max={events.length - 1}
          value={pos}
          onChange={(e) => (setFollow(false), setPlaying(false), setPos(Number(e.target.value)))}
        />
        <button className={follow ? 'chip-btn on' : 'chip-btn'} onClick={() => setFollow(!follow)} title="Stay on the latest event">
          Live
        </button>
      </div>
      <div className="panel-scroll">
        <section className="card">
          <div className="card-title">
            {describe(item, s)}
            <span className="spacer" />
            <span className="muted small num" title={new Date(at).toLocaleString()}>{elapsed(at - start)} in</span>
          </div>
          <ReplayItem item={item} />
        </section>
        <section className="card">
          <div className="card-title">At this point</div>
          <div className="replay-state small">
            <div><span className="muted">Task</span> {task ? String(task.input.summary ?? '') : 'not set yet'}</div>
            <div><span className="muted">Tool calls</span> {toolIds.size}</div>
            <div>
              <span className="muted">Files edited</span> {edited.length ? edited.map((p) => baseName(p)).join(', ') : 'none yet'}
            </div>
            <div><span className="muted">Decisions logged</span> {decisions.length}</div>
          </div>
        </section>
      </div>
    </div>
  )
}

function describe(item: TimelineItem, s: ReturnType<typeof useSession>['s']): string {
  switch (item.kind) {
    case 'user':
      return 'You asked'
    case 'comment':
      return `You commented on ${targetLabel(item.target)}`
    case 'text':
      return 'Claude said'
    case 'thinking':
      return 'Claude thought'
    case 'tool': {
      const c = s.toolCalls[item.toolId]
      return c ? describeTool(c) : 'Tool call'
    }
    case 'decision':
      return 'Claude logged'
    case 'guard':
      return 'Guardrail'
    case 'finding':
      return 'Finding'
    case 'checkin':
      return 'Claude checked in'
    default:
      return 'Event'
  }
}

function ReplayItem({ item }: { item: TimelineItem }) {
  const { s } = useSession()
  switch (item.kind) {
    case 'user':
    case 'comment':
      return <div className="msg user replay-msg">{item.text}</div>
    case 'text':
    case 'thinking':
      return <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
    case 'decision': {
      const d = s.decisions.find((x) => x.id === item.id)
      return d ? <div className="small"><strong>{d.kind}</strong>: {d.title}{d.detail && <p className="muted">{d.detail}</p>}</div> : null
    }
    case 'guard':
      return <div className="small">{item.hit.action === 'block' ? 'Blocked' : 'Asked'}: {item.hit.label}<div className="mono muted">{item.hit.detail}</div></div>
    case 'finding': {
      const f = s.findings.find((x) => x.id === item.id)
      return f ? <div className="small"><strong>{f.severity}</strong>: {f.title}</div> : null
    }
    case 'checkin': {
      const c = s.checkins.find((x) => x.id === item.id)
      return c ? <div className="small">{c.about}<div className="muted">Answer: {c.answer ?? 'waiting'}</div></div> : null
    }
    case 'tool': {
      const c = s.toolCalls[item.toolId]
      if (!c) return null
      const path = String(c.input.file_path ?? '')
      if (c.name === 'Edit') return <div className="replay-diff"><DiffView path={path} original={String(c.input.old_string ?? '')} modified={String(c.input.new_string ?? '')} inline /></div>
      if (c.name === 'Write') return <div className="replay-diff"><DiffView path={path} original="" modified={String(c.input.content ?? '')} inline /></div>
      return (
        <div className="small">
          <div className="mono ellipsis" title={toolSummary(c)}>{toolSummary(c)}</div>
          {c.result && <pre className="replay-result">{c.result.slice(0, 1500)}</pre>}
          {c.status === 'error' && <div className="err"><Icon name="error" /> Failed</div>}
        </div>
      )
    }
    default:
      return null
  }
}

/** Time since the session started, e.g. "0:42" or "12:05". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
