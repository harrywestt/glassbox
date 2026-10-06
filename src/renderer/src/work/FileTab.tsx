import { useRef, useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { absPath, mediaKind, mediaUrl, relPath } from '../lib'
import { MediaView } from '../components/MediaView'
import { CodeView, useSelectionComment } from '../components/Code'
import { Icon, IconButton } from '../components/ui'
import type { FileMark } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

const MARKS: { mark: FileMark; icon: string; label: string }[] = [
  { mark: 'read', icon: 'eye', label: 'fileTab.marks.read' },
  { mark: 'edit', icon: 'edit', label: 'fileTab.marks.edit' },
  { mark: 'avoid', icon: 'lock', label: 'fileTab.marks.avoid' }
]

/** A project file, full size, with marks and comment-on-selection. Opened by Claude, it lands on the lines it's pointing at. */
export function FileTab({ path, line, endLine }: { path: string; line?: number; endLine?: number }) {
  const { tab, s, markFile, composerRef } = useSession()
  const rel = relPath(tab.cwd, path)
  const absFile = absPath(tab.cwd, path)
  const [file, setFile] = useState<{ content?: string; error?: string } | null>(null)
  const comment = useSelectionComment(rel)
  const mark = s.requirements.files.find((f) => relPath(tab.cwd, f.path) === rel)?.mark
  // Images, video and audio show as themselves; an SVG can flip to its source.
  const media = mediaKind(path)
  // A PDF opens in Chromium's own viewer, inside the tab.
  const pdf = /\.pdf$/i.test(path)
  const [source, setSource] = useState(false)
  const asText = (!media && !pdf) || source
  // A file from outside the project (an attachment, something in Downloads) can't be marked for Claude.
  const outside = /^\.\.|^[a-z]:|^\//i.test(rel)
  const touches = s.files.filter((f) => relPath(tab.cwd, f.path) === rel).length

  // A different file starts blank; the same file changing (Claude editing it) refreshes in place once edits settle.
  const shownRel = useRef<string | null>(null)
  useEffect(() => {
    if (!asText) return
    const same = shownRel.current === rel
    shownRel.current = rel
    if (!same) setFile(null)
    let live = true
    const t = setTimeout(() => window.glassbox.fs.read(tab.cwd, rel).then((f) => live && setFile(f), (e) => live && setFile({ error: String(e) })), same ? 500 : 0)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [rel, tab.cwd, s.git?.dirty, asText])

  return (
    <div className="work-page">
      <div className="work-bar">
        <Icon name="file" className="muted" />
        <span className="mono small ellipsis grow" title={path}>{rel}</span>
        {!outside && MARKS.map((m) => (
          <button key={m.mark} className={mark === m.mark ? `chip-btn on mark-${m.mark}` : 'chip-btn'} onClick={() => markFile(rel, mark === m.mark ? null : m.mark)} title={tr('fileTab.markTip', { label: tr(m.label) })}>
            <Icon name={m.icon} /> {tr(m.label)}
          </button>
        ))}
        {/\.svg$/i.test(path) && (
          <button className={source ? 'chip-btn on' : 'chip-btn'} onClick={() => setSource(!source)} title={tr('fileTab.svgSourceTip')}>
            <Icon name="code" /> {tr('fileTab.source')}
          </button>
        )}
        {asText && comment.button}
        <IconButton icon="mention" title={tr('fileTab.mention')} onClick={() => composerRef.current?.insert(`@${rel}`)} />
        <IconButton icon="go-to-file" title={tr('fileTab.openInEditor')} onClick={() => void window.glassbox.openPath(file && 'content' in file ? `${tab.cwd}/${rel}` : path)} />
      </div>
      {comment.box}
      <div className="work-body">
        {pdf ? <iframe className="pdf-view" src={`${mediaUrl(absFile)}?v=${touches}`} title={rel} /> : !asText ? <MediaView path={absFile} version={touches} /> : !file ? <div className="muted pad">{tr('fileTab.loading')}</div> : file.error ? <div className="note note-error">{file.error}</div> : <CodeView
            path={rel}
            content={file.content ?? ''}
            onEditor={(ed) => {
              comment.bind(ed)
              if (!line) return
              const end = Math.max(line, endLine ?? line)
              ed.revealLinesInCenter(line, end)
              ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: Number.MAX_SAFE_INTEGER })
            }}
          />}
      </div>
    </div>
  )
}
