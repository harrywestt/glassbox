import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileConnections, type FileConnection } from './architecture'
import { gitDiff } from './git'
import { isPublicEntry, moduleOf } from '../shared/architecture'
import type { ArchBreach, ArchDiff, ArchDiffEdge, DiffMode } from '../shared/events'

/**
 * What a branch does to the architecture: the connections between modules it adds and removes.
 * Only the changed files are read, at the base and now; a connection counts as new when no
 * unchanged file already made it, and as removed when nothing makes it any more.
 */

const MAX_FILES = 400

const show = (root: string, ref: string, path: string) =>
  new Promise<string>((done) =>
    execFile('git', ['show', `${ref}:${path}`], { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => done(err ? '' : out))
  )

const topLevel = (cwd: string) =>
  new Promise<string | null>((done) => execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true }, (err, out) => done(err ? null : out.trim())))

/** `apiOnly`: module folders (absolute) marked "public API only", to flag new imports past their entry point. */
export async function architectureDiff(cwd: string, ref: string, mode: DiffMode, apiOnly: string[] = []): Promise<ArchDiff> {
  try {
    const root = await topLevel(cwd)
    if (!root) return { added: [], removed: [], breaches: [], error: 'Not a git repository' }
    const diff = await gitDiff(cwd, ref, mode)
    const changed = diff.files.slice(0, MAX_FILES)
    const [before, after] = await Promise.all([
      Promise.all(changed.map(async (f) => ({ path: f.oldPath ?? f.path, text: f.status === 'A' || f.status === '?' ? '' : await show(root, diff.base, f.oldPath ?? f.path) }))),
      Promise.all(changed.map(async (f) => ({ path: f.path, text: f.status === 'D' ? '' : await readFile(`${root}/${f.path}`, 'utf8').catch(() => '') })))
    ])
    const was = await fileConnections(cwd, before)
    const now = await fileConnections(cwd, after)
    if (!was || !now) return { added: [], removed: [], breaches: [] }
    const arch = now.arch
    const key = (from: string, to: string) => `${from}>${to}`
    const changedSet = new Set(changed.flatMap((f) => [f.path, f.oldPath].filter((x): x is string => !!x)).map((p) => p.toLowerCase()))

    // Connections the rest of the code (files this branch didn't touch) already makes.
    const kept = new Set<string>()
    const linked = new Set<string>()
    for (const l of arch.links ?? []) {
      linked.add(key(l.fromModule, l.toModule))
      if (!changedSet.has(l.from.toLowerCase())) kept.add(key(l.fromModule, l.toModule))
    }
    // Edges with no file-level detail (C# project references, links past the cap) stay as they are.
    for (const e of arch.edges) if (!linked.has(key(e.from, e.to))) kept.add(key(e.from, e.to))

    const collect = (side: { path: string }[], conns: FileConnection[][]) => {
      const by = new Map<string, ArchDiffEdge>()
      side.forEach((f, i) => {
        const from = moduleOf(arch, f.path)
        if (!from) return
        for (const c of conns[i]) {
          const k = key(from.id, c.toModule)
          let e = by.get(k)
          if (!e) by.set(k, (e = { from: from.id, to: c.toModule, files: [], names: [], ...(c.http ? { http: true } : {}) }))
          if (!c.http) delete e.http
          if (!e.files.includes(f.path)) e.files.push(f.path)
          for (const n of c.names) if (!e.names.includes(n) && e.names.length < 12) e.names.push(n)
        }
      })
      return by
    }
    const old = collect(before, was.conns)
    const neu = collect(after, now.conns)
    const added = [...neu].filter(([k]) => !kept.has(k) && !old.has(k)).map(([, e]) => e)
    const removed = [...old].filter(([k]) => !kept.has(k) && !neu.has(k)).map(([, e]) => e)

    // New imports that reach inside a module marked "public API only".
    const breaches: ArchBreach[] = []
    const rel = (abs: string) => abs.replace(/\\/g, '/').replace(/\/+$/, '').slice(root.replace(/\\/g, '/').length + 1)
    const guarded = apiOnly.map((p) => moduleOf(arch, rel(p) + '/x')).filter((m): m is NonNullable<typeof m> => !!m)
    if (guarded.length) {
      after.forEach((f, i) => {
        const from = moduleOf(arch, f.path)
        const had = new Set(was.conns[before.findIndex((b) => b.path === f.path)]?.map((c) => c.to) ?? [])
        for (const c of now.conns[i]) {
          const m = guarded.find((g) => g.id === c.toModule)
          if (!m || from?.id === m.id || c.http || !c.to || had.has(c.to) || isPublicEntry(m.path, c.to)) continue
          breaches.push({ module: m.id, from: f.path, to: c.to })
        }
      })
    }
    return { added, removed, breaches }
  } catch (e) {
    return { added: [], removed: [], breaches: [], error: e instanceof Error ? e.message : String(e) }
  }
}
