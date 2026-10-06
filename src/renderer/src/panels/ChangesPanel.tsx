import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS, isClaudeOwnFile, type ToolCall } from '../session'
import { baseName, relPath } from '../lib'

/** A changed file's folder, relative to the project (empty for the project root). */
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')
import { DiffView } from '../components/Code'
import type { editor } from 'monaco-editor'
import { Empty, Icon, IconButton, Segmented, useFolded } from '../components/ui'
import type { ArchDiff, ArchDiffEdge, DiffMode, DiffResult } from '../../../shared/events'
import { Select } from '../components/Select'
import { useArchitecture } from '../architecture'
import type { Architecture } from '../../../shared/architecture'
import { tr } from '../../../shared/i18n'

type Row = { path: string; status: string; oldPath?: string; additions?: number; deletions?: number; claudeEdits: number }

const STATUS: Record<string, { label: string; cls: string; title: string }> = {
  A: { label: 'A', cls: 'ok', title: tr('changesPanel.statusAdded') },
  M: { label: 'M', cls: 'warn', title: tr('changesPanel.statusModified') },
  D: { label: 'D', cls: 'err', title: tr('changesPanel.statusDeleted') },
  R: { label: 'R', cls: 'info', title: tr('changesPanel.statusRenamed') },
  '?': { label: 'U', cls: 'ok', title: tr('changesPanel.statusUntracked') }
}

/**
 * Everything changed on this branch, in one list, with Claude's changes from this session tagged.
 * Clicking a file opens its diff full size in the work area.
 */
export function ChangesPanel() {
  const { tab, s, openDiff, workPath, openRipple } = useSession()
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<DiffMode>('merge-base')
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  const load = useCallback(() => {
    if (!base) return
    setError(null)
    window.glassbox.git.diff(tab.cwd, base, diffMode).then(setDiff, (e) => setError(String(e)))
  }, [tab.cwd, base, diffMode])
  useEffect(load, [load, s.git?.dirty, s.git?.head])

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

  const rows: Row[] = useMemo(() => {
    const list: Row[] = (diff?.files ?? []).map((f) => ({ ...f, claudeEdits: claude.get(f.path)?.edits ?? 0 }))
    // Claude's edits that git can't show (not a repo, or a file outside it) still belong here. Inside the
    // repo, an edit missing from the diff has no net change (made then undone, or created then deleted).
    for (const [rel, c] of claude) if (!list.some((r) => r.path === rel) && (!diff || rel.startsWith('..') || /^[a-z]:/i.test(rel))) list.push({ path: rel, status: 'M', claudeEdits: c.edits })
    return list
      .filter((r) => showUntracked || !isStrayUntracked(r))
      .filter((r) => !onlyClaude || r.claudeEdits > 0)
      .filter((r) => !filter || r.path.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => b.claudeEdits - a.claudeEdits || a.path.localeCompare(b.path))
  }, [diff, claude, onlyClaude, filter, showUntracked])
  const strays = (diff?.files ?? []).filter((f) => f.status === '?' && !claude.has(f.path)).length

  const total = diff ? diff.files.length - (showUntracked ? 0 : strays) : claude.size
  const adds = diff?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const dels = diff?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0
  const absOf = (r: Row) => claude.get(r.path)?.abs ?? `${root}/${r.path}`

  return (
    <div className="panel">
      {/* One row: what changed, against what (base branch and how, in one control), and refresh. */}
      <div className="changes-summary">
        <span className="small changes-count">
          <strong>{tr('changesPanel.files', { count: total })}</strong>
          {diff && <> <span className="ok">+{adds}</span> <span className="err">−{dels}</span></>}
        </span>
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
        {total > 0 && <IconButton icon="radio-tower" title={tr('changesPanel.rippleTitle')} onClick={() => openRipple()} />}
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
        {(total > 10 || filter) && (
          <div className="search grow">
            <Icon name="search" />
            <input placeholder={tr('changesPanel.filterFiles')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
      </div>
      {error && <div className="note note-error">{error}</div>}
      {strays > 0 && (
        <div className="changes-untracked small muted">
          {showUntracked
            ? tr('changesPanel.showingUntracked', { count: strays })
            : tr('changesPanel.untrackedHidden', { count: strays })}{' '}
          <button className="link small" onClick={() => setShowUntracked(!showUntracked)}>{showUntracked ? tr('changesPanel.hideThem') : tr('changesPanel.showThem')}</button>
        </div>
      )}
      {repo && base && diff && <ArchitectureChanges base={base} diffMode={diffMode} diff={diff} />}
      <div className="file-list full">
        {repo && !diff && !error && <div className="muted pad">{tr('changesPanel.comparing')}</div>}
        {(diff || !repo) && rows.length === 0 && (
          <Empty icon={onlyClaude ? 'edit' : 'check'} title={onlyClaude ? tr('changesPanel.claudeNoChanges') : base ? tr('changesPanel.noDifferencesFrom', { base }) : tr('changesPanel.noChanges')}>
            {tr('changesPanel.emptyBody')}
          </Empty>
        )}
        {/* Grouped by folder, so where each change lives reads at a glance. */}
        {[...rows.reduce((m, r) => m.set(dirOf(r.path), [...(m.get(dirOf(r.path)) ?? []), r]), new Map<string, typeof rows>())]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dir, files]) => (
            <div key={dir} className="change-folder">
              <div className="change-folder-head" title={dir || tr('changesPanel.projectRoot')}>
                <Icon name="folder" className="muted" />
                <span className="grow ellipsis change-folder-path">{dir || tr('changesPanel.projectRoot')}</span>
                <span className="muted small">{tr('changesPanel.folderFiles', { count: files.length })}</span>
                {files.some((f) => f.additions !== undefined) && (
                  <span className="small num">
                    <span className="ok">+{files.reduce((n, f) => n + (f.additions ?? 0), 0)}</span> <span className="err">−{files.reduce((n, f) => n + (f.deletions ?? 0), 0)}</span>
                  </span>
                )}
              </div>
              {files.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, cls: 'muted', title: r.status }
                const abs = absOf(r)
                return (
                  <div
                    key={r.path}
                    className={abs === workPath ? 'list-row clickable selected change-file' : 'list-row clickable change-file'}
                    onClick={() => openDiff({ path: abs, base, diffMode, source: r.claudeEdits ? 'session' : 'branch' })}
                    title={r.oldPath ? `${r.oldPath} → ${r.path}` : r.path}
                  >
                    <span className={`status-letter ${st.cls}`} title={st.title}>{st.label}</span>
                    <span className="grow ellipsis">{baseName(r.path)}</span>
                    {r.additions !== undefined && (
                      <span className="small num">
                        <span className="ok">+{r.additions}</span> <span className="err">−{r.deletions}</span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
      </div>
    </div>
  )
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
    window.glassbox.architecture.diff(tab.cwd, base, diffMode, apiOnly).then((r) => live && setResult(r), () => live && setResult(null))
    return () => {
      live = false
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

