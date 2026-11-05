import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'

/**
 * Glassbox's own files for a project (how to run its services, QA reports, the map's module list,
 * the component library, session worktrees) live in Glassbox's data folder, never in the project:
 * nothing of Glassbox's shows up in the repo.
 */

const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** A folder's name in Glassbox's data: readable, and unique by its full path. */
export const keyOf = (p: string) => `${basename(resolve(p)).replace(/[^\w.-]+/g, '-').slice(0, 32) || 'project'}-${createHash('sha1').update(norm(p)).digest('hex').slice(0, 10)}`

const dirIn = (...parts: string[]) => {
  const d = join(app.getPath('userData'), ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

/** Where Glassbox keeps its files for this folder (a worktree has its own, apart from its main checkout's). */
export function folderData(cwd: string): string {
  return dirIn('projects', keyOf(cwd))
}

/**
 * The repo's main checkout (worktrees map to it; a folder outside git is itself), and where this
 * folder sits inside it (a session can be in a subfolder).
 */
const checkouts = new Map<string, { root: string; rel: string }>()
export function mainCheckout(cwd: string): { root: string; rel: string } {
  // Asked on every library save and list: worked out once per folder (it doesn't change).
  const key = norm(cwd)
  const known = checkouts.get(key)
  if (known) return known
  let found = { root: resolve(cwd), rel: '' }
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    const top = git(['rev-parse', '--show-toplevel'])
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    // The shared .git folder sits in the main checkout; a submodule's (under .git/modules) doesn't, so a submodule is its own.
    const root = /[\\/]\.git$/i.test(common) ? dirname(common) : top
    found = { root: resolve(root), rel: resolve(cwd).slice(resolve(top).length) }
  } catch {
    /* not in git: the folder is its own */
  }
  checkouts.set(key, found)
  return found
}

/** Where Glassbox keeps what a whole repo shares (its worktrees included): the main checkout's folder. */
export function repoData(cwd: string): string {
  return folderData(mainCheckout(cwd).root)
}

/**
 * A file or folder Glassbox used to keep in the project (under .glassbox): copied into Glassbox's
 * data the first time it's wanted. The original is left for you to delete.
 */
export function fromProject(cwd: string, name: string, dest: string): void {
  if (existsSync(dest)) return
  const old = join(cwd, '.glassbox', name)
  if (!existsSync(old)) return
  try {
    cpSync(old, dest, { recursive: true })
  } catch {
    /* it can be made again */
  }
}

/** The QA reports folder for this folder's QA sessions. */
export function qaDir(cwd: string): string {
  const d = join(folderData(cwd), 'qa')
  fromProject(cwd, 'qa', d)
  mkdirSync(d, { recursive: true })
  return d
}

/** Your list of the map's modules for this folder (it overrides the ones Glassbox works out). */
export function architectureFile(cwd: string): string {
  const f = join(folderData(cwd), 'architecture.json')
  fromProject(cwd, 'architecture.json', f)
  return f
}

/**
 * Where a session's worktrees for this repo go: Glassbox's folder on this machine (local app data on
 * Windows, so a roaming profile never syncs them), under a short name to stay clear of Windows' path limit.
 */
export function worktreesDir(cwd: string): string {
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, basename(app.getPath('userData'))) : app.getPath('userData')
  const d = join(base, 'wt', keyOf(mainCheckout(cwd).root))
  mkdirSync(d, { recursive: true })
  return d
}
