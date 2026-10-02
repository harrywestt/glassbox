import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { adoptServicesFile } from './services'
import { worktreePath } from './git'
import { tr } from '../shared/i18n'

const exec = promisify(execFile)
const run = async (cmd: string, args: string[], cwd: string) =>
  (await exec(cmd, args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout

export type LaunchPr = {
  number: number
  title: string
  author: string
  branch: string
  isDraft: boolean
  url: string
  updatedAt: string
  reviewRequested: boolean
}

const FIELDS = 'number,title,author,headRefName,isDraft,url,updatedAt'
type GhPr = { number: number; title: string; author?: { login: string }; headRefName: string; isDraft: boolean; url: string; updatedAt: string }

/** Open PRs in the folder's GitHub repo, the ones waiting on your review first. */
export async function listOpenPrs(cwd: string): Promise<{ prs: LaunchPr[]; error?: string }> {
  try {
    const [mine, all] = await Promise.all([
      run('gh', ['pr', 'list', '--search', 'review-requested:@me', '--json', FIELDS, '--limit', '20'], cwd),
      run('gh', ['pr', 'list', '--json', FIELDS, '--limit', '40'], cwd)
    ])
    const requested = new Set((JSON.parse(mine) as GhPr[]).map((p) => p.number))
    const prs = (JSON.parse(all) as GhPr[]).map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login ?? '',
      branch: p.headRefName,
      isDraft: p.isDraft,
      url: p.url,
      updatedAt: p.updatedAt,
      reviewRequested: requested.has(p.number)
    }))
    prs.sort((a, b) => Number(b.reviewRequested) - Number(a.reviewRequested) || b.updatedAt.localeCompare(a.updatedAt))
    return { prs }
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || err)
    return { prs: [], error: /not a git repository|no git remotes|could not determine/i.test(msg) ? tr('mainLauncher.notGitHubRepo') : /auth|login/i.test(msg) ? tr('mainLauncher.signInGh') : msg.split('\n')[0] }
  }
}

/**
 * Check a PR out into its own worktree next to the repo (<repo>-pr-<n>), so a review session can
 * run it without touching your working copy. Reuses the worktree if it already exists.
 */
export async function createPrWorktree(cwd: string, number: number): Promise<string> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).trim()
  const target = await worktreePath(root, `pr-${number}`)
  const branch = `glassbox/pr-${number}`
  await run('git', ['fetch', 'origin', `pull/${number}/head:${branch}`, '--force'], root)
  if (existsSync(target)) {
    await run('git', ['checkout', branch], target)
    await run('git', ['reset', '--hard', branch], target)
  } else {
    await run('git', ['worktree', 'add', target, branch], root)
  }
  adoptServicesFile(target)
  return target
}

/**
 * Look up one PR by URL or number (open, closed or merged), and whether it belongs to the folder's
 * own repo, which decides if it can be checked out into a worktree.
 */
export async function getPr(cwd: string, ref: string): Promise<{ pr?: LaunchPr & { repo: string; state: string }; sameRepo?: boolean; error?: string }> {
  try {
    const raw = JSON.parse(await run('gh', ['pr', 'view', ref.trim(), '--json', `${FIELDS},state`], cwd)) as GhPr & { state: string }
    const repo = raw.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? ''
    let own = ''
    try {
      own = (await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)).trim()
    } catch {
      /* not a GitHub repo folder: the PR can still be reviewed from its link */
    }
    return {
      pr: { number: raw.number, title: raw.title, author: raw.author?.login ?? '', branch: raw.headRefName, isDraft: raw.isDraft, url: raw.url, updatedAt: raw.updatedAt, reviewRequested: false, repo, state: raw.state },
      sameRepo: !!own && own.toLowerCase() === repo.toLowerCase()
    }
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || err)
    return { error: /could not resolve|not found|no pull requests/i.test(msg) ? tr('mainLauncher.noPr') : /auth|login/i.test(msg) ? tr('mainLauncher.signInGh') : msg.split('\n')[0] }
  }
}

export type BranchPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  base: string
  author: string
  updatedAt: string
  review?: string
  additions: number
  deletions: number
  files: number
  checks: { passed: number; failed: number; pending: number }
}

type GhCheck = { conclusion?: string; state?: string; status?: string }

/** The pull request for the folder's current branch, if there is one (open, draft, merged or closed). */
export async function getBranchPr(cwd: string): Promise<{ pr?: BranchPr; none?: boolean; error?: string }> {
  try {
    const fields = 'number,title,url,state,isDraft,baseRefName,author,updatedAt,reviewDecision,additions,deletions,changedFiles,statusCheckRollup'
    const raw = JSON.parse(await run('gh', ['pr', 'view', '--json', fields], cwd)) as {
      number: number; title: string; url: string; state: string; isDraft: boolean; baseRefName: string; author?: { login: string }; updatedAt: string
      reviewDecision?: string; additions: number; deletions: number; changedFiles: number; statusCheckRollup?: GhCheck[]
    }
    const checks = { passed: 0, failed: 0, pending: 0 }
    for (const c of raw.statusCheckRollup ?? []) {
      const v = (c.conclusion || c.state || c.status || '').toUpperCase()
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) checks.passed++
      else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) checks.failed++
      else checks.pending++
    }
    return {
      pr: { number: raw.number, title: raw.title, url: raw.url, state: raw.state, isDraft: raw.isDraft, base: raw.baseRefName, author: raw.author?.login ?? '', updatedAt: raw.updatedAt, review: raw.reviewDecision || undefined, additions: raw.additions, deletions: raw.deletions, files: raw.changedFiles, checks }
    }
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || err)
    if (/no pull requests found|no open pull requests/i.test(msg)) return { none: true }
    return { error: /not a git repository|no git remotes|could not determine/i.test(msg) ? tr('mainLauncher.notGitHubRepo') : /auth|login/i.test(msg) ? tr('mainLauncher.signInGitHub') : /ENOENT|not recognized/i.test(msg) ? tr('mainLauncher.ghMissing') : msg.split('\n')[0] }
  }
}
