import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS, isClaudeOwnFile, type ToolCall } from '../session'
import { baseName, relPath } from '../lib'
import { DiffView } from '../components/Code'
import type { editor } from 'monaco-editor'
import { Empty, Icon, IconButton, Segmented, useFolded } from '../components/ui'
import type { ArchDiff, ArchDiffEdge, DiffMode, DiffResult } from '../../../shared/events'
import { Select } from '../components/Select'
import { useArchitecture } from '../architecture'
import type { Architecture } from '../../../shared/architecture'
import { tr } from '../../../shared/i18n'

/** A changed file's folder, relative to the project (empty for the project root). */
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')

type Row = { path: string; abs: string; status: string; oldPath?: string; additions?: number; deletions?: number; claudeEdits: number }
type Group = { dir: string; files: Row[]; additions: number; deletions: number; claude: number }

const STATUS: Record<string, { label: string; cls: string; title: string }> = {
  A: { label: 'A', cls: 'ok', title: tr('changesPanel.statusAdded') },
  M: { label: 'M', cls: 'warn', title: tr('changesPanel.statusModified') },
  D: { label: 'D', cls: 'err', title: tr('changesPanel.statusDeleted') },
  R: { label: 'R', cls: 'info', title: tr('changesPanel.statusRenamed') },
  '?': { label: 'U', cls: 'ok', title: tr('changesPanel.statusUntracked') }
}

/** Past this many files a long list shows the first ones, with a button for the rest (it stays quick). */
const PAGE = 150

/**
 * Everything changed on this branch, in one list grouped by folder, with Claude's changes from this
 * session marked. Clicking a file opens its diff full size in the work area.
 */
export function ChangesPanel() {
  const { tab, s, openDiff, workPath, openRipple } = useSession()
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<DiffMode>('merge-base')
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [onlyClaude, setOnlyClaude] = useState(false)
  const [filter, setFilter] = useState('')
  const [showUntracked, setShowUntracked] = useState(false)
  const repo = !!s.git?.isRepo
  const root = s.git?.root ?? tab.cwd

  useEffect(() => {
    if (!repo) return
    window.glassbox.git.branches(tab.cwd).then(({ branches, defaultBase }) => {
      setBranches(branches)
      setBase((b) => b ?? defaultBase ?? branches[0] ?? null)
    })
  }, [tab.cwd, repo])

  // One diff at a time: while one runs, further changes ask for a single follow-up, not a pile of them.
  const running = useRef(false)
  const again = useRef(false)
  const load = useCallback(() => {
    if (!base) return
    if (running.current) return void (again.current = true)
    running.current = true
    setLoading(true)
    setError(null)
    window.glassbox.git
      .diff(tab.cwd, base, diffMode)
      .then(setDiff, (e) => setError(String(e)))
      .finally(() => {
        running.current = false
        setLoading(false)
        if (again.current) {
          again.current = false
          load()
        }
      })
  }, [tab.cwd, base, diffMode])
  useEffect(load, [load])
  // Claude editing quickly changes the tree many times a second: refresh once it settles.
  useEffect(() => {
    const t = setTimeout(load, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.git?.dirty, s.git?.head])

  // Files Claude edited this session, keyed by path relative to the repo root.
  const claude = useMemo(() => {
    const m = new Map<string, { abs: string; edits: number }>()
    for (const f of s.files) {
      if (!CHANGE_TOOLS.has(f.tool) || isClaudeOwnFile(f.path) || s.toolCalls[f.toolId]?.status === 'error') continue
      const rel = relPath(root, f.path)
      const e = m.get(rel) ?? { abs: f.path, edits: 0 }
      e.edits++
      m.set(rel, e)
    }
    return m
  }, [s.files, s.toolCalls, root])

  const all: Row[] = useMemo(() => {
    const list: Row[] = (diff?.files ?? []).map((f) => ({ ...f, abs: claude.get(f.path)?.abs ?? `${root}/${f.path}`, claudeEdits: claude.get(f.path)?.edits ?? 0 }))
    // Claude's edits that git can't show (not a repo, or a file outside it) still belong here. Inside the
    // repo, an edit missing from the diff has no net change (made then undone, or created then deleted).
    const listed = new Set(list.map((r) => r.path))
    for (const [rel, c] of claude) if (!listed.has(rel) && (!diff || rel.startsWith('..') || /^[a-z]:/i.test(rel))) list.push({ path: rel, abs: c.abs, status: 'M', claudeEdits: c.edits })
    return list
  }, [diff, claude, root])

  const strays = all.filter((r) => isStrayUntracked(r)).length
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return all.filter((r) => (showUntracked || !isStrayUntracked(r)) && (!onlyClaude || r.claudeEdits > 0) && (!q || r.path.toLowerCase().includes(q)))
  }, [all, onlyClaude, filter, showUntracked])

  // Grouped by folder; a folder with Claude's changes in it comes first.
  const groups: Group[] = useMemo(() => {
    const by = new Map<string, Row[]>()
    for (const r of rows) by.set(dirOf(r.path), [...(by.get(dirOf(r.path)) ?? []), r])
    return [...by]
      .map(([dir, files]) => ({
        dir,
        files: files.sort((a, b) => b.claudeEdits - a.claudeEdits || a.path.localeCompare(b.path)),
        additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
        deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        claude: files.filter((f) => f.claudeEdits).length
      }))
      .sort((a, b) => (b.claude ? 1 : 0) - (a.claude ? 1 : 0) || a.dir.localeCompare(b.dir))
  }, [rows])

  const counted = all.filter((r) => showUntracked || !isStrayUntracked(r))
  const adds = counted.reduce((n, f) => n + (f.additions ?? 0), 0)
  const dels = counted.reduce((n, f) => n + (f.deletions ?? 0), 0)

  // The session's openDiff changes identity on every event; the list keeps one that doesn't.
  const latest = useRef({ openDiff, base, diffMode })
  latest.current = { openDiff, base, diffMode }
  const open = useCallback((r: Row) => latest.current.openDiff({ path: r.abs, base: latest.current.base, diffMode: latest.current.diffMode, source: r.claudeEdits ? 'session' : 'branch' }), [])

  return (
    <div className="panel">
      {/* One row: what changed, against what (base branch and how, in one control), and refresh. */}
      <div className="changes-summary">
        <span className="small changes-count">
          <strong>{tr('changesPanel.files', { count: counted.length })}</strong>
          {diff && <> <span className="ok">+{adds}</span> <span className="err">−{dels}</span></>}
        </span>
        {loading && diff && <span className="changes-refreshing" title={tr('changesPanel.refreshing')} aria-label={tr('changesPanel.refreshing')} />}
        <span className="spacer" />
        {repo && (
          <Select
            value={`${diffMode}|${base ?? ''}`}
            onChange={(v) => {
              const [mode, ...rest] = v.split('|')
              setDiffMode(mode as DiffMode)
              setBase(rest.join('|'))
            }}
            aria-label={tr('changesPanel.compareAgainst')}
            options={branches.flatMap((b) => [
              { value: `merge-base|${b}`, label: tr('changesPanel.vsSinceBranching', { branch: b }) },
              { value: `direct|${b}`, label: tr('changesPanel.vsDirect', { branch: b }) }
            ])}
          />
        )}
        {counted.length > 0 && <IconButton icon="radio-tower" title={tr('changesPanel.rippleTitle')} onClick={() => openRipple()} />}
        {repo && <IconButton icon="refresh" title={tr('changesPanel.refresh')} onClick={load} />}
      </div>
      <div className="changes-filters">
        <Segmented<'all' | 'claude'>
          value={onlyClaude ? 'claude' : 'all'}
          onChange={(v) => setOnlyClaude(v === 'claude')}
          options={[
            { value: 'all', label: tr('changesPanel.allChanges') },
            { value: 'claude', label: claude.size ? tr('changesPanel.claudesChangesCount', { n: claude.size }) : tr('changesPanel.claudesChanges') }
          ]}
        />
        {/* Filtering only earns its space in a long list. */}
        {(counted.length > 10 || filter) && (
          <div className="search grow">
            <Icon name="search" />
            <input placeholder={tr('changesPanel.filterFiles')} aria-label={tr('changesPanel.filterFiles')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
      </div>
      {error && <div className="note note-error">{error}</div>}
      {strays > 0 && (
        <div className="changes-untracked small muted">
          {showUntracked ? tr('changesPanel.showingUntracked', { count: strays }) : tr('changesPanel.untrackedHidden', { count: strays })}{' '}
          <button className="link small" onClick={() => setShowUntracked(!showUntracked)}>
            {showUntracked ? tr('changesPanel.hideThem') : tr('changesPanel.showThem')}
          </button>
        </div>
      )}
      {repo && base && diff && <ArchitectureChanges base={base} diffMode={diffMode} diff={diff} />}
      {repo && !diff && !error && <div className="muted pad">{tr('changesPanel.comparing')}</div>}
      {(diff || !repo) && rows.length === 0 && (
        <Empty icon={onlyClaude ? 'edit' : 'check'} title={onlyClaude ? tr('changesPanel.claudeNoChanges') : base ? tr('changesPanel.noDifferencesFrom', { base }) : tr('changesPanel.noChanges')}>
          {tr('changesPanel.emptyBody')}
        </Empty>
      )}
      {rows.length > 0 && <FileList groups={groups} total={rows.length} selected={workPath} onOpen={open} root={tab.cwd} />}
    </div>
  )
}

/**
 * The changed files by folder. Kept apart (and memoised) so a session event that doesn't change the
 * list doesn't redraw it. Folders fold away; arrow keys move between files, Enter opens one.
 */
const FileList = memo(function FileList({ groups, total, selected, onOpen, root }: { groups: Group[]; total: number; selected: string | null; onOpen: (r: Row) => void; root: string }) {
  const [folded, setFolded] = useState<Set<string>>(() => loadFoldedDirs(root))
  const [limit, setLimit] = useState(PAGE)
  const list = useRef<HTMLDivElement>(null)
  const toggle = (dir: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      saveFoldedDirs(root, next)
      return next
    })
  const allFolded = groups.length > 1 && groups.every((g) => folded.has(g.dir))
  const foldAll = () => {
    const next = allFolded ? new Set<string>() : new Set(groups.map((g) => g.dir))
    saveFoldedDirs(root, next)
    setFolded(next)
  }
  // Up and down move between the visible rows (folders and files); left and right fold a folder.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && i >= 0 && items[i].dataset.dir !== undefined) {
      const dir = items[i].dataset.dir!
      if ((e.key === 'ArrowLeft') !== folded.has(dir)) (e.preventDefault(), toggle(dir))
    }
  }
  let shown = 0
  return (
    <div className="file-list full changes-list" ref={list} onKeyDown={onKey}>
      {groups.length > 1 && (
        <div className="changes-list-tools">
          <button className="link small" onClick={foldAll}>
            {allFolded ? tr('changesPanel.expandAll') : tr('changesPanel.collapseAll')}
          </button>
        </div>
      )}
      {groups.map((g) => {
        if (shown >= limit) return null
        const isFolded = folded.has(g.dir)
        const files = isFolded ? [] : g.files.slice(0, Math.max(0, limit - shown))
        shown += isFolded ? 1 : files.length
        return (
          <div key={g.dir} className="change-folder">
            <button className="change-folder-head" data-nav data-dir={g.dir} aria-expanded={!isFolded} onClick={() => toggle(g.dir)} title={g.dir || tr('changesPanel.projectRoot')}>
              <Icon name={isFolded ? 'chevron-right' : 'chevron-down'} className="muted" />
              <span className="grow change-folder-path">{shortDir(g.dir) || tr('changesPanel.projectRoot')}</span>
              {g.claude > 0 && (
                <span className="change-claude" title={tr('changesPanel.claudeInFolder', { count: g.claude })}>
                  <Icon name="sparkle" /> {g.claude}
                </span>
              )}
              <span className="muted small">{tr('changesPanel.folderFiles', { count: g.files.length })}</span>
              {g.files.some((f) => f.additions !== undefined) && (
                <span className="small num">
                  <span className="ok">+{g.additions}</span> <span className="err">−{g.deletions}</span>
                </span>
              )}
            </button>
            {files.map((r) => {
              const st = STATUS[r.status] ?? { label: r.status, cls: 'muted', title: r.status }
              return (
                <button
                  key={r.path}
                  data-nav
                  className={r.abs === selected ? 'list-row clickable selected change-file' : 'list-row clickable change-file'}
                  aria-current={r.abs === selected ? 'true' : undefined}
                  onClick={() => onOpen(r)}
                  title={r.oldPath ? `${r.oldPath} → ${r.path}` : r.path}
                >
                  <span className={`status-letter ${st.cls}`} title={st.title}>
                    {st.label}
                  </span>
                  <span className="grow ellipsis change-file-name">{baseName(r.path)}</span>
                  {r.claudeEdits > 0 && (
                    <span className="change-claude" title={tr('changesPanel.claudeEdited', { count: r.claudeEdits })}>
                      <Icon name="sparkle" />
                    </span>
                  )}
                  {r.additions !== undefined && (
                    <span className="small num">
                      <span className="ok">+{r.additions}</span> <span className="err">−{r.deletions}</span>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
      {total > limit && (
        <button className="quiet wide changes-more" onClick={() => setLimit((n) => n + PAGE * 2)}>
          {tr('changesPanel.showMore', { count: total - limit })}
        </button>
      )}
    </div>
  )
})

/** A long folder path keeps its start and end: "src/…/checkout/components". */
function shortDir(dir: string): string {
  const parts = dir.split('/')
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : dir
}

const FOLD_KEY = (root: string) => `glassbox.changes.folded.${root}`
function loadFoldedDirs(root: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLD_KEY(root)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function saveFoldedDirs(root: string, dirs: Set<string>) {
  try {
    localStorage.setItem(FOLD_KEY(root), JSON.stringify([...dirs].slice(-300)))
  } catch {
    /* folded for now only */
  }
}

/**
 * What the branch does to the architecture, above the file list: connections between modules it
 * adds (+) and removes (−), and any new import that reaches past a module you allowed its public
 * API only. Each opens the map on the two modules.
 */
function ArchitectureChanges({ base, diffMode, diff }: { base: string; diffMode: DiffMode; diff: DiffResult }) {
  const { tab, s, actions } = useSession()
  const arch = useArchitecture(tab.cwd, s.files.filter((f) => f.tool === 'Write').length)
  const [result, setResult] = useState<ArchDiff | null>(null)
  const [folded, toggle] = useFolded('section:architecture')
  const apiOnly = useMemo(() => s.requirements.files.filter((f) => f.mark === 'api').map((f) => f.path), [s.requirements.files])
  // Recomputed when the file list changes (a new edit, a different base).
  const sig = diff.files.map((f) => `${f.status}${f.path}${f.additions ?? ''}/${f.deletions ?? ''}`).join('|')
  useEffect(() => {
    let live = true
    // It scans the project, so it waits for the edits to settle rather than running after each one.
    const t = setTimeout(() => window.glassbox.architecture.diff(tab.cwd, base, diffMode, apiOnly).then((r) => live && setResult(r), () => live && setResult(null)), 1500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [tab.cwd, base, diffMode, sig, apiOnly])
  if (!result || !arch || (!diff.files.length && !result.error)) return null
  const name = (id: string) => arch.modules.find((m) => m.id === id)?.name ?? id
  const pathOf = (id: string) => arch.modules.find((m) => m.id === id && !m.external)?.path
  const show = (ids: string[], why: string) => {
    const paths = ids.map(pathOf).filter((p): p is string => p !== undefined).map((p) => p || '.')
    if (paths.length) actions.show(tab.id, { view: 'map', paths }, why)
  }
  const none = !result.added.length && !result.removed.length && !result.breaches.length
  return (
    <div className={folded ? 'arch-changes folded' : 'arch-changes'}>
      <div className="arch-changes-head small">
        <button className="section-toggle" aria-expanded={!folded} onClick={toggle}>
          <Icon name="chevron-down" className="section-chevron" />
          <strong>{tr('changesPanel.architecture')}</strong>
          <span className="muted arch-changes-meta" title={none ? tr('changesPanel.noConnectionsTitle') : undefined}>
            {result.error ? tr('changesPanel.couldntCompare', { error: result.error }) : none ? tr('changesPanel.noConnectionsChanged') : summary(result)}
          </span>
        </button>
      </div>
      {!folded && (
        <>
      {result.breaches.map((b, i) => (
        <button key={`b${i}`} className="arch-change breach" onClick={() => show([moduleIdOf(arch, b.from), b.module].filter(Boolean) as string[], tr('changesPanel.reachesIntoWhy', { module: name(b.module) }))} title={tr('changesPanel.imports', { from: b.from, to: b.to })}>
          <Icon name="shield" />
          <span className="grow">
            {tr('changesPanel.reachesInto', { module: name(b.module) })} <span className="muted mono">{tr('changesPanel.imports', { from: baseName(b.from), to: b.to.replace(/\/$/, '') })}</span>
          </span>
        </button>
      ))}
      {[...result.added.map((e) => ({ e, sign: '+' as const })), ...result.removed.map((e) => ({ e, sign: '−' as const }))].map(({ e, sign }) => (
        <button key={`${sign}${e.from}>${e.to}`} className={sign === '+' ? 'arch-change added' : 'arch-change removed'} onClick={() => show([e.from, e.to], tr(sign === '+' ? 'changesPanel.newConnectionWhy' : 'changesPanel.removedConnectionWhy', { from: name(e.from), to: name(e.to) }))} title={edgeTip(e)}>
          <span className={sign === '+' ? 'arch-change-sign ok' : 'arch-change-sign err'}>{sign}</span>
          <span className="grow ellipsis">
            {name(e.from)} → {name(e.to)}
            {e.http && <span className="muted"> {tr('changesPanel.overHttp')}</span>}
            {e.names.length > 0 && <span className="muted">: {e.names.slice(0, 3).join(', ')}{e.names.length > 3 ? ` +${e.names.length - 3}` : ''}</span>}
          </span>
        </button>
      ))}
        </>
      )}
    </div>
  )
}

const moduleIdOf = (arch: Architecture, rel: string) => {
  let best: { id: string; len: number } | undefined
  for (const m of arch.modules) {
    if (m.external) continue
    const p = m.path.toLowerCase()
    const r = rel.toLowerCase()
    if ((p === '' || r === p || r.startsWith(p + '/')) && (!best || m.path.length > best.len)) best = { id: m.id, len: m.path.length }
  }
  return best?.id
}

function summary(r: ArchDiff): string {
  const parts = [r.added.length && tr('changesPanel.newConnections', { count: r.added.length }), r.removed.length && tr('changesPanel.removedCount', { n: r.removed.length }), r.breaches.length && tr('changesPanel.boundaryBreaks', { count: r.breaches.length })].filter(Boolean)
  return parts.join(', ') + '.'
}

const edgeTip = (e: ArchDiffEdge) => `${e.files.slice(0, 6).join('\n')}${e.files.length > 6 ? `\n${tr('changesPanel.andMore', { n: e.files.length - 6 })}` : ''}\n${tr('changesPanel.openOnMap')}`

/** Untracked and not touched by Claude this session: leftovers in the folder, not branch changes. */
const isStrayUntracked = (r: Row) => r.status === '?' && r.claudeEdits === 0

export function CallDiff({ call, path }: { call?: ToolCall; path: string }) {
  if (!call) return null
  const i = call.input
  let original = ''
  let modified = ''
  if (call.name === 'Write') modified = String(i.content ?? '')
  else if (call.name === 'Edit') {
    original = String(i.old_string ?? '')
    modified = String(i.new_string ?? '')
  } else if (call.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = i.edits as { old_string: string; new_string: string }[]
    original = edits.map((e) => e.old_string).join('\n\n⋯\n\n')
    modified = edits.map((e) => e.new_string).join('\n\n⋯\n\n')
  } else modified = JSON.stringify(i, null, 2)
  return <DiffView path={path} original={original} modified={modified} inline />
}

/** Whole file against the base. `version` re-reads it (e.g. after Claude edits it again). */
export function GitFileDiff({ path, base, diffMode, onEditor, version }: { path: string; base: string; diffMode: DiffMode; onEditor?: (ed: editor.ICodeEditor) => void; version?: number }) {
  const { tab } = useSession()
  const [pair, setPair] = useState<{ key: string; original: string; modified: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = `${path}|${base}|${diffMode}`
  useEffect(() => {
    let stale = false
    setError(null)
    // Keep showing the current diff while a refresh loads, so live updates don't flicker.
    Promise.all([window.glassbox.git.fileAt(tab.cwd, base, diffMode, path), window.glassbox.fs.read(tab.cwd, path).catch(() => ({ content: '' }))])
      .then(([original, current]) => {
        if (stale) return
        // A read that failed (e.g. too large) isn't an empty file: say so rather than show it all as deleted.
        if ('error' in current && current.error) return setError(current.error)
        setPair({ key, original, modified: current.content ?? '' })
      })
      .catch((e) => !stale && setError(String(e)))
    return () => {
      stale = true
    }
  }, [key, tab.cwd, version])
  if (error) return <div className="note note-error">{error}</div>
  if (!pair || pair.key !== key) return <div className="muted pad">{tr('changesPanel.loadingDiff')}</div>
  return <DiffView key={path} path={path} original={pair.original} modified={pair.modified} inline onEditor={onEditor} />
}

