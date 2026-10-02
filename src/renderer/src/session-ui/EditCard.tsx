import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import type { ToolCall } from '../session'
import { baseName, relPath } from '../lib'
import { counts, diffLines, withContext, type DiffLine } from '../linediff'
import { editText } from '../edits'

export { editText }
import { Icon } from '../components/ui'
import { secretIn } from '../radar'
import { tr } from '../../../shared/i18n'

const PREVIEW_LINES = 14
/** Edits undone this run, so the cards remember after re-rendering. */
const UNDONE = new Set<string>()

export function editCounts(call: ToolCall) {
  const { before, after } = editText(call)
  return counts(diffLines(before, after))
}

/**
 * An edit shown where it happens in the conversation: the file, +/- counts and the changed lines,
 * without clicking into anything. Click the header for the file's full diff.
 */
export function EditCard({ call }: { call: ToolCall }) {
  const { tab, s, openDiff, composerRef, openRipple, everyday } = useSession()
  const [undo, setUndo] = useState<'idle' | 'confirm' | 'working' | 'done'>(() => (UNDONE.has(call.id) ? 'done' : 'idle'))
  const [undoError, setUndoError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const path = String(call.input.file_path ?? call.input.notebook_path ?? '')
  const { lines, added, removed } = useMemo(() => {
    const { before, after } = editText(call)
    const d = diffLines(before, after)
    return { lines: withContext(d), ...counts(d) }
  }, [call])
  const shown = all ? lines : lines.slice(0, PREVIEW_LINES)
  const secret = useMemo(() => secretIn(lines.filter((l) => l?.t === '+').map((l) => l!.s).join('\n')), [lines])
  const failed = call.status === 'error'
  // A Write can only be undone if it created the file: Claude always reads a file before rewriting it.
  const createdFile = call.name === 'Write' && !s.files.some((f) => f.path === path && f.at < call.at)
  const canUndo = !failed && call.status === 'done' && (call.name !== 'Write' || createdFile)

  const doUndo = async () => {
    setUndo('working')
    setUndoError(null)
    try {
      await window.glassbox.undoEdit(tab.cwd, call.name, call.input, createdFile)
      UNDONE.add(call.id)
      setUndo('done')
      composerRef.current?.insert(`I undid your ${call.name === 'Write' ? 'new file' : 'edit to'} ${baseName(path)} because `)
    } catch (e) {
      setUndo('idle')
      setUndoError(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''))
    }
  }

  return (
    <div className={failed ? 'edit-card failed' : undo === 'done' ? 'edit-card undone' : 'edit-card'}>
      <div className="edit-head-row">
      <button className="edit-head" onClick={() => openDiff({ path, base: null, diffMode: 'merge-base', source: 'session' })} title={tr('editCard.openFullDiff', { path })}>
        {call.status === 'running' ? <Icon name="loading" className="codicon-modifier-spin accent" /> : <Icon name={call.name === 'Write' ? 'new-file' : 'edit'} className={failed ? 'err' : 'warn'} />}
        <span className="edit-verb">{failed ? tr('editCard.triedToEdit') : call.name === 'Write' ? tr('editCard.wrote') : tr('editCard.edited')}</span>
        <span className="edit-file">{baseName(path)}</span>
        <span className="muted small ellipsis">{relPath(tab.cwd, path).split('/').slice(0, -1).join('/')}</span>
        <span className="spacer" />
        {secret && <span className="tag err-tag" title={tr('editCard.secretHint')}>{tr('editCard.possibleSecret', { secret })}</span>}
        <span className="small num"><span className="ok">+{added}</span> <span className="err">−{removed}</span></span>
        <Icon name="link-external" className="muted edit-open" />
      </button>
      {!failed && !everyday && call.status === 'done' && (
        <button className="icon-btn edit-undo" title={tr('editCard.whatWouldItAffect')} aria-label={tr('editCard.whatWouldItAffect')} onClick={() => openRipple(undefined, path)}>
          <Icon name="radio-tower" />
        </button>
      )}
      {undo === 'done' ? (
        <span className="tag edit-undone">{tr('editCard.undone')}</span>
      ) : undo === 'confirm' ? (
        <span className="edit-undo-confirm small">
          {tr('editCard.undoConfirm')}
          <button className="chip-btn" onClick={() => void doUndo()}>{tr('editCard.undo')}</button>
          <button className="chip-btn" onClick={() => setUndo('idle')}>{tr('editCard.keep')}</button>
        </span>
      ) : (
        canUndo && (
          <button className="icon-btn edit-undo" disabled={undo === 'working'} title={call.name === 'Write' ? tr('editCard.undoNewFile') : tr('editCard.undoEdit')} onClick={() => setUndo('confirm')}>
            <Icon name={undo === 'working' ? 'loading' : 'discard'} className={undo === 'working' ? 'codicon-modifier-spin' : ''} />
          </button>
        )
      )}
      </div>
      {undoError && <div className="edit-error small">{undoError}</div>}
      {!failed && (
        <div className="edit-diff mono">
          {shown.map((l, idx) => (l ? <Line key={idx} l={l} /> : <div key={idx} className="edit-gap">⋯</div>))}
          {lines.length > PREVIEW_LINES && (
            <button className="edit-more" onClick={() => setAll(!all)}>
              {all ? tr('editCard.showLess') : tr('editCard.showMoreLines', { n: lines.length - PREVIEW_LINES })}
            </button>
          )}
        </div>
      )}
      {failed && call.result && <div className="edit-error small">{call.result.slice(0, 300)}</div>}
    </div>
  )
}

function Line({ l }: { l: DiffLine }) {
  return (
    <div className={l.t === '+' ? 'dl add' : l.t === '-' ? 'dl del' : 'dl'}>
      <span className="dl-mark">{l.t === ' ' ? '' : l.t === '+' ? '+' : '−'}</span>
      <span className="dl-text">{l.s || ' '}</span>
    </div>
  )
}
