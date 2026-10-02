import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { DecisionKind } from '../../../shared/events'
import { DecisionCard } from '../session-ui/Timeline'
import { Empty, PanelHeader, Segmented } from '../components/ui'
import { tr } from '../../../shared/i18n'

type Filter = 'all' | DecisionKind

export function DecisionsPanel() {
  const { s } = useSession()
  const [filter, setFilter] = useState<Filter>('all')
  const count = (k: DecisionKind) => s.decisions.filter((d) => d.kind === k).length
  // Newest at the top. Open questions are also asked in the box under the conversation.
  const list = s.decisions.filter((d) => filter === 'all' || d.kind === filter).sort((a, b) => b.at - a.at)

  return (
    <div className="panel">
      <PanelHeader title={tr('decisionsPanel.title')} />
      {s.decisions.length > 0 && (
        <div className="panel-toolbar">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: tr('decisionsPanel.filterAll', { n: s.decisions.length }) },
              { value: 'question', label: tr('decisionsPanel.filterQuestions', { n: count('question') }) },
              { value: 'assumption', label: tr('decisionsPanel.filterAssumptions', { n: count('assumption') }) },
              { value: 'decision', label: tr('decisionsPanel.filterDecisions', { n: count('decision') }) }
            ]}
          />
        </div>
      )}
      <div className="panel-scroll decisions-list">
        {list.length === 0 ? (
          <Empty title={s.decisions.length ? tr('decisionsPanel.nothingInFilter') : tr('decisionsPanel.emptyTitle')}>{tr('decisionsPanel.emptyBody')}</Empty>
        ) : (
          list.map((d) => <DecisionCard key={d.id} d={d} />)
        )}
      </div>
    </div>
  )
}
