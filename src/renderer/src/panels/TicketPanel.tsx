import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useSession } from '../views/SessionView'
import type { Ticket, TicketTransition } from '../../../shared/events'
import { ticketKeyFromBranch } from '../../../shared/ticket'
import { IconButton, PanelHeader } from '../components/ui'
import { Select, type SelectOption } from '../components/Select'
import { renderMarkdown, timeAgo } from '../lib'

const overrideKey = (tabId: string) => `glassbox.ticketKey.${tabId}`

function readOverride(tabId: string): string | null {
  try {
    return localStorage.getItem(overrideKey(tabId))
  } catch {
    return null
  }
}

function writeOverride(tabId: string, key: string | null) {
  try {
    if (key) localStorage.setItem(overrideKey(tabId), key)
    else localStorage.removeItem(overrideKey(tabId))
  } catch {
    /* storage unavailable; the override lasts until the panel closes */
  }
}

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? '' : timeAgo(t)
}

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; ticket: Ticket }

/** The Jira ticket this session targets: from the branch name, or a key you set for this tab. */
export function TicketPanel() {
  const { tab, s } = useSession()
  const branchKey = ticketKeyFromBranch(s.git?.branch)
  const [override, setOverride] = useState<string | null>(() => readOverride(tab.id))
  const key = override ?? branchKey
  const [editing, setEditing] = useState(false)
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const [transitions, setTransitions] = useState<TicketTransition[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  // Ignore answers for a key that is no longer shown.
  const current = useRef(key)
  current.current = key

  useEffect(() => setOverride(readOverride(tab.id)), [tab.id])

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
      if (!quiet) setLoad({ state: 'loading' })
      const r = await window.glassbox.ticket.get(tab.cwd, k, force)
      if (current.current !== k) return
      if (r.ticket) {
        setLoad({ state: 'ready', ticket: r.ticket })
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
    writeOverride(tab.id, value)
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

  const header = (
    <PanelHeader title="Ticket">
      <IconButton icon="refresh" title="Refresh" onClick={() => refresh(true)} disabled={!key || load.state === 'loading'} />
    </PanelHeader>
  )

  if (!key || editing) {
    return (
      <div className="ticket">
        {header}
        <div className="ticket-empty">
          {!key && <p>No ticket in this branch name.</p>}
          <KeyForm initial={key ?? ''} onSave={setKey} onCancel={key ? () => setEditing(false) : undefined} branchKey={branchKey} />
        </div>
      </div>
    )
  }

  return (
    <div className="ticket">
      {header}
      <div className="ticket-head">
        <span className="ticket-key">{load.state === 'ready' ? load.ticket.key : key}</span>
        {load.state === 'ready' && load.ticket.url && (
          <IconButton icon="link-external" title="Open in Jira" onClick={() => void window.glassbox.openExternal(load.ticket.url!)} />
        )}
        <button className="btn quiet" onClick={() => setEditing(true)}>
          Change
        </button>
      </div>

      {load.state === 'loading' && (
        <div className="ticket-skeleton" aria-busy="true" aria-label="Loading">
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
                Connect Jira
              </button>
            )}
            <button className="btn" onClick={() => refresh(true)}>
              Retry
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
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ticket key, e.g. NSD-123" aria-label="Ticket key" spellCheck={false} autoFocus={!!onCancel} />
      <button type="submit" className="btn primary" disabled={!value.trim() && !onCancel}>
        Show
      </button>
      {branchKey && initial !== branchKey && (
        <button type="button" className="btn quiet" onClick={() => onSave('')}>
          Use {branchKey}
        </button>
      )}
      {onCancel && (
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
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
    { value: '', label: moving ? `Moving to ${moving}…` : ticket.status },
    ...choices.map((t) => ({ value: t.id, label: t.name, hint: t.to && t.to !== t.name ? t.to : undefined }))
  ]

  return (
    <>
      <h2 className="ticket-title">{ticket.summary}</h2>
      <dl className="ticket-meta">
        <dt>Status</dt>
        <dd>
          <Select
            value=""
            options={options}
            disabled={!!moving || transitions === null || choices.length === 0}
            title={transitions === null ? 'Loading statuses' : choices.length === 0 ? 'No other statuses available' : 'Change status'}
            aria-label="Status"
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
            <dt>Type</dt>
            <dd>{ticket.type}</dd>
          </>
        )}
        <dt>Assignee</dt>
        <dd>{ticket.assignee ?? 'Unassigned'}</dd>
        {ticket.updated && (
          <>
            <dt>Updated</dt>
            <dd title={new Date(ticket.updated).toLocaleString()}>{ago(ticket.updated)}</dd>
          </>
        )}
      </dl>

      <section className="ticket-section">
        <h3 className="ticket-section-title">Description</h3>
        {ticket.description ? (
          <div className="ticket-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(ticket.description) }} />
        ) : (
          <p className="ticket-empty">No description.</p>
        )}
      </section>

      <section className="ticket-section">
        <h3 className="ticket-section-title">Comments{ticket.comments.length ? ` (${ticket.comments.length})` : ''}</h3>
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
        placeholder="Add a comment"
        aria-label="Add a comment"
        disabled={posting}
        rows={3}
      />
      {error && (
        <span className="ticket-error" role="alert">
          {error}
        </span>
      )}
      <button type="submit" className="btn primary" disabled={posting || !text.trim()}>
        {posting ? 'Posting…' : 'Post'}
      </button>
    </form>
  )
}
