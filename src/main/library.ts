import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { repoData } from './projectData'
import type { LibraryComponent, LibraryKind, LibraryScreen } from '../shared/library'

/**
 * A project's component library and the screens built from it, kept in Glassbox's data per repo
 * (worktrees share their main checkout's), never in the project. One JSON file each.
 */

type Item<K extends LibraryKind> = K extends 'components' ? LibraryComponent : LibraryScreen

const folder = (cwd: string, kind: LibraryKind) => {
  const d = join(repoData(cwd), kind)
  mkdirSync(d, { recursive: true })
  return d
}
const safeId = (id: string) => /^[\w-]{1,80}$/.test(id)

export function listLibrary<K extends LibraryKind>(cwd: string, kind: K): Item<K>[] {
  const d = folder(cwd, kind)
  const out: Item<K>[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(d, f), 'utf8')) as Item<K>)
    } catch {
      /* a broken file is skipped */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every window hears that a project's library changed, so open views refresh. */
function changed(cwd: string, kind: LibraryKind) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('glassbox:library-changed', { cwd, kind })
}

export function saveLibrary<K extends LibraryKind>(cwd: string, kind: K, item: Omit<Item<K>, 'id' | 'at'> & { id?: string }): Item<K> {
  const id = item.id && safeId(item.id) ? item.id : randomUUID()
  const saved = { ...item, id, at: Date.now() } as Item<K>
  writeFileSync(join(folder(cwd, kind), `${id}.json`), JSON.stringify(saved, null, 1))
  changed(cwd, kind)
  return saved
}

export function deleteLibrary(cwd: string, kind: LibraryKind, id: string): void {
  if (!safeId(id)) return
  rmSync(join(folder(cwd, kind), `${id}.json`), { force: true })
  changed(cwd, kind)
}

/** A fingerprint of a component's source file (null when it can't be read), to notice when it changes. */
export function sourceHash(cwd: string, source?: string): string | undefined {
  if (!source) return undefined
  try {
    return createHash('sha1').update(readFileSync(isAbsolute(source) ? source : resolve(cwd, source))).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}

/** The components whose source file has changed since they were saved: their ids. */
export function staleComponents(cwd: string): string[] {
  return listLibrary(cwd, 'components')
    .filter((c) => c.source && c.sourceHash && sourceHash(cwd, c.source) !== c.sourceHash)
    .map((c) => c.id)
}

/** A component's id from its name, so saving the same name again replaces it. */
export const componentId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'component'
