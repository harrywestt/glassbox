import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { HIDDEN_TOOLS, taskOf, toolSummary, type ToolCall } from '../session'
import { baseName, relPath, renderMarkdown } from '../lib'
import { Empty, Icon, PanelHeader, Section } from '../components/ui'
import { CommentBox } from '../components/CommentBox'
import { SideTasks } from '../session-ui/SideTasks'
import { toolIcon } from '../session-ui/Timeline'
import { describeTool } from '../session-ui/describe'
import { TestsSummary } from '../session-ui/TestSignals'
import { tr } from '../../../shared/i18n'

const shortSummary = (c: ToolCall) => {
  const p = c.input.file_path ?? c.input.notebook_path
  return typeof p === 'string' ? baseName(p) : toolSummary(c)
}

export function ActivityPanel() {
  const { tab, s, showPanel, setFilter, openFile, actions, openPlan, filter } = useSession()
  // Tasks follow the conversation picker: the agent you're looking at shows its own list; "everything"
  // shows Claude's list and then each agent's, under its name.
  const viewing = filter !== 'all' && filter !== 'main' ? filter : undefined
  const task = taskOf(s, viewing)
  const agentLists =
    filter === 'all'
      ? Object.keys(s.agentTodos ?? {})
          .filter((id) => s.agentTodos![id].length && s.agents[id])
          .map((id) => ({ id, agent: s.agents[id], task: taskOf(s, id)! }))
      : []
  const agentName = (id: string) => {
    const a = s.agents[id]
    return a ? (a.type ? tr('activityPanel.agentNamed', { type: a.type[0].toUpperCase() + a.type.slice(1), description: a.description }) : tr('activityPanel.agentUnnamed', { description: a.description })) : tr('activityPanel.thisAgent')
  }
  const [commentOn, setCommentOn] = useState<string | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Glassbox's own tools show up as the task, decisions and checklist, not as activity.
  const calls = Object.values(s.toolCalls).filter((c) => !c.name.startsWith('mcp__glassbox__') && !HIDDEN_TOOLS.has(c.name))
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
      <PanelHeader title={tr('activityPanel.title')} />
      <div className="panel-scroll">
        {s.alerts.map((a) => (
          <div key={a.at} className="callout callout-warn">
            <Icon name="warning" />
            <span className="grow">{a.text}</span>
            <button className="icon-btn" title={tr('activityPanel.dismiss')} onClick={() => actions.dismissAlert(tab.id, a.at)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        {waitingOnYou.map((c) => (
          <div key={c.id} className="callout callout-warn">
            <Icon name="debug-pause" /> {tr('activityPanel.pausedWaiting', { about: c.about })}
          </div>
        ))}
        {s.permissions.length > 0 && (
          <div className="callout callout-warn">
            <Icon name="bell-dot" /> {tr('activityPanel.permissionsWaiting', { count: s.permissions.length })}
          </div>
        )}

        {/* Sections with nothing in them aren't shown; each can be folded away. */}
        {(task || agentLists.length > 0) && (
          <Section id="task" title={tr('activityPanel.tasks')} meta={task?.steps?.length ? <span className="muted small">{tr('activityPanel.stepsDone', { done: task.steps.filter((x) => x.status === 'done').length, total: task.steps.length })}</span> : undefined}>
            <>
              {viewing && <div className="task-owner small muted">{agentName(viewing)}</div>}
              {task && <div className="task-summary">{task.summary}</div>}
              {!task && <div className="muted small">{tr('activityPanel.noList')}</div>}
              {task?.steps?.map((step, i) => (
                <div key={i}>
                  <div className={`step step-${step.status}`}>
                    <Icon name={step.status === 'done' ? 'pass-filled' : step.status === 'active' ? 'circle-large-filled' : 'circle-large-outline'} />
                    <span className="grow">{step.label}</span>
                    <button className="icon-btn hover-action" title={tr('activityPanel.commentOnStep')} onClick={() => setCommentOn(step.label)}>
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
              {agentLists.map(({ id, agent, task: t }) => (
                <div key={id} className="task-agent">
                  <button className="task-owner link small" onClick={() => setFilter(id)} title={tr('activityPanel.showOnlyAgent')}>
                    {agentName(id)}
                    <span className="muted"> {tr(agent.status !== 'running' ? 'activityPanel.stepsDoneFinished' : 'activityPanel.stepsDone', { done: t.steps?.filter((x) => x.status === 'done').length ?? 0, total: t.steps?.length ?? 0 })}</span>
                  </button>
                  {t.steps?.map((step, i) => (
                    <div key={i} className={`step step-${step.status}`}>
                      <Icon name={step.status === 'done' ? 'pass-filled' : step.status === 'active' ? 'circle-large-filled' : 'circle-large-outline'} />
                      <span className="grow">{step.label}</span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          </Section>
        )}

        {s.plan && (
          <Section
            id="plan"
            title={tr('activityPanel.plan')}
            meta={<span className={`tag ${s.plan.status === 'approved' ? 'accent' : ''}`}>{s.plan.status === 'approved' ? tr('activityPanel.planApproved') : s.plan.status === 'proposed' ? tr('activityPanel.planProposed') : tr('activityPanel.planChangesRequested')}</span>}
            actions={
              <>
                <button className="link small" onClick={() => setShowPlan(!showPlan)}>{showPlan ? tr('activityPanel.hideText') : tr('activityPanel.showText')}</button>
                <button className="link small" onClick={() => openPlan()}>{tr('activityPanel.open')}</button>
              </>
            }
          >
            {showPlan && <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.plan.text) }} />}
            {commentOn === ':plan' ? (
              <CommentBox target={{ kind: 'plan' }} onDone={() => setCommentOn(null)} />
            ) : (
              <button className="chip-btn" onClick={() => setCommentOn(':plan')}>
                <Icon name="comment" /> {tr('activityPanel.commentOnPlan')}
              </button>
            )}
          </Section>
        )}

        <TestsNow />

        {running.length + agents.length > 0 && <Section id="running" title={tr('activityPanel.running')} meta={<span className="count">{running.length + agents.length}</span>}>
          {agents.map((a) => (
            <div key={a.id} className="list-row clickable" onClick={() => (setFilter(a.id), showPanel('agents'))}>
              <Icon name="organization" className="accent" />
              <span className="grow ellipsis">
                <strong>{a.type}</strong> {a.description}
              </span>
              <span className="muted small">{tr('activityPanel.tools', { n: a.toolCalls })}</span>
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
          <Section id="recent" title={tr('activityPanel.recentActivity')}>
            {recent.map((c) => (
              <div key={c.id} className="list-row" title={toolSummary(c)}>
                <Icon name={c.status === 'error' ? 'error' : toolIcon(c.name)} className={c.status === 'error' ? 'err' : ''} />
                <span className="grow ellipsis">
                  {describeTool(c)}
                </span>
                <span className="activity-time muted small" title={c.endedAt ? tr('activityPanel.startedTook', { time: new Date(c.at).toLocaleString(), duration: took(c.endedAt - c.at) }) : tr('activityPanel.started', { time: new Date(c.at).toLocaleString() })}>
                  <span className="num">{clock(c.at)}</span>
                  {!c.endedAt && c.status === 'running' && <span>{tr('activityPanel.runningStatus')}</span>}
                </span>
              </div>
            ))}
          </Section>
        )}
        {!task && !agentLists.length && !s.plan && !recent.length && !running.length && !agents.length && !s.alerts.length && !waitingOnYou.length && !s.permissions.length && (
          <Empty icon="pulse" title={s.status === 'running' ? tr('activityPanel.starting') : tr('activityPanel.nothingYet')}>
            {tr('activityPanel.emptyBody')}
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
    <Section id="tests" title={tr('activityPanel.tests')}>
      <TestsSummary compact />
    </Section>
  )
}
