import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { languageFor, monacoTheme } from '../monaco'
import { useThemeTokens } from '../App'
import { CommentBox } from './CommentBox'
import { Icon } from './ui'
import { tr } from '../../../shared/i18n'
import type { CommentTarget } from '../session'

const base = { readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }

type EditorRef = (ed: editor.ICodeEditor) => void

export function CodeView({ path, content, onEditor }: { path: string; content: string; onEditor?: EditorRef }) {
  const theme = useThemeTokens()
  return <Editor theme={monacoTheme(theme)} value={content} language={languageFor(path)} options={base} onMount={(ed) => onEditor?.(ed)} />
}

export function DiffView({ path, original, modified, inline, onEditor }: { path: string; original: string; modified: string; inline?: boolean; onEditor?: EditorRef }) {
  const theme = useThemeTokens()
  // Monaco treats an empty original as one blank line and shows it as removed; a new file is all additions.
  if (original === '') return <NewFileView path={path} content={modified} onEditor={onEditor} />
  // Room for the longest line number, so 5-digit numbers in long files don't run together.
  const digits = String(Math.max(lineCount(original), lineCount(modified))).length
  return (
    <DiffEditor
      theme={monacoTheme(theme)}
      original={original}
      modified={modified}
      language={languageFor(path)}
      options={{
        ...base,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: true,
        // Large (e.g. generated) files: no time limit on the diff, and long unchanged stretches folded away.
        lineNumbersMinChars: Math.max(3, digits + 1),
        maxComputationTime: 0,
        maxFileSize: 100,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 }
      }}
      onMount={(ed) => {
        onEditor?.(ed.getModifiedEditor())
        // Open at the first change rather than the top of the file.
        const sub = ed.onDidUpdateDiff(() => {
          const first = ed.getLineChanges()?.[0]
          if (!first) return
          const line = first.modifiedEndLineNumber > 0 ? first.modifiedStartLineNumber : Math.max(1, first.modifiedStartLineNumber)
          ed.getModifiedEditor().revealLineNearTop(line)
          sub.dispose()
        })
      }}
    />
  )
}

const lineCount = (s: string) => {
  let n = 1
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** A new file: every line shown as added, without a phantom removed line above it. */
function NewFileView({ path, content, onEditor }: { path: string; content: string; onEditor?: EditorRef }) {
  const theme = useThemeTokens()
  const ed = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorations = useRef<editor.IEditorDecorationsCollection | null>(null)
  const paint = () => {
    const model = ed.current?.getModel()
    if (!model) return
    const lines = content.endsWith('\n') ? model.getLineCount() - 1 : model.getLineCount()
    const ranges = Array.from({ length: Math.max(lines, 0) }, (_, i) => ({
      range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 1 },
      options: { isWholeLine: true, className: 'nf-added', linesDecorationsClassName: 'nf-plus' }
    }))
    decorations.current?.clear()
    decorations.current = ed.current!.createDecorationsCollection(ranges)
  }
  useEffect(paint, [content])
  return (
    <Editor
      theme={monacoTheme(theme)}
      value={content}
      language={languageFor(path)}
      options={{ ...base, lineDecorationsWidth: 16 }}
      onMount={(e) => {
        ed.current = e
        paint()
        onEditor?.(e)
      }}
    />
  )
}

/**
 * "Comment on selection" for a code or diff view: returns the editor binder, a toolbar button and
 * the comment box (render it above the editor).
 */
export function useSelectionComment(path: string) {
  const ed = useRef<editor.ICodeEditor | null>(null)
  const [target, setTarget] = useState<CommentTarget | null>(null)

  const start = () => {
    const e = ed.current
    const model = e?.getModel()
    const sel = e?.getSelection()
    if (!e || !model || !sel) return
    const startLine = sel.startLineNumber
    const endLine = sel.endColumn === 1 && sel.endLineNumber > startLine ? sel.endLineNumber - 1 : sel.endLineNumber
    const lines = model.getLinesContent().slice(startLine - 1, endLine)
    const snippet = lines.join('\n').slice(0, 4000)
    setTarget({ kind: 'code', path, startLine, endLine, snippet })
  }

  const button = (
    <button className="chip-btn" title={tr('code.commentOnSelectionTip')} onClick={start}>
      <Icon name="comment" /> {tr('code.commentOnSelection')}
    </button>
  )
  const box = target ? <CommentBox target={target} onDone={() => setTarget(null)} /> : null
  return { bind: (e: editor.ICodeEditor) => (ed.current = e), button, box }
}
