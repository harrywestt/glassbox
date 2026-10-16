import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS, isClaudeOwnFile } from '../session'
import { baseName, relPath } from '../lib'
import { Icon, IconButton, useFolded } from '../components/ui'
import { tr } from '../../../shared/i18n'

type WorkingFile = { path: string; oldPath?: string; staged?: string; unstaged?: string }
type Entry = { path: string; abs: string; code: string; claude: boolean }

/** A status letter as VS Code shows it, and its colour. */
const LETTER: Record<string, { label: string; cls: string; title: string }> = {
  M: { label: 'M', cls: 'warn', title: tr('changesPanel.statusModified') },
  A: { label: 'A', cls: 'ok', title: tr('changesPanel.statusAdded') },
  D: { label: 'D', cls: 'err', title: tr('changesPanel.statusDeleted') },
  R: { label: 'R', cls: 'info', title: tr('changesPanel.statusRenamed') },
  C: { label: 'C', cls: 'info', title: tr('changesPanel.statusRenamed') },
  U: { label: '!', cls: 'err', title: tr('sourceControl.conflict') },
  T: { label: 'T', cls: 'warn', title: tr('changesPanel.statusModified') },
  '?': { label: 'U', cls: 'ok', title: tr('changesPanel.statusUntracked') }
}

/**
 * Source Control, laid out as VS Code's: a commit message and Commit at the top, then Staged
 * Changes and Changes, a row per file (name, folder, status letter) with its actions on hover.
 * Clicking a file opens its diff; Claude's edits this session carry a small mark.
 */
export function SourceControl() {
  const { tab, s, openDiff, openFile, workPath } = useSession()
  const [files, setFiles] = useState<WorkingFile[] | null>(null)
  const [root, setRoot] = useState(s.git?.root ?? tab.cwd)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const repo = !!s.git?.isRepo

  const running = useRef(false)
  const again = useRef(false)
  const load = useCallback(() => {
    if (!repo) return
    if (running.current) return void (again.current = true)
    running.current = true
    window.glassbox.git
      .status(tab.cwd)
      .then((r) => (setFiles(r.files), setRoot(r.root)), (e) => setError(String(e)))
      .finally(() => {
        running.current = false
        if (again.current) (again.current = false), load()
      })
  }, [tab.cwd, repo])
  useEffect(load, [load])
  // The working copy changes as Claude edits: refresh once it settles.
  useEffect(() => {
    const t = setTimeout(load, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.git?.dirty, s.git?.head, s.files.length])

  // Files Claude changed this session (relative to the repo root).
  const claude = useMemo(() => new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && !isClaudeOwnFile(f.path)).map((f) => relPath(root, f.path).replace(/\\/g, '/'))), [s.files, root])
  const abs = (p: string) => `${root.replace(/\\/g, '/')}/${p}`
  const staged: Entry[] = useMemo(() => (files ?? []).filter((f) => f.staged).map((f) => ({ path: f.path, abs: abs(f.path), code: f.staged!, claude: claude.has(f.path) })), [files, claude, root]) // eslint-disable-line react-hooks/exhaustive-deps
  const changes: Entry[] = useMemo(() => (files ?? []).filter((f) => f.unstaged).map((f) => ({ path: f.path, abs: abs(f.path), code: f.unstaged!, claude: claude.has(f.path) })), [files, claude, root]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
      load()
    }
  }
  const stage = (paths: string[]) => act('stage', () => window.glassbox.git.stage(tab.cwd, paths))
  const unstage = (paths: string[]) => act('unstage', () => window.glassbox.git.unstage(tab.cwd, paths))
  const discard = (entries: Entry[]) => {
    const fresh = entries.filter((e) => e.code === '?').length
    const ask =
      entries.length === 1
        ? fresh
          ? tr('sourceControl.confirmDeleteOne', { file: baseName(entries[0].path) })
          : tr('sourceControl.confirmDiscardOne', { file: baseName(entries[0].path) })
        : tr('sourceControl.confirmDiscardMany', { count: entries.length })
    if (!window.confirm(ask)) return
    void act('discard', () => window.glassbox.git.discard(tab.cwd, entries.map((e) => e.path)))
  }
  const branch = s.git?.branch ?? ''
  const nothing = !staged.length && !changes.length
  const commit = () => {
    if (!message.trim() || nothing) return
    void act('commit', async () => {
      await window.glassbox.git.commit(tab.cwd, message.trim())
      setMessage('')
    })
  }
  const ahead = s.git?.ahead ?? 0

  // The diff of a file against what's committed (the work area's diff view).
  const latest = useRef(openDiff)
  latest.current = openDiff
  const open = useCallback((e: Entry) => (e.code === 'D' ? undefined : latest.current({ path: e.abs, base: 'HEAD', diffMode: 'direct', source: 'branch' })), [])
  const openTheFile = useCallback((e: Entry) => openFile(e.abs), [openFile])

  if (!repo) return null
  return (
    <div className="scm">
      <div className="scm-commit">
        <textarea
          className="scm-message"
          rows={message.includes('\n') ? 4 : 1}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), commit())}
          placeholder={tr('sourceControl.message')}
          title={branch ? tr('sourceControl.messageOn', { branch }) : undefined}
          aria-label={tr('sourceControl.messageLabel')}
        />
        <button className="primary scm-commit-btn" disabled={!message.trim() || nothing || !!busy} onClick={commit} title={staged.length ? tr('sourceControl.commitStagedTip') : tr('sourceControl.commitAllTip')}>
          <Icon name={busy === 'commit' ? 'loading' : 'check'} className={busy === 'commit' ? 'codicon-modifier-spin' : undefined} /> {staged.length || nothing ? tr('sourceControl.commit') : tr('sourceControl.commitAll')}
        </button>
        {nothing && ahead > 0 && (
          <button className="btn scm-commit-btn" disabled={!!busy} onClick={() => void act('push', () => window.glassbox.git.push(tab.cwd))}>
            <Icon name={busy === 'push' ? 'loading' : 'cloud-upload'} className={busy === 'push' ? 'codicon-modifier-spin' : undefined} /> {tr('sourceControl.push', { count: ahead })}
          </button>
        )}
      </div>
      {error && <div className="note note-error scm-error">{error}</div>}
      {files && nothing && <div className="scm-empty muted small">{tr('sourceControl.clean')}</div>}
      {staged.length > 0 && (
        <Group id="staged" title={tr('sourceControl.staged')} count={staged.length} actions={<IconButton icon="remove" title={tr('sourceControl.unstageAll')} onClick={() => void unstage(staged.map((e) => e.path))} />}>
          <Files entries={staged} selected={workPath} onOpen={open} onOpenFile={openTheFile} actions={(e) => <IconButton icon="remove" title={tr('sourceControl.unstage')} onClick={() => void unstage([e.path])} />} />
        </Group>
      )}
      {changes.length > 0 && (
        <Group
          id="changes"
          title={tr('sourceControl.changes')}
          count={changes.length}
          actions={
            <>
              <IconButton icon="discard" title={tr('sourceControl.discardAll')} onClick={() => discard(changes)} />
              <IconButton icon="add" title={tr('sourceControl.stageAll')} onClick={() => void stage(changes.map((e) => e.path))} />
            </>
          }
        >
          <Files
            entries={changes}
            selected={workPath}
            onOpen={open}
            onOpenFile={openTheFile}
            actions={(e) => (
              <>
                <IconButton icon="discard" title={e.code === '?' ? tr('sourceControl.delete') : tr('sourceControl.discard')} onClick={() => discard([e])} />
                <IconButton icon="add" title={tr('sourceControl.stage')} onClick={() => void stage([e.path])} />
              </>
            )}
          />
        </Group>
      )}
    </div>
  )
}

/** A foldable group (Staged Changes, Changes): its count, and its actions on hover. */
function Group({ id, title, count, actions, children }: { id: string; title: string; count: number; actions: React.ReactNode; children: React.ReactNode }) {
  const [folded, toggle] = useFolded(`scm:${id}`)
  return (
    <div className={folded ? 'scm-group folded' : 'scm-group'}>
      <div className="scm-group-head">
        <button className="scm-group-toggle" aria-expanded={!folded} onClick={toggle}>
          <Icon name="chevron-down" className="section-chevron" />
          <span>{title}</span>
          <span className="scm-count">{count}</span>
        </button>
        <span className="scm-actions">{actions}</span>
      </div>
      {!folded && children}
    </div>
  )
}

/** The files, a row each: name, folder, the actions on hover, the status letter. Arrow keys move, Enter opens. */
const Files = memo(function Files({ entries, selected, onOpen, onOpenFile, actions }: { entries: Entry[]; selected: string | null; onOpen: (e: Entry) => void; onOpenFile: (e: Entry) => void; actions: (e: Entry) => React.ReactNode }) {
  const keys = (ev: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...ev.currentTarget.querySelectorAll<HTMLElement>('.scm-row')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'ArrowDown') (ev.preventDefault(), rows[Math.min(rows.length - 1, i + 1)]?.focus())
    else if (ev.key === 'ArrowUp') (ev.preventDefault(), rows[Math.max(0, i - 1)]?.focus())
  }
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return (
    <div className="scm-files" role="list" onKeyDown={keys}>
      {entries.map((e) => {
        const l = LETTER[e.code] ?? LETTER.M
        const dir = e.path.split('/').slice(0, -1).join('/')
        const on = !!selected && norm(selected) === norm(e.abs)
        return (
          <div
            key={e.path}
            role="listitem"
            tabIndex={0}
            className={`scm-row${on ? ' selected' : ''}${e.code === 'D' ? ' deleted' : ''}`}
            onClick={() => onOpen(e)}
            onKeyDown={(k) => k.key === 'Enter' && onOpen(e)}
            title={e.path}
          >
            <Icon name="file" className="scm-icon" />
            <span className="scm-name">{baseName(e.path)}</span>
            {e.claude && <span className="scm-claude" title={tr('sourceControl.claudeChanged')} aria-label={tr('sourceControl.claudeChanged')} />}
            <span className="scm-dir">{dir}</span>
            <span className="scm-row-actions" onClick={(k) => k.stopPropagation()}>
              {e.code !== 'D' && <IconButton icon="go-to-file" title={tr('sourceControl.openFile')} onClick={() => onOpenFile(e)} />}
              {actions(e)}
            </span>
            <span className={`scm-letter ${l.cls}`} title={l.title}>
              {l.label}
            </span>
          </div>
        )
      })}
    </div>
  )
})
