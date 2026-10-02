import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useSession } from '../views/SessionView'
import type { Ticket, TicketTransition } from '../../../shared/events'
import { ticketKeyFromBranch } from '../../../shared/ticket'
import { IconButton } from '../components/ui'
import { Select, type SelectOption } from '../components/Select'
import { renderMarkdown, timeAgo } from '../lib'
import { tr } from '../../../shared/i18n'

// A ticket key you set, per project and branch, so it's still there when the session is reopened.
const overrideKey = (cwd: string, branch?: string) => `glassbox.ticketKey.${cwd.replace(/\\/g, '/').toLowerCase()}#${branch ?? ''}`

function readOverride(cwd: string, branch?: string): string | null {
  try {
    return localStorage.getItem(overrideKey(cwd, branch))
  } catch {
    return null
  }
}

export const hasTicketOverride = (cwd: string, branch?: string) => !!readOverride(cwd, branch)

function writeOverride(cwd: string, branch: string | undefined, key: string | null) {
  try {
    if (key) localStorage.setItem(overrideKey(cwd, branch), key)
    else localStorage.removeItem(overrideKey(cwd, branch))
  } catch {
    /* storage unavailable; the override lasts until the panel closes */
  }
}

// Tickets already fetched this run: shown straight away when you come back, refreshed quietly.
const seen = new Map<string, Ticket>()

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? '' : timeAgo(t)
}

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; ticket: Ticket }

/** The Jira ticket this session targets: from the branch name, or a key you set for this tab. */
export function TicketPanel() {
  const { tab, s } = useSession()
  const branchKey = ticketKeyFromBranch(s.git?.branch)
  const [override, setOverride] = useState<string | null>(() => readOverride(tab.cwd, s.git?.branch))
  const key = override ?? branchKey
  const [editing, setEditing] = useState(false)
  const [load, setLoad] = useState<Load>(() => (key && seen.get(key) ? { state: 'ready', ticket: seen.get(key)! } : { state: 'idle' }))
  const [transitions, setTransitions] = useState<TicketTransition[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  // Ignore answers for a key that is no longer shown.
  const current = useRef(key)
  current.current = key

  useEffect(() => setOverride(readOverride(tab.cwd, s.git?.branch)), [tab.cwd, s.git?.branch])

  const fetchTransitions = useCallback(
    async (k: string) => {
      setTransitions(null)
      const r = await window.glassbox.ticket.transitions(tab.cwd, k)
      if (current.current === k) setTransitions(r.transitions ?? [])
    },
    [tab.cwd]
  )

  const fetchTicket = useCallback(
    async (k: string, force = false, quiet = false) => {
      if (!quiet && !seen.has(k)) setLoad({ state: 'loading' })
      const r = await window.glassbox.ticket.get(tab.cwd, k, force)
      if (current.current !== k) return
      if (r.ticket) {
        seen.set(k, r.ticket)
        setLoad({ state: 'ready', ticket: r.ticket })
        // A saved copy: the fresh one is loading in the background, so pick it up when it lands.
        if (r.stale && !quiet) setTimeout(() => current.current === k && void fetchTicket(k, false, true), 20_000)
      } else setLoad({ state: 'error', error: r.error })
    },
    [tab.cwd]
  )

  const refresh = useCallback(
    (force = true) => {
      if (!key) return
      setMoveError(null)
      void fetchTicket(key, force)
      void fetchTransitions(key)
    },
    [key, fetchTicket, fetchTransitions]
  )

  useEffect(() => {
    setMoving(null)
    if (!key) {
      setLoad({ state: 'idle' })
      setTransitions(null)
      return
    }
    refresh(false)
  }, [key, refresh])

  const setKey = (next: string) => {
    const k = next.trim().toUpperCase()
    const value = k && k !== branchKey ? k : null
    writeOverride(tab.cwd, s.git?.branch, value)
    setOverride(value)
    setEditing(false)
  }

  const move = async (t: TicketTransition) => {
    if (!key) return
    setMoving(t.to ?? t.name)
    setMoveError(null)
    const r = await window.glassbox.ticket.transition(tab.cwd, key, t.id)
    setMoving(null)
    if (current.current !== key) return
    if (r.error) return setMoveError(r.error)
    await Promise.all([fetchTicket(key, true, true), fetchTransitions(key)])
  }

  if (!key || editing) {
    return (
      <div className="ticket">
        <div className="ticket-empty">
          {!key && <p>{tr('ticketPanel.noTicket')}</p>}
          <KeyForm initial={key ?? ''} onSave={setKey} onCancel={key ? () => setEditing(false) : undefined} branchKey={branchKey} />
        </div>
      </div>
    )
  }

  return (
    <div className="ticket">
      <div className="ticket-head">
        <span className="ticket-key">{load.state === 'ready' ? load.ticket.key : key}</span>
        {load.state === 'ready' && load.ticket.url && (
          <IconButton icon="link-external" title={tr('ticketPanel.openInJira')} onClick={() => void window.glassbox.openExternal(load.ticket.url!)} />
        )}
        <button className="btn quiet" onClick={() => setEditing(true)}>
          {tr('ticketPanel.change')}
        </button>
        <IconButton icon="refresh" title={tr('ticketPanel.refresh')} onClick={() => refresh(true)} disabled={load.state === 'loading'} />
      </div>

      {load.state === 'loading' && (
        <div className="ticket-skeleton" aria-busy="true" aria-label={tr('ticketPanel.loading')}>
          {/* Jira answers through the Claude connector, which takes ten seconds or so the first time. */}
          <div className="muted small">{tr('ticketPanel.gettingFromJira', { key })}</div>
          <span style={{ width: '70%' }} />
          <span style={{ width: '45%' }} />
          <span style={{ width: '55%' }} />
          <span style={{ width: '90%' }} />
          <span style={{ width: '80%' }} />
        </div>
      )}

      {load.state === 'error' && (
        <div className="ticket-error" role="alert">
          <span>{load.error}</span>
          <span className="ticket-error-actions">
            {/connector|sign in|signed in|connect/i.test(load.error) && (
              <button className="btn primary" onClick={() => void window.glassbox.accounts.signIn('connector:claude.ai Atlassian')}>
                {tr('ticketPanel.connectJira')}
              </button>
            )}
            <button className="btn" onClick={() => refresh(true)}>
              {tr('ticketPanel.retry')}
            </button>
          </span>
        </div>
      )}

      {load.state === 'ready' && (
        <TicketBody
          ticket={load.ticket}
          transitions={transitions}
          moving={moving}
          moveError={moveError}
          onMove={move}
          onCommented={() => void fetchTicket(key, true, true)}
          cwd={tab.cwd}
        />
      )}
    </div>
  )
}

function KeyForm({ initial, onSave, onCancel, branchKey }: { initial: string; onSave: (k: string) => void; onCancel?: () => void; branchKey: string | null }) {
  const [value, setValue] = useState(initial)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSave(value)
  }
  return (
    <form onSubmit={submit}>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={tr('ticketPanel.keyPlaceholder')} aria-label={tr('ticketPanel.ticketKey')} spellCheck={false} autoFocus={!!onCancel} />
      <button type="submit" className="btn primary" disabled={!value.trim() && !onCancel}>
        {tr('ticketPanel.show')}
      </button>
      {branchKey && initial !== branchKey && (
        <button type="button" className="btn quiet" onClick={() => onSave('')}>
          {tr('ticketPanel.use', { key: branchKey })}
        </button>
      )}
      {onCancel && (
        <button type="button" className="btn quiet" onClick={onCancel}>
          {tr('ticketPanel.cancel')}
        </button>
      )}
    </form>
  )
}

function TicketBody({
  ticket,
  transitions,
  moving,
  moveError,
  onMove,
  onCommented,
  cwd
}: {
  ticket: Ticket
  transitions: TicketTransition[] | null
  moving: string | null
  moveError: string | null
  onMove: (t: TicketTransition) => void
  onCommented: () => void
  cwd: string
}) {
  const choices = (transitions ?? []).filter((t) => (t.to ?? t.name) !== ticket.status)
  const options: SelectOption<string>[] = [
    { value: '', label: moving ? tr('ticketPanel.movingTo', { status: moving }) : ticket.status },
    ...choices.map((t) => ({ value: t.id, label: t.name, hint: t.to && t.to !== t.name ? t.to : undefined }))
  ]

  return (
    <>
      <h2 className="ticket-title">{ticket.summary}</h2>
      <dl className="ticket-meta">
        <dt>{tr('ticketPanel.status')}</dt>
        <dd>
          <Select
            value=""
            options={options}
            disabled={!!moving || transitions === null || choices.length === 0}
            title={transitions === null ? tr('ticketPanel.loadingStatuses') : choices.length === 0 ? tr('ticketPanel.noOtherStatuses') : tr('ticketPanel.changeStatus')}
            aria-label={tr('ticketPanel.status')}
            onChange={(id) => {
              const t = choices.find((c) => c.id === id)
              if (t) onMove(t)
            }}
          />
          {moveError && (
            <span className="ticket-error" role="alert">
              {moveError}
            </span>
          )}
        </dd>
        {ticket.type && (
          <>
            <dt>{tr('ticketPanel.type')}</dt>
            <dd>{ticket.type}</dd>
          </>
        )}
        <dt>{tr('ticketPanel.assignee')}</dt>
        <dd>{ticket.assignee ?? tr('ticketPanel.unassigned')}</dd>
        {ticket.updated && (
          <>
            <dt>{tr('ticketPanel.updated')}</dt>
            <dd title={new Date(ticket.updated).toLocaleString()}>{ago(ticket.updated)}</dd>
          </>
        )}
      </dl>

      <section className="ticket-section">
        <h3 className="ticket-section-title">{tr('ticketPanel.description')}</h3>
        {ticket.description ? (
          <div className="ticket-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(ticket.description) }} />
        ) : (
          <p className="ticket-empty">{tr('ticketPanel.noDescription')}</p>
        )}
      </section>

      <section className="ticket-section">
        <h3 className="ticket-section-title">{ticket.comments.length ? tr('ticketPanel.commentsCount', { n: ticket.comments.length }) : tr('ticketPanel.comments')}</h3>
        {ticket.comments.length > 0 && (
          <ul className="ticket-comments">
            {ticket.comments.map((c, i) => (
              <li key={c.id ?? i} className="ticket-comment">
                <div className="ticket-comment-by">
                  <span>{c.author}</span>
                  {c.created && <time dateTime={c.created} title={new Date(c.created).toLocaleString()}>{ago(c.created)}</time>}
                </div>
                <div className="ticket-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
              </li>
            ))}
          </ul>
        )}
        <Reply ticketKey={ticket.key} cwd={cwd} onPosted={onCommented} />
      </section>
    </>
  )
}

function Reply({ ticketKey, cwd, onPosted }: { ticketKey: string; cwd: string; onPosted: () => void }) {
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const post = async () => {
    if (!text.trim() || posting) return
    setPosting(true)
    setError(null)
    const r = await window.glassbox.ticket.comment(cwd, ticketKey, text)
    setPosting(false)
    if (r.error) return setError(r.error)
    setText('')
    onPosted()
  }

  return (
    <form
      className="ticket-reply"
      onSubmit={(e) => {
        e.preventDefault()
        void post()
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void post()
          }
        }}
        placeholder={tr('ticketPanel.addComment')}
        aria-label={tr('ticketPanel.addComment')}
        disabled={posting}
        rows={3}
      />
      {error && (
        <span className="ticket-error" role="alert">
          {error}
        </span>
      )}
      <button type="submit" className="btn primary" disabled={posting || !text.trim()}>
        {posting ? tr('ticketPanel.posting') : tr('ticketPanel.post')}
      </button>
    </form>
  )
}
