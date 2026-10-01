import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CheckState, GitHubSummary, PrItem, RepoPrCount, ReviewDecision, RunItem } from '../shared/github'

/*
  GitHub summary for the dashboard, read through the `gh` CLI (so it uses the user's existing
  `gh auth login` and needs no token handling here).

  One GraphQL call covers the account-wide lists (your PRs, review requests, assignments) including
  check rollup and review decision. Each local repo then gets its own open-PR count and `gh run list`,
  run in parallel with a timeout so one slow or broken repo only adds a line to `error`.
*/

const exec = promisify(execFile)

const CALL_TIMEOUT_MS = 15_000
const CACHE_MS = 60_000
const MAX_REPOS = 8
const PR_LIMIT = 20
const RUNS_PER_REPO = 20
const COMPLETED_RUNS_PER_REPO = 3
const RECENT_MS = 24 * 60 * 60 * 1000

class GhError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'auth' | 'timeout' | 'other'
  ) {
    super(message)
  }
}

async function gh(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, {
      cwd,
      timeout: CALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    })
    return stdout
  } catch (err) {
    // GraphQL partial success (e.g. one SSO-protected org) exits non-zero but still prints `data`.
    const stdout = (err as { stdout?: string }).stdout
    if (args[0] === 'api' && stdout && /"data"\s*:\s*\{/.test(stdout)) return stdout
    throw toGhError(err)
  }
}

function toGhError(err: unknown): GhError {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
  if (e.code === 'ENOENT') return new GhError('The GitHub CLI isn’t installed. Install it from cli.github.com, then run `gh auth login`.', 'missing')
  if (e.killed || e.signal === 'SIGTERM') return new GhError('GitHub took too long to respond', 'timeout')
  const stderr = (e.stderr ?? '').trim()
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(stderr)) {
    return new GhError('You’re signed out of the GitHub CLI. Sign in with `gh auth login`.', 'auth')
  }
  return new GhError(firstLine(stderr) || e.message || String(err), 'other')
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: CALL_TIMEOUT_MS, windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}

/** owner/name for a github.com remote URL (https, ssh or scp-style), else null. */
export function parseGitHubRemote(url: string): string | null {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

async function resolveRepos(dirs: string[]): Promise<string[]> {
  const remotes = await Promise.all(dirs.map((d) => git(d, ['remote', 'get-url', 'origin'])))
  const seen = new Map<string, string>()
  for (const url of remotes) {
    const repo = url && parseGitHubRemote(url)
    if (repo && !seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), repo)
  }
  return [...seen.values()].slice(0, MAX_REPOS)
}

// ── Account-wide PR lists ──

const PR_FIELDS = `
  number title url isDraft updatedAt reviewDecision
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`

const ACCOUNT_QUERY = `
query($mine: String!, $review: String!, $assigned: String!, $n: Int!) {
  viewer { login }
  mine: search(type: ISSUE, first: $n, query: $mine) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  review: search(type: ISSUE, first: $n, query: $review) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  assigned: search(type: ISSUE, first: $n, query: $assigned) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
}`

type RawPr = {
  number?: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string
  reviewDecision: ReviewDecision
  author: { login: string } | null
  repository: { nameWithOwner: string }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

type AccountData = { viewer: { login: string }; mine: { nodes: RawPr[] } | null; review: { nodes: RawPr[] } | null; assigned: { nodes: RawPr[] } | null }

function checkState(raw: string | undefined): CheckState {
  switch (raw) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

function toPr(p: RawPr): PrItem {
  return {
    repo: p.repository.nameWithOwner,
    number: p.number!,
    title: p.title,
    url: p.url,
    isDraft: p.isDraft,
    updatedAt: Date.parse(p.updatedAt),
    author: p.author?.login ?? null,
    checks: checkState(p.commits.nodes[0]?.commit.statusCheckRollup?.state),
    reviewDecision: p.reviewDecision ?? null
  }
}

const prs = (nodes: RawPr[]) => nodes.filter((n) => typeof n?.number === 'number').map(toPr)

async function fetchAccount(): Promise<{ login: string; mine: PrItem[]; review: PrItem[]; assigned: PrItem[] }> {
  const base = 'is:pr is:open archived:false sort:updated-desc'
  const out = await gh([
    'api', 'graphql',
    '-f', `query=${ACCOUNT_QUERY}`,
    '-f', `mine=${base} author:@me`,
    '-f', `review=${base} review-requested:@me`,
    '-f', `assigned=${base} assignee:@me`,
    '-F', `n=${PR_LIMIT}`
  ])
  const { data } = JSON.parse(out) as { data: AccountData }
  return { login: data.viewer.login, mine: prs(data.mine?.nodes ?? []), review: prs(data.review?.nodes ?? []), assigned: prs(data.assigned?.nodes ?? []) }
}

// ── Per-repo ──

const REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { nameWithOwner url pullRequests(states: OPEN) { totalCount } }
}`

async function fetchRepoCount(repo: string): Promise<RepoPrCount> {
  const [owner, name] = repo.split('/')
  const out = await gh(['api', 'graphql', '-f', `query=${REPO_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`])
  const r = (JSON.parse(out) as { data: { repository: { nameWithOwner: string; url: string; pullRequests: { totalCount: number } } | null } }).data.repository
  if (!r) throw new Error('not found, or your account can’t see it')
  return { repo: r.nameWithOwner, open: r.pullRequests.totalCount, url: `${r.url}/pulls` }
}

type RawRun = {
  name: string
  workflowName: string
  displayTitle: string
  status: string
  conclusion: string
  headBranch: string
  event: string
  createdAt: string
  url: string
}

async function fetchRuns(repo: string, login: string): Promise<RunItem[]> {
  const out = await gh([
    'run', 'list',
    '--repo', repo,
    '--user', login,
    '--limit', String(RUNS_PER_REPO),
    '--json', 'name,workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,url'
  ])
  const since = Date.now() - RECENT_MS
  const runs = (JSON.parse(out) as RawRun[]).map<RunItem>((r) => ({
    repo,
    name: r.workflowName || r.name,
    displayTitle: r.displayTitle,
    status: r.status,
    conclusion: r.conclusion ?? '',
    branch: r.headBranch,
    event: r.event,
    createdAt: Date.parse(r.createdAt),
    url: r.url
  }))
  const active = runs.filter((r) => r.status !== 'completed')
  const completed = runs.filter((r) => r.status === 'completed' && r.createdAt >= since).slice(0, COMPLETED_RUNS_PER_REPO)
  return [...active, ...completed]
}

// ── Summary ──

const empty = (error?: string): GitHubSummary => ({
  login: null,
  fetchedAt: Date.now(),
  error,
  myOpenPrs: [],
  reviewRequested: [],
  assigned: [],
  repoOpenPrCounts: [],
  runs: []
})

async function buildSummary(repoDirs: string[]): Promise<GitHubSummary> {
  const [account, repos] = await Promise.all([fetchAccount().catch((e: unknown) => e as GhError), resolveRepos(repoDirs)])
  if (account instanceof Error) {
    // Without the account call we don't know who "you" are, so there's nothing useful to show.
    const kind = (account as GhError).kind
    return empty(kind === 'missing' || kind === 'auth' ? account.message : `Couldn’t reach GitHub: ${account.message}`)
  }

  const errors: string[] = []
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const [count, runs] = await Promise.allSettled([fetchRepoCount(repo), fetchRuns(repo, account.login)])
      if (count.status === 'rejected') errors.push(`${repo}: ${(count.reason as Error).message}`)
      if (runs.status === 'rejected') errors.push(`${repo} runs: ${(runs.reason as Error).message}`)
      return { count: count.status === 'fulfilled' ? count.value : null, runs: runs.status === 'fulfilled' ? runs.value : [] }
    })
  )

  const runs = perRepo
    .flatMap((r) => r.runs)
    .sort((a, b) => Number(b.status !== 'completed') - Number(a.status !== 'completed') || b.createdAt - a.createdAt)

  return {
    login: account.login,
    fetchedAt: Date.now(),
    error: errors.length ? errors.join('\n') : undefined,
    myOpenPrs: account.mine,
    reviewRequested: account.review,
    assigned: account.assigned,
    repoOpenPrCounts: perRepo.flatMap((r) => (r.count ? [r.count] : [])).sort((a, b) => b.open - a.open || a.repo.localeCompare(b.repo)),
    runs
  }
}

let cache: { key: string; at: number; value: Promise<GitHubSummary> } | null = null

/**
 * GitHub summary for the dashboard. `repoDirs` are local folders; each is resolved to its github.com
 * `origin` (non-GitHub folders are skipped, duplicates merged, at most 8 repos). Cached for 60s per
 * set of folders, and concurrent callers share one in-flight fetch. Never rejects.
 */
export async function getGitHubSummary(repoDirs: string[], opts: { force?: boolean } = {}): Promise<GitHubSummary> {
  const key = [...new Set(repoDirs)].sort().join('\n')
  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value
  const value = buildSummary(repoDirs).catch((err: unknown) => empty(`Couldn’t load GitHub: ${err instanceof Error ? err.message : String(err)}`))
  cache = { key, at: Date.now(), value }
  const result = await value
  // Don't hold on to a sign-in failure: the user may fix it and hit refresh straight away.
  if (!result.login && cache?.value === value) cache = null
  return result
}
