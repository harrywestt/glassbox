import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { withoutHandback, type AgentNode } from '../session'
import { renderMarkdown } from '../lib'
import { Empty, Icon, PanelHeader } from '../components/ui'
import { tr } from '../../../shared/i18n'

/** How long a finished agent stays in the list. */
const DONE_SHOWN_MS = 2 * 60_000

export function AgentsPanel() {
  const { tab, s, filter, setFilter } = useSession()
  const agents = Object.values(s.agents)
  const mainTools = Object.values(s.toolCalls).filter((t) => t.agentId === null).length
  const running = agents.filter((a) => a.status === 'running').length
  // Finished agents stay listed for a couple of minutes, then make way for the ones still working.
  const [showDone, setShowDone] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const finished = agents.filter((a) => a.status !== 'running' && a.endedAt && now - a.endedAt >= DONE_SHOWN_MS).length

  const render = (node: AgentNode, depth: number) => (
    <div key={node.id}>
      <div
        className={filter === node.id ? 'agent-row selected' : 'agent-row'}

        onClick={() => setFilter(filter === node.id ? 'main' : node.id)}
      >
        <span className={`dot dot-${node.status}`} />
        <span className="agent-type">{node.type}</span>
        <span className="grow ellipsis">{node.description}</span>
        <span className="muted small">{node.stopped ? tr('agentsPanel.stopped') : tr('agentsPanel.tools', { n: node.toolCalls })}</span>
        {node.status === 'running' && node.taskId && (
          <button
            className="icon-btn"
            title={tr('agentsPanel.stopAgentTitle')}
            aria-label={tr('agentsPanel.stopAgent')}
            onClick={(e) => (e.stopPropagation(), void window.glassbox.session.stopTask(tab.id, node.taskId!))}
          >
            <Icon name="debug-stop" />
          </button>
        )}
      </div>
      {filter === node.id && (
        <div className="agent-detail">
          <div className="label">{tr('agentsPanel.brief')}</div>
          <div className="small agent-brief-text">{node.prompt}</div>
          {node.result && (
            <>
              <div className="label">{tr('agentsPanel.report')}</div>
              <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(withoutHandback(node.result)) }} />
            </>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="panel">
      <PanelHeader title={tr('agentsPanel.title')}>{running > 0 && <span className="pill pill-accent">{tr('agentsPanel.runningCount', { n: running })}</span>}</PanelHeader>
      <div className="panel-scroll flush">
        <div className={filter === 'main' ? 'agent-row selected' : 'agent-row'} onClick={() => setFilter(filter === 'main' ? 'all' : 'main')}>
          <span className={`dot dot-${s.status === 'running' ? 'running' : 'done'}`} />
          <span className="agent-type">{tr('agentsPanel.main')}</span>
          <span className="grow ellipsis muted">{s.model ?? tr('agentsPanel.session')}</span>
          <span className="muted small">{tr('agentsPanel.tools', { n: mainTools })}</span>
        </div>
        {/* Agents that finished more than two minutes ago drop off the list (they stay in the conversation). */}
        {agents
          .filter((a) => showDone || a.status === 'running' || !a.endedAt || now - a.endedAt < DONE_SHOWN_MS)
          .sort((a, b) => a.at - b.at)
          .map((a) => render(a, 1))}
        {finished > 0 && (
          <button className="link small agents-more" onClick={() => setShowDone((v) => !v)}>
            {showDone ? tr('agentsPanel.hideFinished') : tr('agentsPanel.showFinished', { count: finished })}
          </button>
        )}
        {agents.length === 0 && (
          <Empty icon="organization" title={tr('agentsPanel.emptyTitle')}>
            {tr('agentsPanel.emptyBody')}
          </Empty>
        )}
      </div>
    </div>
  )
}
