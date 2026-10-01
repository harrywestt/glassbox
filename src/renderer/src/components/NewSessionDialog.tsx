import { useEffect, useMemo, useState } from 'react'
import { buildLaunch, jiraKey, KINDS, type LaunchFields, type PendingStart, type SessionKind } from '../launch'
import { baseName, timeAgo } from '../lib'
import { Icon, Segmented } from './ui'

type Pr = { number: number; title: string; author: string; branch: string; isDraft: boolean; url: string; updatedAt: string; reviewRequested: boolean }

export type LaunchRequest = { cwd: string; kind: SessionKind; title: string; start?: PendingStart }

export function NewSessionDialog({ initialCwd, onLaunch, onClose }: { initialCwd?: string; onLaunch: (r: LaunchRequest) => void; onClose: () => void }) {
  const [cwd, setCwd] = useState(initialCwd ?? '')
  const [recent, setRecent] = useState<string[]>([])
  const [kind, setKind] = useState<SessionKind>('coding')
  const [f, setF] = useState<LaunchFields>({ startWith: 'plan', worktree: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<LaunchFields>) => setF((x) => ({ ...x, ...patch }))
  // Another live session already works in this folder: the new one gets its own copy by default,
  // so their files, branches and commits can't get mixed up.
  const [sharing, setSharing] = useState(0)
  const [ownCopy, setOwnCopy] = useState(true)
  useEffect(() => {
    let live = true
    if (!cwd) return setSharing(0)
    void window.glassbox.git.peers(cwd).then((n) => live && setSharing(n)).catch(() => live && setSharing(0))
    return () => {
      live = false
    }
  }, [cwd])
  const changesFiles = kind === 'coding' || kind === 'blank'

  useEffect(() => {
    void window.glassbox.history.list().then((h) => {
      const dirs = [...new Set(h.map((x) => x.cwd).filter((c): c is string => !!c))].slice(0, 8)
      setRecent(dirs)
      setCwd((c) => c || dirs[0] || '')
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const valid =
    !!cwd &&
    (kind === 'coding' ? !!(f.ticket?.trim() || f.describe?.trim()) : kind === 'review' ? !!f.pr : kind === 'planning' || kind === 'prd' ? !!f.topic?.trim() : true)

  // What Start is waiting for, said next to it rather than left as a greyed-out button.
  const missing = !cwd
    ? 'Pick a project folder'
    : kind === 'coding' && !f.ticket?.trim() && !f.describe?.trim()
      ? 'Add a ticket or describe the change'
      : kind === 'review' && !f.pr
        ? 'Pick a pull request'
        : (kind === 'planning' || kind === 'prd') && !f.topic?.trim()
          ? 'Say what it’s about'
          : null

  const launch = async () => {
    if (!valid) return
    setError(null)
    let dir = cwd
    try {
      if (kind === 'review' && f.pr && f.worktree) {
        setBusy(`Checking out #${f.pr.number} into a worktree…`)
        dir = await window.glassbox.launch.worktree(cwd, f.pr.number)
      }
      let fields = f
      if (sharing > 0 && ownCopy && changesFiles) {
        const branch = f.branch?.trim() || `${jiraKey(f.ticket ?? '') ?? 'session'}-${Date.now().toString(36).slice(-5)}`
        setBusy('Getting the latest from the default branch…')
        await window.glassbox.git.fetchDefault(cwd).catch(() => {})
        setBusy(`Checking out its own copy on ${branch} (a big repo takes a little while)…`)
        dir = await window.glassbox.git.worktree(cwd, branch)
        fields = { ...f, branch }
      }
      const { title, start, requirements } = buildLaunch(kind, fields)
      onLaunch({ cwd: dir, kind, title, start: start ? { ...start, requirements } : undefined })
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''))
      setBusy(null)
    }
  }

  const pick = async () => {
    const folder = await window.glassbox.pickFolder()
    if (folder) setCwd(folder)
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog launcher" role="dialog" aria-label="New session">
        <div className="dialog-title">
          <span>New session</span>
          <span className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="launch-section">
          <div className="launch-label">Project</div>
          <div className="launch-project">
            <Icon name="folder" />
            <span className="grow ellipsis" title={cwd}>{cwd ? <><strong>{baseName(cwd)}</strong> <span className="muted small">{cwd}</span></> : <span className="muted">Choose a folder</span>}</span>
            <button onClick={() => void pick()}>Browse</button>
          </div>
          {recent.length > 0 && (
            <div className="chips-row flush">
              {recent.map((d) => (
                <button key={d} className={d === cwd ? 'chip-btn on' : 'chip-btn'} onClick={() => setCwd(d)} title={d}>
                  {baseName(d)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="launch-section">
          <div className="launch-label">What are you doing?</div>
          <div className="kind-grid">
            {KINDS.map((k) => (
              <button key={k.kind} className={k.kind === kind ? 'kind active' : 'kind'} onClick={() => setKind(k.kind)}>
                <Icon name={k.icon} className="kind-icon" />
                <span className="kind-title">{k.title}</span>
                <span className="kind-blurb">{k.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="launch-section launch-fields">
          {kind === 'coding' && (
            <>
              <label className="field">
                <span>Ticket</span>
                <input autoFocus placeholder="Paste a Jira link or key (NSD-1234), a GitHub issue, or leave empty and describe it below" value={f.ticket ?? ''} onChange={(e) => set({ ticket: e.target.value })} />
                {f.ticket?.trim() && (
                  <span className="field-hint">
                    {jiraKey(f.ticket) ? (
                      <><Icon name="check" className="ok" /> Jira {jiraKey(f.ticket)}. Claude reads the ticket and finds the related code first, so a description isn’t needed.</>
                    ) : (
                      <><Icon name="info" /> Claude fetches this and anything it links to, then finds the related code.</>
                    )}
                  </span>
                )}
              </label>
              <label className="field">
                <span>{f.ticket?.trim() ? 'Notes (optional)' : 'What to build'}</span>
                <textarea rows={3} placeholder={f.ticket?.trim() ? 'Anything the ticket doesn’t say' : 'Describe the change'} value={f.describe ?? ''} onChange={(e) => set({ describe: e.target.value })} />
              </label>
              <div className="field-row">
                <label className="field grow">
                  <span>Branch (optional)</span>
                  <input className="mono" placeholder="NSD-1234-short-description" value={f.branch ?? ''} onChange={(e) => set({ branch: e.target.value })} />
                </label>
                <div className="field">
                  <span>Start with</span>
                  <Segmented value={f.startWith ?? 'plan'} onChange={(v) => set({ startWith: v })} options={[{ value: 'plan', label: 'A plan to approve' }, { value: 'code', label: 'Writing code' }]} />
                </div>
              </div>
            </>
          )}
          {kind === 'review' && <PrPicker cwd={cwd} selected={f.pr?.url} onSelect={(pr) => set({ pr })} worktree={!!f.worktree} onWorktree={(w) => set({ worktree: w })} />}
          {(kind === 'planning' || kind === 'prd') && (
            <>
              <label className="field">
                <span>{kind === 'prd' ? 'Feature or product' : 'What do you want to think through?'}</span>
                <input autoFocus placeholder={kind === 'prd' ? 'e.g. Supplier risk scoring' : 'e.g. How should we split the monolith’s notifications?'} value={f.topic ?? ''} onChange={(e) => set({ topic: e.target.value })} />
              </label>
              <label className="field">
                <span>Context and links (optional)</span>
                <textarea rows={3} placeholder="Background, constraints, Jira epics, Confluence pages, Figma links…" value={f.context ?? ''} onChange={(e) => set({ context: e.target.value })} />
              </label>
              {kind === 'prd' && (
                <label className="check">
                  <input type="checkbox" checked={!!f.confluence} onChange={(e) => set({ confluence: e.target.checked })} /> Publish to Confluence once I approve the draft
                </label>
              )}
            </>
          )}
          {kind === 'blank' && <p className="muted small">Opens an empty session in {cwd ? baseName(cwd) : 'the folder you pick'}.</p>}
        </div>

        {sharing > 0 && changesFiles && (
          <div className="launch-shared">
            <Icon name="warning" className="warn" />
            <div className="grow">
              <strong>
                {sharing === 1 ? 'Another session is' : `${sharing} other sessions are`} already working in {baseName(cwd)}.
              </strong>
              <span className="muted small"> Sharing one folder, sessions see each other's changes and a branch switch in one moves the other.</span>
              <label className="check">
                <input type="checkbox" checked={ownCopy} onChange={(e) => setOwnCopy(e.target.checked)} /> Give this session its own copy of the repo (a git worktree, kept inside the repo under .claude/worktrees{f.branch?.trim() ? `, on ${f.branch.trim()}` : ''})
              </label>
            </div>
          </div>
        )}
        {error && <div className="note note-error">{error}</div>}
        <div className="dialog-actions">
          {busy ? <span className="muted small"><Icon name="loading" className="codicon-modifier-spin" /> {busy}</span> : missing && <span className="muted small">{missing}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid || !!busy} onClick={() => void launch()}>
            Start session
          </button>
        </div>
      </div>
    </div>
  )
}

type Lookup = { pr?: Pr & { repo: string; state: string }; sameRepo?: boolean; error?: string; loading?: boolean }

const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i

function PrPicker({ cwd, selected, onSelect, worktree, onWorktree }: { cwd: string; selected?: string; onSelect: (pr: { number: number; title: string; url: string; repo?: string }) => void; worktree: boolean; onWorktree: (w: boolean) => void }) {
  const [prs, setPrs] = useState<Pr[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [otherRepo, setOtherRepo] = useState(false)

  // A pasted PR link, or a number that isn't among the open PRs, is looked up directly (any state, any repo).
  useEffect(() => {
    const t = q.trim().replace(/^#/, '')
    const isUrl = PR_URL.test(t)
    const isNumber = /^\d+$/.test(t) && !(prs ?? []).some((p) => String(p.number) === t)
    if (!isUrl && !isNumber) return setLookup(null)
    setLookup({ loading: true })
    const timer = setTimeout(() => {
      void window.glassbox.launch.pr(cwd, isUrl ? `https://${t.match(PR_URL)![0]}` : t).then(setLookup)
    }, 350)
    return () => clearTimeout(timer)
  }, [q, cwd, prs])

  const pick = (p: { number: number; title: string; url: string; repo?: string }, sameRepo: boolean) => {
    setOtherRepo(!sameRepo)
    if (!sameRepo) onWorktree(false)
    onSelect(p)
  }

  useEffect(() => {
    if (!cwd) return
    setPrs(null)
    setError(null)
    void window.glassbox.launch.prs(cwd).then((r) => {
      setPrs(r.prs)
      if (r.error) setError(r.error)
    })
  }, [cwd])

  const shown = useMemo(() => {
    const t = PR_URL.test(q) ? '' : q.trim().toLowerCase().replace(/^#/, '')
    return (prs ?? []).filter((p) => !t || String(p.number) === t || `${p.title} ${p.author} ${p.branch}`.toLowerCase().includes(t))
  }, [prs, q])

  return (
    <>
      <div className="search">
        <Icon name="search" />
        <input autoFocus placeholder="Search open pull requests, or paste a PR link or number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pr-list">
        {lookup?.loading && <div className="muted small pad-x"><Icon name="loading" className="codicon-modifier-spin" /> Looking up that pull request…</div>}
        {lookup?.error && <div className="note note-error">{lookup.error}</div>}
        {lookup?.pr && (() => {
          const p = lookup.pr
          const same = !!lookup.sameRepo
          return (
            <button className={p.url === selected ? 'pr-row selected' : 'pr-row'} onClick={() => pick({ number: p.number, title: p.title, url: p.url, repo: same ? undefined : p.repo }, same)}>
              <Icon name={p.state === 'MERGED' ? 'git-merge' : p.state === 'CLOSED' ? 'git-pull-request-closed' : 'git-pull-request'} className="accent" />
              <span className="grow pr-main">
                <span className="ellipsis">{p.title}</span>
                <span className="muted small">
                  {same ? '' : `${p.repo} `}#{p.number} by {p.author}, updated {timeAgo(Date.parse(p.updatedAt))}
                </span>
              </span>
              {p.state !== 'OPEN' && <span className="tag">{p.state === 'MERGED' ? 'Merged' : 'Closed'}</span>}
              {!same && <span className="tag">Other repo</span>}
            </button>
          )
        })()}
        {!prs && !error && <div className="muted small pad-x">Loading pull requests…</div>}
        {error && <div className="note note-error">{error}</div>}
        {prs && !shown.length && !error && <div className="muted small pad-x">No open pull requests match.</div>}
        {shown.map((p) => (
          <button key={p.number} className={p.url === selected ? 'pr-row selected' : 'pr-row'} onClick={() => pick({ number: p.number, title: p.title, url: p.url }, true)}>
            <Icon name={p.isDraft ? 'git-pull-request-draft' : 'git-pull-request'} className={p.reviewRequested ? 'accent' : 'muted'} />
            <span className="grow pr-main">
              <span className="ellipsis">{p.title}</span>
              <span className="muted small">
                #{p.number} by {p.author}, updated {timeAgo(Date.parse(p.updatedAt))}
              </span>
            </span>
            {p.reviewRequested && <span className="tag accent">Your review</span>}
            {p.isDraft && <span className="tag">Draft</span>}
          </button>
        ))}
      </div>
      <label className={otherRepo ? 'check disabled' : 'check'} title={otherRepo ? 'Only pull requests from this folder’s repo can be checked out here' : undefined}>
        <input type="checkbox" checked={worktree} disabled={otherRepo} onChange={(e) => onWorktree(e.target.checked)} /> Check it out in a separate worktree so Claude can run its tests
      </label>
      {otherRepo && <div className="muted small">This pull request is in another repo, so Claude reviews it from its link.</div>}
    </>
  )
}
