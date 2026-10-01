import { useCallback, useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Empty, Icon, IconButton, Section, Toggle } from '../components/ui'
import { CHANGE_TOOLS } from '../session'
import type { CommitEntry } from '../../../main/git'
import type { BranchPr } from '../../../main/launcher'
import { timeAgo } from '../lib'

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
export function GitPanel() {
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

  if (!repo) return <Empty icon="git-commit" title="Not a git repository">Open a folder under git to see its history here.</Empty>
  const head = log?.commits[0]
  const lastError = [...s.timeline].reverse().find((i) => i.kind === 'commits' && (i.error || i.skipped))

  return (
    <div className="panel">
      <div className="panel-scroll">
        <PrCard />
        <section className="card">
          <label className="setting-inline">
            <span className="grow" title="At the end of each turn, split into logical commits in this repo’s style. Only files Claude edited; never pushed; never on the default branch.">
              <strong className="small">Commit Claude’s changes automatically</strong>
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
              {log ? (log.uncommitted ? <><strong>{log.uncommitted}</strong> uncommitted change{log.uncommitted > 1 ? 's' : ''}</> : 'Nothing uncommitted') : 'Loading…'}
            </span>
            <span className="spacer" />
            <IconButton icon="refresh" title="Refresh" onClick={() => void load()} />
            <button disabled={busy || !log?.uncommitted || !claudeChanged} onClick={() => void commitNow()} title={claudeChanged ? 'Commit what Claude has changed this session and hasn’t been committed yet' : 'Claude hasn’t changed any files in this session'}>
              {busy ? <Icon name="loading" className="codicon-modifier-spin" /> : <Icon name="git-commit" />} Commit Claude’s changes
            </button>
          </div>
          {error && <div className="note note-error">{error}</div>}
        </section>

        <Section id="git-commits" title={`On ${s.git?.branch ?? 'this branch'}`} meta={<span className="muted small">{log ? `${log.commits.length} commit${log.commits.length === 1 ? '' : 's'} since it branched` : ''}</span>}>
          {log && log.commits.length === 0 && <div className="muted small">No commits on this branch yet.</div>}
          <div className="commit-list">
            {log?.commits.map((c) => {
              const ours = !!mine[c.sha]
              return (
                <div key={c.sha} className="commit-row" onClick={() => openCommit(c.sha, c.short)} title={`${c.subject}\n${c.author}, ${c.when}\nClick to see the changes`}>
                  <span className={c.pushed ? 'commit-dot pushed' : 'commit-dot'} title={c.pushed ? 'Pushed' : 'Not pushed yet'} />
                  <span className="commit-main">
                    <span className="ellipsis">{c.subject}</span>
                    <span className="muted small">
                      {/* Plain words, not tags: who made it and whether it's pushed. */}
                      <span className="mono">{c.short}</span>, {c.when}
                      {ours && ', by Glassbox'}
                      {!c.pushed && ', not pushed'}
                    </span>
                  </span>
                  {ours && c === head && !c.pushed && (
                    <button className="icon-btn" title="Undo this commit (its changes stay, uncommitted)" onClick={(e) => (e.stopPropagation(), void undo(c.sha))}>
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

const REVIEW: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review needed' }

/** The branch's pull request: what state it's in, reviews and checks, and a link to open it on GitHub. */
function PrCard() {
  const { tab, s, composerRef } = useSession()
  const [res, setRes] = useState<{ pr?: BranchPr; none?: boolean; error?: string } | null>(null)
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
  const state = pr ? (pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open') : ''
  const checks = pr?.checks
  return (
    <Section id="git-pr" className="pr-card" title="Pull request" actions={<IconButton icon={loading ? 'loading' : 'refresh'} title="Check again" onClick={load} />}>
      {!res ? (
        <div className="muted small">Looking for a pull request…</div>
      ) : pr ? (
        <>
          <button className="pr-link" onClick={() => void window.glassbox.openExternal(pr.url)} title={`${pr.url}
Open on GitHub`}>
            <span className="pr-title">{pr.title}</span>
            <span className="pr-number">#{pr.number}</span>
            <Icon name="link-external" />
          </button>
          <div className="pr-facts">
            <span className={`pr-state pr-${state.toLowerCase()}`}>{state}</span>
            <span>into {pr.base}</span>
            {pr.review && <span>{REVIEW[pr.review] ?? pr.review}</span>}
            {checks && checks.passed + checks.failed + checks.pending > 0 && (
              <span className={checks.failed ? 'pr-checks-failed' : ''}>
                {checks.failed ? `${checks.failed} check${checks.failed > 1 ? 's' : ''} failing` : checks.pending ? `${checks.pending} check${checks.pending > 1 ? 's' : ''} running` : 'Checks passing'}
              </span>
            )}
          </div>
          <div className="muted small">
            {pr.files} file{pr.files === 1 ? '' : 's'}, <span className="ok">+{pr.additions}</span> <span className="err">−{pr.deletions}</span>, updated {timeAgo(Date.parse(pr.updatedAt))}
          </div>
        </>
      ) : res.none ? (
        <div className="pr-none">
          <span className="muted small">No pull request for {s.git?.branch ?? 'this branch'} yet.</span>
          <button className="btn" onClick={() => composerRef.current?.insert('Push this branch and open a pull request for it. ')}>
            Ask Claude to open one
          </button>
        </div>
      ) : (
        <div className="muted small">{res.error}</div>
      )}
    </Section>
  )
}
