import type { Session, WebContents } from 'electron'

/**
 * What the Browser's pages say behind the scenes: console messages, and the requests they make
 * (API calls, and any request that failed). Kept per page so Claude can check for errors a page
 * doesn't show (a 500 behind a spinner, an exception in a click handler) and so the Browser can
 * flag them. Only read, never changed.
 */

export type LogEntry = {
  at: number
  kind: 'console' | 'network' | 'navigation'
  /** console: error, warning, info, log or debug. network: error for a failure (4xx, 5xx, no answer). */
  level: 'error' | 'warning' | 'info' | 'log' | 'debug'
  text: string
  /** Where a console message came from (file:line). */
  source?: string
  method?: string
  url?: string
  status?: number
  ms?: number
  type?: string
}

const KEEP = 400
const logs = new Map<number, LogEntry[]>()
/** How far Claude has been told about, per page (so each result mentions only what's new). */
const toldUpTo = new Map<number, number>()
const readUpTo = new Map<number, number>()

function push(wcId: number, e: LogEntry) {
  const list = logs.get(wcId) ?? []
  list.push(e)
  if (list.length > KEEP) list.splice(0, list.length - KEEP)
  logs.set(wcId, list)
}

const LEVELS = ['debug', 'info', 'warning', 'error'] as const
const levelOf = (l: unknown): LogEntry['level'] => (typeof l === 'string' ? (l === 'warning' || l === 'error' || l === 'info' || l === 'debug' ? l : 'log') : typeof l === 'number' ? (LEVELS[l] ?? 'log') : 'log')

/** Starts keeping a Browser page's console messages and page loads. */
export function watchPage(wc: WebContents) {
  const id = wc.id
  wc.on('console-message', (...args: unknown[]) => {
    // Newer Electron passes one details object; older, (event, level, message, line, source).
    const d = args[0] as { level?: unknown; message?: string; lineNumber?: number; sourceId?: string }
    const level = d.message !== undefined ? d.level : args[1]
    const message = d.message ?? String(args[2] ?? '')
    const line = d.lineNumber ?? (args[3] as number | undefined)
    const source = d.sourceId ?? (args[4] as string | undefined)
    // Electron's own development warning about the page's security policy is noise here.
    if (message.includes('Electron Security Warning')) return
    push(id, { at: Date.now(), kind: 'console', level: levelOf(level), text: message.slice(0, 2000), source: source ? `${source.split('/').pop()}${line ? `:${line}` : ''}` : undefined })
  })
  wc.on('did-start-navigation', (d) => {
    const e = d as unknown as { url: string; isMainFrame: boolean; isSameDocument: boolean }
    if (e.isMainFrame && !e.isSameDocument) push(id, { at: Date.now(), kind: 'navigation', level: 'info', text: e.url })
  })
  wc.once('destroyed', () => (logs.delete(id), toldUpTo.delete(id), readUpTo.delete(id)))
}

/** Starts keeping the Browser's requests: API calls (fetch, XHR) and anything that failed. */
export function watchNetwork(ses: Session) {
  const started = new Map<number, number>()
  ses.webRequest.onSendHeaders((d) => started.set(d.id, Date.now()))
  ses.webRequest.onCompleted((d) => {
    const t0 = started.get(d.id)
    started.delete(d.id)
    if (d.webContentsId === undefined) return
    const api = d.resourceType === 'xhr'
    const failed = d.statusCode >= 400
    if (!api && !failed) return
    push(d.webContentsId, { at: Date.now(), kind: 'network', level: failed ? 'error' : 'info', text: `${d.method} ${d.url} → ${d.statusCode}`, method: d.method, url: d.url, status: d.statusCode, ms: t0 ? Date.now() - t0 : undefined, type: d.resourceType })
  })
  ses.webRequest.onErrorOccurred((d) => {
    const t0 = started.get(d.id)
    started.delete(d.id)
    // A request the page itself dropped (navigating away, a superseded load) isn't a failure.
    if (d.webContentsId === undefined || d.error === 'net::ERR_ABORTED') return
    push(d.webContentsId, { at: Date.now(), kind: 'network', level: 'error', text: `${d.method} ${d.url} → ${d.error}`, method: d.method, url: d.url, ms: t0 ? Date.now() - t0 : undefined, type: d.resourceType })
  })
}

export function pageLogs(wcId: number): LogEntry[] {
  return logs.get(wcId) ?? []
}

export function clearLogs(wcId: number) {
  logs.set(wcId, [])
  toldUpTo.delete(wcId)
  readUpTo.delete(wcId)
}

const isProblem = (e: LogEntry) => e.level === 'error' || (e.kind === 'console' && e.level === 'warning')

/** For a tool's result: problems the page reported since Claude was last told, in one line (or nothing). */
export function newProblems(wcId: number): string {
  const list = logs.get(wcId) ?? []
  const from = toldUpTo.get(wcId) ?? 0
  const fresh = list.filter((e) => e.at > from && isProblem(e))
  toldUpTo.set(wcId, Date.now())
  if (!fresh.length) return ''
  const errors = fresh.filter((e) => e.kind === 'console' && e.level === 'error').length
  const warnings = fresh.filter((e) => e.kind === 'console' && e.level === 'warning').length
  const failed = fresh.filter((e) => e.kind === 'network').length
  const parts = [errors && `${errors} console error${errors > 1 ? 's' : ''}`, failed && `${failed} failed request${failed > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`].filter(Boolean)
  return ` The page reported ${parts.join(', ')}: browser_logs shows them.`
}

/** The log as text for Claude: what's new since it last asked (or everything), narrowed as asked. */
export function logsText(wcId: number, opts: { show: 'problems' | 'console' | 'network' | 'all'; all?: boolean; find?: string; limit?: number }): string {
  const list = logs.get(wcId) ?? []
  const from = opts.all ? 0 : (readUpTo.get(wcId) ?? 0)
  readUpTo.set(wcId, Date.now())
  toldUpTo.set(wcId, Date.now())
  const q = opts.find?.toLowerCase()
  const shown = list.filter(
    (e) =>
      e.at > from &&
      (opts.show === 'all' || e.kind === 'navigation' || (opts.show === 'problems' ? isProblem(e) : e.kind === opts.show)) &&
      (!q || e.text.toLowerCase().includes(q) || e.kind === 'navigation')
  )
  // Page loads only matter between other lines.
  const lines = shown.filter((e, i) => e.kind !== 'navigation' || (shown[i + 1] && shown[i + 1].kind !== 'navigation'))
  const limit = opts.limit ?? 60
  const cut = lines.slice(-limit)
  if (!cut.some((e) => e.kind !== 'navigation')) return opts.all ? 'Nothing logged for this page.' : 'Nothing new since you last looked.'
  const t = (at: number) => new Date(at).toISOString().slice(11, 19)
  const body = cut
    .map((e) =>
      e.kind === 'navigation'
        ? `— loaded ${e.text}`
        : e.kind === 'console'
          ? `${t(e.at)} console ${e.level}: ${e.text}${e.source ? ` (${e.source})` : ''}`
          : `${t(e.at)} ${e.level === 'error' ? 'FAILED ' : ''}${e.method} ${e.url} → ${e.status ?? e.text.split('→ ').pop()}${e.ms !== undefined ? ` (${e.ms}ms)` : ''}`
    )
    .join('\n')
  return `${lines.length > limit ? `(${lines.length - limit} earlier lines not shown)\n` : ''}${body}`
}
