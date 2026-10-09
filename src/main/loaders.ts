import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { LoaderState } from '../shared/events'
import { tr } from '../shared/i18n'

/**
 * Loaders Claude puts above the message box (show_progress). Claude can move one along itself, or
 * give Glassbox something to watch and let it: a URL that answers when the thing is up, a file that
 * appears when it's done, or a log whose lines say how far it's got. Watching only reads; it never
 * runs anything.
 *
 * One set per session, kept across the session's restarts (a model switch, a resume), so Claude can
 * always update or finish a loader it started.
 */

/**
 * A count of a total, as printed by deploys, CI stages, migrations and test runners: "[3/5]",
 * "step 3 of 5", "Stage 3/5", "3 of 5". Not a bare "3/5", which is as often a date or a ratio.
 */
const FRACTIONS = [/\[\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*\]/, /\b(?:step|stage|phase|task|job|batch|chunk|file|test|suite|migration|layer|page|part|item|record)s?\s*#?(\d{1,5})\s*(?:of|\/)\s*(\d{1,5})\b/i, /\b(\d{1,5})\s+of\s+(\d{1,5})\b/i]

/** "45%", "45.5 %": a percent, and not one that's plainly something else (CPU, memory, coverage, battery). */
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/
const NOT_PROGRESS = /\b(cpu|mem(ory)?|ram|coverage|stmts|branch(es)?|funcs|lines|battery|disk|load|usage|util)\b/i

export type Watch = { url?: string; file?: string; log?: string; percent_pattern?: string; done_pattern?: string; fail_pattern?: string }

const POLL_MS = 2000
const GIVE_UP_MS = 2 * 60 * 60_000
/** How much of a log's newest output is read each time. */
const TAIL = 32_000

export class Loaders {
  private watching = new Map<string, NodeJS.Timeout>()
  private state = new Map<string, LoaderState>()

  constructor(private cwd: string, private emit: (l: LoaderState) => void) {}

  has(id: string): boolean {
    return this.state.has(id)
  }

  /** Loaders still running that only Claude can move (nothing is watching them). */
  unwatched(): LoaderState[] {
    return [...this.state.values()].filter((l) => l.status === 'running' && !l.watching)
  }

  set(l: Omit<LoaderState, 'started' | 'updated' | 'watching'> & { watch?: Watch }) {
    const had = this.state.get(l.id)
    const { watch, ...given } = l
    const next: LoaderState = { ...had, ...given, started: had?.started ?? Date.now(), updated: Date.now() }
    // A step moves the bar too (with the total given before, if this update leaves it out).
    if (next.step && next.steps && (given.step !== undefined || given.steps !== undefined) && given.percent === undefined) next.percent = ((Math.min(next.step, next.steps) - 1) / next.steps) * 100
    if (next.status === 'done') next.percent = 100
    // Starting again (a new run under the same id) starts the clock again.
    if (had && had.status !== 'running' && next.status === 'running') next.started = Date.now()
    if (next.status !== 'running') this.stop(l.id)
    next.watching = next.status === 'running' && (!!watch || this.watching.has(l.id))
    this.state.set(l.id, next)
    this.emit(next)
    if (watch && next.status === 'running') this.watch(l.id, watch)
  }

  /** Ends every loader nothing is watching (the session stopped, or the turn was interrupted). */
  stopUnwatched(detail: string) {
    for (const l of this.unwatched()) this.patch(l.id, { status: 'failed', detail })
  }

  private patch(id: string, p: Partial<LoaderState>) {
    const cur = this.state.get(id)
    if (!cur || cur.status !== 'running') return
    const next = { ...cur, ...p, updated: Date.now() }
    if (next.status !== 'running') next.watching = false
    this.state.set(id, next)
    this.emit(next)
    if (next.status !== 'running') this.stop(id)
  }

  private stop(id: string) {
    const t = this.watching.get(id)
    if (t) clearInterval(t)
    this.watching.delete(id)
  }

  private watch(id: string, w: Watch) {
    this.stop(id)
    const full = (p: string) => (isAbsolute(p) ? p : resolve(this.cwd, p))
    const rx = (s?: string) => {
      try {
        return s ? new RegExp(s, 'i') : undefined
      } catch {
        return undefined
      }
    }
    const percentRx = rx(w.percent_pattern)
    const doneRx = rx(w.done_pattern)
    const failRx = rx(w.fail_pattern)
    const began = Date.now()
    // Only what the log says from now on counts: an earlier run's "done" or "failed" mustn't end this one.
    const logPath = w.log ? full(w.log) : undefined
    let from = logPath && existsSync(logPath) ? statSync(logPath).size : 0
    let best = this.state.get(id)?.percent ?? 0
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        if (Date.now() - began > GIVE_UP_MS) return this.patch(id, { status: 'failed', detail: tr('mainLoaders.gaveUp') })
        if (w.url) {
          const r = await fetch(w.url, { signal: AbortSignal.timeout(2500) }).catch(() => null)
          if (r && r.status < 500) return this.patch(id, { status: 'done', percent: 100, detail: tr('mainLoaders.answering', { url: w.url }) })
        }
        if (w.file && existsSync(full(w.file))) return this.patch(id, { status: 'done', percent: 100 })
        if (logPath) {
          if (!existsSync(logPath)) {
            if (Date.now() - began > 15_000) this.patch(id, { detail: tr('mainLoaders.waitingFor', { file: basename(logPath) }) })
            return
          }
          const size = statSync(logPath).size
          // The file was replaced or truncated (a new run): read it from the start.
          if (size < from) from = 0
          if (size === from) return
          const start = Math.max(from, size - TAIL)
          const buf = Buffer.alloc(size - start)
          const fd = openSync(logPath, 'r')
          try {
            readSync(fd, buf, 0, buf.length, start)
          } finally {
            closeSync(fd)
          }
          // Progress bars redraw a line with carriage returns: each redraw counts as a line.
          const lines = buf.toString('utf8').split(/\r\n|\r|\n/).map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean)
          const last = lines.at(-1)?.slice(0, 160)
          if (failRx && lines.some((l) => failRx.test(l))) return this.patch(id, { status: 'failed', detail: lines.find((l) => failRx.test(l))?.slice(0, 160) })
          if (doneRx && lines.some((l) => doneRx.test(l))) return this.patch(id, { status: 'done', percent: 100, detail: last })
          const pct = progressIn(lines, percentRx)
          // The bar only moves forward, and stays short of full until it's actually done.
          if (pct !== undefined) best = Math.max(best, Math.min(99, pct))
          this.patch(id, { ...(pct !== undefined ? { percent: best } : {}), ...(last ? { detail: last } : {}) })
        }
      } catch {
        /* try again next tick */
      } finally {
        busy = false
      }
    }
    void tick()
    this.watching.set(id, setInterval(() => void tick(), POLL_MS))
  }

  /** Ends every running loader (the session closed: nothing will move them now). */
  stopAll(detail: string) {
    for (const l of [...this.state.values()]) if (l.status === 'running') this.patch(l.id, { status: 'failed', detail })
  }

  dispose() {
    for (const id of [...this.watching.keys()]) this.stop(id)
  }
}

/** How far along the newest lines say it is: a percent, or a count of a total. */
function progressIn(lines: string[], percentRx?: RegExp): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (percentRx) {
      const m = percentRx.exec(line)
      if (m) {
        const n = Number(m[1] ?? m[0])
        if (!Number.isNaN(n)) return Math.min(100, n)
      }
      continue
    }
    const p = PERCENT.exec(line)
    if (p && !NOT_PROGRESS.test(line)) return Math.min(100, Number(p[1]))
    for (const rx of FRACTIONS) {
      const m = rx.exec(line)
      if (m && Number(m[2]) > 0 && Number(m[1]) <= Number(m[2])) return (Number(m[1]) / Number(m[2])) * 100
    }
  }
  return undefined
}
