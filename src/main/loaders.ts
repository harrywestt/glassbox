import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { LoaderState } from '../shared/events'
import { tr } from '../shared/i18n'

/**
 * Loaders Claude puts above the message box (show_progress). Claude can move one along itself, or
 * give Glassbox something to watch and let it: a URL that answers when the thing is up, a file that
 * appears when it's done, or a log whose lines say how far it's got. Watching only reads; it never
 * runs anything.
 */

export type Watch = { url?: string; file?: string; log?: string; percent_pattern?: string; done_pattern?: string; fail_pattern?: string }

const POLL_MS = 3000
const GIVE_UP_MS = 60 * 60_000

export class Loaders {
  private watching = new Map<string, NodeJS.Timeout>()
  private state = new Map<string, LoaderState>()

  constructor(private cwd: string, private emit: (l: LoaderState) => void) {}

  has(id: string): boolean {
    return this.state.has(id)
  }

  set(l: Omit<LoaderState, 'started' | 'updated'> & { watch?: Watch }) {
    const had = this.state.get(l.id)
    const next: LoaderState = { ...had, ...l, started: had?.started ?? Date.now(), updated: Date.now() }
    delete (next as { watch?: Watch }).watch
    if (next.status !== 'running') this.stop(l.id)
    this.state.set(l.id, next)
    this.emit(next)
    if (l.watch && next.status === 'running') this.watch(l.id, l.watch)
  }

  private patch(id: string, p: Partial<LoaderState>) {
    const cur = this.state.get(id)
    if (!cur) return
    const next = { ...cur, ...p, updated: Date.now() }
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
    const percentRx = rx(w.percent_pattern) ?? /(\d{1,3}(?:\.\d+)?)\s*%/
    const doneRx = rx(w.done_pattern)
    const failRx = rx(w.fail_pattern)
    const began = Date.now()
    const tick = async () => {
      if (Date.now() - began > GIVE_UP_MS) return this.patch(id, { status: 'failed', detail: tr('mainLoaders.gaveUp') })
      try {
        if (w.url) {
          const r = await fetch(w.url, { signal: AbortSignal.timeout(2500) }).catch(() => null)
          if (r && r.status < 500) return this.patch(id, { status: 'done', percent: 100, detail: tr('mainLoaders.answering', { url: w.url }) })
        }
        if (w.file && existsSync(full(w.file))) return this.patch(id, { status: 'done', percent: 100 })
        if (w.log && existsSync(full(w.log))) {
          const path = full(w.log)
          const size = statSync(path).size
          const text = readFileSync(path, 'utf8').slice(Math.max(0, size - 20_000))
          const lines = text.split(/\r?\n/).filter((l) => l.trim())
          const last = lines.at(-1)?.trim().slice(0, 160)
          if (failRx && lines.some((l) => failRx.test(l))) return this.patch(id, { status: 'failed', detail: last })
          if (doneRx && lines.some((l) => doneRx.test(l))) return this.patch(id, { status: 'done', percent: 100, detail: last })
          let pct: number | undefined
          for (let i = lines.length - 1; i >= 0 && pct === undefined; i--) {
            const m = percentRx.exec(lines[i])
            if (m) pct = Math.min(100, Number(m[1] ?? m[0]))
          }
          this.patch(id, { ...(pct !== undefined && !Number.isNaN(pct) ? { percent: pct } : {}), ...(last ? { detail: last } : {}) })
        }
      } catch {
        /* try again next tick */
      }
    }
    void tick()
    this.watching.set(id, setInterval(() => void tick(), POLL_MS))
  }

  dispose() {
    for (const id of [...this.watching.keys()]) this.stop(id)
  }
}
