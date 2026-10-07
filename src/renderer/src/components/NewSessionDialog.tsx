import { useEffect, useMemo, useState } from 'react'
import { buildLaunch, jiraKey, KINDS, type LaunchFields, type PendingStart, type SessionKind } from '../launch'
import { baseName, timeAgo } from '../lib'
import { Icon, Segmented } from './ui'
import { tr } from '../../../shared/i18n'

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
    (kind === 'coding' ? !!(f.ticket?.trim() || f.describe?.trim()) : kind === 'review' ? !!f.pr : kind === 'planning' ? !!f.topic?.trim() : kind === 'qa' ? !!f.what?.trim() && (f.env !== 'url' || !!f.url?.trim()) : true)

  // What Start is waiting for, said next to it rather than left as a greyed-out button.
  const missing = !cwd
    ? tr('newSessionDialog.missing.folder')
    : kind === 'coding' && !f.ticket?.trim() && !f.describe?.trim()
      ? tr('newSessionDialog.missing.ticket')
      : kind === 'review' && !f.pr
        ? tr('newSessionDialog.missing.pr')
        : kind === 'planning' && !f.topic?.trim()
          ? tr('newSessionDialog.missing.topic')
          : kind === 'qa' && !f.what?.trim()
            ? tr('newSessionDialog.missing.qaWhat')
            : kind === 'qa' && f.env === 'url' && !f.url?.trim()
              ? tr('newSessionDialog.missing.qaUrl')
              : null

  const launch = async () => {
    if (!valid) return
    setError(null)
    let dir = cwd
    try {
      if (kind === 'review' && f.pr && f.worktree) {
        setBusy(tr('newSessionDialog.busy.checkoutPr', { number: f.pr.number }))
        dir = await window.glassbox.launch.worktree(cwd, f.pr.number)
      }
      let fields = f
      if (sharing > 0 && ownCopy && changesFiles) {
        const branch = f.branch?.trim() || `${jiraKey(f.ticket ?? '') ?? 'session'}-${Date.now().toString(36).slice(-5)}`
        setBusy(tr('newSessionDialog.busy.fetching'))
        await window.glassbox.git.fetchDefault(cwd).catch(() => {})
        setBusy(tr('newSessionDialog.busy.ownCopy', { branch }))
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
      <div className="dialog launcher" role="dialog" aria-label={tr('newSessionDialog.title')}>
        <div className="dialog-title">
          <span>{tr('newSessionDialog.title')}</span>
          <span className="spacer" />
          <button className="icon-btn" title={tr('newSessionDialog.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="launch-section">
          <div className="launch-label">{tr('newSessionDialog.project')}</div>
          <div className="launch-project">
            <Icon name="folder" />
            <span className="grow ellipsis" title={cwd}>{cwd ? <><strong>{baseName(cwd)}</strong> <span className="muted small">{cwd}</span></> : <span className="muted">{tr('newSessionDialog.chooseFolder')}</span>}</span>
            <button onClick={() => void pick()}>{tr('newSessionDialog.browse')}</button>
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
          <div className="launch-label">{tr('newSessionDialog.whatDoing')}</div>
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
                <span>{tr('newSessionDialog.ticket')}</span>
                <input autoFocus placeholder={tr('newSessionDialog.ticketPlaceholder')} value={f.ticket ?? ''} onChange={(e) => set({ ticket: e.target.value })} />
                {f.ticket?.trim() && (
                  <span className="field-hint">
                    {jiraKey(f.ticket) ? (
                      <><Icon name="check" className="ok" /> {tr('newSessionDialog.jiraHint', { key: jiraKey(f.ticket) })}</>
                    ) : (
                      <><Icon name="info" /> {tr('newSessionDialog.linkHint')}</>
                    )}
                  </span>
                )}
              </label>
              <label className="field">
                <span>{f.ticket?.trim() ? tr('newSessionDialog.notesOptional') : tr('newSessionDialog.whatToBuild')}</span>
                <textarea rows={3} placeholder={f.ticket?.trim() ? tr('newSessionDialog.notesPlaceholder') : tr('newSessionDialog.describePlaceholder')} value={f.describe ?? ''} onChange={(e) => set({ describe: e.target.value })} />
              </label>
              <div className="field-row">
                <label className="field grow">
                  <span>{tr('newSessionDialog.branchOptional')}</span>
                  <input className="mono" placeholder={tr('newSessionDialog.branchPlaceholder')} value={f.branch ?? ''} onChange={(e) => set({ branch: e.target.value })} />
                </label>
                <div className="field">
                  <span>{tr('newSessionDialog.startWith')}</span>
                  <Segmented value={f.startWith ?? 'plan'} onChange={(v) => set({ startWith: v })} options={[{ value: 'plan', label: tr('newSessionDialog.startPlan') }, { value: 'code', label: tr('newSessionDialog.startCode') }]} />
                </div>
              </div>
            </>
          )}
          {kind === 'review' && <PrPicker cwd={cwd} selected={f.pr?.url} onSelect={(pr) => set({ pr })} worktree={!!f.worktree} onWorktree={(w) => set({ worktree: w })} />}
          {kind === 'planning' && (
            <>
              <label className="field">
                <span>{tr('newSessionDialog.thinkThrough')}</span>
                <input autoFocus placeholder={tr('newSessionDialog.planningPlaceholder')} value={f.topic ?? ''} onChange={(e) => set({ topic: e.target.value })} />
              </label>
              <label className="field">
                <span>{tr('newSessionDialog.contextOptional')}</span>
                <textarea rows={3} placeholder={tr('newSessionDialog.contextPlaceholder')} value={f.context ?? ''} onChange={(e) => set({ context: e.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={!!f.prd} onChange={(e) => set({ prd: e.target.checked })} /> {tr('newSessionDialog.endWithPrd')}
              </label>
              {f.prd && (
                <label className="check sub">
                  <input type="checkbox" checked={!!f.confluence} onChange={(e) => set({ confluence: e.target.checked })} /> {tr('newSessionDialog.publishConfluence')}
                </label>
              )}
            </>
          )}
          {kind === 'qa' && (
            <>
              <label className="field">
                <span>{tr('newSessionDialog.qaWhat')}</span>
                <textarea autoFocus rows={3} placeholder={tr('newSessionDialog.qaWhatPlaceholder')} value={f.what ?? ''} onChange={(e) => set({ what: e.target.value })} />
              </label>
              <div className="field">
                <span>{tr('newSessionDialog.qaWhere')}</span>
                <Segmented<'local' | 'url'> value={f.env ?? 'local'} onChange={(env) => set({ env })} options={[{ value: 'local', label: tr('newSessionDialog.qaLocal') }, { value: 'url', label: tr('newSessionDialog.qaUrl') }]} />
              </div>
              {f.env === 'url' && (
                <label className="field">
                  <span>{tr('newSessionDialog.qaUrlLabel')}</span>
                  <input placeholder={tr('newSessionDialog.qaUrlPlaceholder')} value={f.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
                </label>
              )}
              <label className="field">
                <span>{tr('newSessionDialog.qaNotes')}</span>
                <textarea rows={2} placeholder={tr('newSessionDialog.qaNotesPlaceholder')} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
              </label>
              <p className="muted small">{tr('newSessionDialog.qaHint')}</p>
            </>
          )}
          {kind === 'blank' && <p className="muted small">{tr('newSessionDialog.blankHint', { folder: cwd ? baseName(cwd) : tr('newSessionDialog.folderYouPick') })}</p>}
        </div>

        {sharing > 0 && changesFiles && (
          <div className="launch-shared">
            <Icon name="warning" className="warn" />
            <div className="grow">
              <strong>
                {tr('newSessionDialog.sharing', { count: sharing, folder: baseName(cwd) })}
              </strong>
              <span className="muted small"> {tr('newSessionDialog.sharingNote')}</span>
              <label className="check">
                <input type="checkbox" checked={ownCopy} onChange={(e) => setOwnCopy(e.target.checked)} /> {f.branch?.trim() ? tr('newSessionDialog.ownCopyOnBranch', { branch: f.branch.trim() }) : tr('newSessionDialog.ownCopy')}
              </label>
            </div>
          </div>
        )}
        {error && <div className="note note-error">{error}</div>}
        <div className="dialog-actions">
          {busy ? <span className="muted small"><Icon name="loading" className="codicon-modifier-spin" /> {busy}</span> : missing && <span className="muted small">{missing}</span>}
          <span className="spacer" />
          <button onClick={onClose}>{tr('newSessionDialog.cancel')}</button>
          <button className="primary" disabled={!valid || !!busy} onClick={() => void launch()}>
            {tr('newSessionDialog.start')}
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
        <input autoFocus placeholder={tr('newSessionDialog.prPicker.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pr-list">
        {lookup?.loading && <div className="muted small pad-x"><Icon name="loading" className="codicon-modifier-spin" /> {tr('newSessionDialog.prPicker.lookingUp')}</div>}
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
                  {same ? tr('newSessionDialog.prPicker.meta', { number: p.number, author: p.author, when: timeAgo(Date.parse(p.updatedAt)) }) : tr('newSessionDialog.prPicker.metaOtherRepo', { repo: p.repo, number: p.number, author: p.author, when: timeAgo(Date.parse(p.updatedAt)) })}
                </span>
              </span>
              {p.state !== 'OPEN' && <span className="tag">{p.state === 'MERGED' ? tr('newSessionDialog.prPicker.merged') : tr('newSessionDialog.prPicker.closed')}</span>}
              {!same && <span className="tag">{tr('newSessionDialog.prPicker.otherRepo')}</span>}
            </button>
          )
        })()}
        {!prs && !error && <div className="muted small pad-x">{tr('newSessionDialog.prPicker.loading')}</div>}
        {error && <div className="note note-error">{error}</div>}
        {prs && !shown.length && !error && <div className="muted small pad-x">{tr('newSessionDialog.prPicker.noMatches')}</div>}
        {shown.map((p) => (
          <button key={p.number} className={p.url === selected ? 'pr-row selected' : 'pr-row'} onClick={() => pick({ number: p.number, title: p.title, url: p.url }, true)}>
            <Icon name={p.isDraft ? 'git-pull-request-draft' : 'git-pull-request'} className={p.reviewRequested ? 'accent' : 'muted'} />
            <span className="grow pr-main">
              <span className="ellipsis">{p.title}</span>
              <span className="muted small">
                {tr('newSessionDialog.prPicker.meta', { number: p.number, author: p.author, when: timeAgo(Date.parse(p.updatedAt)) })}
              </span>
            </span>
            {p.reviewRequested && <span className="tag accent">{tr('newSessionDialog.prPicker.yourReview')}</span>}
            {p.isDraft && <span className="tag">{tr('newSessionDialog.prPicker.draft')}</span>}
          </button>
        ))}
      </div>
      <label className={otherRepo ? 'check disabled' : 'check'} title={otherRepo ? tr('newSessionDialog.prPicker.otherRepoTip') : undefined}>
        <input type="checkbox" checked={worktree} disabled={otherRepo} onChange={(e) => onWorktree(e.target.checked)} /> {tr('newSessionDialog.prPicker.worktree')}
      </label>
      {otherRepo && <div className="muted small">{tr('newSessionDialog.prPicker.otherRepoNote')}</div>}
    </>
  )
}
