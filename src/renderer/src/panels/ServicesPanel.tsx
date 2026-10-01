import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useServices } from '../services'
import { Empty, Icon, IconButton, PanelHeader } from '../components/ui'
import { READ_TOOLS, SHELL_TOOLS } from '../side'
import type { ServiceStatus } from '../../../shared/events'

const STATUS: Record<ServiceStatus, { label: string; cls: string }> = {
  stopped: { label: 'Stopped', cls: 'muted' },
  waiting: { label: 'Waiting', cls: 'muted' },
  starting: { label: 'Starting…', cls: 'muted' },
  running: { label: 'Running', cls: 'ok' },
  stopping: { label: 'Stopping…', cls: 'muted' },
  crashed: { label: 'Crashed', cls: 'err' }
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

  if (!snapshot) return <div className="panel"><PanelHeader title="Services" /></div>
  const anyRunning = snapshot.services.some((x) => x.status === 'running' || x.status === 'starting' || x.status === 'waiting')

  return (
    <div className="panel">
      <PanelHeader title="Services">
        {snapshot.services.length > 0 && (
          <>
            <button className="btn run-all" onClick={() => void svc.startAll(tab.id, tab.cwd)} title="Start every autostart service, each in its own process. Services wait only for what they depend on.">
              <Icon name="run-all" /> Run all
            </button>
            <IconButton icon="debug-stop" title="Stop all" onClick={() => void svc.stopAll(tab.id, tab.cwd)} disabled={!anyRunning} />
          </>
        )}
        <IconButton icon="go-to-file" title="Open services.json" onClick={() => void window.glassbox.openPath(snapshot.configPath)} disabled={!snapshot.exists} />
      </PanelHeader>
      {snapshot.error && <div className="note note-error">{snapshot.error}</div>}
      {!snapshot.exists ? (
        <div className="services-empty">
          <span className="muted" title="Add .glassbox/services.json to start this project’s services with one click. Claude can work out the commands for you.">No services set up.</span>
          <button className="btn quiet" disabled={!canSend} onClick={() => runSide({ kind: 'services', title: 'Set up services', prompt: SETUP_PROMPT, tools: [...READ_TOOLS, 'Write', 'Edit'] })}>
            Ask Claude to set them up
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
                      <span className={x.port && x.config.port && x.port !== x.config.port ? 'tag warn-tag' : 'tag'} title={x.port && x.port !== x.config.port ? `Usually ${x.config.port}; that was taken, so this session uses ${x.port}` : 'This session’s port'}>
                        :{x.port ?? x.config.port}
                      </span>
                    )}{' '}
                    <span className="muted mono small">{x.config.command}</span>
                  </span>
                  <span className={`small ${st.cls}`} title={x.waitingFor?.length ? `Starts once ${x.waitingFor.join(' and ')} ${x.waitingFor.length > 1 ? 'are' : 'is'} ready (its readyPattern appears in the log)` : undefined}>
                    {x.status === 'waiting' && x.waitingFor?.length ? `Waiting for ${x.waitingFor.join(', ')}` : st.label}
                  </span>
                  {x.config.url && live && <IconButton icon="globe" title="Preview it in Glassbox" onClick={() => showPanel('preview')} />}
                  {x.config.url && live && <IconButton icon="link-external" title={`Open ${x.config.url} in your browser`} onClick={() => void window.glassbox.openExternal(x.config.url!)} />}
                  {live ? (
                    <>
                      <IconButton icon="debug-restart" title="Restart" onClick={() => void svc.restart(tab.id, tab.cwd, x.name)} />
                      <IconButton icon="debug-stop" title="Stop" onClick={() => void svc.stop(tab.id, tab.cwd, x.name)} />
                    </>
                  ) : (
                    <IconButton icon="play" title="Start" onClick={() => void svc.start(tab.id, tab.cwd, x.name)} />
                  )}
                </div>
              )
            })}
            {snapshot.services.some((x) => !x.config.port) && (
              <div className="services-note small muted">
                <span title="Every session runs its own copy of these services. Services with a port set get a random free port of their own in each session; the others would clash.">Services without a port can clash between sessions.</span>{' '}
                <button
                  className="link small"
                  disabled={!canSend}
                  onClick={() => runSide({ kind: 'services', title: 'Per-session ports', prompt: PER_SESSION_PROMPT, tools: [...READ_TOOLS, 'Write', 'Edit'] })}
                >
                  Ask Claude to set up ports
                </button>
              </div>
            )}
            <div className="row-actions pad-x">
              <input
                className="grow"
                placeholder="Ask Claude to change services, e.g. add the worker with a 5s delay"
                value={change}
                onChange={(e) => setChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && change.trim() && canSend) {
                    runSide({ kind: 'services', title: 'Change services', prompt: `Update .glassbox/services.json: ${change.trim()}. Check the repo for the real commands, ports and ready log lines.`, tools: [...READ_TOOLS, 'Write', 'Edit'] })
                    setChange('')
                  }
                }}
              />
            </div>
          </div>
          <div className="preview">
            <div className="preview-bar">
              <div className="log-tabs grow" role="tablist" aria-label="Service terminals">
                {snapshot.services.map((x) => (
                  <button
                    key={x.name}
                    role="tab"
                    aria-selected={x.name === selected}
                    className={x.name === selected ? 'log-tab active' : 'log-tab'}
                    onClick={() => setSelected(x.name)}
                    title={`${x.name}: ${STATUS[x.status].label}`}
                  >
                    <span className={`dot dot-${STATUS[x.status].cls}${x.status === 'starting' ? ' pulse' : ''}`} />
                    {x.name}
                  </button>
                ))}
              </div>
              <IconButton icon="copy" title="Copy logs" onClick={() => void navigator.clipboard.writeText(stripAnsi((logs[selected ?? ''] ?? []).join('\n')))} />
              <IconButton
                icon="comment-discussion"
                title="Ask Claude about these logs"
                disabled={!canSend || !selected}
                onClick={() =>
                  runSide({
                    kind: 'services',
                    title: `Diagnose ${selected}`,
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
