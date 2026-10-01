import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { DecisionKind } from '../../../shared/events'
import { DecisionCard } from '../session-ui/Timeline'
import { Empty, PanelHeader, Segmented } from '../components/ui'

type Filter = 'all' | DecisionKind

export function DecisionsPanel() {
  const { s } = useSession()
  const [filter, setFilter] = useState<Filter>('all')
  const count = (k: DecisionKind) => s.decisions.filter((d) => d.kind === k).length
  // Newest at the top. Open questions are also asked in the box under the conversation.
  const list = s.decisions.filter((d) => filter === 'all' || d.kind === filter).sort((a, b) => b.at - a.at)

  return (
    <div className="panel">
      <PanelHeader title="Decisions" />
      {s.decisions.length > 0 && (
        <div className="panel-toolbar">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${s.decisions.length}` },
              { value: 'question', label: `Questions ${count('question')}` },
              { value: 'assumption', label: `Assumptions ${count('assumption')}` },
              { value: 'decision', label: `Decisions ${count('decision')}` }
            ]}
          />
        </div>
      )}
      <div className="panel-scroll decisions-list">
        {list.length === 0 ? (
          <Empty title={s.decisions.length ? 'Nothing in this filter.' : 'No decisions yet.'}>Claude's choices, assumptions and questions appear here as it makes them.</Empty>
        ) : (
          list.map((d) => <DecisionCard key={d.id} d={d} />)
        )}
      </div>
    </div>
  )
}
