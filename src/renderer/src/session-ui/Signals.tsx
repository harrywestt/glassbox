import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { SessionState } from '../session'
import type { CriterionStatus, FindingSeverity } from '../../../shared/events'
import { baseName } from '../lib'
import { Icon, Section } from '../components/ui'

type FindingEntry = SessionState['findings'][number]

const SEVERITY: Record<FindingSeverity, { label: string; cls: string }> = {
  blocker: { label: 'Blocker', cls: 'sev-blocker' },
  major: { label: 'Major', cls: 'sev-major' },
  minor: { label: 'Minor', cls: 'sev-minor' },
  nit: { label: 'Nit', cls: 'sev-nit' },
  question: { label: 'Question', cls: 'sev-question' }
}

/** A review finding: from Claude in a review session, or from the background reviewer. */
export function FindingCard({ f, compact }: { f: FindingEntry; compact?: boolean }) {
  const { tab, actions, openFile } = useSession()
  const [open, setOpen] = useState(!compact && f.severity !== 'nit')
  const sev = SEVERITY[f.severity]
  const where = f.file ? `${baseName(f.file)}${f.line ? `:${f.line}` : ''}` : null

  const raise = () => {
    const about = `${f.title}${f.file ? ` (${f.file}${f.line ? ` line ${f.line}` : ''})` : ''}`
    const text =
      f.source === 'reviewer'
        ? `A reviewer flagged this in your recent edits: ${about}.${f.detail ? ` ${f.detail}` : ''}${f.suggestion ? ` Suggested: ${f.suggestion}` : ''} Check whether it's a real problem; fix it if so, otherwise tell me why it's fine.`
        : `About your finding "${about}": fix it now.`
    void actions.comment(tab.id, { kind: 'message', excerpt: `Flag: ${f.title}` }, text)
    actions.findingStatus(tab.id, f.id, 'sent')
  }

  if (f.status === 'dismissed') return null
  return (
    <div className={`finding ${sev.cls}`}>
      <div className="finding-head" onClick={() => setOpen(!open)}>
        <span className="sev">{sev.label}</span>
        <span className="grow finding-title">{f.title}</span>
        {where && (
          <button className="link small mono" onClick={(e) => (e.stopPropagation(), openFile(f.file!))}>
            {where}
          </button>
        )}
        <span className="muted small">{f.source === 'reviewer' ? 'Reviewer' : 'Claude'}</span>
      </div>
      {open && (f.detail || f.suggestion) && (
        <div className="finding-body small">
          {f.detail && <p>{f.detail}</p>}
          {f.suggestion && <p className="muted">Suggestion: {f.suggestion}</p>}
        </div>
      )}
      <div className="finding-actions">
        {f.status === 'sent' ? (
          <span className="muted small"><Icon name="check" /> Sent to Claude</span>
        ) : (
          <button className="chip-btn" onClick={raise}>
            <Icon name="comment" /> {f.source === 'reviewer' ? 'Ask Claude to check' : 'Ask Claude to fix'}
          </button>
        )}
        <button className="chip-btn" onClick={() => actions.findingStatus(tab.id, f.id, 'dismissed')}>Dismiss</button>
      </div>
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
          Checked in about <strong>{c.about}</strong>. You answered: {c.answer}
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
          Paused to check with you about <strong>{c.about}</strong>. Answer below the conversation.
        </span>
      </div>
    )
  return (
    <div className={sticky ? 'checkin waiting sticky' : 'checkin waiting'}>
      <div className="checkin-head">
        <Icon name="debug-pause" className="warn" />
        <strong>Claude has paused to check with you</strong>
        <span className={`tag ${c.confidence === 'low' ? 'warn-tag' : ''}`}>{c.confidence} confidence</span>
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
          placeholder="Or tell Claude what to do"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && answer(text.trim())}
        />
        <button className="primary" disabled={!text.trim()} onClick={() => answer(text.trim())}>Send</button>
        <button onClick={() => answer('Go ahead with your best judgement.')}>Carry on</button>
      </div>
    </div>
  )
}

const CRITERION: Record<CriterionStatus, { icon: string; cls: string; label: string }> = {
  todo: { icon: 'circle-large-outline', cls: 'muted', label: 'To do' },
  'in-progress': { icon: 'loading', cls: 'accent codicon-modifier-spin', label: 'In progress' },
  done: { icon: 'pass', cls: 'warn', label: 'Done, not tested' },
  tested: { icon: 'pass-filled', cls: 'ok', label: 'Tested' }
}

export function CriteriaList() {
  const { s } = useSession()
  if (!s.criteria) return null
  const list = s.criteria.list
  const tested = list.filter((c) => c.status === 'tested').length
  const untested = list.filter((c) => c.status === 'done').length
  return (
    <Section id="criteria" title="Acceptance criteria" meta={s.criteria.source && <span className="muted small">{s.criteria.source}</span>} actions={<span className="small muted">{tested} of {list.length} tested</span>}>
      {untested > 0 && (
        <div className="callout callout-warn">
          <Icon name="warning" /> {untested} marked done without a test proving it
        </div>
      )}
      {list.map((c) => {
        const st = CRITERION[c.status]
        return (
          <div key={c.id} className="criterion" title={st.label}>
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
