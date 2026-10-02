import { useState } from 'react'

type Row = { at: number; event: SessionEvent }
/** A stable id per event, so an open one stays open as new events arrive (and old ones drop off). */
const ids = new WeakMap<Row, number>()
let nextId = 0
const idOf = (r: Row) => ids.get(r) ?? (ids.set(r, ++nextId), nextId)
import { useSession } from '../views/SessionView'
import type { SessionEvent } from '../../../shared/events'
import { PanelHeader, Segmented } from '../components/ui'

export function RawPanel() {
  const { s } = useSession()
  const [view, setView] = useState<'events' | 'stderr'>('events')
  const [filter, setFilter] = useState('')
  // Events you've opened. While any is open the list holds still: new events wait behind a button.
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [heldAt, setHeldAt] = useState<number | null>(null)
  const all = s.raw.filter((r) => !filter || JSON.stringify(r.event).toLowerCase().includes(filter.toLowerCase()))
  const rows = heldAt === null ? all : all.filter((r) => idOf(r) <= heldAt)
  const waiting = all.length - rows.length
  const toggle = (id: number, on: boolean) => {
    const next = new Set(open)
    if (on) next.add(id)
    else next.delete(id)
    setOpen(next)
    if (!next.size) setHeldAt(null)
    else if (heldAt === null) setHeldAt(Math.max(0, ...s.raw.map(idOf)))
  }

  return (
    <div className="panel">
      <PanelHeader title="Raw" />
      <div className="panel-toolbar">
        {view === 'events' ? <input className="grow" placeholder="Filter events (any text)…" value={filter} onChange={(e) => setFilter(e.target.value)} /> : <span className="grow" />}
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'events', label: `Events (${s.raw.length})` },
            { value: 'stderr', label: `stderr (${s.stderr.length})` }
          ]}
        />
      </div>
      <div className="panel-scroll raw">
        {view === 'stderr' ? (
          <pre>{s.stderr.join('')}</pre>
        ) : (
          <>
          {heldAt !== null && (
            <div className="raw-held">
              <span className="muted small">{waiting ? `Paused while you read: ${waiting} new event${waiting === 1 ? '' : 's'}` : 'Paused while you read'}</span>
              <button className="link small" onClick={() => (setOpen(new Set()), setHeldAt(null))}>
                Close all and resume
              </button>
            </div>
          )}
          {[...rows].reverse().map((r) => (
            <details key={idOf(r)} open={open.has(idOf(r))} onToggle={(e) => (e.currentTarget.open !== open.has(idOf(r))) && toggle(idOf(r), e.currentTarget.open)}>
              <summary className="mono small">
                <span className="muted">{new Date(r.at).toLocaleTimeString()}</span> {label(r.event)}
              </summary>
              {open.has(idOf(r)) && <pre>{JSON.stringify(r.event, null, 2)}</pre>}
            </details>
          ))}
          </>
        )}
      </div>
    </div>
  )
}

function label(event: SessionEvent): string {
  switch (event.kind) {
    case 'sdk':
      return `sdk:${event.msg.type}${'subtype' in event.msg ? ':' + event.msg.subtype : ''}`
    case 'hook':
      return `hook:${event.input.hook_event_name}`
    case 'glassbox':
      return `glassbox:${event.signal.type}`
    default:
      return event.kind
  }
}
