import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { renderMarkdown } from '../lib'
import { money, useFx } from '../money'
import { Icon, Section } from '../components/ui'
import type { SideTask } from '../../../shared/events'
import type { ToolCall } from '../session'
import { describeTool } from './describe'
import { toolIcon } from './Timeline'
import { tr } from '../../../shared/i18n'

const ICON: Record<SideTask['kind'], string> = {
  diagram: 'type-hierarchy-sub',
  showcase: 'preview',
  services: 'run-all',
  checks: 'beaker',
  review: 'git-pull-request',
  status: 'broadcast'
}

/** Background runs started from the side panels, which never block the main session. */
export function SideTasks() {
  const { tab, s } = useSession()
  const fx = useFx()
  const [open, setOpen] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const tasks = Object.values(s.sideTasks).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
  const running = tasks.some((t) => t.status === 'running')

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  if (!tasks.length) return null
  return (
    <Section id="side-tasks" title={tr('sideTasks.title')} meta={<span className="muted small">{tr('sideTasks.meta')}</span>}>
      {tasks.slice(0, 8).map((t) => {
        const secs = Math.round(((t.endedAt ?? now) - t.startedAt) / 1000)
        const cost = t.costUsd != null ? money(t.costUsd, 'USD', fx) : null
        return (
          <div key={t.id} className="side-task">
            <div className="list-row clickable" onClick={() => setOpen(open === t.id ? null : t.id)}>
              {t.status === 'running' ? (
                <Icon name="loading" className="codicon-modifier-spin accent" />
              ) : (
                <Icon name={t.status === 'done' ? 'pass' : t.status === 'stopped' ? 'circle-slash' : 'error'} className={t.status === 'done' ? 'ok' : t.status === 'stopped' ? 'muted' : 'err'} />
              )}
              <Icon name={ICON[t.kind]} />
              <span className="grow ellipsis">
                {t.title}
                <span className="muted small"> {t.status === 'running' ? t.activity ?? tr('sideTasks.starting') : t.status === 'failed' ? tr('sideTasks.failed') : t.status === 'stopped' ? tr('sideTasks.stopped') : ''}</span>
              </span>
              <span className="muted small num">{secs >= 60 ? tr('sideTasks.minutesSeconds', { m: Math.floor(secs / 60), s: secs % 60 }) : tr('sideTasks.seconds', { s: secs })}</span>
              {cost && <span className="muted small" title={cost.title}>{cost.text}</span>}
              {t.status === 'running' && (
                <button className="icon-btn" title={tr('sideTasks.stop')} onClick={(e) => (e.stopPropagation(), void window.glassbox.session.stopSide(tab.id, t.id))}>
                  <Icon name="debug-stop" />
                </button>
              )}
            </div>
            {open === t.id && <SideTaskSteps task={t} />}
          </div>
        )
      })}
    </Section>
  )
}

/** A side task's progress, live: each tool it ran in plain English, notes from its replies, then its result. */
export function SideTaskSteps({ task }: { task: SideTask }) {
  const list = useRef<HTMLDivElement>(null)
  // The final reply is shown as the result, so don't repeat it as a note.
  const all = task.steps ?? []
  const last = all.at(-1)
  const steps = task.result && last?.text && task.result.trim().startsWith(last.text.slice(0, 60)) ? all.slice(0, -1) : all
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length, task.status])
  return (
    <div className="side-steps" ref={list}>
      {steps.length === 0 && task.status === 'running' && <div className="muted small side-step">{tr('sideTasks.starting')}</div>}
      {steps.map((st, i) =>
        st.tool ? (
          <div key={i} className="side-step">
            <Icon name={toolIcon(st.tool)} className="muted" />
            <span className="grow ellipsis">{describeTool({ id: String(i), name: st.tool, input: st.input ?? {}, status: 'done', at: st.at } as ToolCall)}</span>
            <span className="muted small num">{new Date(st.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
          </div>
        ) : (
          <div key={i} className="side-step note-step small">{st.text}</div>
        )
      )}
      {task.status === 'running' && steps.length > 0 && (
        <div className="side-step muted small">
          <Icon name="loading" className="codicon-modifier-spin" /> {tr('sideTasks.working')}
        </div>
      )}
      {task.result && <div className="markdown small side-result" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.result) }} />}
    </div>
  )
}
