import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useThemeTokens } from '../App'
import { THEMES, type ThemeTokens } from '../theme'
import { ACCENTS, accentFor, useAppearance } from '../appearance'
import { textOn } from '../colour'
import type { Sketch, SketchVersion } from '../session'
import type { ProjectStyle, StyleVars } from '../../../main/projectStyle'
import { Empty, Icon, IconButton } from '../components/ui'
import { PanZoom } from '../components/PanZoom'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

/**
 * Hand pans (a click still presses things in the page); Comment points at a part to say something
 * about it; Move drags a part somewhere else; Draw drags out a box for something new; Use hands the
 * page the mouse. Comments, moves, boxes and picks collect as numbered notes, sent together.
 */
type Mode = 'hand' | 'comment' | 'move' | 'draw' | 'use'

/**
 * The colours a sketch is drawn in: one of the app's schemes and accents when Claude picked them,
 * otherwise the user's own.
 */
function schemeFor(app: ThemeTokens, userAccent: string, scheme?: 'dark' | 'light', accent?: string): ThemeTokens {
  const base = scheme ?? app.base
  const tokens = base === app.base ? app : THEMES[`glassbox-${base}`]
  const preset = accent ? ACCENTS.find((a) => a.id === accent) : undefined
  if (!preset && base === app.base) return app
  const colour = preset ? preset[base] : accentFor({ accent: userAccent } as Parameters<typeof accentFor>[0], base)
  return { ...tokens, accent: colour, accentFg: preset ? tokens.accentFg : textOn(colour) }
}

/** The project's own colours (read from its stylesheets once per folder), for sketches drawn in them. */
const styles = new Map<string, Promise<ProjectStyle>>()
export function useProjectStyle(cwd: string): ProjectStyle | null {
  const [style, setStyle] = useState<ProjectStyle | null>(null)
  useEffect(() => {
    let p = styles.get(cwd)
    if (!p) styles.set(cwd, (p = window.glassbox.projectStyle(cwd).catch(() => ({}))))
    let live = true
    void p.then((v) => live && setStyle(v))
    return () => {
      live = false
    }
  }, [cwd])
  return style
}

/** How light a CSS colour is (0 dark to 1 light), for hex, hsl() and oklch(); null when it can't tell. */
function lightness(v?: string): number | null {
  if (!v) return null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(v)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1]
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const hsl = /hsla?\([^,\s]+[,\s]+[\d.]+%[,\s]+([\d.]+)%/i.exec(v)
  if (hsl) return Number(hsl[1]) / 100
  const ok = /oklch\(\s*([\d.]+)(%?)/i.exec(v)
  if (ok) return Number(ok[1]) / (ok[2] ? 100 : 1)
  return null
}

/**
 * The variables a sketch page is drawn with: the project's own colours by default (its dark set
 * when Glassbox is dark and it has one), filling any gaps from Glassbox's theme of the same
 * lightness; or Glassbox's look when Claude asked for it.
 */
export function sketchVars(app: ThemeTokens, userAccent: string, version: Pick<SketchVersion, 'scheme' | 'accent'>, project: ProjectStyle | null): Record<string, string> {
  const set: StyleVars | undefined = !version.scheme || version.scheme === 'project' ? (app.base === 'dark' ? (project?.dark ?? project?.light) : (project?.light ?? project?.dark)) : undefined
  const l = lightness(set?.bg)
  const base = set && Object.keys(set).length ? (l === null ? app.base : l < 0.5 ? 'dark' : 'light') : null
  const theme = base ? THEMES[`glassbox-${base}`] : schemeFor(app, userAccent, version.scheme === 'dark' || version.scheme === 'light' ? version.scheme : undefined, version.accent)
  const t: Record<string, string> = { base: theme.base, bg: theme.bg, surface: theme.surface, surface2: theme.surface2, elevated: theme.elevated, border: theme.border, fg: theme.fg, muted: theme.muted, subtle: theme.subtle, accent: theme.accent, accentFg: theme.accentFg, ok: theme.ok, warn: theme.warn, err: theme.err, info: theme.info }
  if (set) for (const [k, v] of Object.entries(set)) if (v) t[k] = v
  if (set?.accent && !set.accentFg && /^#/.test(set.accent)) t.accentFg = textOn(set.accent)
  return t
}

/** The address a sketch version is served at, in its colours; null while it's being prepared. */
export function useSketchUrl(version: SketchVersion): { url: string | null; base: string } {
  const { tab } = useSession()
  const app = useThemeTokens()
  const appearance = useAppearance()
  const project = useProjectStyle(tab.cwd)
  const wantsProject = !version.scheme || version.scheme === 'project'
  const vars = useMemo(() => (wantsProject && !project ? null : sketchVars(app, appearance.accent, version, project)), [app, appearance.accent, version.scheme, version.accent, project, wantsProject])
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!vars) return
    let live = true
    void window.glassbox.sketch.url(version.html).then((u) => live && setUrl(`${u}?t=${encodeURIComponent(JSON.stringify(vars))}`))
    return () => {
      live = false
    }
  }, [version.html, vars])
  return { url, base: vars?.base ?? app.base }
}

/** Claude's sketches: rough pages to look at, choose between and comment on, panned and zoomed like a diagram. */
export function SketchTab() {
  const { s } = useSession()
  const list = Object.values(s.sketches ?? {}).sort((a, b) => b.at - a.at)
  const [selected, setSelected] = useState<string | null>(null)
  const current = (selected && s.sketches?.[selected]) || list[0]
  if (!current)
    return (
      <div className="work-page sketch-view">
        <Empty icon="edit" title={tr('sketchTab.emptyTitle')}>
          {tr('sketchTab.emptyBody')}
        </Empty>
      </div>
    )
  return (
    <div className="work-page sketch-view">
      <SketchView key={current.id} sketch={current} others={list} onSelect={setSelected} />
    </div>
  )
}

type What = { kind: string; text: string; pick: string; section: string }
type Rect = { x: number; y: number; w: number; h: number }
/** A note on a sketch, waiting to go to Claude with the others (nothing is sent until Send all). */
type Note =
  | { id: string; version: number; text: string; kind: 'pick'; label: string; path: string }
  | { id: string; version: number; text: string; kind: 'comment'; what: What; path: string }
  | { id: string; version: number; text: string; kind: 'move'; what: What; path: string; dx: number; dy: number; near: What | null }
  | { id: string; version: number; text: string; kind: 'draw'; what: What; rect: Rect }
/** What you're writing a note for, before it's added. */
type Pending = Note extends infer N ? (N extends Note ? Omit<N, 'id' | 'version' | 'text'> : never) : never

// Notes outlive the view (switching tab or sketch), until they're sent or cleared.
const NOTES = new Map<string, Note[]>()
const NOTE_ICON: Record<Note['kind'], string> = { pick: 'pass', comment: 'comment', move: 'gripper', draw: 'primitive-square' }

function SketchView({ sketch, others, onSelect }: { sketch: Sketch; others: Sketch[]; onSelect: (id: string) => void }) {
  const { tab, s, send } = useSession()
  const count = sketch.versions.length
  const [index, setIndex] = useState(count - 1)
  // A new version from Claude comes to the front.
  useEffect(() => setIndex(count - 1), [count])
  const version = sketch.versions[Math.min(index, count - 1)]
  const { url, base } = useSketchUrl(version)
  const { openAttachment } = useSession()
  // As a PNG, drawn in code: saved under captures (and opened), or put on the clipboard.
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const exportPng = async (how: 'copy' | 'save') => {
    if (!url || exporting) return
    setExporting(true)
    try {
      const file = await window.glassbox.sketch.png(url, version.width, sketch.title, how)
      if (how === 'copy') setExported(tr('sketchTab.copiedPng'))
      else {
        setExported(tr('sketchTab.savedPng', { file: file.split(/[\\/]/).pop() ?? file }))
        openAttachment(file)
      }
      setTimeout(() => setExported(null), 3000)
    } catch (e) {
      setExported(String(e))
    } finally {
      setExporting(false)
    }
  }
  const [height, setHeight] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('hand')
  const [pointer, setPointer] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const noteBox = useRef<HTMLInputElement>(null)

  const notesKey = `${tab.id}:${sketch.id}`
  const [notes, setNotesState] = useState<Note[]>(() => NOTES.get(notesKey) ?? [])
  const setNotes = (next: Note[]) => {
    if (next.length) NOTES.set(notesKey, next)
    else NOTES.delete(notesKey)
    setNotesState(next)
  }
  const n = index + 1
  // Numbered in the order they were added, the same in the list and on the page.
  const numbered = notes.map((x, i) => ({ ...x, n: i + 1 }))

  // A different page measures itself afresh.
  useEffect(() => setHeight(null), [version.html])

  const toPage = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ glassboxSketch: true, ...m }, '*')
  /** The notes on this version, drawn on the page (and the parts they moved, moved). */
  const showNotes = () =>
    toPage({
      type: 'notes',
      notes: numbered.filter((x) => x.version === n).map((x) => ({ n: x.n, kind: x.kind, path: 'path' in x ? x.path : undefined, rect: x.kind === 'draw' ? x.rect : undefined, dx: x.kind === 'move' ? x.dx : undefined, dy: x.kind === 'move' ? x.dy : undefined }))
    })
  const showNotesRef = useRef(showNotes)
  showNotesRef.current = showNotes
  useEffect(() => showNotes(), [notes, n, url])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string } & Record<string, any>
      if (!m || m.glassboxSketch !== true) return
      if (m.type === 'size') setHeight(Math.max(120, m.h))
      else if (m.type === 'cursor') setPointer(m.pointer)
      else if (m.type === 'pick') setPending({ kind: 'pick', label: m.label, path: m.path ?? '' })
      else if (m.type === 'comment') setPending({ kind: 'comment', what: m.what, path: m.path ?? '' })
      else if (m.type === 'moved') setPending({ kind: 'move', what: m.what, path: m.path, dx: m.dx, dy: m.dy, near: m.near ?? null })
      else if (m.type === 'area') setPending({ kind: 'draw', what: m.what, rect: m.rect })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (pending) noteBox.current?.focus()
  }, [pending])

  const hoverAt = useRef<number | null>(null)
  const hover = (at: { x: number; y: number } | null) => {
    if (hoverAt.current) cancelAnimationFrame(hoverAt.current)
    hoverAt.current = requestAnimationFrame(() => toPage({ type: 'hover', x: at?.x ?? null, y: at?.y ?? null, mode }))
  }
  const cancel = () => {
    setPending(null)
    setNote('')
    toPage({ type: 'clear' })
    // A move you didn't keep goes back where it was.
    showNotes()
  }
  const switchMode = (m: Mode) => {
    if (pending) cancel()
    setMode(m)
    setPointer(false)
    toPage({ type: 'hover', x: null, y: null, mode: m })
  }
  // Move drags a part of the page; Draw drags out a box. Hand and Comment drag to pan.
  const drag = (phase: 'start' | 'move' | 'end', from: { x: number; y: number }, to: { x: number; y: number }) => {
    if (mode === 'move') {
      if (phase === 'start') {
        if (pending) cancel()
        toPage({ type: 'grab', x: from.x, y: from.y })
      } else toPage({ type: phase === 'move' ? 'drag' : 'drop', dx: to.x - from.x, dy: to.y - from.y })
    } else if (mode === 'draw') {
      if (phase === 'start' && pending) cancel()
      const rect = { x: Math.round(Math.min(from.x, to.x)), y: Math.round(Math.min(from.y, to.y)), w: Math.round(Math.abs(to.x - from.x)), h: Math.round(Math.abs(to.y - from.y)) }
      toPage({ type: 'drawing', rect })
      if (phase === 'end') {
        if (rect.w < 8 || rect.h < 8) return toPage({ type: 'clear' })
        toPage({ type: 'drawn', rect })
      }
    }
  }

  const subject = (w: What) => {
    const what = w.text ? (w.kind ? tr('sketchTab.subjectKind', { kind: w.kind, text: w.text }) : `“${w.text}”`) : tr('sketchTab.subjectPart')
    return w.pick ? tr('sketchTab.subjectInOption', { what, option: w.pick }) : w.section ? tr('sketchTab.subjectInSection', { what, section: w.section }) : what
  }
  const short = (w: What) => (w.text ? (w.kind ? tr('sketchTab.subjectKind', { kind: w.kind, text: w.text }) : `“${w.text}”`) : tr('sketchTab.subjectPart'))
  const how = (dx: number, dy: number) =>
    [dy ? tr(dy > 0 ? 'sketchTab.moveDown' : 'sketchTab.moveUp', { px: Math.abs(dy) }) : '', dx ? tr(dx > 0 ? 'sketchTab.moveRight' : 'sketchTab.moveLeft', { px: Math.abs(dx) }) : ''].filter(Boolean).join(tr('sketchTab.and'))
  /** One line saying what a note is about, for the list and for the message. */
  const about = (x: Pending): string =>
    x.kind === 'pick'
      ? tr('sketchTab.picked', { option: x.label })
      : x.kind === 'comment'
        ? tr('sketchTab.commentOn', { subject: subject(x.what) })
        : x.kind === 'move'
          ? tr('sketchTab.movedNote', { subject: subject(x.what), how: how(x.dx, x.dy) }) + (x.near ? tr('sketchTab.movedNear', { near: short(x.near) }) : '')
          : x.what.section
            ? tr('sketchTab.drewIn', { section: x.what.section, w: x.rect.w, h: x.rect.h })
            : tr('sketchTab.drew', { w: x.rect.w, h: x.rect.h, x: x.rect.x, y: x.rect.y })

  // A comment or a drawn box needs words; a pick or a move says enough on its own.
  const needsText = pending?.kind === 'comment' || pending?.kind === 'draw'
  const canAdd = !!pending && (!needsText || !!note.trim())
  const add = () => {
    if (!pending || !canAdd) return
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // Picking again in the same version replaces the earlier pick; moving a part again replaces its move.
    const keep = notes.filter((x) => !(x.version === n && ((pending.kind === 'pick' && x.kind === 'pick') || (pending.kind === 'move' && x.kind === 'move' && x.path === pending.path))))
    setNotes([...keep, { ...pending, id, version: n, text: note.trim() } as Note])
    setPending(null)
    setNote('')
    toPage({ type: 'clear' })
  }
  const remove = (id: string) => setNotes(notes.filter((x) => x.id !== id))
  const editText = (id: string, text: string) => setNotes(notes.map((x) => (x.id === id ? { ...x, text } : x)))

  const canSend = notes.length > 0 && s.status !== 'stopped'
  const sendAll = () => {
    if (!canSend) return
    const versions = new Set(notes.map((x) => x.version))
    const lines = numbered.map((x) => {
      const v = versions.size > 1 ? tr('sketchTab.inVersion', { n: x.version }) : ''
      return `${x.n}. ${about(x)}${v}${x.text ? `: ${x.text}` : '.'}`
    })
    const head = versions.size > 1 ? tr('sketchTab.notesHeadVersions', { title: sketch.title, count: notes.length }) : tr('sketchTab.notesHead', { where: tr('sketchTab.where', { title: sketch.title, n: notes[0].version }), count: notes.length })
    const changes = notes.some((x) => x.kind !== 'pick')
    void send([head, ...lines, ...(changes ? ['', tr('sketchTab.notesAsk')] : [])].join('\n'))
    setNotes([])
  }

  const hint = mode === 'hand' ? tr('sketchTab.hintHand') : mode === 'comment' ? tr('sketchTab.hintComment') : mode === 'move' ? tr('sketchTab.hintMove') : mode === 'draw' ? tr('sketchTab.hintDraw') : tr('sketchTab.hintUse')
  const onVersion = (i: number) => {
    if (pending) cancel()
    setIndex(i)
  }
  return (
    <>
      <div className="preview-bar sketch-bar">
        {others.length > 1 ? (
          <Select className="sketch-pick" value={sketch.id} onChange={onSelect} aria-label={tr('sketchTab.sketch')} options={others.map((x) => ({ value: x.id, label: x.title }))} />
        ) : (
          <strong className="ellipsis">{sketch.title}</strong>
        )}
        {count > 1 && (
          <span className="sketch-versions">
            <IconButton icon="chevron-left" title={tr('sketchTab.older')} disabled={index === 0} onClick={() => onVersion(index - 1)} />
            <span className="num">{tr('sketchTab.version', { n, total: count })}</span>
            <IconButton icon="chevron-right" title={tr('sketchTab.newer')} disabled={index >= count - 1} onClick={() => onVersion(index + 1)} />
          </span>
        )}
        <span className="muted small ellipsis grow">{exported ?? version.note}</span>
        <span className="muted small">{new Date(version.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div
        className="sketch-canvas"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return
          if (e.key === 'h') switchMode('hand')
          else if (e.key === 'c') switchMode('comment')
          else if (e.key === 'm') switchMode('move')
          else if (e.key === 'd') switchMode('draw')
          else if (e.key === 'u') switchMode('use')
          else if (e.key === 'Escape' && pending) cancel()
        }}
      >
        {url && (
          <PanZoom
            contentKey={`${sketch.id}:${index}:${base}:${height === null ? 0 : 1}`}
            size={{ w: version.width, h: height ?? 800 }}
            fitWidth
            className={`sketch-${mode}${pointer && mode !== 'use' ? ' over-target' : ''}`}
            hint={hint}
            onTap={mode === 'use' ? undefined : (x, y) => toPage({ type: 'tap', x, y, mode })}
            onHover={mode === 'use' ? undefined : hover}
            onDrag={mode === 'move' || mode === 'draw' ? drag : undefined}
            toolbar={
              <>
                <span className="panzoom-sep" />
                <IconButton icon="move" title={tr('sketchTab.modeHand')} active={mode === 'hand'} onClick={() => switchMode('hand')} />
                <IconButton icon="comment" title={tr('sketchTab.modeComment')} active={mode === 'comment'} onClick={() => switchMode('comment')} />
                <IconButton icon="gripper" title={tr('sketchTab.modeMove')} active={mode === 'move'} onClick={() => switchMode('move')} />
                <IconButton icon="primitive-square" title={tr('sketchTab.modeDraw')} active={mode === 'draw'} onClick={() => switchMode('draw')} />
                <IconButton icon="inspect" title={tr('sketchTab.modeUse')} active={mode === 'use'} onClick={() => switchMode('use')} />
                <span className="panzoom-sep" />
                <IconButton icon="copy" title={tr('sketchTab.copyHtml')} onClick={() => void navigator.clipboard.writeText(version.html)} />
                <IconButton icon={exporting ? 'loading' : 'file-media'} title={tr('sketchTab.copyPng')} onClick={() => void exportPng('copy')} />
                <IconButton icon="desktop-download" title={tr('sketchTab.savePng')} onClick={() => void exportPng('save')} />
              </>
            }
          >
            <iframe
              ref={frame}
              className="sketch-frame"
              title={sketch.title}
              src={url}
              sandbox="allow-scripts"
              width={version.width}
              height={height ?? 800}
              style={{ pointerEvents: mode === 'use' ? 'auto' : 'none' }}
              // A page that just (re)loaded gets the notes drawn on it again.
              onLoad={() => showNotesRef.current()}
            />
          </PanZoom>
        )}
      </div>
      {pending && (
        <div className="sketch-reply">
          <Icon name={NOTE_ICON[pending.kind]} />
          <span className="sketch-reply-what ellipsis" title={about(pending)}>
            {about(pending)}
          </span>
          <input
            ref={noteBox}
            className="grow"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
              else if (e.key === 'Escape') cancel()
            }}
            placeholder={pending.kind === 'comment' ? tr('sketchTab.commentNote') : pending.kind === 'draw' ? tr('sketchTab.drawNote') : tr('sketchTab.pickNote')}
            aria-label={pending.kind === 'comment' ? tr('sketchTab.commentNote') : pending.kind === 'draw' ? tr('sketchTab.drawNote') : tr('sketchTab.pickNote')}
          />
          <button className="primary" disabled={!canAdd} onClick={add} title={tr('sketchTab.addNoteTip')}>
            {tr('sketchTab.addNote')}
          </button>
          <IconButton icon="close" title={tr('sketchTab.cancel')} onClick={cancel} />
        </div>
      )}
      {notes.length > 0 && (
        <div className="sketch-notes" role="region" aria-label={tr('sketchTab.notesTitle', { count: notes.length })}>
          <div className="sketch-notes-head">
            <strong>{tr('sketchTab.notesTitle', { count: notes.length })}</strong>
            <span className="muted small ellipsis grow">{tr('sketchTab.notesHint')}</span>
            <button className="link small" onClick={() => setNotes([])}>
              {tr('sketchTab.clearNotes')}
            </button>
            <button className="primary" disabled={!canSend} onClick={sendAll}>
              <Icon name="send" /> {tr('sketchTab.sendAll', { count: notes.length })}
            </button>
          </div>
          <ol className="sketch-notes-list">
            {numbered.map((x) => (
              <li key={x.id} className={x.version === n ? undefined : 'other-version'} title={x.version === n ? undefined : tr('sketchTab.onVersion', { n: x.version })}>
                <span className="sketch-pin num">{x.n}</span>
                <Icon name={NOTE_ICON[x.kind]} className="muted" />
                <span className="sketch-note-about ellipsis" title={about(x)}>
                  {about(x)}
                </span>
                <input className="sketch-note-text" value={x.text} placeholder={tr('sketchTab.noteEmpty')} aria-label={tr('sketchTab.noteText', { n: x.n })} onChange={(e) => editText(x.id, e.target.value)} />
                <IconButton icon="close" title={tr('sketchTab.removeNote')} onClick={() => remove(x.id)} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  )
}
