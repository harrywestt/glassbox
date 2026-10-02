import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { DiffFile, DiffMode, DiffResult, GitInfo } from '../shared/events'
import { adoptServicesFile } from './services'

const exec = promisify(execFile)

async function git(cwd: string, args: string[], timeout?: number): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout })
  return stdout
}

async function tryGit(cwd: string, args: string[], timeout?: number): Promise<string | null> {
  try {
    return (await git(cwd, args, timeout)).trim()
  } catch {
    return null
  }
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const root = await tryGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) return { isRepo: false }
  const [branch, head, status, upstream] = await Promise.all([
    tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryGit(cwd, ['rev-parse', '--short', 'HEAD']),
    tryGit(cwd, ['status', '--porcelain']),
    tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  ])
  let ahead: number | undefined
  let behind: number | undefined
  if (upstream) {
    const counts = await tryGit(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
    if (counts) [behind, ahead] = counts.split(/\s+/).map(Number)
  }
  // The same count the Changes panel shows by default (against the default branch, since branching;
  // untracked files hidden), so the header and the panel agree.
  const refs = (await tryGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])) ?? ''
  const base = ['origin/main', 'main', 'origin/master', 'master'].find((b) => refs.split('\n').includes(b))
  let changed: number | undefined
  if (base) {
    const mb = await tryGit(cwd, ['merge-base', base, 'HEAD'])
    const names = mb ? await tryGit(cwd, ['diff', '--name-only', mb]) : null
    if (names !== null) changed = names.split('\n').filter(Boolean).length
  }
  return {
    isRepo: true,
    root,
    branch: branch ?? undefined,
    head: head ?? undefined,
    dirty: status ? status.split('\n').filter(Boolean).length : 0,
    changed,
    base,
    upstream: upstream ?? undefined,
    ahead,
    behind
  }
}

export async function gitBranches(cwd: string): Promise<{ branches: string[]; defaultBase: string | null }> {
  const out = await tryGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  const branches = (out ?? '').split('\n').filter((b) => b && !b.endsWith('/HEAD'))
  const defaultBase = ['origin/main', 'main', 'origin/master', 'master'].find((b) => branches.includes(b)) ?? null
  return { branches, defaultBase }
}

async function resolveBase(cwd: string, ref: string, mode: DiffMode): Promise<string> {
  if (mode === 'direct') return ref
  return (await git(cwd, ['merge-base', ref, 'HEAD'])).trim()
}

/** Working tree (including uncommitted and untracked files) compared against `ref`. */
export async function gitDiff(cwd: string, ref: string, mode: DiffMode): Promise<DiffResult> {
  const base = await resolveBase(cwd, ref, mode)
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(cwd, ['diff', '--name-status', '-M', base]),
    git(cwd, ['diff', '--numstat', '-M', base]),
    git(cwd, ['ls-files', '--others', '--exclude-standard'])
  ])
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t')
    const path = rest.at(-1)!.replace(/^.*=> /, '').replace(/[{}]/g, '')
    stats.set(path, { additions: Number(a) || 0, deletions: Number(d) || 0 })
  }
  const files: DiffFile[] = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split('\t')
      const path = second ?? first
      return { path, status: status[0], oldPath: second ? first : undefined, ...stats.get(path) }
    })
  for (const path of untracked.split('\n').filter(Boolean)) files.push({ path, status: '?' })
  return { base, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** Contents of `path` at `ref` (merge-base-adjusted), or '' when it doesn't exist there. */
export async function gitFileAt(cwd: string, ref: string, mode: DiffMode, path: string): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const rel = relative(root, isAbsolute(path) ? path : resolve(cwd, path)).split('\\').join('/')
  const base = await resolveBase(cwd, ref, mode)
  try {
    return await git(root, ['show', `${base}:${rel}`])
  } catch {
    return ''
  }
}

/**
 * A separate working copy of the repo (a git worktree) for `branch`, next to the repo: a session
 * there can't see or disturb another session's files or branch. Creates the branch from the current
 * commit when it doesn't exist yet. Returns the folder.
 */
/**
 * Where a session's worktree goes: inside the repo, under .claude/worktrees/<name> (as Claude Code
 * keeps its own), not as another folder next to the project. That folder is kept out of git by the
 * repo's local exclude file (.git/info/exclude), so nothing is committed and .gitignore is untouched.
 */
export async function worktreePath(root: string, name: string): Promise<string> {
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session'
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const exclude = join(common, 'info', 'exclude')
  const rule = '/.claude/worktrees/'
  try {
    const now = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!now.split(/\r?\n/).some((l) => l.trim() === rule)) appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}# Glassbox session worktrees\n${rule}\n`)
  } catch {
    /* the worktree still works; git just lists it as untracked */
  }
  return join(root, '.claude', 'worktrees', safe)
}

export async function gitWorktree(cwd: string, branch: string): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const target = await worktreePath(root, branch)
  const exists = (await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  // A new branch starts from the default branch (fetched just before, by gitFetchDefault), else HEAD.
  const from = (await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'HEAD'
  // Check files out on several threads: much quicker for a big repo on Windows.
  const add = ['-c', 'checkout.workers=0', 'worktree', 'add']
  await git(root, exists ? [...add, target, branch] : [...add, '-b', branch, target, from])
  // Untracked, so git leaves it behind: bring the services file so the copy can start its services.
  adoptServicesFile(target)
  return target
}

/**
 * Bring the default branch up to date before a new copy branches from it. Only that one branch
 * (not every branch and tag the remote has), and given up on after a while: an offline or slow
 * remote just means the copy starts from what's already here.
 */
export async function gitFetchDefault(cwd: string): Promise<void> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const head = await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const name = head?.replace(/^origin\//, '')
  await tryGit(root, name ? ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`] : ['fetch', '--quiet', '--no-tags', 'origin'], 20_000)
}

export async function gitListFiles(cwd: string): Promise<string[] | null> {
  const out = await tryGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard'])
  return out === null ? null : out.split('\n').filter(Boolean)
}

export type BranchList = { current: string | null; local: { name: string; when: string; upstream?: string }[]; remote: string[] }

/** Local branches, most recently committed first, plus remote branches with no local copy yet. */
export async function gitBranchList(cwd: string): Promise<BranchList> {
  const [current, locals, remotes] = await Promise.all([
    tryGit(cwd, ['branch', '--show-current']),
    tryGit(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:relative)%09%(upstream:short)', 'refs/heads']),
    tryGit(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes'])
  ])
  const local = (locals ?? '').split('\n').filter(Boolean).map((l) => {
    const [name, when, upstream] = l.split('\t')
    return { name, when, upstream: upstream || undefined }
  })
  const tracked = new Set(local.flatMap((b) => (b.upstream ? [b.upstream] : [])))
  const names = new Set(local.map((b) => b.name))
  const remote = (remotes ?? '')
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD') && r.includes('/') && !tracked.has(r) && !names.has(r.slice(r.indexOf('/') + 1)))
  return { current: current || null, local, remote }
}

/**
 * Switches branch (`git switch`), or creates one from the current HEAD. A remote branch gets a
 * local tracking branch. Git refuses if uncommitted changes would be overwritten; that message is
 * passed back as the error.
 */
export async function gitSwitch(cwd: string, branch: string, create = false): Promise<void> {
  const remoteOnly = !create && /^[^/]+\//.test(branch) && !(await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
  const args = create ? ['switch', '-c', branch] : remoteOnly ? ['switch', '--track', branch] : ['switch', branch]
  try {
    await git(cwd, args)
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new Error(stderr || String(err))
  }
}

export type CommitEntry = { sha: string; short: string; subject: string; author: string; when: string; at: number; pushed: boolean }

/**
 * Commits on this branch since it left `base` (or the latest 30 when there's no base), newest
 * first, each marked pushed or not.
 */
export async function gitLog(cwd: string, base: string | null): Promise<{ commits: CommitEntry[]; uncommitted: number }> {
  const range = base ? `${(await tryGit(cwd, ['merge-base', base, 'HEAD'])) ?? base}..HEAD` : 'HEAD'
  const out = (await tryGit(cwd, ['log', '--max-count=100', '--format=%H%x09%h%x09%at%x09%ar%x09%an%x09%s', range])) ?? ''
  const unpushed = new Set(((await tryGit(cwd, ['rev-list', '@{u}..HEAD'])) ?? '').split('\n').filter(Boolean))
  const hasUpstream = (await tryGit(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])) !== null
  const commits = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, short, at, when, author, ...subject] = l.split('\t')
      return { sha, short, at: Number(at) * 1000, when, author, subject: subject.join('\t'), pushed: hasUpstream && !unpushed.has(sha) }
    })
  const status = (await tryGit(cwd, ['status', '--porcelain'])) ?? ''
  return { commits, uncommitted: status.split('\n').filter(Boolean).length }
}

/** The files a commit touched, with their status letter (A, M, D, R). */
export async function gitCommitFiles(cwd: string, sha: string): Promise<{ status: string; path: string }[]> {
  const out = (await tryGit(cwd, ['show', '--name-status', '--format=', '-M', sha])) ?? ''
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...paths] = l.split('\t')
      return { status: status[0], path: paths.at(-1)! }
    })
}

/** A file's contents at a commit ('' if it didn't exist there). */
export async function gitShowFile(cwd: string, ref: string, path: string): Promise<string> {
  try {
    return await git(cwd, ['show', `${ref}:${path}`])
  } catch {
    return ''
  }
}
