/**
 * The project as the architect map draws it: modules (folders that hang together) grouped into
 * layers, and which modules depend on which. Detected from the code, or read from
 * .glassbox/architecture.json when the project defines one.
 */

/** The role a folder plays, used when nothing more specific names its category, and to order categories. */
export type ArchRole = 'Web' | 'API' | 'Domain' | 'Data' | 'Other'
export const LAYER_ORDER: ArchRole[] = ['Web', 'API', 'Domain', 'Data', 'Other']
/**
 * A band on the map. Named from the project itself (the folder that groups its modules, such as
 * Lambdas or Renderer, or whatever .glassbox/architecture.json calls it), falling back to a role.
 */
export type ArchLayer = string

export type ArchModule = {
  id: string
  name: string
  /** Folder relative to the repo root, forward slashes, no trailing slash ('' for the root). */
  path: string
  layer: ArchLayer
  /** Source files in the module. */
  files: number
  /** Test files in the module (or clearly aimed at it). */
  tests: number
  /** Something the code talks to but doesn't contain, such as a database or a payment provider. */
  external?: boolean
}

/** `from` depends on (imports) `to`. */
/** `http`: the connection is HTTP calls (a frontend calling a backend's routes), not imports. */
/** `weak`: an HTTP connection matched only loosely (by the shape of a URL), so it may not be real. */
export type ArchEdge = { from: string; to: string; weight: number; http?: boolean; weak?: boolean }

/**
 * One import across modules: `from` (a file) brings in `names` from `to` (a file, a folder for
 * C#/Go project references, or '' for an external system). Module ids say which boxes it joins.
 */
export type ArchLink = { from: string; to: string; fromModule: string; toModule: string; names: string[]; http?: boolean; weak?: boolean }

/** Bumped when the map's shape changes, so maps saved by older builds are rebuilt. */
export const ARCH_VERSION = 4

export type Architecture = {
  /** Absolute repo (or project) root the paths are relative to, forward slashes. */
  root: string
  layers: ArchLayer[]
  modules: ArchModule[]
  edges: ArchEdge[]
  /** The imports behind the edges, file to file with the names used. */
  links?: ArchLink[]
  version?: number
  source: 'file' | 'detected'
  /** Claude is naming this project's categories in the background; ask again shortly for its names. */
  organising?: boolean
  error?: string
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The module a file belongs to: the one whose folder is the longest prefix of the file's path. */
export function moduleOf(arch: Architecture, file: string): ArchModule | undefined {
  const root = norm(arch.root).toLowerCase()
  let rel = norm(file)
  if (rel.toLowerCase().startsWith(root + '/')) rel = rel.slice(root.length + 1)
  else if (/^[a-z]:\//i.test(rel) || rel.startsWith('/')) return undefined
  const lower = rel.toLowerCase()
  let best: ArchModule | undefined
  for (const m of arch.modules) {
    if (m.external) continue
    const p = m.path.toLowerCase()
    if (p === '' ? true : lower === p || lower.startsWith(p + '/')) {
      if (!best || m.path.length > best.path.length) best = m
    }
  }
  return best
}

/** Modules that depend on `id`, directly or through others, with how many hops away they are. */
export function dependentsOf(arch: Architecture, id: string): Map<string, number> {
  const depth = new Map<string, number>([[id, 0]])
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of arch.edges) {
      if (e.to === cur && !depth.has(e.from)) {
        depth.set(e.from, depth.get(cur)! + 1)
        queue.push(e.from)
      }
    }
  }
  return depth
}

const ENTRY_STEMS = new Set(['index', 'main', 'mod', '__init__', 'public-api', 'public_api', 'exports', 'api'])
const PUBLIC_DIR = /^(contracts?|public|abstractions|interfaces)$|\.(contracts?|abstractions|public|client|sdk)$/i

/**
 * Whether `target` (a file or folder relative to the repo root) is part of the public face of the
 * module at `modPath`: its entry file (index.ts, __init__.py, mod.rs…), the module itself (a C# or
 * Go project reference), or a contracts-style folder. Anything else inside is its internals.
 */
export function isPublicEntry(modPath: string, target: string): boolean {
  const base = norm(modPath).toLowerCase()
  const t = norm(target).toLowerCase()
  const rel = !base ? t : t === base ? '' : t.startsWith(base + '/') ? t.slice(base.length + 1) : null
  if (rel === null || rel === '') return true
  const segs = rel.split('/').filter(Boolean)
  if (segs.length === 1 && ENTRY_STEMS.has(segs[0].replace(/\.[^.]+$/, ''))) return true
  return segs.some((s) => PUBLIC_DIR.test(s))
}
