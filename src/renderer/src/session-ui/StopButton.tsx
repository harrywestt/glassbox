import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { stoppableTasks } from '../tally'

/**
 * Stop, without taking everything down with it. The square stops what you're looking at: the agent
 * you've selected, otherwise Claude's reply (background agents keep working). The arrow beside it
 * lists the rest: Claude's reply, each agent on its own, or everything at once.
 */
/** What "Stop everything" takes down, in words: "Claude's reply and both agents." */
function everythingNote(turn: boolean, tasks: { agentId?: string }[]) {
  const noun = tasks.every((t) => t.agentId) ? 'agent' : 'background task'
  const n = tasks.length
  const these = n === 1 ? `the ${noun}` : n === 2 ? `both ${noun}s` : `all ${n} ${noun}s`
  return turn ? `Claude’s reply and ${these}.` : `${these[0].toUpperCase()}${these.slice(1)}.`
}

export function StopButton() {
  const { tab, s, filter } = useSession()
  const [open, setOpen] = useState(false)
  const tasks = stoppableTasks(s)
  const turn = s.status === 'running'
  const focused = tasks.find((t) => t.agentId && t.agentId === filter)

  const stopReply = () => void window.glassbox.session.interrupt(tab.id)
  const stopTask = (id: string) => void window.glassbox.session.stopTask(tab.id, id)
  const stopAll = () => {
    if (turn) stopReply()
    tasks.forEach((t) => stopTask(t.id))
  }
  const run = (f: () => void) => () => (f(), setOpen(false))

  const square = (
    <button
      className="send stop"
      onClick={focused ? () => stopTask(focused.id) : turn ? stopReply : () => setOpen(!open)}
      title={focused ? `Stop this agent: ${focused.label}` : turn ? (tasks.length ? 'Stop Claude’s reply (Esc). Background agents keep working' : 'Stop Claude (Esc)') : 'Stop background agents'}
      aria-label={focused ? 'Stop this agent' : turn ? 'Stop Claude' : 'Stop background agents'}
    >
      <span className="stop-square" />
    </button>
  )
  if (!tasks.length) return square

  return (
    <div className="stop-split">
      {square}
      <button className={open ? 'send stop stop-more open' : 'send stop stop-more'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Choose what to stop">
        <Icon name="chevron-up" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu stop-menu" role="menu">
            {turn && (
              <button role="menuitem" className="menu-item" onClick={run(stopReply)}>
                <span className="stop-menu-label">Stop Claude’s reply</span>
                <span className="stop-menu-note">Agents keep working in the background.</span>
              </button>
            )}
            <div className="menu-group">
              <div className="menu-heading">{tasks.length === 1 ? 'Running in the background' : `${tasks.length} running in the background`}</div>
              {tasks.map((t) => (
                <button key={t.id} role="menuitem" className="menu-item" onClick={run(() => stopTask(t.id))} title={t.label}>
                  <span className="stop-menu-label">
                    <span className="ellipsis">Stop {t.label}</span>
                    {t === focused && <span className="muted small">Selected</span>}
                  </span>
                </button>
              ))}
            </div>
            <div className="menu-group">
              <button role="menuitem" className="menu-item danger" onClick={run(stopAll)}>
                <span className="stop-menu-label">Stop everything</span>
                <span className="stop-menu-note">{everythingNote(turn, tasks)} You can send a message afterwards to carry on.</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
