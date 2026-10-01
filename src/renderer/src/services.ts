import { useCallback, useEffect, useState } from 'react'
import type { ServicesSnapshot } from '../../shared/events'

const LOG_LIMIT = 3000
// Same folder whichever way its slashes go (the main process reports C:\x, a tab may hold C:/x).
const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const sameDir = (a: string, b: string) => norm(a) === norm(b)

/** Live view of a project's services: state snapshot plus logs for any service whose logs were loaded. */
export function useServices(scope: string, cwd: string) {
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | null>(null)
  const [logs, setLogs] = useState<Record<string, string[]>>({})

  useEffect(() => {
    void window.glassbox.services.get(scope, cwd).then(setSnapshot)
    return window.glassbox.services.onEvent((e) => {
      if (e.kind === 'state' && e.snapshot.scope === scope && sameDir(e.snapshot.cwd, cwd)) setSnapshot(e.snapshot)
      if (e.kind === 'log' && e.scope === scope && sameDir(e.cwd, cwd)) {
        setLogs((l) => ({ ...l, [e.name]: [...(l[e.name] ?? []), ...e.lines].slice(-LOG_LIMIT) }))
      }
    })
  }, [scope, cwd])

  const loadLogs = useCallback(
    (name: string) => void window.glassbox.services.logs(scope, cwd, name).then((lines) => setLogs((l) => ({ ...l, [name]: lines }))),
    [scope, cwd]
  )

  return { snapshot, logs, loadLogs }
}
