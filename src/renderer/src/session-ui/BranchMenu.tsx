import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import type { BranchList } from '../../../main/git'

/** The branch chip in the session header; click it to switch to another branch or start a new one. */
export function BranchMenu() {
  const { tab, s, peers } = useSession()
  const git = s.git
  const slash = (p?: string) => p?.replace(/\\/g, '/').toLowerCase()
  const root = slash(git?.root)
  const shared = !!root && peers.some((p) => p.tab.id !== tab.id && p.s.status !== 'stopped' && slash(p.s.git?.root) === root)
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  if (!git?.isRepo) return null
  const busy = s.status === 'running'

  return (
    <>
      <button
        ref={button}
        className={open ? 'sh-branch open' : 'sh-branch'}
        disabled={busy}
        onClick={() => setOpen(!open)}
        title={busy ? 'Wait for Claude to finish before switching branch' : `${git.branch} @ ${git.head}${git.upstream ? `\ntracking ${git.upstream}` : ''}\nClick to switch branch`}
      >
        <Icon name="git-branch" /> {git.branch}
        {/* The branch's changed files, the number the Changes panel shows; uncommitted ones are in the tooltip. */}
        {(git.changed ?? git.dirty) ? (
          <span
            className={git.dirty ? 'chip-extra warn' : 'chip-extra'}
            title={`${git.changed ?? git.dirty} file${(git.changed ?? git.dirty) === 1 ? '' : 's'} changed${git.base ? ` against ${git.base}` : ''}${git.dirty ? `, ${git.dirty} not committed yet` : ', all committed'}`}
          >
            ●{git.changed ?? git.dirty}
          </span>
        ) : null}
        {!!git.ahead && <span className="chip-extra">↑{git.ahead}</span>}
        {!!git.behind && <span className="chip-extra">↓{git.behind}</span>}
        <Icon name="chevron-down" className="sh-branch-caret" />
      </button>
      {open && button.current && createPortal(<Popover anchor={button.current} cwd={tab.cwd} tabId={tab.id} dirty={git.dirty ?? 0} shared={shared} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function Popover({ anchor, cwd, tabId, dirty, shared, onClose }: { anchor: HTMLElement; cwd: string; tabId: string; dirty: number; shared: boolean; onClose: () => void }) {
  const [list, setList] = useState<BranchList | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.glassbox.git.branchList(cwd).then(setList, (e) => setError(String(e)))
  }, [cwd])

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 380)) })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    // Its session went out of view (another tab, the dashboard): the menu goes too.
    const gone = setInterval(() => anchor.offsetParent === null && onClose(), 400)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
      clearInterval(gone)
    }
  }, [anchor, onClose])

  const needle = q.trim().toLowerCase()
  const local = useMemo(() => (list?.local ?? []).filter((b) => b.name.toLowerCase().includes(needle)), [list, needle])
  const remote = useMemo(() => (list?.remote ?? []).filter((b) => b.toLowerCase().includes(needle)).slice(0, needle ? 30 : 8), [list, needle])
  const newName = q.trim().replace(/\s+/g, '-')
  const canCreate = !!newName && !list?.local.some((b) => b.name === newName) && !/[~^:?*[\\\s]|\.\.|^[-/]|[/.]$|@\{/.test(newName)

  const go = async (branch: string, create = false) => {
    // Another session in this same folder would have its files switched too.
    if (shared && !window.confirm(`Another session is working in this same folder. Switching to ${branch} changes the files for it too, mid-task.

Switch anyway?`)) return
    setSwitching(branch)
    setError(null)
    try {
      await window.glassbox.git.switchBranch(cwd, branch, create)
      await window.glassbox.session.refresh(tabId).catch(() => {})
      onClose()
    } catch (e) {
      setError(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''))
      setSwitching(null)
    }
  }

  return (
    <div ref={box} className="branch-pop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Switch branch">
      <div className="search">
        <Icon name="search" />
        <input
          autoFocus
          placeholder="Find or create a branch"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (local[0]) void go(local[0].name)
            else if (remote[0]) void go(remote[0])
            else if (canCreate) void go(newName, true)
          }}
        />
      </div>
      {dirty > 0 && (
        <div className="branch-note small">
          <Icon name="warning" className="warn" /> {dirty} uncommitted change{dirty > 1 ? 's' : ''} will come with you. Git won’t switch if they’d be overwritten.
        </div>
      )}
      {error && <div className="note note-error branch-error">{error}</div>}
      <div className="branch-list">
        {!list && !error && <div className="muted small pad">Loading branches…</div>}
        {local.length > 0 && <div className="branch-group">Local</div>}
        {local.map((b) => {
          const current = b.name === list?.current
          return (
            <button key={b.name} className={current ? 'branch-row current' : 'branch-row'} disabled={current || !!switching} onClick={() => void go(b.name)}>
              {/* Only the branch you're on (or switching to) is marked; the rest keep the space, so names line up. */}
              <span className="branch-mark">{current ? <Icon name="check" className="accent" /> : switching === b.name ? <Icon name="loading" className="codicon-modifier-spin" /> : null}</span>
              <span className="grow ellipsis">{b.name}</span>
              <span className="muted small">{b.when}</span>
            </button>
          )
        })}
        {remote.length > 0 && <div className="branch-group">Remote, not checked out yet</div>}
        {remote.map((b) => (
          <button key={b} className="branch-row" disabled={!!switching} onClick={() => void go(b)} title={`Create a local branch tracking ${b} and switch to it`}>
            <span className="branch-mark">{switching === b ? <Icon name="loading" className="codicon-modifier-spin" /> : null}</span>
            <span className="grow ellipsis">{b}</span>
          </button>
        ))}
        {list && !local.length && !remote.length && !canCreate && <div className="muted small pad">No matching branches.</div>}
      </div>
      {canCreate && (
        <button className="branch-create" disabled={!!switching} onClick={() => void go(newName, true)}>
          <Icon name="add" /> Create <strong>{newName}</strong> from the current commit
        </button>
      )}
    </div>
  )
}
