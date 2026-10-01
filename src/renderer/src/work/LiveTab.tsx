import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { EDIT_TOOLS, CHANGE_TOOLS, isClaudeOwnFile } from '../session'
import { baseName, relPath, timeAgo } from '../lib'
import { editCounts } from '../session-ui/EditCard'
import { CallDiff, GitFileDiff } from '../panels/ChangesPanel'
import { Empty, Icon, Toggle } from '../components/ui'

type LiveFile = { path: string; edits: number; added: number; removed: number; last: number; lastCallId: string }

/**
 * What Claude is changing, as it changes it: follows the most recently edited file and shows its
 * full diff against the base branch, refreshed after every edit.
 */
export function LiveTab() {
  const { tab, s, openDiff, actions } = useSession()
  // The edit you last asked about, so the button can say it's been asked.
  const [asked, setAsked] = useState<string | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [pinned, setPinned] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    if (!s.git?.isRepo) return
    void window.glassbox.git.branches(tab.cwd).then((b) => setBase(b.defaultBase))
  }, [tab.cwd, s.git?.isRepo])

  // Keep "updated 12s ago" fresh.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const files = useMemo(() => {
    const by = new Map<string, LiveFile>()
    for (const f of s.files) {
      const call = s.toolCalls[f.toolId]
      if (!CHANGE_TOOLS.has(f.tool) || !call || call.status === 'error' || isClaudeOwnFile(f.path)) continue
      const c = editCounts(call)
      const e = by.get(f.path) ?? { path: f.path, edits: 0, added: 0, removed: 0, last: 0, lastCallId: call.id }
      e.edits++
      e.added += c.added
      e.removed += c.removed
      if (f.at >= e.last) {
        e.last = f.at
        e.lastCallId = call.id
      }
      by.set(f.path, e)
    }
    return [...by.values()].sort((a, b) => b.last - a.last)
  }, [s.files, s.toolCalls])

  const current = (follow ? files[0] : files.find((f) => f.path === pinned)) ?? files[0]
  const writing = Object.values(s.toolCalls).find((c) => c.status === 'running' && EDIT_TOOLS.has(c.name))

  if (!files.length)
    return (
      <div className="work-page">
        <Empty icon="pulse" title="Nothing changed yet">
          When Claude edits a file it shows up here straight away, with its full diff, and updates after every edit.
        </Empty>
      </div>
    )

  return (
    <div className="live-view">
      <aside className="live-files">
        <div className="live-files-head">
          <span className="small muted">{files.length} file{files.length > 1 ? 's' : ''} changed this session</span>
          <span className="spacer" />
          <label className="live-follow" title="Show each file as Claude edits it">
            Follow Claude <Toggle checked={follow} onChange={(on) => setFollow(on)} />
          </label>
        </div>
        {files.map((f) => (
          <button
            key={f.path}
            className={f.path === current?.path ? 'live-file active' : 'live-file'}
            onClick={() => {
              setFollow(false)
              setPinned(f.path)
            }}
            title={f.path}
          >
            <Icon name="edit" className={f.path === files[0].path && Date.now() - f.last < 15_000 ? 'accent' : 'warn'} />
            <span className="live-file-main">
              <span className="ellipsis">{baseName(f.path)}</span>
              <span className="muted small ellipsis">{relPath(tab.cwd, f.path).split('/').slice(0, -1).join('/') || 'project root'}</span>
            </span>
            <span className="live-file-meta small">
              <span><span className="ok">+{f.added}</span> <span className="err">−{f.removed}</span></span>
              <span className="muted">{timeAgo(f.last)}</span>
            </span>
          </button>
        ))}
      </aside>
      {current && (
        <div className="work-page">
          <div className="work-bar">
            {writing ? <Icon name="loading" className="codicon-modifier-spin accent" /> : <Icon name="git-compare" className="muted" />}
            <strong className="ellipsis">{baseName(current.path)}</strong>
            <span className="muted small ellipsis grow">
              {current.edits} edit{current.edits > 1 ? 's' : ''} by Claude, last {timeAgo(current.last)}
              {base ? `, shown against ${base}` : ''}
            </span>
            {writing && <span className="pill pill-accent">Claude is editing {baseName(String(writing.input.file_path ?? ''))}</span>}
            {/* Ask Claude why it made the latest edit here; the answer comes back in the conversation. */}
            <button
              className="chip-btn"
              disabled={asked === current.lastCallId || !s.toolCalls[current.lastCallId] || s.status === 'new' || s.status === 'stopped'}
              title="Ask Claude why it made this edit. It answers in the conversation, then carries on."
              onClick={() => {
                const call = s.toolCalls[current.lastCallId]
                if (!call) return
                setAsked(call.id)
                void actions.comment(tab.id, { kind: 'tool', toolId: call.id, label: `Edit to ${baseName(current.path)}` }, `Why did you make this edit to ${relPath(tab.cwd, current.path)}? Say briefly what it's for and why you did it this way.`)
              }}
            >
              <Icon name="question" /> {asked === current.lastCallId ? 'Asked, see the conversation' : 'Ask why'}
            </button>
            <button className="chip-btn" onClick={() => openDiff({ path: current.path, base, diffMode: 'merge-base', source: 'session' })}>
              <Icon name="list-selection" /> Each change
            </button>
          </div>
          <div className="work-body">
            {base ? (
              <GitFileDiff path={current.path} base={base} diffMode="merge-base" version={current.last} />
            ) : (
              <CallDiff call={s.toolCalls[current.lastCallId]} path={current.path} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
