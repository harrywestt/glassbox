import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { EDIT_TOOLS } from '../session'
import { relPath } from '../lib'
import { useSelectionComment } from '../components/Code'
import { CallDiff, GitFileDiff } from '../panels/ChangesPanel'
import { Icon, IconButton } from '../components/ui'
import type { DiffMode } from '../../../shared/events'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

/**
 * A changed file, full size. Session edits can be viewed as the whole file against the base branch
 * or change by change; branch compares show the whole file.
 */
export function DiffTab({ path, base: givenBase, diffMode, source }: { path: string; base: string | null; diffMode: DiffMode; source: 'session' | 'branch' }) {
  const { tab, s } = useSession()
  // Opened from somewhere that didn't pick a base (e.g. an edit in the conversation): use the repo's default branch.
  const [base, setBase] = useState(givenBase)
  useEffect(() => {
    if (givenBase || !s.git?.isRepo) return
    void window.glassbox.git.branches(tab.cwd).then((b) => setBase(b.defaultBase))
  }, [givenBase, s.git?.isRepo, tab.cwd])
  const latest = s.files.filter((f) => f.path === path).at(-1)?.at
  const rel = relPath(tab.cwd, path)
  const calls = useMemo(
    () => s.files.filter((f) => f.path === path && EDIT_TOOLS.has(f.tool)).map((f) => s.toolCalls[f.toolId]).filter((c) => !!c),
    [s.files, s.toolCalls, path]
  )
  const [view, setView] = useState<string>('base')
  const whole = view === 'base' && !!base
  const comment = useSelectionComment(rel)

  return (
    <div className="work-page">
      <div className="work-bar">
        <Icon name="git-compare" className="muted" />
        <span className="mono small ellipsis grow" title={path}>{rel}</span>
        {source === 'session' && calls.length > 0 ? (
          <Select
            value={view}
            onChange={setView}
            aria-label={tr('diffTab.compareLabel')}
            options={[
              ...(base ? [{ value: 'base', label: tr('diffTab.wholeFile', { base }) }] : []),
              ...calls.map((c, i) => ({
                value: String(i),
                label: tr(c!.name === 'Write' ? 'diffTab.changeWrote' : 'diffTab.changeEdited', { n: i + 1, total: calls.length, time: new Date(c!.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
              }))
            ]}
          />
        ) : (
          base && <span className="muted small">{tr(diffMode === 'merge-base' ? 'diffTab.againstSinceBranching' : 'diffTab.against', { base })}</span>
        )}
        {whole && comment.button}
        <IconButton icon="go-to-file" title={tr('diffTab.openInEditor')} onClick={() => void window.glassbox.openPath(path)} />
      </div>
      {comment.box}
      <div className="work-body">
        {whole || source === 'branch' ? (
          base ? <GitFileDiff path={path} base={base} diffMode={diffMode} onEditor={comment.bind} version={latest} /> : s.git?.isRepo === false ? <CallDiff call={calls.at(-1)} path={path} /> : <div className="muted pad">{tr('diffTab.loading')}</div>
        ) : (
          <CallDiff call={view === 'base' ? calls.at(-1) : calls[Number(view)]} path={path} />
        )}
      </div>
    </div>
  )
}
