import { useCallback, useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { PanelHeader, Empty, Icon, IconButton, Section, Toggle } from '../components/ui'
import { CHANGE_TOOLS } from '../session'
import type { CommitEntry } from '../../../main/git'
import type { BranchPr } from '../../../main/launcher'
import { timeAgo } from '../lib'
import { tr } from '../../../shared/i18n'

const AUTO_KEY = 'glassbox.autoCommit'

/** Whether Glassbox commits Claude's changes at the end of each turn (on unless turned off). */
export function loadAutoCommit(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Git side panel: this branch's commits (Glassbox's own ones tagged), what's uncommitted, and the
 * switch for committing Claude's changes automatically.
 */
/** `withPr`: show the pull request card here (the Changes tab shows it at its top instead). */
export function GitPanel({ withPr = true }: { withPr?: boolean } = {}) {
  const { tab, s, openCommit } = useSession()
  const [log, setLog] = useState<{ commits: CommitEntry[]; uncommitted: number } | null>(null)
  const [mine, setMine] = useState<Record<string, { at: number }>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const repo = !!s.git?.isRepo
  const claudeChanged = s.files.some((f) => CHANGE_TOOLS.has(f.tool))

  const load = useCallback(async () => {
    if (!repo) return
    const { defaultBase } = await window.glassbox.git.branches(tab.cwd)
    const [l, m] = await Promise.all([window.glassbox.git.log(tab.cwd, defaultBase), window.glassbox.git.glassboxCommits()])
    setLog(l)
    setMine(m)
  }, [tab.cwd, repo])
  useEffect(() => void load(), [load, s.git?.head, s.git?.dirty, s.commits.length])

  const setAuto = (on: boolean) => {
    try {
      localStorage.setItem(AUTO_KEY, on ? 'on' : 'off')
    } catch {
      /* not remembered */
    }
    void window.glassbox.session.setAutoCommit(tab.id, on)
  }

  const commitNow = async () => {
    setBusy(true)
    try {
      await window.glassbox.session.commitNow(tab.id)
    } finally {
      setBusy(false)
      void load()
    }
  }

  const undo = async (sha: string) => {
    setError(null)
    try {
      await window.glassbox.git.undoCommit(tab.cwd, sha)
      await window.glassbox.session.refresh(tab.id).catch(() => {})
      void load()
    } catch (e) {
      setError(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''))
    }
  }

  if (!repo) return <Empty icon="git-commit" title={tr('gitPanel.notRepo')}>{tr('gitPanel.notRepoBody')}</Empty>
  const head = log?.commits[0]
  const lastError = [...s.timeline].reverse().find((i) => i.kind === 'commits' && (i.error || i.skipped))

  return (
    <div className="panel">
      <PanelHeader title={tr('gitPanel.title')} />
      <div className="panel-scroll">
        {withPr && <PrCard />}
        <section className="card">
          <label className="setting-inline">
            <span className="grow" title={tr('gitPanel.autoCommitTitle')}>
              <strong className="small">{tr('gitPanel.autoCommit')}</strong>
            </span>
            <Toggle checked={s.autoCommit} onChange={setAuto} />
          </label>
          {lastError && lastError.kind === 'commits' && (
            <div className={lastError.error ? 'note note-error' : 'note'}>
              <Icon name={lastError.error ? 'error' : 'info'} /> {lastError.error ?? lastError.skipped}
            </div>
          )}
          <div className="git-status">
            <span className="small">
              {log ? (log.uncommitted ? <><strong>{log.uncommitted}</strong> {tr('gitPanel.uncommittedChanges', { count: log.uncommitted })}</> : tr('gitPanel.nothingUncommitted')) : tr('gitPanel.loading')}
            </span>
            <span className="spacer" />
            <IconButton icon="refresh" title={tr('gitPanel.refresh')} onClick={() => void load()} />
            <button disabled={busy || !log?.uncommitted || !claudeChanged} onClick={() => void commitNow()} title={claudeChanged ? tr('gitPanel.commitNowTitle') : tr('gitPanel.claudeNoChanges')}>
              {busy ? <Icon name="loading" className="codicon-modifier-spin" /> : <Icon name="git-commit" />} {tr('gitPanel.commitNow')}
            </button>
          </div>
          {error && <div className="note note-error">{error}</div>}
        </section>

        <Section id="git-commits" title={s.git?.branch ? tr('gitPanel.onBranch', { branch: s.git.branch }) : tr('gitPanel.onThisBranch')} meta={<span className="muted small">{log ? tr('gitPanel.commitsSinceBranched', { count: log.commits.length }) : ''}</span>}>
          {log && log.commits.length === 0 && <div className="muted small">{tr('gitPanel.noCommits')}</div>}
          <div className="commit-list">
            {log?.commits.map((c) => {
              const ours = !!mine[c.sha]
              return (
                <div key={c.sha} className="commit-row" onClick={() => openCommit(c.sha, c.short)} title={`${c.subject}\n${c.author}, ${c.when}\n${tr('gitPanel.clickToSee')}`}>
                  <span className={c.pushed ? 'commit-dot pushed' : 'commit-dot'} title={c.pushed ? tr('gitPanel.pushed') : tr('gitPanel.notPushedYet')} />
                  <span className="commit-main">
                    <span className="ellipsis">{c.subject}</span>
                    <span className="muted small">
                      {/* Plain words, not tags: who made it and whether it's pushed. */}
                      <span className="mono">{c.short}</span>, {c.when}
                      {ours && tr('gitPanel.byGlassbox')}
                      {!c.pushed && tr('gitPanel.notPushed')}
                    </span>
                  </span>
                  {ours && c === head && !c.pushed && (
                    <button className="icon-btn" title={tr('gitPanel.undoCommit')} onClick={(e) => (e.stopPropagation(), void undo(c.sha))}>
                      <Icon name="discard" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </Section>
      </div>
    </div>
  )
}

const REVIEW: Record<string, string> = { APPROVED: tr('gitPanel.reviewApproved'), CHANGES_REQUESTED: tr('gitPanel.reviewChangesRequested'), REVIEW_REQUIRED: tr('gitPanel.reviewNeeded') }

/** The branch's pull request: what state it's in, reviews and checks, and a link to open it on GitHub. */
export function PrCard() {
  const { tab, s, composerRef } = useSession()
  const [res, setRes] = useState<{ pr?: BranchPr; none?: boolean; error?: string; notGitHub?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => {
    setLoading(true)
    window.glassbox.git
      .branchPr(tab.cwd)
      .then(setRes, (e) => setRes({ error: String(e) }))
      .finally(() => setLoading(false))
  }, [tab.cwd])
  // Again when the branch changes or commits get pushed.
  useEffect(() => load(), [load, s.git?.branch, s.git?.head])

  const pr = res?.pr
  const stateKey = pr ? (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open') : ''
  const state = stateKey ? tr(`gitPanel.prState.${stateKey}`) : ''
  const checks = pr?.checks
  // Not on GitHub: there's no pull request to show, so the section stays out of the way.
  if (res?.notGitHub) return null
  return (
    <Section id="git-pr" className="pr-card" title={tr('gitPanel.pullRequest')} actions={<IconButton icon={loading ? 'loading' : 'refresh'} title={tr('gitPanel.checkAgain')} onClick={load} />}>
      {!res ? (
        <div className="muted small">{tr('gitPanel.lookingForPr')}</div>
      ) : pr ? (
        <>
          <button className="pr-link" onClick={() => void window.glassbox.openExternal(pr.url)} title={`${pr.url}
${tr('gitPanel.openOnGithub')}`}>
            <span className="pr-title">{pr.title}</span>
            <span className="pr-number">#{pr.number}</span>
            <Icon name="link-external" />
          </button>
          <div className="pr-facts">
            <span className={`pr-state pr-${stateKey}`}>{state}</span>
            <span>{tr('gitPanel.into', { base: pr.base })}</span>
            {pr.review && <span>{REVIEW[pr.review] ?? pr.review}</span>}
            {checks && checks.passed + checks.failed + checks.pending > 0 && (
              <span className={checks.failed ? 'pr-checks-failed' : ''}>
                {checks.failed ? tr('gitPanel.checksFailing', { count: checks.failed }) : checks.pending ? tr('gitPanel.checksRunning', { count: checks.pending }) : tr('gitPanel.checksPassing')}
              </span>
            )}
          </div>
          <div className="muted small">
            {tr('gitPanel.prFiles', { count: pr.files })}, <span className="ok">+{pr.additions}</span> <span className="err">−{pr.deletions}</span>, {tr('gitPanel.updated', { ago: timeAgo(Date.parse(pr.updatedAt)) })}
          </div>
        </>
      ) : res.none ? (
        <div className="pr-none">
          <span className="muted small">{s.git?.branch ? tr('gitPanel.noPr', { branch: s.git.branch }) : tr('gitPanel.noPrThisBranch')}</span>
          <button className="btn" onClick={() => composerRef.current?.insert('Push this branch and open a pull request for it. ')}>
            {tr('gitPanel.askClaudeToOpen')}
          </button>
        </div>
      ) : (
        <div className="muted small">{res.error}</div>
      )}
    </Section>
  )
}
