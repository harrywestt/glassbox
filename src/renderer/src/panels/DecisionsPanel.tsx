import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { DecisionKind } from '../../../shared/events'
import { DecisionCard } from '../session-ui/Timeline'
import { Empty, PanelHeader, Section, Segmented } from '../components/ui'
import { CriteriaList } from '../session-ui/Signals'
import { Findings } from './ReviewPanel'
import { RadarCard } from '../session-ui/RadarCard'
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
              { value: 'all', label: tr('decisionsPanel.filterAll'), count: s.decisions.length },
              { value: 'question', label: tr('decisionsPanel.filterQuestions'), count: count('question') },
              { value: 'assumption', label: tr('decisionsPanel.filterAssumptions'), count: count('assumption') },
              { value: 'decision', label: tr('decisionsPanel.filterDecisions'), count: count('decision') }
            ]}
          />
        </div>
      )}
      <div className="panel-scroll decisions-list">
        {/* What to review: the acceptance criteria and what a review found, then Claude's decisions. */}
        <CriteriaList />
        <Findings />
        <RadarCard />
        {list.length === 0 ? (
          <Empty title={s.decisions.length ? tr('decisionsPanel.nothingInFilter') : tr('decisionsPanel.emptyTitle')}>{tr('decisionsPanel.emptyBody')}</Empty>
        ) : s.findings.length || s.criteria?.list.length ? (
          <Section id="decisions-list" title={tr('decisionsPanel.title')} meta={<span className="count">{list.length}</span>}>
            {list.map((d) => <DecisionCard key={d.id} d={d} />)}
          </Section>
        ) : (
          list.map((d) => <DecisionCard key={d.id} d={d} />)
        )}
      </div>
    </div>
  )
}
