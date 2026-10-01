import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { absPath, mediaKind, mediaUrl, relPath } from '../lib'
import { MediaView } from '../components/MediaView'
import { CodeView, useSelectionComment } from '../components/Code'
import { Icon, IconButton } from '../components/ui'
import type { FileMark } from '../../../shared/events'

const MARKS: { mark: FileMark; icon: string; label: string }[] = [
  { mark: 'read', icon: 'eye', label: 'Must read' },
  { mark: 'edit', icon: 'edit', label: 'Must edit' },
  { mark: 'avoid', icon: 'lock', label: "Don't touch" }
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

  useEffect(() => {
    if (!asText) return
    setFile(null)
    window.glassbox.fs.read(tab.cwd, rel).then(setFile, (e) => setFile({ error: String(e) }))
  }, [rel, tab.cwd, s.git?.dirty, asText])

  return (
    <div className="work-page">
      <div className="work-bar">
        <Icon name="file" className="muted" />
        <span className="mono small ellipsis grow" title={path}>{rel}</span>
        {!outside && MARKS.map((m) => (
          <button key={m.mark} className={mark === m.mark ? `chip-btn on mark-${m.mark}` : 'chip-btn'} onClick={() => markFile(rel, mark === m.mark ? null : m.mark)} title={`${m.label}: Claude sees this with every message`}>
            <Icon name={m.icon} /> {m.label}
          </button>
        ))}
        {/\.svg$/i.test(path) && (
          <button className={source ? 'chip-btn on' : 'chip-btn'} onClick={() => setSource(!source)} title="Show the SVG's source">
            <Icon name="code" /> Source
          </button>
        )}
        {asText && comment.button}
        <IconButton icon="mention" title="Mention this file in your message" onClick={() => composerRef.current?.insert(`@${rel}`)} />
        <IconButton icon="go-to-file" title="Open in your default editor" onClick={() => void window.glassbox.openPath(file && 'content' in file ? `${tab.cwd}/${rel}` : path)} />
      </div>
      {comment.box}
      <div className="work-body">
        {pdf ? <iframe className="pdf-view" src={`${mediaUrl(absFile)}?v=${touches}`} title={rel} /> : !asText ? <MediaView path={absFile} version={touches} /> : !file ? <div className="muted pad">Loading…</div> : file.error ? <div className="note note-error">{file.error}</div> : <CodeView
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
