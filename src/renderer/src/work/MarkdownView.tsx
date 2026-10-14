import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useThemeTokens } from '../App'
import { enhance, folderOf, renderDocument } from '../markdownDoc'
import { CommentBox } from '../components/CommentBox'
import { Icon } from '../components/ui'
import type { CommentTarget } from '../session'
import { tr } from '../../../shared/i18n'

type Head = { id: string; text: string; level: number }

/** A heading to land on when a link from another Markdown file opens this one ("guide.md#setup"). */
const pendingAnchor = new Map<string, string>()
const key = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** "a/b/../c.md" → "a/c.md". */
function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..' && out.length > 1) out.pop()
    else if (part !== '.' && (part || !out.length)) out.push(part)
  }
  return out.join('/')
}

/**
 * A Markdown file, read as a document: the outline of its headings beside it (the one you're in
 * marked), diagrams drawn, code coloured like the editor, GitHub's callouts and task lists. Links
 * to other files open them here, links out open in your browser. Select any passage to comment
 * on it to Claude: the comment points at the lines it came from. It follows the file as Claude
 * edits it, keeping your place.
 */
export function MarkdownView({ path, rel, content, line, onLine }: { path: string; rel: string; content: string; line?: number; onLine: (line: number) => void }) {
  const { openFile } = useSession()
  const theme = useThemeTokens()
  const dir = folderOf(path)
  const doc = useMemo(() => renderDocument(content, dir), [content, dir])
  const article = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [heads, setHeads] = useState<Head[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ x: number; y: number; target: CommentTarget } | null>(null)
  const [target, setTarget] = useState<CommentTarget | null>(null)
  const landed = useRef(false)
  const reading = useRef(0)

  // After each render of the HTML: anchors, callouts, code colours, diagrams; then the outline.
  useLayoutEffect(() => {
    if (!article.current) return
    setHeads(
      enhance(article.current, theme, {
        copy: tr('markdownView.copyCode'),
        copied: tr('markdownView.copied'),
        alert: (kind) => tr(`markdownView.alert.${kind}`)
      })
    )
  }, [doc.html, theme])

  // Where it opens: the lines Claude pointed at, a heading another file linked to, or the top.
  useEffect(() => {
    if (landed.current || !article.current) return
    landed.current = true
    const anchor = pendingAnchor.get(key(path))
    pendingAnchor.delete(key(path))
    if (anchor) return void document.getElementById(anchor)?.scrollIntoView({ block: 'start' })
    if (!line) return
    const block = blockAt(article.current, line)
    if (!block) return
    block.scrollIntoView({ block: 'center' })
    block.classList.add('md-hit')
    setTimeout(() => block.classList.remove('md-hit'), 2200)
  }, [doc.html, path, line])

  const outline = useMemo(() => {
    const h1s = heads.filter((h) => h.level === 1).length
    return heads.filter((h) => h.level <= 3 && (h.level > 1 || h1s > 1))
  }, [heads])
  const top = outline.length ? Math.min(...outline.map((h) => h.level)) : 1

  // The section you're reading, marked in the outline; and the line at the top, for Source.
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const onScroll = () => {
      const r = box.getBoundingClientRect()
      const at = r.top + Math.min(120, r.height / 3)
      let id: string | null = null
      for (const o of outline) {
        const h = document.getElementById(o.id)
        if (h && h.getBoundingClientRect().top <= at) id = o.id
        else break
      }
      setCurrent(id)
      setPicked(null)
      const first = [...(article.current?.querySelectorAll<HTMLElement>('[data-line]') ?? [])].find((b) => b.getBoundingClientRect().bottom > r.top + 8)
      reading.current = first && box.scrollTop > 0 ? Number(first.dataset.line) : 0
    }
    onScroll()
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [outline])

  // Source opens on the line you were reading.
  useEffect(() => () => void (reading.current && onLine(reading.current)), [])

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest('a')
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    e.preventDefault()
    if (!href) return
    if (href.startsWith('#')) return jump(decodeURIComponent(href.slice(1)))
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return void window.glassbox.openExternal(href)
    // Another file in the project: open it here (at the heading, if the link names one).
    const [file, hash] = decodeURI(href).split('#')
    const target = normalise(/^([a-z]:)?[\\/]/i.test(file) ? file : `${dir}/${file}`)
    if (hash) pendingAnchor.set(key(target), hash)
    openFile(target)
  }

  // A selection in the document: offer to comment on it, pointing at the lines it came from.
  const onMouseUp = () => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!sel || !text || !sel.rangeCount || !article.current?.contains(sel.anchorNode)) return setPicked(null)
    const from = blockOf(sel.anchorNode)
    const to = blockOf(sel.focusNode)
    if (!from || !to) return setPicked(null)
    const startLine = Math.min(Number(from.dataset.line), Number(to.dataset.line))
    const endLine = Math.max(Number(from.dataset.end), Number(to.dataset.end))
    const snippet = content.split(/\r?\n/).slice(startLine - 1, endLine).join('\n').slice(0, 4000)
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const box = scroller.current!.getBoundingClientRect()
    setPicked({
      x: Math.min(Math.max(rect.left + rect.width / 2 - box.left, 60), box.width - 60),
      y: rect.bottom - box.top + scroller.current!.scrollTop + 6,
      target: { kind: 'code', path: rel, startLine, endLine, snippet }
    })
  }

  const minutes = Math.max(1, Math.round(doc.words / 230))

  return (
    <div className="md-view">
      {target && <CommentBox target={target} onDone={() => setTarget(null)} />}
      <div className="md-scroll" ref={scroller}>
        <div className={outline.length >= 2 ? 'md-layout with-outline' : 'md-layout'}>
          {outline.length >= 2 && (
            <nav className="md-outline" aria-label={tr('markdownView.outline')}>
              <div className="md-outline-title">{tr('markdownView.onThisPage')}</div>
              {outline.map((o) => (
                <button key={o.id} className={o.id === current ? 'on' : ''} style={{ paddingLeft: 10 + (o.level - top) * 12 }} onClick={() => jump(o.id)} title={o.text}>
                  {o.text}
                </button>
              ))}
              <div className="md-outline-meta" title={tr('markdownView.wordsTitle', { count: doc.words })}>
                {tr('markdownView.readingTime', { count: minutes })}
              </div>
            </nav>
          )}
          {content.trim() ? (
            <article key={theme.base + theme.accent} className="md-doc markdown" ref={article} onClick={onClick} onMouseUp={onMouseUp} dangerouslySetInnerHTML={{ __html: doc.html }} />
          ) : (
            <div className="md-empty muted">{tr('markdownView.empty')}</div>
          )}
        </div>
        {picked && (
          <button
            className="md-comment-pop"
            style={{ left: picked.x, top: picked.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setTarget(picked.target)
              setPicked(null)
              window.getSelection()?.removeAllRanges()
            }}
          >
            <Icon name="comment" /> {tr('markdownView.comment')}
          </button>
        )}
      </div>
    </div>
  )
}

/** The top-level block (tagged with its source lines) a node sits in. */
function blockOf(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : node?.parentElement
  while (el && !el.dataset.line) el = el.parentElement
  return el ?? null
}

/** The block that holds a source line (or the nearest one after it). */
function blockAt(root: HTMLElement, line: number): HTMLElement | null {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-line]')]
  return blocks.find((b) => Number(b.dataset.line) <= line && Number(b.dataset.end) >= line) ?? blocks.find((b) => Number(b.dataset.line) >= line) ?? null
}
