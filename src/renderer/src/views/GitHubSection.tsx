import type { ReactNode } from 'react'
import { Empty, Icon, SkeletonRows } from '../components/ui'
import { timeAgo } from '../lib'
import { tr } from '../../../shared/i18n'
import { isRunActive, isRunFailed, type GitHubSummary, type PrItem, type RunItem } from '../../../shared/github'

type Props = { summary: GitHubSummary | null; onOpen: (url: string) => void }

const LIST_MAX = 5

/** Dashboard card: your PRs, review requests, Actions runs you started and open PRs per local repo. */
export function GitHubSection({ summary, onOpen }: Props) {
  if (!summary) {
    return (
      <section className="card gh-card">
        <Title />
        <SkeletonRows rows={4} />
      </section>
    )
  }

  if (!summary.login) {
    return (
      <section className="card gh-card">
        <Title />
        {needsSetup(summary.error) ? (
          <Empty icon="github" title={tr('gitHubSection.connectTitle')}>
            <p>{renderCode(summary.error ?? tr('gitHubSection.cliUnavailable'))}</p>
            <p>{tr('gitHubSection.connectBody')}</p>
          </Empty>
        ) : (
          <Empty icon="debug-disconnect" title={tr('gitHubSection.unreachableTitle')}>
            <p>{renderCode(summary.error ?? tr('gitHubSection.somethingWrong'))}</p>
            <p>{renderCode(tr('gitHubSection.unreachableBody'))}</p>
          </Empty>
        )}
      </section>
    )
  }

  const running = summary.runs.filter(isRunActive).length
  const failed = summary.runs.filter(isRunFailed).length
  const seen = new Set([...summary.reviewRequested, ...summary.myOpenPrs].map((p) => p.url))
  const assignedOnly = summary.assigned.filter((p) => !seen.has(p.url))

  return (
    <section className="card gh-card">
      <Title login={summary.login} fetchedAt={summary.fetchedAt} />

      <div className="gh-counts">
        <Count value={summary.reviewRequested.length} label={tr('gitHubSection.awaitingReview')} tone={summary.reviewRequested.length ? 'accent' : undefined} onClick={() => onOpen('https://github.com/pulls/review-requested')} />
        <Count value={summary.myOpenPrs.length} label={tr('gitHubSection.yourOpenPrs')} onClick={() => onOpen('https://github.com/pulls')} />
        <Count value={summary.assigned.length} label={tr('gitHubSection.assignedToYou')} onClick={() => onOpen('https://github.com/pulls/assigned')} />
        <Count
          value={running}
          label={failed ? tr('gitHubSection.workflowsRunningFailed', { failed }) : tr('gitHubSection.workflowsRunning')}
          tone={failed ? 'err' : running ? 'accent' : undefined}
        />
      </div>

      {summary.error && (
        <div className="note note-warn gh-note" title={summary.error}>
          <Icon name="warning" />
          <span className="grow">{summary.error.split('\n').length > 1 ? tr('gitHubSection.someReposUnread', { error: summary.error.split('\n')[0] }) : summary.error}</span>
        </div>
      )}

      <div className="gh-lists">
        <Group title={tr('gitHubSection.awaitingReview')} count={summary.reviewRequested.length} moreUrl="https://github.com/pulls/review-requested" onOpen={onOpen}>
          {summary.reviewRequested.length === 0 ? (
            <Hint icon="check">{tr('gitHubSection.caughtUp')}</Hint>
          ) : (
            summary.reviewRequested.slice(0, LIST_MAX).map((p) => <PrRow key={p.url} pr={p} onOpen={onOpen} showAuthor />)
          )}
        </Group>

        <Group title={tr('gitHubSection.yourPrs')} count={summary.myOpenPrs.length} moreUrl="https://github.com/pulls" onOpen={onOpen}>
          {summary.myOpenPrs.length === 0 ? (
            <Hint icon="git-pull-request">{tr('gitHubSection.noOpenPrs')}</Hint>
          ) : (
            summary.myOpenPrs.slice(0, LIST_MAX).map((p) => <PrRow key={p.url} pr={p} onOpen={onOpen} showChecks />)
          )}
        </Group>

        {assignedOnly.length > 0 && (
          <Group title={tr('gitHubSection.assignedToYou')} count={assignedOnly.length} moreUrl="https://github.com/pulls/assigned" onOpen={onOpen}>
            {assignedOnly.slice(0, LIST_MAX).map((p) => (
              <PrRow key={p.url} pr={p} onOpen={onOpen} showAuthor showChecks />
            ))}
          </Group>
        )}

        <Group title={tr('gitHubSection.runsYouStarted')} onOpen={onOpen}>
          {summary.runs.length === 0 ? (
            <Hint icon="github-action">
              {summary.repoOpenPrCounts.length
                ? tr('gitHubSection.noRuns')
                : tr('gitHubSection.runsNeedSessions')}
            </Hint>
          ) : (
            summary.runs.slice(0, LIST_MAX + 1).map((r) => <RunRow key={r.url} run={r} onOpen={onOpen} />)
          )}
        </Group>

        <Group title={tr('gitHubSection.openPrsByRepo')} onOpen={onOpen}>
          {summary.repoOpenPrCounts.length === 0 ? (
            <Hint icon="repo">{tr('gitHubSection.noRepos')}</Hint>
          ) : (
            <RepoCounts repos={summary.repoOpenPrCounts} onOpen={onOpen} />
          )}
        </Group>
      </div>
    </section>
  )
}

function Title({ login, fetchedAt }: { login?: string; fetchedAt?: number }) {
  return (
    <div className="card-title gh-title">
      <Icon name="github" />
      <span>{tr('gitHubSection.github')}</span>
      <span className="spacer" />
      {login && (
        <span className="muted small gh-login" title={fetchedAt ? tr('gitHubSection.updated', { ago: timeAgo(fetchedAt) }) : undefined}>
          {tr('gitHubSection.signedInAs', { login })}
        </span>
      )}
    </div>
  )
}

function Count({ value, label, tone, onClick }: { value: number; label: string; tone?: 'accent' | 'err'; onClick?: () => void }) {
  const body = (
    <>
      <span className={`gh-count-value ${tone && value > 0 ? tone : ''}`}>{value}</span>
      <span className="gh-count-label">{label}</span>
    </>
  )
  return onClick ? (
    <button className="gh-count clickable" onClick={onClick} title={tr('gitHubSection.openOnGitHub', { label })}>
      {body}
    </button>
  ) : (
    <div className="gh-count">{body}</div>
  )
}

function Group({ title, count, moreUrl, onOpen, children }: { title: string; count?: number; moreUrl?: string; onOpen: (url: string) => void; children: ReactNode }) {
  return (
    <div className="gh-group">
      <div className="gh-group-head">
        <span className="gh-group-title">{title}</span>
        {count !== undefined && count > 0 && <span className="muted small num">{count}</span>}
        <span className="spacer" />
        {moreUrl && count !== undefined && count > LIST_MAX && (
          <button className="link small" onClick={() => onOpen(moreUrl)}>
            {tr('gitHubSection.seeAll')}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Hint({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="gh-hint">
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  )
}

const needsSetup = (error?: string) => !error || /gh auth login|isn’t installed/i.test(error)

const shortRepo = (repo: string) => repo.split('/').pop() ?? repo

function checkIcon(pr: PrItem): { name: string; cls: string; title: string } {
  switch (pr.checks) {
    case 'success':
      return { name: 'pass', cls: 'ok', title: tr('gitHubSection.checksPassed') }
    case 'failure':
      return { name: 'error', cls: 'err', title: tr('gitHubSection.checksFailed') }
    case 'pending':
      return { name: 'loading', cls: 'codicon-modifier-spin accent', title: tr('gitHubSection.checksRunning') }
    default:
      return pr.isDraft
        ? { name: 'git-pull-request-draft', cls: 'muted', title: tr('gitHubSection.draftNoChecks') }
        : { name: 'git-pull-request', cls: 'muted', title: tr('gitHubSection.noChecks') }
  }
}

function ReviewState({ pr }: { pr: PrItem }) {
  if (pr.isDraft) return <span className="tag">{tr('gitHubSection.draft')}</span>
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return (
        <span className="gh-review ok">
          <Icon name="check" /> {tr('gitHubSection.approved')}
        </span>
      )
    case 'CHANGES_REQUESTED':
      return (
        <span className="gh-review warn">
          <Icon name="request-changes" /> {tr('gitHubSection.changesRequested')}
        </span>
      )
    case 'REVIEW_REQUIRED':
      return <span className="gh-review muted">{tr('gitHubSection.needsReview')}</span>
    default:
      return null
  }
}

function PrRow({ pr, onOpen, showChecks, showAuthor }: { pr: PrItem; onOpen: (url: string) => void; showChecks?: boolean; showAuthor?: boolean }) {
  const icon = showChecks ? checkIcon(pr) : { name: pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request', cls: pr.isDraft ? 'muted' : 'accent', title: pr.isDraft ? tr('gitHubSection.draft') : tr('gitHubSection.open') }
  return (
    <div className="list-row clickable gh-row" onClick={() => onOpen(pr.url)} title={`${pr.repo}#${pr.number}\n${pr.title}`}>
      <Icon name={icon.name} className={`gh-lead ${icon.cls}`} title={icon.title} />
      <div className="grow gh-main">
        <div className="ellipsis">{pr.title}</div>
        <div className="gh-meta">
          <span>
            {shortRepo(pr.repo)} <span className="num">#{pr.number}</span>
          </span>
          {showAuthor && pr.author && <span>{tr('gitHubSection.byAuthor', { author: pr.author })}</span>}
          <span>{tr('gitHubSection.updatedLower', { ago: timeAgo(pr.updatedAt) })}</span>
        </div>
      </div>
      {showChecks ? <ReviewState pr={pr} /> : pr.isDraft && <span className="tag">{tr('gitHubSection.draft')}</span>}
    </div>
  )
}

function runIcon(r: RunItem): { name: string; cls: string; label: string } {
  if (r.status === 'in_progress') return { name: 'loading', cls: 'codicon-modifier-spin accent', label: tr('gitHubSection.running') }
  if (r.status !== 'completed') return { name: 'clock', cls: 'muted', label: r.status === 'waiting' ? tr('gitHubSection.waitingApproval') : tr('gitHubSection.queued') }
  if (r.conclusion === 'success') return { name: 'pass', cls: 'ok', label: tr('gitHubSection.succeeded') }
  if (isRunFailed(r)) return { name: 'error', cls: 'err', label: tr('gitHubSection.failed') }
  if (r.conclusion === 'cancelled') return { name: 'circle-slash', cls: 'muted', label: tr('gitHubSection.cancelled') }
  if (r.conclusion === 'action_required') return { name: 'warning', cls: 'warn', label: tr('gitHubSection.needsAction') }
  return { name: 'circle-outline', cls: 'muted', label: r.conclusion ? r.conclusion.replace(/_/g, ' ') : tr('gitHubSection.finished') }
}

function RunRow({ run, onOpen }: { run: RunItem; onOpen: (url: string) => void }) {
  const icon = runIcon(run)
  const active = isRunActive(run)
  return (
    <div className="list-row clickable gh-row" onClick={() => onOpen(run.url)} title={tr('gitHubSection.runTitle', { name: run.name, displayTitle: run.displayTitle, repo: run.repo, event: run.event })}>
      <Icon name={icon.name} className={`gh-lead ${icon.cls}`} title={icon.label} />
      <div className="grow gh-main">
        <div className="ellipsis">{run.name}</div>
        <div className="gh-meta">
          <span className="gh-branch">
            <Icon name="git-branch" /> {run.branch}
          </span>
          <span>{tr('gitHubSection.inRepo', { repo: shortRepo(run.repo) })}</span>
        </div>
      </div>
      <span className={`small gh-run-state ${active || isRunFailed(run) ? icon.cls.replace('codicon-modifier-spin', '').trim() : 'muted'}`}>
        {active ? tr('gitHubSection.activeRun', { label: icon.label, ago: timeAgo(run.createdAt) }) : timeAgo(run.createdAt)}
      </span>
    </div>
  )
}

function RepoCounts({ repos, onOpen }: { repos: GitHubSummary['repoOpenPrCounts']; onOpen: (url: string) => void }) {
  const max = Math.max(1, ...repos.map((r) => r.open))
  return (
    <div className="gh-repos">
      {repos.map((r) => (
        <div key={r.repo} className="list-row clickable gh-repo" onClick={() => onOpen(r.url)} title={tr('gitHubSection.repoOpenPrs', { repo: r.repo, open: r.open })}>
          <span className="gh-repo-name ellipsis">{shortRepo(r.repo)}</span>
          <span className="gh-bar" aria-hidden>
            <span style={{ width: `${r.open === 0 ? 0 : Math.max(4, (r.open / max) * 100)}%` }} />
          </span>
          <span className="num small gh-repo-count">{r.open}</span>
        </div>
      ))}
    </div>
  )
}

/** Renders `code` spans in gh error messages (e.g. "Sign in with `gh auth login`"). */
function renderCode(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="gh-code">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    )
  )
}
