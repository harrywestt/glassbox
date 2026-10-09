import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename } from 'node:path'
import type { GlassboxSignal, SessionEvent, TaskStep } from '../shared/events'

/**
 * Watch-only links: teammates on the same network follow a session live, read-only, in a browser.
 *
 * Privacy: the feed is a compact summary derived from SessionEvents. It never carries raw tool
 * results, file contents, tool inputs beyond a one-line summary, or permission inputs.
 */

const PORT_RANGE = [4870, 4890] as const
const MAX_ENTRIES = 500
const MAX_TEXT = 2000
const MAX_THINKING = 300
const MAX_LINE = 160
const HEARTBEAT_MS = 25_000

type ToolStatus = 'running' | 'done' | 'error' | 'blocked'

type WatchEntry =
  | { id: number; at: number; kind: 'text'; text: string }
  | { id: number; at: number; kind: 'thinking'; text: string }
  | { id: number; at: number; kind: 'prompt'; text: string }
  | { id: number; at: number; kind: 'tool'; name: string; summary: string; status: ToolStatus }
  | { id: number; at: number; kind: 'task'; summary: string }
  | { id: number; at: number; kind: 'decision'; decisionKind: string; title: string; detail?: string }
  | { id: number; at: number; kind: 'guard'; label: string; action: 'block' | 'ask'; toolName: string }
  | { id: number; at: number; kind: 'status'; status: string }
  | { id: number; at: number; kind: 'result'; ok: boolean; durationMs: number; turns?: number }
  | { id: number; at: number; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type NewEntry = DistributiveOmit<WatchEntry, 'id' | 'at'>

/** What a watcher sees as the session's live state. */
type WatchState = {
  status: 'starting' | 'working' | 'waiting' | 'needs-you' | 'error' | 'stopped'
  task?: { summary: string; steps?: TaskStep[] }
}

type Share = {
  token: string
  tokenBuf: Buffer
  title: string
  cwd: string
  entries: WatchEntry[]
  tools: Map<string, WatchEntry & { kind: 'tool' }>
  clients: Set<ServerResponse>
  nextId: number
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string, n = MAX_LINE) => clip(s.replace(/\s+/g, ' ').trim(), n)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }

function blocksOf(message: unknown): Block[] | string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? (content as Block[]) : undefined
}

/** A short, content-free description of what a tool call does. */
export function toolSummary(name: string, rawInput: unknown, cwd: string): string {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const rel = (p: string) => {
    const a = p.replace(/\\/g, '/')
    const b = cwd.replace(/\\/g, '/').replace(/\/$/, '')
    return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : a
  }
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(str(input.description) ?? str(input.command) ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? oneLine(rel(path)) : ''
    case 'Grep':
    case 'Glob':
      return oneLine([str(input.pattern), path && `in ${rel(path)}`].filter(Boolean).join(' '))
    case 'WebFetch':
      return oneLine(str(input.url) ?? '')
    case 'WebSearch':
      return oneLine(str(input.query) ?? '')
    case 'Agent':
    case 'Task':
      return oneLine(str(input.description) ?? str(input.subagent_type) ?? '')
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} to-dos` : ''
    case 'Skill':
      return oneLine(str(input.skill) ?? '')
    case 'mcp__glassbox__show_diagram':
    case 'mcp__glassbox__show_sketch':
      return oneLine(str(input.title) ?? '')
    case 'mcp__glassbox__pin_file':
      return path ? oneLine(rel(path)) : ''
    case 'mcp__glassbox__showcase_ready':
      return oneLine(str(input.title) ?? '')
  }
  if (path) return oneLine(rel(path))
  for (const key of ['description', 'title', 'query', 'name', 'url']) {
    const v = str(input[key])
    if (v) return oneLine(v)
  }
  return ''
}

/** Readable tool name: mcp__server__tool → "server: tool". */
function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}` : name
}

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '0.0.0.0')
  })
}

export class WatchServer {
  private server?: Server
  private starting?: Promise<number>
  private port = 0
  private shares = new Map<string, Share>() // by tabId
  private states = new Map<string, WatchState>() // by tabId, kept for every tab so a late share has status and task
  private heartbeat?: NodeJS.Timeout

  constructor() {}

  async share(tabId: string, title: string, cwd: string): Promise<{ url: string; lanUrl: string | null }> {
    let s = this.shares.get(tabId)
    if (!s) {
      const token = randomBytes(18).toString('base64url')
      s = { token, tokenBuf: Buffer.from(token), title, cwd, entries: [], tools: new Map(), clients: new Set(), nextId: 1 }
      this.shares.set(tabId, s)
    } else {
      s.title = title
      s.cwd = cwd
      this.broadcast(s, 'meta', this.meta(s))
    }
    let port: number
    try {
      port = await this.ensureServer()
    } catch (err) {
      this.shares.delete(tabId)
      throw err
    }
    const path = `/w/${s.token}`
    const lan = lanAddress()
    return { url: `http://127.0.0.1:${port}${path}`, lanUrl: lan ? `http://${lan}:${port}${path}` : null }
  }

  unshare(tabId: string): void {
    const s = this.shares.get(tabId)
    if (!s) return
    this.shares.delete(tabId)
    for (const res of s.clients) {
      res.write('event: end\ndata: {}\n\n')
      res.end()
    }
    s.clients.clear()
    if (!this.shares.size) this.stopServer()
  }

  isShared(tabId: string): boolean {
    return this.shares.has(tabId)
  }

  /** Optional: drop the small per-tab state kept for unshared tabs (call when a tab closes). */
  forget(tabId: string): void {
    this.unshare(tabId)
    this.states.delete(tabId)
  }

  publish(tabId: string, event: SessionEvent): void {
    const state = this.states.get(tabId) ?? { status: 'starting' }
    this.states.set(tabId, state)
    const s = this.shares.get(tabId)
    const before = JSON.stringify(state)
    this.apply(state, s, event)
    if (s && JSON.stringify(state) !== before) this.broadcast(s, 'state', state)
  }

  dispose(): void {
    for (const tabId of [...this.shares.keys()]) this.unshare(tabId)
    this.stopServer()
    this.states.clear()
  }

  // Event → state and feed

  private apply(state: WatchState, s: Share | undefined, event: SessionEvent) {
    const add = (e: NewEntry) => s && this.add(s, e)
    switch (event.kind) {
      case 'status': {
        const next = event.status === 'running' ? 'working' : event.status === 'ready' ? 'waiting' : event.status
        if (next === 'waiting' && state.status === 'error') return // keep the error visible until work resumes
        if (state.status !== next) {
          state.status = next
          if (next === 'stopped') add({ kind: 'status', status: 'Session stopped' })
        }
        return
      }
      case 'permission':
        state.status = 'needs-you'
        add({ kind: 'notice', level: 'warn', text: event.toolName === 'ExitPlanMode' ? 'Waiting for the user to review a plan' : `Waiting for approval to use ${toolLabel(event.toolName)}` })
        return
      case 'permission-cancelled':
        if (state.status === 'needs-you') state.status = 'working'
        return
      case 'error':
        state.status = 'error'
        add({ kind: 'notice', level: 'error', text: oneLine(event.message, 300) })
        return
      case 'alert':
        add({ kind: 'notice', level: event.level, text: oneLine(event.text, 300) })
        return
      case 'guard': {
        const { hit } = event
        add({ kind: 'guard', label: hit.label, action: hit.action, toolName: toolLabel(hit.toolName) })
        const tool = s?.tools.get(hit.toolUseId)
        if (s && tool && hit.action === 'block') this.setToolStatus(s, tool, 'blocked')
        return
      }
      case 'glassbox':
        this.applySignal(state, s, event.signal)
        return
      case 'sdk': {
        const msg = event.msg
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) this.applyAssistant(state, s, msg.message)
        else if (msg.type === 'user') this.applyToolResults(s, msg.message)
        else if (msg.type === 'result') {
          state.status = msg.is_error ? 'error' : 'waiting'
          add({ kind: 'result', ok: !msg.is_error, durationMs: msg.duration_ms, turns: msg.num_turns })
          // Anything still marked running when the turn ends didn't report back.
          if (s) for (const t of s.tools.values()) if (t.status === 'running') this.setToolStatus(s, t, msg.is_error ? 'error' : 'done')
        }
        return
      }
      case 'history':
        for (const m of event.messages) {
          if (m.parent_tool_use_id) continue
          if (m.type === 'assistant') this.applyAssistant(state, s, m.message)
          else if (m.type === 'user') {
            const blocks = blocksOf(m.message)
            const text = typeof blocks === 'string' ? blocks : blocks?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
            // Skip command wrappers and system reminders injected as user turns.
            if (text && text.trim() && !text.trimStart().startsWith('<')) add({ kind: 'prompt', text: clip(text.trim(), MAX_TEXT) })
            this.applyToolResults(s, m.message)
          }
        }
        return
    }
  }

  private applySignal(state: WatchState, s: Share | undefined, signal: GlassboxSignal) {
    if (signal.type !== 'task') return
    this.setTask(state, s, signal.summary, signal.steps)
  }

  private setTask(state: WatchState, s: Share | undefined, summary: string, steps?: TaskStep[]) {
    const task = { summary: clip(summary, 300), steps: steps?.slice(0, 40).map((st) => ({ label: clip(st.label, 200), status: st.status })) }
    const prev = state.task
    const sameSummary = prev?.summary === task.summary
    if (sameSummary && JSON.stringify(prev?.steps) === JSON.stringify(task.steps)) return
    state.task = task
    if (!sameSummary && s) this.add(s, { kind: 'task', summary: task.summary })
  }

  private applyAssistant(state: WatchState, s: Share | undefined, message: unknown) {
    const blocks = blocksOf(message)
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === 'mcp__glassbox__set_current_task') {
        const input = (b.input ?? {}) as { summary?: unknown; steps?: unknown }
        if (typeof input.summary === 'string') this.setTask(state, s, input.summary, Array.isArray(input.steps) ? (input.steps as TaskStep[]) : undefined)
        continue
      }
      if (!s) continue
      if (b.type === 'text' && b.text?.trim()) this.add(s, { kind: 'text', text: clip(b.text.trim(), MAX_TEXT) })
      else if (b.type === 'thinking' && b.thinking?.trim()) this.add(s, { kind: 'thinking', text: clip(b.thinking.trim(), MAX_THINKING) })
      else if (b.type === 'tool_use' && b.name === 'mcp__glassbox__log_decision') {
        const input = (b.input ?? {}) as Record<string, unknown>
        this.add(s, {
          kind: 'decision',
          decisionKind: str(input.kind) ?? 'decision',
          title: oneLine(str(input.title) ?? '', 300),
          detail: str(input.detail) ? clip(str(input.detail)!, 600) : undefined
        })
      } else if (b.type === 'tool_use' && b.id && b.name && !s.tools.has(b.id)) {
        const entry = this.add(s, { kind: 'tool', name: toolLabel(b.name), summary: toolSummary(b.name, b.input, s.cwd), status: 'running' })
        s.tools.set(b.id, entry as WatchEntry & { kind: 'tool' })
      }
    }
  }

  private applyToolResults(s: Share | undefined, message: unknown) {
    const blocks = blocksOf(message)
    if (!s || !Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const tool = s.tools.get(b.tool_use_id)
      if (tool && tool.status !== 'blocked') this.setToolStatus(s, tool, b.is_error ? 'error' : 'done')
    }
  }

  private setToolStatus(s: Share, tool: WatchEntry & { kind: 'tool' }, status: ToolStatus) {
    if (tool.status === status) return
    tool.status = status
    this.broadcast(s, 'update', { id: tool.id, status })
  }

  private add(s: Share, e: NewEntry): WatchEntry {
    const entry = { ...e, id: s.nextId++, at: Date.now() } as WatchEntry
    s.entries.push(entry)
    while (s.entries.length > MAX_ENTRIES) {
      const old = s.entries.shift()
      if (old?.kind === 'tool') for (const [k, v] of s.tools) if (v === old) s.tools.delete(k)
    }
    this.broadcast(s, 'entry', entry)
    return entry
  }

  // HTTP

  private meta(s: Share) {
    return { title: s.title, folder: basename(s.cwd) || s.cwd }
  }

  private broadcast(s: Share, event: string, data: unknown) {
    if (!s.clients.size) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of s.clients) res.write(frame)
  }

  private ensureServer(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = (async () => {
      const server = createServer((req, res) => this.handle(req, res))
      server.keepAliveTimeout = 5_000
      let port = 0
      for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1] && !port; p++) {
        try {
          port = await listen(server, p)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err
        }
      }
      if (!port) port = await listen(server, 0)
      this.server = server
      this.port = port
      this.heartbeat = setInterval(() => {
        for (const s of this.shares.values()) for (const res of s.clients) res.write(': ping\n\n')
      }, HEARTBEAT_MS)
      return port
    })().finally(() => (this.starting = undefined))
    return this.starting
  }

  private stopServer() {
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    const server = this.server
    this.server = undefined
    this.port = 0
    if (!server) return
    server.close()
    server.closeAllConnections()
  }

  /** Constant-time lookup: every share's token is compared, whatever matches first. */
  private findShare(token: string): Share | undefined {
    const candidate = Buffer.from(token)
    let found: Share | undefined
    for (const s of this.shares.values()) {
      const same = candidate.length === s.tokenBuf.length && timingSafeEqual(candidate, s.tokenBuf)
      if (same) found = s
    }
    return found
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed')
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    const m = /^\/w\/([A-Za-z0-9_-]{24})(\/events)?$/.exec(path)
    const s = m ? this.findShare(m[1]) : undefined
    if (!m || !s) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    if (m[2]) this.serveEvents(req, res, s)
    else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP })
      res.end(req.method === 'HEAD' ? undefined : PAGE_HTML)
    }
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse, s: Share) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    if (req.method === 'HEAD') return void res.end()
    res.socket?.setNoDelay(true)
    res.socket?.setTimeout(0)
    const tabId = [...this.shares].find(([, v]) => v === s)?.[0]
    const state = (tabId && this.states.get(tabId)) || { status: 'starting' }
    res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify({ meta: this.meta(s), state, entries: s.entries })}\n\n`)
    s.clients.add(res)
    const drop = () => s.clients.delete(res)
    req.on('close', drop)
    res.on('error', drop)
  }
}

// The watch page: static, self-contained, no server-side interpolation. Everything dynamic
// arrives over SSE and is rendered with textContent only.

const PAGE_CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e4e4e2;--accent:#2f8ea3;--amber:#b7791f;--red:#c9383e;--green:#2f8f4e;--code:#f0f0ee}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--panel:#1f1f21;--text:#e8e8ea;--muted:#9a9aa0;--line:#2e2e31;--accent:#4fb3c8;--amber:#e3a33b;--red:#f06a6f;--green:#58c07a;--code:#28282b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 20px}
.wrap{max-width:860px;margin:0 auto}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:17px;font-weight:600;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.folder{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:13px;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.s-working .dot{background:var(--accent);animation:pulse 1.4s ease-in-out infinite}
.s-waiting .dot{background:var(--green)}
.s-needs-you .dot{background:var(--amber)}
.s-error .dot{background:var(--red)}
@keyframes pulse{50%{opacity:.35}}
.conn{font-size:12px;color:var(--muted)}
main{padding:16px 20px 60px}
.task{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.task .label{font-size:12px;color:var(--muted);margin-bottom:2px}
.task .summary{font-weight:600}
.steps{list-style:none;margin:8px 0 0;padding:0}
.steps li{display:flex;gap:8px;padding:2px 0;color:var(--muted)}
.steps li.active{color:var(--text);font-weight:500}
.steps li.done{text-decoration:line-through;text-decoration-color:var(--line)}
.steps .mark{width:16px;flex:none;text-align:center}
.feed{display:flex;flex-direction:column;gap:6px}
.e{display:flex;gap:10px;align-items:flex-start;padding:6px 2px;border-radius:6px}
.e time{flex:none;width:44px;color:var(--muted);font-size:12px;padding-top:2px;font-variant-numeric:tabular-nums}
.e .body{flex:1;min-width:0}
.e .k{font-size:12px;color:var(--muted)}
.text .body{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.prompt .body{border-left:3px solid var(--accent);padding-left:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.thinking .body{color:var(--muted);font-style:italic;overflow-wrap:anywhere}
.tool .body{display:flex;gap:8px;align-items:baseline;min-width:0}
.tool .name{font-weight:500;flex:none}
.tool .sum{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12.5px;background:var(--code);padding:1px 6px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tool .st{flex:none;font-size:12px;color:var(--muted);margin-left:auto}
.tool.running .st{color:var(--accent)}
.tool.error .st,.tool.blocked .st{color:var(--red)}
.decision .body,.guard .body,.notice .body,.task-e .body,.result .body,.status .body{overflow-wrap:anywhere}
.guard .body,.notice.error .body{color:var(--red)}
.notice.warn .body{color:var(--amber)}
.result .body,.status .body{color:var(--muted);font-size:13px}
.detail{color:var(--muted);font-size:13px}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.banner{display:none;margin:0 0 12px;padding:10px 12px;border-radius:8px;background:var(--panel);border:1px solid var(--line);color:var(--muted)}
.banner.show{display:block}
.hidden{display:none}
`

const PAGE_JS = `
(function(){
  var $ = function(id){ return document.getElementById(id) };
  var feed = $('feed'), taskBox = $('task'), conn = $('conn'), banner = $('banner');
  var byId = {};
  var STATUS = { starting: 'Starting', working: 'Working', waiting: 'Waiting for the user', 'needs-you': 'Needs the user', error: 'Error', stopped: 'Stopped' };
  var TOOL = { running: 'Running', done: 'Done', error: 'Failed', blocked: 'Blocked' };
  var KIND = { decision: 'Decision', assumption: 'Assumption', question: 'Question for the user' };
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function hhmm(t){ var d = new Date(t); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') }
  function dur(ms){ var s = Math.round(ms/1000); return s < 60 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's' }
  function nearBottom(){ return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80 }

  function meta(m){ $('title').textContent = m.title || 'Glassbox session'; $('folder').textContent = m.folder || ''; document.title = (m.title || 'Session') + ' · Glassbox' }
  function state(s){
    var p = $('status'); p.className = 'pill s-' + s.status; $('statusText').textContent = STATUS[s.status] || s.status;
    taskBox.textContent = '';
    taskBox.classList.toggle('hidden', !s.task);
    if (!s.task) return;
    taskBox.appendChild(el('div', 'label', 'Current task'));
    taskBox.appendChild(el('div', 'summary', s.task.summary));
    if (s.task.steps && s.task.steps.length) {
      var ul = el('ul', 'steps');
      s.task.steps.forEach(function(st){
        var li = el('li', st.status);
        li.appendChild(el('span', 'mark', st.status === 'done' ? '\\u2713' : st.status === 'active' ? '\\u25B8' : '\\u25CB'));
        li.appendChild(el('span', null, st.label));
        ul.appendChild(li);
      });
      taskBox.appendChild(ul);
    }
  }
  function render(e){
    var row = el('div', 'e ' + (e.kind === 'task' ? 'task-e' : e.kind));
    var body = el('div', 'body');
    row.appendChild(el('time', null, hhmm(e.at)));
    row.appendChild(body);
    switch (e.kind) {
      case 'text': body.textContent = e.text; break;
      case 'prompt': body.appendChild(el('div', 'k', 'User')); body.appendChild(el('div', null, e.text)); break;
      case 'thinking': body.textContent = e.text; break;
      case 'tool':
        row.classList.add(e.status);
        body.appendChild(el('span', 'name', e.name));
        if (e.summary) body.appendChild(el('span', 'sum', e.summary));
        var st = el('span', 'st', TOOL[e.status] || e.status); body.appendChild(st);
        row._st = st; break;
      case 'task': body.appendChild(el('div', 'k', 'New task')); body.appendChild(el('div', null, e.summary)); break;
      case 'decision':
        body.appendChild(el('div', 'k', KIND[e.decisionKind] || 'Decision'));
        body.appendChild(el('div', null, e.title));
        if (e.detail) body.appendChild(el('div', 'detail', e.detail)); break;
      case 'guard': body.textContent = (e.action === 'block' ? 'Guardrail blocked ' : 'Guardrail asked before ') + e.toolName + ': ' + e.label; break;
      case 'status': body.textContent = e.status; break;
      case 'result': body.textContent = (e.ok ? 'Finished' : 'Stopped with an error') + ' after ' + dur(e.durationMs) + (e.turns ? ', ' + e.turns + (e.turns === 1 ? ' turn' : ' turns') : ''); break;
      case 'notice': row.classList.add(e.level); body.textContent = e.text; break;
    }
    byId[e.id] = row;
    return row;
  }
  function add(e){
    var stick = nearBottom();
    var empty = feed.querySelector('.empty'); if (empty) empty.remove();
    feed.appendChild(render(e));
    while (feed.children.length > 600) { feed.firstChild.remove() }
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }
  function update(u){
    var row = byId[u.id]; if (!row || !row._st) return;
    row.classList.remove('running','done','error','blocked'); row.classList.add(u.status);
    row._st.textContent = TOOL[u.status] || u.status;
  }

  var es = null, delay = 1000, ended = false;
  function connect(){
    if (ended) return;
    conn.textContent = 'Connecting';
    es = new EventSource(location.pathname.replace(/\\/$/, '') + '/events');
    es.addEventListener('snapshot', function(m){
      var d = JSON.parse(m.data); delay = 1000; conn.textContent = 'Live'; banner.classList.remove('show');
      feed.textContent = ''; byId = {};
      meta(d.meta); state(d.state);
      if (!d.entries.length) feed.appendChild(el('div', 'empty', 'Nothing yet. Activity shows up here as Claude works.'));
      d.entries.forEach(function(e){ feed.appendChild(render(e)) });
      window.scrollTo(0, document.body.scrollHeight);
    });
    es.addEventListener('meta', function(m){ meta(JSON.parse(m.data)) });
    es.addEventListener('state', function(m){ state(JSON.parse(m.data)) });
    es.addEventListener('entry', function(m){ add(JSON.parse(m.data)) });
    es.addEventListener('update', function(m){ update(JSON.parse(m.data)) });
    es.addEventListener('end', function(){
      ended = true; es.close(); conn.textContent = 'Offline';
      banner.textContent = 'Sharing has stopped for this session.'; banner.classList.add('show');
    });
    es.onerror = function(){
      if (ended) return;
      conn.textContent = 'Reconnecting';
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up (server gone or link revoked): retry with backoff.
        banner.textContent = 'Lost connection. Retrying.'; banner.classList.add('show');
        setTimeout(connect, delay); delay = Math.min(delay * 2, 30000);
      }
    };
  }
  connect();
})();
`

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Glassbox session</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header><div class="wrap">
  <div class="row"><h1 id="title">Glassbox session</h1><span id="status" class="pill"><span class="dot"></span><span id="statusText">Connecting</span></span></div>
  <div class="row"><span class="folder" id="folder"></span><span class="conn" id="conn"></span><span class="conn">Read-only view</span></div>
</div></header>
<main><div class="wrap">
  <div id="banner" class="banner"></div>
  <section id="task" class="task hidden"></section>
  <section id="feed" class="feed"><div class="empty">Connecting…</div></section>
</div></main>
<script>${PAGE_JS}</script>
</body>
</html>`

const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

// Only the page's own inline style and script (by hash) may run; the only connection allowed is back to this server.
const PAGE_CSP = [
  "default-src 'none'",
  `style-src ${sha(PAGE_CSS)}`,
  `script-src ${sha(PAGE_JS)}`,
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')
