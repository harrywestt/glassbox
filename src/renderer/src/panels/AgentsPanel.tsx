import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import type { AgentNode } from '../session'
import { renderMarkdown } from '../lib'
import { Empty, Icon, PanelHeader } from '../components/ui'

/** How long a finished agent stays in the list. */
const DONE_SHOWN_MS = 2 * 60_000

export function AgentsPanel() {
  const { s, filter, setFilter } = useSession()
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
        <span className="muted small">{node.toolCalls} tools</span>
      </div>
      {filter === node.id && (
        <div className="agent-detail">
          <div className="label">Brief</div>
          <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.prompt) }} />
          {node.result && (
            <>
              <div className="label">Report</div>
              <div className="markdown small" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.result) }} />
            </>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="panel">
      <PanelHeader title="Agents">{running > 0 && <span className="pill pill-accent">{running} running</span>}</PanelHeader>
      <div className="panel-scroll flush">
        <div className={filter === 'main' ? 'agent-row selected' : 'agent-row'} onClick={() => setFilter(filter === 'main' ? 'all' : 'main')}>
          <span className={`dot dot-${s.status === 'running' ? 'running' : 'done'}`} />
          <span className="agent-type">main</span>
          <span className="grow ellipsis muted">{s.model ?? 'session'}</span>
          <span className="muted small">{mainTools} tools</span>
        </div>
        {/* Agents that finished more than two minutes ago drop off the list (they stay in the conversation). */}
        {agents
          .filter((a) => showDone || a.status === 'running' || !a.endedAt || now - a.endedAt < DONE_SHOWN_MS)
          .sort((a, b) => a.at - b.at)
          .map((a) => render(a, 1))}
        {finished > 0 && (
          <button className="link small agents-more" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide finished agents' : `Show ${finished} finished agent${finished === 1 ? '' : 's'}`}
          </button>
        )}
        {agents.length === 0 && (
          <Empty icon="organization" title="No subagents yet">
            When Claude delegates work, each agent appears here. Select one to read its brief and report, and filter the chat to what it did.
          </Empty>
        )}
      </div>
    </div>
  )
}
