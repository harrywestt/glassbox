import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { SessionState } from '../session'
import type { CriterionStatus, FindingSeverity } from '../../../shared/events'
import { baseName, mediaUrl } from '../lib'
import { Icon, Section } from '../components/ui'
import { tr } from '../../../shared/i18n'

type FindingEntry = SessionState['findings'][number]

const SEVERITY: Record<FindingSeverity, { cls: string }> = {
  blocker: { cls: 'sev-blocker' },
  major: { cls: 'sev-major' },
  minor: { cls: 'sev-minor' },
  nit: { cls: 'sev-nit' },
  question: { cls: 'sev-question' }
}

/** A review finding: from Claude in a review session, or from the background reviewer. */
const SOURCE = { claude: 'signals.sourceClaude', reviewer: 'signals.sourceReviewer', ux: 'signals.sourceUx' } as const

export function FindingCard({ f, compact }: { f: FindingEntry; compact?: boolean }) {
  const { tab, actions, openFile, openAttachment } = useSession()
  const [open, setOpen] = useState(!compact && f.severity !== 'nit')
  const sev = SEVERITY[f.severity]
  const where = f.file ? `${baseName(f.file)}${f.line ? `:${f.line}` : ''}` : null

  const raise = () => {
    const about = `${f.title}${f.file ? ` (${f.file}${f.line ? ` line ${f.line}` : ''})` : ''}`
    const text =
      f.source === 'ux'
        ? `The UX reviewer flagged this${f.page ? ` on ${f.page}` : ''}: ${f.title}.${f.detail ? ` ${f.detail}` : ''}${f.suggestion ? ` Suggested: ${f.suggestion}` : ''}${f.image ? ` Screenshot: ${f.image}` : ''} Look at it and say whether it's a real problem and what you'd change.`
        : f.source === 'reviewer'
          ? `A reviewer flagged this in your recent edits: ${about}.${f.detail ? ` ${f.detail}` : ''}${f.suggestion ? ` Suggested: ${f.suggestion}` : ''} Check whether it's a real problem; fix it if so, otherwise tell me why it's fine.`
          : `About your finding "${about}": fix it now.`
    void actions.comment(tab.id, { kind: 'message', excerpt: `Flag: ${f.title}` }, text)
    actions.findingStatus(tab.id, f.id, 'sent')
  }

  if (f.status === 'dismissed') return null
  return (
    <div className={`finding ${sev.cls}`}>
      <div className="finding-head" onClick={() => setOpen(!open)}>
        <span className="sev">{tr(`signals.severity.${f.severity}`)}</span>
        <span className="grow finding-title">{f.title}</span>
        {where && (
          <button className="link small mono" onClick={(e) => (e.stopPropagation(), openFile(f.file!))}>
            {where}
          </button>
        )}
        <span className="muted small">{tr(SOURCE[f.source] ?? 'signals.sourceClaude')}</span>
      </div>
      {open && (f.detail || f.suggestion || f.image) && (
        <div className="finding-body small">
          {f.image && (
            <button className="finding-shot" onClick={() => openAttachment(f.image!)} title={tr('signals.openScreenshot')}>
              <img src={mediaUrl(f.image)} alt={tr('signals.screenshotAlt', { title: f.title })} loading="lazy" />
            </button>
          )}
          {f.detail && <p>{f.detail}</p>}
          {f.suggestion && <p className="muted">{tr('signals.suggestion', { suggestion: f.suggestion })}</p>}
          {f.page && <p className="muted mono ellipsis" title={f.page}>{f.page}</p>}
        </div>
      )}
      <div className="finding-actions">
        {f.status === 'sent' ? (
          <span className="muted small"><Icon name="check" /> {tr('signals.sentToClaude')}</span>
        ) : (
          <button className="chip-btn" onClick={raise}>
            <Icon name="comment" /> {f.source === 'claude' ? tr('signals.askToFix') : tr('signals.askToCheck')}
          </button>
        )}
        <button className="chip-btn" onClick={() => actions.findingStatus(tab.id, f.id, 'dismissed')}>{tr('signals.dismiss')}</button>
      </div>
    </div>
  )
}

/**
 * What the UX reviewer found on one screenshot: the picture, and each finding as a row that opens
 * for the detail. Ask Claude about one, or about all of them at once.
 */
export function UxReviewCard({ image }: { image: string }) {
  const { tab, s, actions, openAttachment } = useSession()
  const [open, setOpen] = useState<string | null>(null)
  const list = s.findings.filter((f) => f.source === 'ux' && f.image === image && f.status !== 'dismissed')
  if (!list.length) return null
  const page = list.find((f) => f.page)?.page
  const line = (f: FindingEntry) => `- [${f.severity}] ${f.title}${f.detail ? `: ${f.detail}` : ''}${f.suggestion ? ` Suggested: ${f.suggestion}` : ''}`
  const ask = (items: FindingEntry[]) => {
    const text = `The UX reviewer looked at a screenshot${page ? ` of ${page}` : ''} (${image}) and flagged:\n${items.map(line).join('\n')}\nLook at the screenshot and say which are real problems and what you'd change.`
    void actions.comment(tab.id, { kind: 'message', excerpt: tr('signals.uxExcerpt', { count: items.length }) }, text)
    for (const f of items) actions.findingStatus(tab.id, f.id, 'sent')
  }
  const waiting = list.filter((f) => f.status === 'open')
  return (
    <div className="ux-review">
      <div className="ux-review-head">
        <button className="ux-review-shot" onClick={() => openAttachment(image)} title={tr('signals.openScreenshot')}>
          <img src={mediaUrl(image)} alt="" loading="lazy" />
        </button>
        <div className="ux-review-title">
          <strong>{tr('signals.uxTitle', { count: list.length })}</strong>
          {page && <span className="muted small mono ellipsis" title={page}>{page}</span>}
        </div>
        {waiting.length > 1 && (
          <button className="chip-btn" onClick={() => ask(waiting)}>
            <Icon name="comment" /> {tr('signals.askAll')}
          </button>
        )}
      </div>
      <ul className="ux-review-list">
        {list.map((f) => (
          <li key={f.id} className={`finding-row ${SEVERITY[f.severity].cls}`}>
            <button className="ux-review-row" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
              <span className="sev">{tr(`signals.severity.${f.severity}`)}</span>
              <span className="grow">{f.title}</span>
              <Icon name={open === f.id ? 'chevron-up' : 'chevron-down'} />
            </button>
            {open === f.id && (
              <div className="ux-review-detail small">
                {f.detail && <p>{f.detail}</p>}
                {f.suggestion && <p className="muted">{tr('signals.suggestion', { suggestion: f.suggestion })}</p>}
                <div className="finding-actions">
                  {f.status === 'sent' ? (
                    <span className="muted small"><Icon name="check" /> {tr('signals.sentToClaude')}</span>
                  ) : (
                    <button className="chip-btn" onClick={() => ask([f])}><Icon name="comment" /> {tr('signals.askToCheck')}</button>
                  )}
                  <button className="chip-btn" onClick={() => actions.findingStatus(tab.id, f.id, 'dismissed')}>{tr('signals.dismiss')}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Claude paused itself and is waiting for an answer. */
export function CheckInCard({ id, sticky }: { id: string; sticky?: boolean }) {
  const { tab, s } = useSession()
  const c = s.checkins.find((x) => x.id === id)
  const [text, setText] = useState('')
  if (!c) return null
  const answer = (a: string) => void window.glassbox.session.respondCheckin(tab.id, c.id, a)

  if (c.answer !== undefined) {
    if (sticky) return null
    return (
      <div className="checkin answered">
        <Icon name="pass" className="ok" />
        <span className="grow small">
          {tr('signals.checkedInBefore')}<strong>{c.about}</strong>{tr('signals.checkedInAfter', { answer: c.answer })}
        </span>
      </div>
    )
  }
  // The pinned copy above the composer is the one you answer; the timeline just marks the moment.
  if (!sticky)
    return (
      <div className="checkin answered">
        <Icon name="debug-pause" className="warn" />
        <span className="grow small">
          {tr('signals.pausedBefore')}<strong>{c.about}</strong>{tr('signals.pausedAfter')}
        </span>
      </div>
    )
  return (
    <div className={sticky ? 'checkin waiting sticky' : 'checkin waiting'}>
      <div className="checkin-head">
        <Icon name="debug-pause" className="warn" />
        <strong>{tr('signals.pausedHeading')}</strong>
        <span className={`tag ${c.confidence === 'low' ? 'warn-tag' : ''}`}>{tr('signals.confidence', { level: c.confidence })}</span>
      </div>
      <div className="checkin-about">{c.about}</div>
      <div className="muted small">{c.reason}</div>
      {c.options?.length ? (
        <div className="row-actions">
          {c.options.map((o) => (
            <button key={o} className="chip-btn" onClick={() => answer(o)}>{o}</button>
          ))}
        </div>
      ) : null}
      <div className="checkin-reply">
        <input
          placeholder={tr('signals.replyPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && answer(text.trim())}
        />
        <button className="primary" disabled={!text.trim()} onClick={() => answer(text.trim())}>{tr('signals.send')}</button>
        <button onClick={() => answer('Go ahead with your best judgement.')}>{tr('signals.carryOn')}</button>
      </div>
    </div>
  )
}

const CRITERION: Record<CriterionStatus, { icon: string; cls: string; label: string }> = {
  todo: { icon: 'circle-large-outline', cls: 'muted', label: 'todo' },
  'in-progress': { icon: 'loading', cls: 'accent codicon-modifier-spin', label: 'inProgress' },
  done: { icon: 'pass', cls: 'warn', label: 'doneNotTested' },
  tested: { icon: 'pass-filled', cls: 'ok', label: 'tested' }
}

export function CriteriaList() {
  const { s } = useSession()
  if (!s.criteria) return null
  const list = s.criteria.list
  const tested = list.filter((c) => c.status === 'tested').length
  const untested = list.filter((c) => c.status === 'done').length
  return (
    <Section id="criteria" title={tr('signals.criteriaTitle')} meta={s.criteria.source && <span className="muted small">{s.criteria.source}</span>} actions={<span className="small muted">{tr('signals.criteriaTested', { tested, total: list.length })}</span>}>
      {untested > 0 && (
        <div className="callout callout-warn">
          <Icon name="warning" /> {tr('signals.untested', { count: untested })}
        </div>
      )}
      {list.map((c) => {
        const st = CRITERION[c.status]
        return (
          <div key={c.id} className="criterion" title={tr(`signals.criterion.${st.label}`)}>
            <Icon name={st.icon} className={st.cls} />
            <div className="grow">
              <div>{c.text}</div>
              {c.evidence && <div className="muted small mono">{c.evidence}</div>}
            </div>
          </div>
        )
      })}
    </Section>
  )
}
