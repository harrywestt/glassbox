import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { ServiceErrorCard } from '../session-ui/Timeline'
import { useServices } from '../services'
import { Empty, Icon, IconButton, PanelHeader } from '../components/ui'
import { READ_TOOLS, SHELL_TOOLS } from '../side'
import type { ServiceStatus } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

const STATUS: Record<ServiceStatus, { label: string; cls: string }> = {
  stopped: { label: tr('servicesPanel.statusStopped'), cls: 'muted' },
  waiting: { label: tr('servicesPanel.statusWaiting'), cls: 'muted' },
  starting: { label: tr('servicesPanel.statusStarting'), cls: 'muted' },
  running: { label: tr('servicesPanel.statusRunning'), cls: 'ok' },
  stopping: { label: tr('servicesPanel.statusStopping'), cls: 'muted' },
  crashed: { label: tr('servicesPanel.statusCrashed'), cls: 'err' }
}

const SETUP_PROMPT =
  'Set up .glassbox/services.json so the Glassbox Run button starts everything this project needs for local development. Inspect the repo first (package.json scripts, docker-compose, launch settings, READMEs, CLAUDE.md) to find the real commands, working directories, ports, URLs and ready log lines, and set dependsOn so infrastructure starts first. Each Glassbox session runs its own copy, so give every app service its usual "port" and use the port placeholders (see the services instructions) instead of hard-coding ports; leave shared infrastructure without one. Then summarise what you configured.'

const PER_SESSION_PROMPT =
  'Update .glassbox/services.json so each Glassbox session can run its own copy of the app services side by side: give every app service its usual "port", and replace hard-coded ports in its command, env and url with the port placeholders from the services instructions (its own port, and other services’ ports where one calls another). Find how each tool takes a port (flags like --port or --urls, or env vars like PORT or ASPNETCORE_URLS). Leave shared infrastructure (databases, docker compose) without a port. Summarise what changed.'

export function ServicesPanel() {
  const { tab, s, runSide, showPanel } = useSession()
  const [change, setChange] = useState('')
  const { snapshot, logs, loadLogs } = useServices(tab.id, tab.cwd)
  const [selected, setSelected] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const canSend = s.status !== 'new' && s.status !== 'stopped'
  const svc = window.glassbox.services

  useEffect(() => {
    if (!selected && snapshot?.services[0]) setSelected(snapshot.services[0].name)
  }, [snapshot, selected])
  useEffect(() => {
    if (selected) loadLogs(selected)
  }, [selected, loadLogs])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [selected, logs[selected ?? '']?.length])

  const lastUser = s.timeline.map((i) => i.kind).lastIndexOf('user')
  const errors = [...new Map(s.timeline.slice(lastUser + 1).flatMap((i) => (i.kind === 'service-error' ? [[i.service, i] as const] : []))).values()]
  if (!snapshot) return <div className="panel"><PanelHeader title={tr('servicesPanel.title')} /></div>
  const anyRunning = snapshot.services.some((x) => x.status === 'running' || x.status === 'starting' || x.status === 'waiting')

  return (
    <div className="panel">
      <PanelHeader title={tr('servicesPanel.title')}>
        {snapshot.services.length > 0 && (
          <>
            <button className="btn run-all" onClick={() => void svc.startAll(tab.id, tab.cwd)} title={tr('servicesPanel.runAllTitle')}>
              <Icon name="run-all" /> {tr('servicesPanel.runAll')}
            </button>
            <IconButton icon="debug-stop" title={tr('servicesPanel.stopAll')} onClick={() => void svc.stopAll(tab.id, tab.cwd)} disabled={!anyRunning} />
          </>
        )}
        <IconButton icon="go-to-file" title={tr('servicesPanel.openConfig')} onClick={() => void window.glassbox.openPath(snapshot.configPath)} disabled={!snapshot.exists} />
      </PanelHeader>
      {snapshot.error && <div className="note note-error">{snapshot.error}</div>}
      {!snapshot.exists ? (
        <div className="services-empty">
          <span className="muted" title={tr('servicesPanel.noServicesTitle')}>{tr('servicesPanel.noServices')}</span>
          <button className="btn quiet" disabled={!canSend} onClick={() => runSide({ kind: 'services', title: tr('servicesPanel.setUpServices'), prompt: SETUP_PROMPT, tools: [...READ_TOOLS, 'Write', 'Edit'] })}>
            {tr('servicesPanel.askSetUp')}
          </button>
        </div>
      ) : (
        <div className="split-v">
          <div className="file-list">
            {snapshot.services.map((x) => {
              const st = STATUS[x.status]
              const live = x.status === 'running' || x.status === 'starting' || x.status === 'waiting'
              return (
                <div key={x.name} className={x.name === selected ? 'list-row clickable selected' : 'list-row clickable'} onClick={() => setSelected(x.name)}>
                  <span className={`dot dot-${st.cls}${x.status === 'starting' ? ' pulse' : ''}`} />
                  <span className="grow ellipsis">
                    <strong>{x.name}</strong>{' '}
                    {(x.port ?? x.config.port) && (
                      <span className={x.port && x.config.port && x.port !== x.config.port ? 'tag warn-tag' : 'tag'} title={x.port && x.port !== x.config.port ? tr('servicesPanel.portTaken', { usual: x.config.port, port: x.port }) : tr('servicesPanel.sessionPort')}>
                        :{x.port ?? x.config.port}
                      </span>
                    )}{' '}
                    <span className="muted mono small">{x.config.command}</span>
                  </span>
                  <span className={`small ${st.cls}`} title={x.waitingFor?.length ? tr('servicesPanel.startsOnce', { count: x.waitingFor.length, names: x.waitingFor.join(tr('servicesPanel.and')) }) : undefined}>
                    {x.status === 'waiting' && x.waitingFor?.length ? tr('servicesPanel.waitingFor', { names: x.waitingFor.join(', ') }) : st.label}
                  </span>
                  {x.config.url && live && <IconButton icon="globe" title={tr('servicesPanel.preview')} onClick={() => showPanel('preview')} />}
                  {x.config.url && live && <IconButton icon="link-external" title={tr('servicesPanel.openInBrowser', { url: x.config.url })} onClick={() => void window.glassbox.openExternal(x.config.url!)} />}
                  {live ? (
                    <>
                      <IconButton icon="debug-restart" title={tr('servicesPanel.restart')} onClick={() => void svc.restart(tab.id, tab.cwd, x.name)} />
                      <IconButton icon="debug-stop" title={tr('servicesPanel.stop')} onClick={() => void svc.stop(tab.id, tab.cwd, x.name)} />
                    </>
                  ) : (
                    <IconButton icon="play" title={tr('servicesPanel.start')} onClick={() => void svc.start(tab.id, tab.cwd, x.name)} />
                  )}
                </div>
              )
            })}
            {/* Errors the services logged since your last message, one card per service (they used to land in the conversation). */}
            {errors.length > 0 && (
              <div className="services-errors">
                {errors.map((e) => (
                  <ServiceErrorCard key={e.service} item={e} />
                ))}
              </div>
            )}
            {snapshot.services.some((x) => !x.config.port) && (
              <div className="services-note small muted">
                <span title={tr('servicesPanel.portsNoteTitle')}>{tr('servicesPanel.portsNote')}</span>{' '}
                <button
                  className="link small"
                  disabled={!canSend}
                  onClick={() => runSide({ kind: 'services', title: tr('servicesPanel.perSessionPorts'), prompt: PER_SESSION_PROMPT, tools: [...READ_TOOLS, 'Write', 'Edit'] })}
                >
                  {tr('servicesPanel.askSetUpPorts')}
                </button>
              </div>
            )}
            <div className="row-actions pad-x">
              <input
                className="grow"
                placeholder={tr('servicesPanel.changePlaceholder')}
                value={change}
                onChange={(e) => setChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && change.trim() && canSend) {
                    runSide({ kind: 'services', title: tr('servicesPanel.changeServices'), prompt: `Update .glassbox/services.json: ${change.trim()}. Check the repo for the real commands, ports and ready log lines.`, tools: [...READ_TOOLS, 'Write', 'Edit'] })
                    setChange('')
                  }
                }}
              />
            </div>
          </div>
          <div className="preview">
            <div className="preview-bar">
              <div className="log-tabs grow" role="tablist" aria-label={tr('servicesPanel.terminals')}>
                {snapshot.services.map((x) => (
                  <button
                    key={x.name}
                    role="tab"
                    aria-selected={x.name === selected}
                    className={x.name === selected ? 'log-tab active' : 'log-tab'}
                    onClick={() => setSelected(x.name)}
                    title={tr('servicesPanel.tabTitle', { name: x.name, status: STATUS[x.status].label })}
                  >
                    <span className={`dot dot-${STATUS[x.status].cls}${x.status === 'starting' ? ' pulse' : ''}`} />
                    {x.name}
                  </button>
                ))}
              </div>
              <IconButton icon="copy" title={tr('servicesPanel.copyLogs')} onClick={() => void navigator.clipboard.writeText(stripAnsi((logs[selected ?? ''] ?? []).join('\n')))} />
              <IconButton
                icon="comment-discussion"
                title={tr('servicesPanel.askAboutLogs')}
                disabled={!canSend || !selected}
                onClick={() =>
                  runSide({
                    kind: 'services',
                    title: tr('servicesPanel.diagnose', { name: selected }),
                    tools: [...READ_TOOLS, ...SHELL_TOOLS],
                    prompt: `Here are the latest logs from the "${selected}" service. Work out what's wrong and how to fix it. Don't change any files; report the cause and the fix.\n\n\`\`\`\n${stripAnsi((logs[selected ?? ''] ?? []).slice(-150).join('\n'))}\n\`\`\``
                  })
                }
              />
            </div>
            <pre className="logs" ref={logRef}>
              {(logs[selected ?? ''] ?? []).map((l, i) => (
                <div key={i}>{stripAnsi(l)}</div>
              ))}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
