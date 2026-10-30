import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { formatDuration } from '../lib'
import { tr } from '../../../shared/i18n'

/** What a background task is, from its type: a command, an agent, a watcher… */
const KIND: Record<string, { icon: string; label: string }> = {
  local_bash: { icon: 'terminal', label: 'backgroundList.kind.command' },
  local_agent: { icon: 'robot', label: 'backgroundList.kind.agent' },
  remote_agent: { icon: 'cloud', label: 'backgroundList.kind.remoteAgent' },
  local_workflow: { icon: 'type-hierarchy-sub', label: 'backgroundList.kind.workflow' },
  monitor_mcp: { icon: 'eye', label: 'backgroundList.kind.monitor' },
  dream: { icon: 'sparkle', label: 'backgroundList.kind.other' }
}

/**
 * Everything running in the background, each on its own row: what it is, what kind, for how long,
 * and a Stop for it. Nothing in the background is just a number.
 */
export function BackgroundList({ compact }: { compact?: boolean }) {
  const { tab, s } = useSession()
  const [now, setNow] = useState(Date.now())
  const tasks = s.backgroundTasks ?? []
  useEffect(() => {
    if (!tasks.length) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [tasks.length])
  if (!tasks.length) return null
  // An agent Glassbox knows about says what it's doing now.
  const agentFor = (id: string) => Object.values(s.agents).find((a) => a.taskId === id)
  return (
    <ul className={compact ? 'bg-list compact' : 'bg-list'}>
      {tasks.map((t) => {
        const kind = KIND[t.type] ?? { icon: 'gear', label: 'backgroundList.kind.other' }
        const agent = agentFor(t.id)
        const what = t.description || agent?.description || tr(kind.label)
        return (
          <li key={t.id} className="bg-row">
            <Icon name={kind.icon} className="bg-icon" />
            <span className="bg-text">
              <span className="bg-what" title={what}>{what}</span>
              <span className="bg-meta">
                {tr(kind.label)}
                {agent?.progress ? ` · ${agent.progress}` : ''}
              </span>
            </span>
            <span className="bg-time num">{formatDuration(now - t.since)}</span>
            <button className="link small bg-stop" onClick={() => void window.glassbox.session.stopTask(tab.id, t.id).catch(() => {})} title={tr('backgroundList.stopTip')}>
              {tr('backgroundList.stop')}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
