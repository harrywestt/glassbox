import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { SessionEvent } from '../../../shared/events'
import { PanelHeader, Segmented } from '../components/ui'

export function RawPanel() {
  const { s } = useSession()
  const [view, setView] = useState<'events' | 'stderr'>('events')
  const [filter, setFilter] = useState('')
  const rows = s.raw.filter((r) => !filter || JSON.stringify(r.event).toLowerCase().includes(filter.toLowerCase()))

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
          [...rows].reverse().map((r, i) => (
            <details key={i}>
              <summary className="mono small">
                <span className="muted">{new Date(r.at).toLocaleTimeString()}</span> {label(r.event)}
              </summary>
              <pre>{JSON.stringify(r.event, null, 2)}</pre>
            </details>
          ))
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
