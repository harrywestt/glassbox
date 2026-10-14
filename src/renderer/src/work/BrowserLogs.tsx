import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, IconButton } from '../components/ui'
import { timeOfDay } from '../lib'
import { tr } from '../../../shared/i18n'

type Entry = Awaited<ReturnType<typeof window.glassbox.browser.logs>>[number]

const problem = (e: Entry) => e.level === 'error' || (e.kind === 'console' && e.level === 'warning')

/**
 * What the page reported behind the scenes, in the Browser bar: a count of errors since it last
 * loaded (console errors, failed requests), and the list behind a click, with its API calls too.
 */
export function BrowserLogs({ wcId }: { wcId?: number }) {
  const { composerRef } = useSession()
  const [entries, setEntries] = useState<Entry[]>([])
  const [open, setOpen] = useState(false)
  const [calls, setCalls] = useState(false)
  useEffect(() => {
    if (wcId === undefined) return setEntries([])
    let live = true
    const read = () => void window.glassbox.browser.logs(wcId).then((e) => live && setEntries(e)).catch(() => {})
    read()
    const t = setInterval(read, 2000)
    return () => ((live = false), clearInterval(t))
  }, [wcId])
  // Only this page load's: what came before the last navigation is history.
  const lastLoad = entries.findLastIndex((e) => e.kind === 'navigation')
  const current = entries.slice(lastLoad + 1)
  const problems = current.filter(problem)
  const errors = problems.filter((e) => e.level === 'error').length
  const shown = calls ? current.filter((e) => e.kind === 'network' || problem(e)) : problems
  if (wcId === undefined) return null
  const line = (e: Entry) => (e.kind === 'console' ? `console ${e.level}: ${e.text}${e.source ? ` (${e.source})` : ''}` : `${e.method} ${e.url} → ${e.status ?? e.text.split('→ ').pop()}`)
  return (
    <span className="browser-logs">
      <button
        className={`btn browser-logs-btn${problems.length ? (errors ? ' has-errors' : ' has-warnings') : ''}`}
        onClick={() => setOpen(!open)}
        title={problems.length ? tr('browserLogs.problemsTip', { count: problems.length }) : tr('browserLogs.noneTip')}
        aria-expanded={open}
      >
        <Icon name="debug-console" />
        {problems.length > 0 && <span className="num">{problems.length}</span>}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="popover browser-logs-pop" role="dialog" aria-label={tr('browserLogs.title')}>
            <div className="browser-logs-head">
              <strong>{tr('browserLogs.title')}</strong>
              <label className="check small">
                <input type="checkbox" checked={calls} onChange={(e) => setCalls(e.target.checked)} /> {tr('browserLogs.showCalls')}
              </label>
              <span className="grow" />
              {problems.length > 0 && (
                <button className="chip-btn" onClick={() => (composerRef.current?.insert(tr('browserLogs.askText', { lines: problems.slice(-10).map(line).join('\n') })), setOpen(false))}>
                  <Icon name="comment" /> {tr('browserLogs.ask')}
                </button>
              )}
              <IconButton icon="clear-all" title={tr('browserLogs.clear')} onClick={() => void window.glassbox.browser.clearLogs(wcId).then(() => setEntries([]))} />
            </div>
            {shown.length === 0 ? (
              <div className="muted small browser-logs-empty">{calls ? tr('browserLogs.nothing') : tr('browserLogs.noProblems')}</div>
            ) : (
              <ul className="browser-logs-list">
                {shown.slice(-150).map((e, i) => (
                  <li key={i} className={`browser-log ${e.level}`}>
                    <span className="browser-log-time num">{timeOfDay(e.at)}</span>
                    <span className={`browser-log-kind ${e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : ''}`}>
                      {e.kind === 'console' ? tr(`browserLogs.level.${e.level}`) : e.status ? String(e.status) : tr('browserLogs.failed')}
                    </span>
                    <span className="browser-log-text mono" title={e.kind === 'network' ? e.url : e.text}>
                      {e.kind === 'console' ? e.text : `${e.method} ${e.url}`}
                    </span>
                    {e.kind === 'network' && e.ms !== undefined && <span className="browser-log-ms num">{e.ms}ms</span>}
                    {e.kind === 'console' && e.source && <span className="browser-log-ms">{e.source}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </span>
  )
}
