import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, IconButton, useFolded } from '../components/ui'
import type { LoaderState } from '../../../shared/events'

/** A finished loader stays this long, then clears itself; a failed one stays until you close it. */
const DONE_KEEP_MS = 20_000

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * Loaders Claude shows for long work with real progress (show_progress: steps, a percent, or something
 * Glassbox watches), just above the message box.
 * One is a row; several fold into one heading ("3 in progress") you open like an accordion.
 */
export function Loaders() {
  const { tab, s, actions } = useSession()
  const [now, setNow] = useState(Date.now())
  const [folded, toggle] = useFolded('loaders')
  const all = Object.values(s.loaders ?? {}).sort((a, b) => a.started - b.started)
  const shown = all.filter((l) => l.status !== 'done' || now - l.updated < DONE_KEEP_MS)
  const running = shown.filter((l) => l.status === 'running')
  useEffect(() => {
    if (!shown.length) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [shown.length])
  if (!shown.length) return null
  const many = shown.length > 1
  const failed = shown.filter((l) => l.status === 'failed').length
  const row = (l: LoaderState) => <LoaderRow key={l.id} l={l} now={now} onClose={() => actions.dismissLoader(tab.id, l.id)} />
  if (!many) return <div className="loaders">{row(shown[0])}</div>
  // Overall progress for the heading: the average of those that say, when any do.
  const known = running.filter((l) => l.percent !== undefined)
  const overall = known.length ? known.reduce((n, l) => n + (l.percent ?? 0), 0) / known.length : undefined
  return (
    <div className={folded ? 'loaders many folded' : 'loaders many'}>
      <button className="loaders-head" aria-expanded={!folded} onClick={toggle}>
        <Icon name="chevron-down" className="section-chevron" />
        <span className="loaders-title">
          {running.length ? `${running.length} in progress` : 'All finished'}
          {failed ? `, ${failed} failed` : ''}
          {shown.length - running.length - failed > 0 ? `, ${shown.length - running.length - failed} done` : ''}
        </span>
        {folded && running.length > 0 && <Bar percent={overall} status="running" />}
      </button>
      {!folded && <div className="loaders-list">{shown.map(row)}</div>}
    </div>
  )
}

function LoaderRow({ l, now, onClose }: { l: LoaderState; now: number; onClose: () => void }) {
  return (
    <div className={`loader ${l.status}`} role="status" aria-label={`${l.label}, ${l.status}${l.percent !== undefined ? `, ${Math.round(l.percent)}%` : ''}`}>
      <span className="loader-icon" aria-hidden>
        {l.status === 'done' ? <Icon name="pass-filled" /> : l.status === 'failed' ? <Icon name="error" /> : <Icon name="loading" className="codicon-modifier-spin" />}
      </span>
      <div className="loader-main">
        <div className="loader-line">
          <span className="loader-label">{l.label}</span>
          <span className="loader-meta">
            {l.status === 'running' && l.step && l.steps ? `Step ${Math.min(l.step, l.steps)} of ${l.steps}, ` : l.percent !== undefined && l.status === 'running' ? `${Math.round(l.percent)}%, ` : ''}
            {l.status === 'running' ? clock(now - l.started) : l.status === 'done' ? `done in ${clock(l.updated - l.started)}` : 'failed'}
          </span>
        </div>
        {l.status === 'running' && <Bar percent={l.percent} status={l.status} />}
        {l.detail && <div className="loader-detail" title={l.detail}>{l.detail}</div>}
      </div>
      {l.status !== 'running' && <IconButton icon="close" title="Clear" onClick={onClose} />}
    </div>
  )
}

/** A bar that fills to the percent, or a moving band when how far along isn't known. */
function Bar({ percent, status }: { percent?: number; status: LoaderState['status'] }) {
  return (
    <span className={`loader-bar ${status}${percent === undefined ? ' unknown' : ''}`} aria-hidden>
      <span style={percent === undefined ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }} />
    </span>
  )
}
