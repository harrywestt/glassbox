/** GitHub summary shown on the dashboard. Produced by src/main/github.ts through the `gh` CLI. */

/** Rolled-up CI state of a PR's head commit. `none` when the commit has no checks. */
export type CheckState = 'success' | 'failure' | 'pending' | 'none'

/** GitHub's review decision for a PR. null when the repo doesn't require reviews. */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

export type PrItem = {
  /** owner/name */
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  /** epoch ms */
  updatedAt: number
  /** Author login (or null for deleted accounts). */
  author: string | null
  checks: CheckState
  reviewDecision: ReviewDecision
}

export type RunStatus = 'queued' | 'in_progress' | 'waiting' | 'requested' | 'pending' | 'completed' | string
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | 'startup_failure' | 'stale' | string

export type RunItem = {
  /** owner/name */
  repo: string
  /** Workflow name */
  name: string
  displayTitle: string
  status: RunStatus
  /** Empty string while the run hasn't finished. */
  conclusion: RunConclusion
  branch: string
  event: string
  /** epoch ms */
  createdAt: number
  url: string
}

export type RepoPrCount = { repo: string; open: number; url: string }

export type GitHubSummary = {
  /** Signed-in gh account, or null when gh is missing or signed out (see `error`). */
  login: string | null
  /** epoch ms */
  fetchedAt: number
  /** Human-readable problems, joined by newlines. Partial data may still be present. */
  error?: string
  /** Open PRs you authored, across GitHub. */
  myOpenPrs: PrItem[]
  /** Open PRs awaiting your review (directly or through a team), across GitHub. */
  reviewRequested: PrItem[]
  /** Open PRs assigned to you, across GitHub. */
  assigned: PrItem[]
  /** Open PR count for each repo found in the given folders. */
  repoOpenPrCounts: RepoPrCount[]
  /** Your Actions runs in those repos: everything active, plus recent completed ones (last 24h). Newest first. */
  runs: RunItem[]
}

export const isRunActive = (r: Pick<RunItem, 'status'>): boolean => r.status !== 'completed'
export const isRunFailed = (r: Pick<RunItem, 'status' | 'conclusion'>): boolean =>
  r.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)
