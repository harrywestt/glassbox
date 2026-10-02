import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { stoppableTasks } from '../tally'
import { tr } from '../../../shared/i18n'

/**
 * Stop, without taking everything down with it. The square stops what you're looking at: the agent
 * you've selected, otherwise Claude's reply (background agents keep working). The arrow beside it
 * lists the rest: Claude's reply, each agent on its own, or everything at once.
 */
/** What "Stop everything" takes down, in words: "Claude's reply and both agents." */
function everythingNote(turn: boolean, tasks: { agentId?: string }[]) {
  const kind = tasks.every((t) => t.agentId) ? 'agents' : 'tasks'
  const n = tasks.length
  const these = tr(`stopButton.${kind}.${n === 1 ? 'one' : n === 2 ? 'two' : 'many'}`, { count: n })
  return turn ? tr('stopButton.replyAnd', { these }) : `${these[0].toUpperCase()}${these.slice(1)}.`
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
      title={focused ? tr('stopButton.stopThisAgentNamed', { label: focused.label }) : turn ? (tasks.length ? tr('stopButton.stopReplyTitle') : tr('stopButton.stopClaudeTitle')) : tr('stopButton.stopBackground')}
      aria-label={focused ? tr('stopButton.stopThisAgent') : turn ? tr('stopButton.stopClaude') : tr('stopButton.stopBackground')}
    >
      <span className="stop-square" />
    </button>
  )
  if (!tasks.length) return square

  return (
    <div className="stop-split">
      {square}
      <button className={open ? 'send stop stop-more open' : 'send stop stop-more'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={tr('stopButton.chooseWhat')}>
        <Icon name="chevron-up" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu stop-menu" role="menu">
            {turn && (
              <button role="menuitem" className="menu-item" onClick={run(stopReply)}>
                <span className="stop-menu-label">{tr('stopButton.stopReply')}</span>
                <span className="stop-menu-note">{tr('stopButton.agentsKeepWorking')}</span>
              </button>
            )}
            <div className="menu-group">
              <div className="menu-heading">{tr('stopButton.running', { count: tasks.length })}</div>
              {tasks.map((t) => (
                <button key={t.id} role="menuitem" className="menu-item" onClick={run(() => stopTask(t.id))} title={t.label}>
                  <span className="stop-menu-label">
                    <span className="ellipsis">{tr('stopButton.stopTask', { label: t.label })}</span>
                    {t === focused && <span className="muted small">{tr('stopButton.selected')}</span>}
                  </span>
                </button>
              ))}
            </div>
            <div className="menu-group">
              <button role="menuitem" className="menu-item danger" onClick={run(stopAll)}>
                <span className="stop-menu-label">{tr('stopButton.stopEverything')}</span>
                <span className="stop-menu-note">{tr('stopButton.everythingNote', { these: everythingNote(turn, tasks) })}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
