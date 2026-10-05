import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { query } from './claude'
import type { GlassboxCommit } from '../shared/events'
import { tr } from '../shared/i18n'

const exec = promisify(execFile)
const MAX_DIFF = 40_000
const MAX_GROUPS = 4

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return stdout
}
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim()
  } catch {
    return null
  }
}

/** The branch Glassbox should never commit to: the remote's default, else main/master. */
async function defaultBranch(root: string): Promise<string[]> {
  const head = await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return [head?.replace(/^origin\//, ''), 'main', 'master'].filter((b): b is string => !!b)
}

/** Commits Glassbox has made, by sha, kept on this machine so the history can tag them. */
const ledgerPath = () => join(app.getPath('userData'), 'glassbox-commits.json')
export function glassboxCommits(): Record<string, { at: number }> {
  try {
    return JSON.parse(readFileSync(ledgerPath(), 'utf8'))
  } catch {
    return {}
  }
}
function remember(commits: GlassboxCommit[]) {
  const all = glassboxCommits()
  for (const c of commits) all[c.sha] = { at: c.at }
  mkdirSync(dirname(ledgerPath()), { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify(all))
}

export type AutoCommitResult = { commits: GlassboxCommit[]; skipped?: string; error?: string }

/**
 * Commits the files Claude edited (and nothing else), split into a few logical commits with
 * messages in the repo's own style. Never pushes, never commits to the default branch, and lets
 * git hooks run as usual.
 */
export async function autoCommit(cwd: string, files: string[], task?: string): Promise<AutoCommitResult> {
  const root = await tryGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) return { commits: [] }
  const branch = await tryGit(root, ['branch', '--show-current'])
  if (!branch) return { commits: [], skipped: tr('mainAutocommit.detached') }
  if ((await defaultBranch(root)).includes(branch)) return { commits: [], skipped: tr('mainAutocommit.onDefault', { branch }) }
  const gitDir = (await tryGit(root, ['rev-parse', '--git-dir'])) ?? '.git'
  const g = isAbsolute(gitDir) ? gitDir : join(root, gitDir)
  if (['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((f) => existsSync(join(g, f)))) {
    return { commits: [], skipped: tr('mainAutocommit.midMerge') }
  }

  // Only files that still have changes.
  const rels = [...new Set(files.map((f) => relative(root, isAbsolute(f) ? f : join(cwd, f)).replace(/\\/g, '/')))].filter((r) => r && !r.startsWith('..'))
  if (!rels.length) return { commits: [] }
  // Not trimmed: each porcelain line starts with a two-letter status that can begin with a space.
  const status = await git(root, ['status', '--porcelain', '-uall', '--', ...rels]).catch(() => '')
  const changed = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!)
  if (!changed.length) return { commits: [] }

  const groups = await planCommits(root, branch, changed, task)
  const made: GlassboxCommit[] = []
  for (const group of groups) {
    try {
      await git(root, ['add', '-A', '--', ...group.files])
      // `-- paths` commits just these files, leaving anything else you've staged alone.
      await git(root, ['commit', '-m', group.message, '--', ...group.files])
      const sha = (await git(root, ['rev-parse', 'HEAD'])).trim()
      made.push({ sha, message: group.message, files: group.files, at: Date.now() })
    } catch (err) {
      await tryGit(root, ['reset', '-q', '--', ...group.files])
      const stderr = (err as { stderr?: string }).stderr?.trim()
      remember(made)
      return { commits: made, error: stderr ? tr('mainAutocommit.failedWith', { error: stderr.slice(0, 600) }) : tr('mainAutocommit.failed') }
    }
  }
  remember(made)
  return { commits: made }
}

type Group = { message: string; files: string[] }

/** Asks a small model to split the change into logical commits; falls back to a single one. */
async function planCommits(root: string, branch: string, files: string[], task?: string): Promise<Group[]> {
  const ticket = branch.match(/^([A-Za-z][A-Za-z0-9]+-\d+)/)?.[1]?.toUpperCase()
  const style = (await tryGit(root, ['log', '-12', '--format=%s'])) ?? ''
  const tracked = new Set(((await tryGit(root, ['ls-files', '--', ...files])) ?? '').split('\n').filter(Boolean))
  let diff = (await tryGit(root, ['diff', 'HEAD', '--', ...files.filter((f) => tracked.has(f))])) ?? ''
  for (const f of files.filter((f) => !tracked.has(f))) {
    let body = ''
    try {
      body = readFileSync(join(root, f), 'utf8').split('\n').slice(0, 120).join('\n')
    } catch {
      /* unreadable or deleted */
    }
    diff += `\n\nNew file ${f}:\n${body}`
  }
  const fallback: Group[] = [{ message: `${ticket ? `${ticket} ` : ''}${task ? task.slice(0, 60) : `Update ${files.length === 1 ? files[0].split('/').pop() : `${files.length} files`}`}`, files }]

  const prompt = `Split these changes into logical git commits (usually one; at most ${MAX_GROUPS}) and write a commit message for each.
Match the style of this repo's recent commit subjects exactly (prefixes, tense, capitalisation, length)${ticket ? `, and start each subject with the ticket key ${ticket} if the recent subjects do` : ''}. Subject line only, no body, no trailing full stop.
Answer with ONLY JSON: [{"message": "...", "files": ["path", ...]}]. Every file must appear in exactly one commit.

Recent subjects:
${style || '(none)'}
${task ? `\nWhat the change is for: ${task}\n` : ''}
Files: ${files.join(', ')}

Diff:
${diff.slice(0, MAX_DIFF)}`
  try {
    let text = ''
    for await (const msg of query({ prompt, options: { cwd: root, model: 'haiku', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' } } })) {
      if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
    }
    const raw = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? 'null') as Group[] | null
    if (!Array.isArray(raw) || !raw.length) return fallback
    const left = new Set(files)
    const groups = raw
      .slice(0, MAX_GROUPS)
      .map((g) => ({ message: String(g.message ?? '').split('\n')[0].trim().slice(0, 120), files: (g.files ?? []).filter((f) => left.delete(f)) }))
      .filter((g) => g.message && g.files.length)
    if (!groups.length) return fallback
    if (left.size) groups[groups.length - 1].files.push(...left)
    return groups
  } catch {
    return fallback
  }
}

/** Undoes a Glassbox commit (keeping its changes, uncommitted) if it's still the latest and not pushed. */
export async function undoGlassboxCommit(cwd: string, sha: string): Promise<void> {
  const head = await tryGit(cwd, ['rev-parse', 'HEAD'])
  if (head !== sha) throw new Error(tr('mainAutocommit.notLatest'))
  const pushed = await tryGit(cwd, ['branch', '-r', '--contains', sha])
  if (pushed) throw new Error(tr('mainAutocommit.pushed'))
  await git(cwd, ['reset', '--soft', 'HEAD~1'])
}
