import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, Section } from '../components/ui'
import { FindingCard } from '../session-ui/Signals'
import { READ_TOOLS, SHELL_TOOLS } from '../side'
import type { ReviewModel } from '../../../shared/events'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

/** What a review of Claude's edits found, with the button that runs one. Shown in Decisions. */
const REVIEW_MODEL_KEY = 'glassbox.reviewModel'
const REVIEW_MODELS: { value: ReviewModel; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' }
]
function loadReviewModel(): ReviewModel {
  try {
    const m = localStorage.getItem(REVIEW_MODEL_KEY)
    if (m === 'sonnet' || m === 'opus') return m
  } catch {
    /* default */
  }
  return 'haiku'
}

export function Findings() {
  const { tab, s, runSide } = useSession()
  const open = s.findings.filter((f) => f.status !== 'dismissed')
  const canSend = s.status === 'ready' || s.status === 'running'
  const r = s.reviewer
  const [model, setModel] = useState<ReviewModel>(loadReviewModel)
  const pickModel = (m: ReviewModel) => {
    setModel(m)
    try {
      localStorage.setItem(REVIEW_MODEL_KEY, m)
    } catch {
      /* not saved; fine */
    }
  }
  // Nothing to show until there are edits to review or something was found.
  if (!open.length && !r.pending && !r.busy && !r.error && !r.reviewedEdits) return null
  return (
    <Section id="findings" title={tr('reviewPanel.findings')} meta={open.length > 0 && <span className="count">{open.length}</span>} actions={r.reviewedEdits > 0 && <span className="small muted">{tr('reviewPanel.editsReviewed', { n: r.reviewedEdits })}</span>}>
      <div className="review-run">
        <Select<ReviewModel> value={model} onChange={pickModel} aria-label={tr('reviewPanel.reviewModel')} title={tr('reviewPanel.reviewModelTitle')} options={REVIEW_MODELS} />
        <button
          className="primary"
          disabled={r.busy || r.pending === 0}
          onClick={() => void window.glassbox.session.review(tab.id, model)}
          title={r.pending ? tr('reviewPanel.reviewTitle', { count: r.pending }) : tr('reviewPanel.noNewEdits')}
        >
          {r.busy ? <><Icon name="loading" className="codicon-modifier-spin" /> {tr('reviewPanel.reviewing')}</> : <><Icon name="checklist" /> {r.pending ? tr('reviewPanel.reviewNewEdits', { count: r.pending }) : tr('reviewPanel.reviewEdits')}</>}
        </button>
      </div>
      {r.error && <div className="note note-error">{r.error}</div>}
      {open.length === 0 ? (
        <div className="muted small">{r.reviewedEdits ? tr('reviewPanel.nothingFlagged') : tr('reviewPanel.notReviewed')}</div>
      ) : (
        <div className="findings">{[...open].reverse().map((f) => <FindingCard key={f.id} f={f} />)}</div>
      )}
      {tab.kind === 'review' && s.findings.some((f) => f.source === 'claude') && (
        <div className="row-actions">
          <button
            className="chip-btn"
            disabled={!canSend}
            onClick={() =>
              runSide({
                kind: 'review',
                title: tr('reviewPanel.draftReview'),
                tools: [...READ_TOOLS, ...SHELL_TOOLS],
                prompt: `Draft a GitHub review for ${tab.title.replace(/^Review /, 'PR ')} from these findings: a short summary, then each finding as an inline comment on its file and line. Return the draft as your final message. Don't post anything.\n\n${open
                  .filter((f) => f.source === 'claude')
                  .map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.detail ? `: ${f.detail}` : ''}${f.suggestion ? ` Suggestion: ${f.suggestion}` : ''}`)
                  .join('\n')}`
              })
            }
          >
            <Icon name="github" /> {tr('reviewPanel.draftReview')}
          </button>
        </div>
      )}
    </Section>
  )
}
