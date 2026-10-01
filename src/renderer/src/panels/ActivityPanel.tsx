import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { toolSummary, type ToolCall } from '../session'
import { baseName, relPath, renderMarkdown } from '../lib'
import { Empty, Icon, PanelHeader, Section } from '../components/ui'
import { CommentBox } from '../components/CommentBox'
import { SideTasks } from '../session-ui/SideTasks'
import { toolIcon } from '../session-ui/Timeline'
import { describeTool } from '../session-ui/describe'
import { TestsSummary } from '../session-ui/TestSignals'

const shortSummary = (c: ToolCall) => {
  const p = c.input.file_path ?? c.input.notebook_path
  return typeof p === 'string' ? baseName(p) : toolSummary(c)
}

export function ActivityPanel() {
  const { tab, s, showPanel, setFilter, openFile, actions, openPlan } = useSession()
  const [commentOn, setCommentOn] = useState<string | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Glassbox's own tools show up as the task, decisions and checklist, not as activity.
  const calls = Object.values(s.toolCalls).filter((c) => !c.name.startsWith('mcp__glassbox__'))
  const waitingOnYou = s.checkins.filter((c) => c.answer === undefined)
  const running = calls.filter((c) => c.status === 'running' && !s.agents[c.id])
  const agents = Object.values(s.agents).filter((a) => a.status === 'running')
  const recent = calls.filter((c) => c.status !== 'running').sort((a, b) => (b.endedAt ?? b.at) - (a.endedAt ?? a.at)).slice(0, 12)
  const secs = (t: number) => {
    const v = Math.max(0, Math.round((now - t) / 1000))
    return v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`
  }

  return (
    <div className="panel">
      <PanelHeader title="Now" />
      <div className="panel-scroll">
        {s.alerts.map((a) => (
          <div key={a.at} className="callout callout-warn">
            <Icon name="warning" />
            <span className="grow">{a.text}</span>
            <button className="icon-btn" title="Dismiss" onClick={() => actions.dismissAlert(tab.id, a.at)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        {waitingOnYou.map((c) => (
          <div key={c.id} className="callout callout-warn">
            <Icon name="debug-pause" /> Claude is paused, waiting for your answer: {c.about}
          </div>
        ))}
        {s.permissions.length > 0 && (
          <div className="callout callout-warn">
            <Icon name="bell-dot" /> {s.permissions.length} tool call{s.permissions.length > 1 ? 's' : ''} waiting for your approval
          </div>
        )}

        {/* Sections with nothing in them aren't shown; each can be folded away. */}
        {s.task && (
          <Section id="task" title="Current task">
            <>
              <div className="task-summary">{s.task.summary}</div>
              {s.task.steps?.map((step, i) => (
                <div key={i}>
                  <div className={`step step-${step.status}`}>
                    <Icon name={step.status === 'done' ? 'pass-filled' : step.status === 'active' ? 'circle-large-filled' : 'circle-large-outline'} />
                    <span className="grow">{step.label}</span>
                    <button className="icon-btn hover-action" title="Comment on this step" onClick={() => setCommentOn(step.label)}>
                      <Icon name="comment" />
                    </button>
                  </div>
                  {step.files?.length ? (
                    <div className="step-files">
                      {step.files.map((f) => (
                        <button key={f} className="link small mono" onClick={() => openFile(f)}>{baseName(f)}</button>
                      ))}
                    </div>
                  ) : null}
                  {commentOn === step.label && <CommentBox target={{ kind: 'step', label: step.label }} onDone={() => setCommentOn(null)} />}
                </div>
              ))}
            </>
          </Section>
        )}

        {s.plan && (
          <Section
            id="plan"
            title="Plan"
            meta={<span className={`tag ${s.plan.status === 'approved' ? 'accent' : ''}`}>{s.plan.status === 'approved' ? 'approved' : s.plan.status === 'proposed' ? 'waiting for you' : 'changes requested'}</span>}
            actions={
              <>
                <button className="link small" onClick={() => setShowPlan(!showPlan)}>{showPlan ? 'Hide the text' : 'Show the text'}</button>
                <button className="link small" onClick={() => openPlan()}>Open</button>
              </>
            }
          >
            {showPlan && <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.plan.text) }} />}
            {commentOn === ':plan' ? (
              <CommentBox target={{ kind: 'plan' }} onDone={() => setCommentOn(null)} />
            ) : (
              <button className="chip-btn" onClick={() => setCommentOn(':plan')}>
                <Icon name="comment" /> Comment on the plan
              </button>
            )}
          </Section>
        )}

        <TestsNow />

        {running.length + agents.length > 0 && <Section id="running" title="Running" meta={<span className="count">{running.length + agents.length}</span>}>
          {agents.map((a) => (
            <div key={a.id} className="list-row clickable" onClick={() => (setFilter(a.id), showPanel('agents'))}>
              <Icon name="organization" className="accent" />
              <span className="grow ellipsis">
                <strong>{a.type}</strong> {a.description}
              </span>
              <span className="muted small">{a.toolCalls} tools</span>
              <span className="muted small num">{secs(a.at)}</span>
            </div>
          ))}
          {running.map((c) => (
            <div key={c.id} className="list-row">
              <Icon name="loading" className="codicon-modifier-spin accent" />
              <Icon name={toolIcon(c.name)} />
              <span className="grow ellipsis">
                {describeTool(c)}
              </span>
              <span className="muted small">{secs(c.at)}</span>
            </div>
          ))}
        </Section>}

        <SideTasks />


        {recent.length > 0 && (
          <Section id="recent" title="Recent activity">
            {recent.map((c) => (
              <div key={c.id} className="list-row" title={toolSummary(c)}>
                <Icon name={c.status === 'error' ? 'error' : toolIcon(c.name)} className={c.status === 'error' ? 'err' : ''} />
                <span className="grow ellipsis">
                  {describeTool(c)}
                </span>
                <span className="activity-time muted small" title={`Started ${new Date(c.at).toLocaleString()}${c.endedAt ? `, took ${took(c.endedAt - c.at)}` : ''}`}>
                  <span className="num">{clock(c.at)}</span>
                  {!c.endedAt && c.status === 'running' && <span>running</span>}
                </span>
              </div>
            ))}
          </Section>
        )}
        {!s.task && !s.plan && !recent.length && !running.length && !agents.length && !s.alerts.length && !waitingOnYou.length && !s.permissions.length && (
          <Empty icon="pulse" title={s.status === 'running' ? 'Claude is starting' : 'Nothing happening yet'}>
            The task, what’s running and recent tool calls show up here once Claude starts.
          </Empty>
        )}
      </div>
    </div>
  )
}


/** Time of day for an activity row, e.g. 16:43:57. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** How long something took: 0.4s, 12s, 3m 05s. */
function took(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Test status while Claude works; hidden until the first test run. */
function TestsNow() {
  const { s, everyday } = useSession()
  if (everyday) return null
  const any = Object.values(s.toolCalls).some((c) => (c.name === 'Bash' || c.name === 'PowerShell') && /test/i.test(String(c.input.command ?? '')))
  if (!any) return null
  return (
    <Section id="tests" title="Tests">
      <TestsSummary compact />
    </Section>
  )
}
