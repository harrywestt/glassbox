import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { ServiceConfig, ServicesEvent, ServicesSnapshot, ServiceState } from '../shared/events'
import { tr } from '../shared/i18n'

export const SERVICES_FILE = join('.glassbox', 'services.json')

/**
 * A worktree starts without the services file (it isn't in git), so it wouldn't know how to start
 * anything. Copy it from the main checkout of the same repo when this folder has none. Each worktree
 * then has its own copy to change; their services run side by side on their own ports.
 */
export function adoptServicesFile(cwd: string): boolean {
  const own = join(cwd, SERVICES_FILE)
  if (existsSync(own)) return false
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const top = git(['rev-parse', '--show-toplevel'])
    const main = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']))
    if (resolve(main).toLowerCase() === resolve(top).toLowerCase()) return false // this is the main checkout
    // The same place inside the main checkout (a session can be in a subfolder of the repo).
    const rel = resolve(cwd).slice(resolve(top).length)
    const from = join(main, rel, SERVICES_FILE)
    if (!existsSync(from)) return false
    mkdirSync(dirname(own), { recursive: true })
    copyFileSync(from, own)
    return true
  } catch {
    return false
  }
}
const LOG_LIMIT = 3000
const READY_TIMEOUT_MS = 90_000

type Running = { proc: ChildProcess; state: ServiceState; logs: string[]; ready: Promise<boolean>; markReady: (ok: boolean) => void }

/** Runs the services declared in a project's .glassbox/services.json, for one session. */
export class ProjectServices {
  /** Ports this session's services were given, by service name. */
  private assigned = new Map<string, number>()
  /** Services queued by Run all, and the dependencies they're still waiting on. */
  private waiting = new Map<string, string[]>()
  private configs: ServiceConfig[] = []
  private error?: string
  private running = new Map<string, Running>()
  private stopped = new Map<string, ServiceState & { logs: string[] }>()
  private pendingLogs = new Map<string, string[]>()
  private flushTimer?: NodeJS.Timeout
  readonly configPath: string

  constructor(
    readonly scope: string,
    readonly cwd: string,
    private emit: (e: ServicesEvent) => void,
    private ports: PortBook
  ) {
    this.configPath = join(cwd, SERVICES_FILE)
    adoptServicesFile(cwd)
    this.load()
    watchFile(this.configPath, { interval: 1500 }, () => {
      this.load()
      this.emitState()
    })
  }

  /** Re-reads the services file (also done automatically when it changes). */
  load() {
    this.error = undefined
    if (!existsSync(this.configPath)) {
      this.configs = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as { services?: ServiceConfig[] }
      if (!Array.isArray(parsed.services)) throw new Error(tr('mainServices.expectedArray'))
      for (const s of parsed.services) {
        if (!s.name || !s.command) throw new Error(tr('mainServices.needsNameCommand'))
      }
      this.configs = parsed.services
    } catch (err) {
      this.error = tr('mainServices.couldNotRead', { file: SERVICES_FILE, error: err instanceof Error ? err.message : String(err) })
    }
  }

  snapshot(): ServicesSnapshot {
    return {
      scope: this.scope,
      cwd: this.cwd,
      configPath: this.configPath,
      exists: existsSync(this.configPath),
      error: this.error,
      services: this.configs.map((c) => this.stateOf(c.name))
    }
  }

  logs(name: string): string[] {
    return this.running.get(name)?.logs ?? this.stopped.get(name)?.logs ?? []
  }

  private stateOf(name: string): ServiceState {
    const config = this.configs.find((c) => c.name === name)!
    const running = this.running.get(name)?.state
    if (running) return running
    const waitingFor = this.waiting.get(name)
    if (waitingFor) return { name, status: 'waiting', config: { ...config, url: this.fill(config.url, config) }, waitingFor }
    return this.stopped.get(name) ?? { name, status: 'stopped', config: { ...config, url: this.fill(config.url, config) } }
  }

  private emitState() {
    this.emit({ kind: 'state', snapshot: this.snapshot() })
  }

  /**
   * Starts every autostart service, each in its own process. Independent services start together;
   * a service waits only for its own dependsOn to be ready, and is skipped if one of them fails.
   */
  async startAll() {
    const launches = new Map<string, Promise<boolean>>()
    const launch = (name: string, chain: string[] = []): Promise<boolean> => {
      if (chain.includes(name)) return Promise.reject(new Error(tr('mainServices.circular', { chain: [...chain, name].join(' → ') })))
      const existing = launches.get(name)
      if (existing) return existing
      const config = this.configs.find((c) => c.name === name)
      if (!config) return Promise.reject(new Error(tr('mainServices.unknownDependency', { name })))
      const p = (async () => {
        const deps = config.dependsOn ?? []
        // Show it as waiting (not stopped) until what it depends on is ready.
        const pending = new Set(deps)
        if (deps.length) {
          this.waiting.set(name, [...pending])
          this.emitState()
        }
        const ok = await Promise.all(
          deps.map((d) =>
            launch(d, [...chain, name]).then((r) => {
              pending.delete(d)
              if (this.waiting.has(name) && pending.size) {
                this.waiting.set(name, [...pending])
                this.emitState()
              }
              return r
            })
          )
        )
        this.waiting.delete(name)
        const failed = deps.filter((_, i) => !ok[i])
        if (failed.length) {
          this.noteSkipped(name, tr('mainServices.notStarted', { deps: failed.join(', ') }))
          return false
        }
        return this.start(name)
      })()
      launches.set(name, p)
      return p
    }
    await Promise.all(this.configs.filter((c) => c.autostart !== false).map((c) => launch(c.name)))
  }

  private noteSkipped(name: string, message: string) {
    const config = this.configs.find((c) => c.name === name)!
    const prev = this.stopped.get(name)
    const logs = prev?.logs ?? []
    this.stopped.set(name, { ...(prev ?? { name, config }), status: 'stopped', logs })
    this.appendLog(name, logs, `\x1b[33m${message}\x1b[0m`)
    this.emitState()
  }

  async start(name: string): Promise<boolean> {
    const existing = this.running.get(name)
    if (existing) return existing.ready
    const config = this.configs.find((c) => c.name === name)
    if (!config) throw new Error(tr('mainServices.noService', { name }))
    for (const dep of config.dependsOn ?? []) {
      const run = this.running.get(dep)
      if (run && !(await run.ready)) return false
    }

    const logs = this.stopped.get(name)?.logs ?? []
    // Every service with a port gets this session's own (random, free) port, all reserved together
    // so ${port:other} points at this session's copy even before that one starts.
    const first = !logs.length
    await this.reservePorts()
    const port = config.port ? this.assigned.get(name) : undefined
    if (port && first) logs.push(`\x1b[90m${tr('mainServices.sessionPort', { name, port, usual: config.port })}\x1b[0m`)
    const command = this.fill(config.command, config)!
    const env: Record<string, string> = { ...(port ? { PORT: String(port) } : {}), ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, this.fill(v, config)!])) }
    logs.push(`\x1b[90m▶ ${command}\x1b[0m`)
    const proc = spawn(command, {
      cwd: resolve(this.cwd, config.cwd ?? '.'),
      env: { ...process.env, FORCE_COLOR: '1', ...env },
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let markReady!: (ok: boolean) => void
    const ready = new Promise<boolean>((r) => (markReady = r))
    const run: Running = { proc, logs, ready, markReady, state: { name, status: 'starting', config: { ...config, command, url: this.fill(config.url, config) }, pid: proc.pid, startedAt: Date.now(), port } }
    this.running.set(name, run)
    this.stopped.delete(name)

    const pattern = config.readyPattern ? new RegExp(this.fill(config.readyPattern, config)!, 'i') : null
    const setReady = () => {
      if (run.state.status !== 'starting') return
      run.state = { ...run.state, status: 'running' }
      markReady(true)
      this.emitState()
    }
    if (!pattern) setTimeout(setReady, 1500)
    setTimeout(() => {
      if (run.state.status === 'starting') {
        this.appendLog(name, run.logs, `\x1b[33m${tr('mainServices.noReadyMatch', { seconds: READY_TIMEOUT_MS / 1000 })}\x1b[0m`)
        setReady()
      }
    }, READY_TIMEOUT_MS)

    // Errors are reported with the lines that follow (the stack), at most one every 15s per service.
    let errorLines: string[] | null = null
    let quietUntil = 0
    const onLine = (line: string) => {
      if (!line) return
      this.appendLog(name, run.logs, line)
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
      if (pattern?.test(plain)) setReady()
      if (errorLines) {
        if (errorLines.length < 8) errorLines.push(plain)
        return
      }
      if (Date.now() < quietUntil || !looksLikeError(plain)) return
      errorLines = [plain]
      setTimeout(() => {
        this.emit({ kind: 'error', scope: this.scope, name, text: errorLines!.join('\n'), at: Date.now() })
        errorLines = null
        quietUntil = Date.now() + 15_000
      }, 400)
    }
    // Output arrives in arbitrary chunks: keep the unfinished last line until the rest arrives, so a
    // long line (JSON logs) is never split and the ready pattern can't be missed.
    const lineReader = () => {
      let rest = ''
      return {
        data: (chunk: Buffer) => {
          const parts = (rest + chunk.toString('utf8')).split(/\r?\n/)
          rest = parts.pop() ?? ''
          parts.forEach(onLine)
        },
        end: () => {
          if (rest) onLine(rest)
          rest = ''
        }
      }
    }
    const out = lineReader()
    const err = lineReader()
    proc.stdout?.on('data', out.data)
    proc.stderr?.on('data', err.data)
    proc.stdout?.on('end', out.end)
    proc.stderr?.on('end', err.end)
    proc.on('exit', (code, signal) => {
      if (this.running.get(name) !== run) return
      this.running.delete(name)
      // The port stays this session's, so a restart comes back on the same one (and links still work).
      // Exiting before it was ready means it failed to start; a clean exit after that is fine.
      markReady(run.state.status === 'running' || code === 0)
      const crashed = run.state.status !== 'stopping' && code !== 0
      this.appendLog(name, run.logs, `\x1b[90m${signal ? tr('mainServices.exitedSignal', { signal }) : tr('mainServices.exitedCode', { code })}\x1b[0m`)
      this.stopped.set(name, { ...run.state, status: crashed ? 'crashed' : 'stopped', exitCode: code ?? undefined, logs: run.logs })
      this.emitState()
    })
    proc.on('error', (err) => this.appendLog(name, run.logs, `\x1b[31m${err.message}\x1b[0m`))
    this.emitState()
    return ready
  }

  async stop(name: string) {
    const run = this.running.get(name)
    if (!run?.proc.pid) return
    run.state = { ...run.state, status: 'stopping' }
    this.emitState()
    await killTree(run.proc.pid)
  }

  async stopAll() {
    this.waiting.clear()
    this.emitState()
    await Promise.all([...this.running.keys()].map((n) => this.stop(n)))
  }

  async restart(name: string) {
    await this.stop(name)
    await new Promise((r) => setTimeout(r, 400))
    await this.start(name)
  }

  /** Claim this session's port for every service that declares one (once each; kept until the session closes). */
  private async reservePorts() {
    for (const c of this.configs) {
      if (!c.port || this.assigned.has(c.name)) continue
      this.assigned.set(c.name, await this.ports.claim(`${this.scope}/${c.name}`, c.port))
    }
  }

  /** ${port} is this service's port; ${port:name} another service's (this session's copy). */
  private fill(text: string | undefined, config: ServiceConfig): string | undefined {
    if (text === undefined) return undefined
    const portOf = (n: string) => this.assigned.get(n) ?? this.configs.find((c) => c.name === n)?.port
    return text.replace(/\$\{port(?::([\w-]+))?\}/g, (m, other: string | undefined) => String((other ? portOf(other) : portOf(config.name)) ?? m))
  }

  /** Synchronous so it completes during app shutdown. */
  dispose() {
    unwatchFile(this.configPath)
    for (const name of this.assigned.keys()) this.ports.release(`${this.scope}/${name}`)
    for (const run of this.running.values()) {
      if (!run.proc.pid) continue
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else process.kill(-run.proc.pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
    this.running.clear()
  }

  private appendLog(name: string, logs: string[], line: string) {
    logs.push(line)
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
    const pending = this.pendingLogs.get(name) ?? []
    pending.push(line)
    this.pendingLogs.set(name, pending)
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined
      for (const [n, lines] of this.pendingLogs) this.emit({ kind: 'log', scope: this.scope, cwd: this.cwd, name: n, lines })
      this.pendingLogs.clear()
    }, 120)
  }
}

/** An error or exception in a service's output (not "0 errors" summaries or debug noise). */
function looksLikeError(line: string): boolean {
  if (/\b(0|no) (errors?|warnings?)\b/i.test(line)) return false
  return (
    /"(LogLevel|level)"\s*:\s*"(Error|Critical|Fatal|error|fatal)"/.test(line) ||
    /\b(Unhandled|Uncaught)\b/.test(line) ||
    /\b\w*(Exception|Error)\b:/.test(line) ||
    /^\s*(ERROR|FATAL|Traceback \(most recent call last\)|panic:|fail:)/.test(line) ||
    /\b(EADDRINUSE|ECONNREFUSED)\b/.test(line) ||
    /"\s(500|502|503)\s|\s(500|502|503)\s+\d+(\.\d+)?\s?ms\b/.test(line)
  )
}

function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => done())
    else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
      done()
    }
  })
}

const RANDOM_LOW = 20_000
const RANDOM_HIGH = 40_000

/** Ports handed out to sessions' services, so two sessions never get the same one. */
class PortBook {
  private owners = new Map<number, string>()

  /**
   * A random free port, so every session (and every worktree) runs its own copy without clashing.
   * The usual port is left alone, for anything you run outside Glassbox.
   */
  async claim(owner: string, preferred: number): Promise<number> {
    for (const [p, o] of this.owners) if (o === owner) return p
    for (let i = 0; i < 60; i++) {
      const p = RANDOM_LOW + Math.floor(Math.random() * (RANDOM_HIGH - RANDOM_LOW))
      if (this.owners.has(p) || !(await portFree(p))) continue
      this.owners.set(p, owner)
      return p
    }
    for (let p = preferred + 1; p < preferred + 200; p++) {
      const holder = this.owners.get(p)
      if (holder && holder !== owner) continue
      if (!(await portFree(p))) continue
      this.owners.set(p, owner)
      return p
    }
    return preferred // nothing free nearby: let the service report the clash itself
  }

  release(owner: string) {
    for (const [p, o] of this.owners) if (o === owner) this.owners.delete(p)
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createServer()
    srv.once('error', () => done(false))
    srv.once('listening', () => srv.close(() => done(true)))
    srv.listen(port)
  })
}

/** Services per session (keyed by tab), so each session can run its own copy on its own ports. */
export class ServiceRegistry {
  private sessions = new Map<string, ProjectServices>()
  private ports = new PortBook()
  constructor(private emit: (e: ServicesEvent) => void) {}

  get(scope: string, cwd: string): ProjectServices {
    let p = this.sessions.get(scope)
    // The session moved to another folder: its old services go.
    if (p && resolve(p.cwd).toLowerCase() !== resolve(cwd).toLowerCase()) {
      p.dispose()
      p = undefined
    }
    if (!p) {
      p = new ProjectServices(scope, resolve(cwd), this.emit, this.ports)
      this.sessions.set(scope, p)
    }
    return p
  }

  /** Stops a session's services (when its tab closes). */
  disposeScope(scope: string) {
    this.sessions.get(scope)?.dispose()
    this.sessions.delete(scope)
  }

  disposeAll() {
    for (const p of this.sessions.values()) p.dispose()
  }
}

export const SERVICES_INSTRUCTIONS = `
Glassbox has a "Run" button that starts the project's services from ${SERVICES_FILE.replace('\\', '/')} in the working directory. Format:
{ "services": [ { "name": "api", "command": "npm run dev -- --port \${port}", "cwd": "relative/dir", "port": 3000, "env": { "API_URL": "http://localhost:\${port:api}" }, "url": "http://localhost:\${port}", "readyPattern": "listening on", "dependsOn": ["db"], "autostart": true } ] }
Only name and command are required. Each Glassbox session (and each worktree) runs its own copy of the services on its own random free ports, so declare each service's usual "port" and use \${port} (its own) and \${port:name} (another service's) wherever the port appears in command, env or url, rather than hard-coding it: that's how the web app finds this session's API. PORT is set automatically too. Shared infrastructure (databases, docker compose) usually shouldn't have a port so it isn't duplicated. When the user asks you to set up, fix or change how services start, create or edit that file. Inspect the repo (package.json scripts, docker-compose, launch settings, READMEs) to get real commands, ports and ready messages.`
