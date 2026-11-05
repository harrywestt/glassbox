import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSession } from '../views/SessionView'
import { useThemeTokens } from '../App'
import { THEMES, type ThemeTokens } from '../theme'
import { ACCENTS, accentFor, useAppearance } from '../appearance'
import { textOn } from '../colour'
import type { Sketch, SketchVersion } from '../session'
import type { ProjectStyle, StyleVars } from '../../../main/projectStyle'
import { Icon, IconButton } from '../components/ui'
import { PanZoom } from '../components/PanZoom'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'
import { filesToPaths } from '../attachments'
import { useLibrary } from '../library'
import { DesignStart, ScreenEditor, START, screenKey } from './ScreensTab'
import { addScreenshot, removeScreenshot, takeShowNext, useScreenshotSketches } from '../screenshotSketches'
import { confirm } from '../components/ConfirmDialog'

/**
 * Hand pans (a click still presses things in the page); Comment pins a note to a point; Arrow drags
 * an arrow from one place to another (move this there); Draw is a pen for circling, crossing out or
 * sketching on the page; Text changes the words in place; Use hands the page the mouse. Pins,
 * arrows, drawings, changed words and picks collect as numbered notes, sent together with a picture
 * of the marks.
 */
type Mode = 'hand' | 'comment' | 'arrow' | 'draw' | 'text' | 'use'

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

/** The project's own colours (read from its stylesheets once per folder, until you refresh them), for sketches drawn in them. */
const styles = new Map<string, Promise<ProjectStyle>>()
let styleEpoch = 0
const styleListeners = new Set<() => void>()
/** Reads the project's stylesheet again (it changed): every sketch, component and screen redraws in the new colours. */
export function refreshProjectStyle(cwd: string) {
  for (const key of [...styles.keys()]) if (key.startsWith(`${cwd}|`)) styles.delete(key)
  styles.set(`${cwd}|`, window.glassbox.projectStyle(cwd, undefined, true).catch(() => ({})))
  styleEpoch++
  styleListeners.forEach((l) => l())
}
export function useProjectStyle(cwd: string, stylesheet?: string): ProjectStyle | null {
  const [style, setStyle] = useState<ProjectStyle | null>(null)
  const epoch = useSyncExternalStore(
    (l) => (styleListeners.add(l), () => styleListeners.delete(l)),
    () => styleEpoch
  )
  useEffect(() => {
    const key = `${cwd}|${stylesheet ?? ''}`
    let p = styles.get(key)
    if (!p) styles.set(key, (p = window.glassbox.projectStyle(cwd, stylesheet).catch(() => ({}))))
    let live = true
    void p.then((v) => live && setStyle(v))
    return () => {
      live = false
    }
  }, [cwd, stylesheet, epoch])
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
export function useSketchUrl(version: SketchVersion): { url: string | null; base: string; colours: Record<string, string> | null } {
  const { tab } = useSession()
  const app = useThemeTokens()
  const appearance = useAppearance()
  const project = useProjectStyle(tab.cwd, version.stylesheet)
  const wantsProject = !version.scheme || version.scheme === 'project'
  const vars = useMemo(() => (wantsProject && !project ? null : sketchVars(app, appearance.accent, version, project)), [app, appearance.accent, version.scheme, version.accent, project, wantsProject])
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!vars) return
    let live = true
    // Sent as edits or a file, the page is read from where it's kept; files it refers to are looked for in the session's folder.
    void (version.html ? Promise.resolve(version.html) : version.ref ? window.glassbox.sketch.read(version.ref) : Promise.resolve(null))
      .then((html) => (html == null ? null : window.glassbox.sketch.url(html, tab.cwd)))
      .then((u) => live && u && setUrl(`${u}?t=${encodeURIComponent(JSON.stringify(vars))}${version.bare ? '&b=1' : ''}`))
    return () => {
      live = false
    }
  }, [version.html, version.ref, version.bare, vars, tab.cwd])
  // `colours`: what the page draws with (the project's accent, not Glassbox's), for anything shown beside it.
  return { url, base: vars?.base ?? app.base, colours: vars }
}

/** Sketches you deleted, per session: hidden until Claude sends a new version of one. */
const DELETED_KEY = 'glassbox.deletedSketches'
function deletedAt(tabId: string, id: string): number {
  try {
    return (JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}') as Record<string, number>)[`${tabId}|${id}`] ?? 0
  } catch {
    return 0
  }
}
function markDeleted(tabId: string, id: string) {
  try {
    const all = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}') as Record<string, number>
    all[`${tabId}|${id}`] = Date.now()
    localStorage.setItem(DELETED_KEY, JSON.stringify(all))
  } catch {
    /* this run only */
  }
}

/**
 * Claude's sketches and your own screenshots: rough pages and real screens to look at, choose
 * between and mark up, panned and zoomed like a diagram. A screenshot comes in by pasting, dropping
 * or picking an image here, or from the Browser.
 */
export function SketchTab() {
  const { s, tab } = useSession()
  const shots = useScreenshotSketches(tab.id)
  const all: Record<string, Sketch> = { ...(s.sketches ?? {}) }
  for (const x of shots) all[x.id] = x
  const list = Object.values(all)
    .filter((k) => k.screenshot || k.at > deletedAt(tab.id, k.id))
    .sort((a, b) => b.at - a.at)
  const screens = useLibrary(tab.cwd, 'screens') ?? []
  // What's open: the start page, a screen of yours, or a sketch (the newest one until you pick).
  const [selected, setSelected] = useState<string | null>(null)
  // A screenshot just added comes to the front.
  useEffect(() => {
    const id = takeShowNext(tab.id)
    if (id) setSelected(id)
  }, [shots.length, tab.id])
  const screenId = selected?.startsWith('screen:') ? selected.slice('screen:'.length) : null
  const [last, setLast] = useState<string | null>(null)
  const start = selected === START || (!selected && !list.length)
  const current = start || screenId ? undefined : (selected && all[selected]) || list[0]
  /** Opens a sketch, screen or the overview; going to the overview remembers what was open, for Back. */
  const open = (key: string) => {
    if (key === START) {
      const was = screenId ? screenKey(screenId) : current?.id
      if (was) setLast(was)
    }
    setSelected(key)
  }
  const lastLabel = last ? (last.startsWith('screen:') ? screens.find((x) => screenKey(x.id) === last)?.name : all[last]?.title) : undefined
  // The picker over a sketch: the overview, then every sketch, screenshot and screen.
  const options = [
    { value: START, label: tr('sketchTab.startPage') },
    ...list.map((x) => ({ value: x.id, label: x.title, hint: x.screenshot ? tr('sketchTab.screenshot') : undefined })),
    ...[...screens].sort((a, b) => b.at - a.at).map((x) => ({ value: screenKey(x.id), label: x.name, hint: tr('screensTab.screen') }))
  ]
  const [dropping, setDropping] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const addFiles = async (paths: string[]) => {
    let added = 0
    for (const p of paths) if (await addScreenshot(tab.id, p)) added++
    setProblem(paths.length && !added ? tr('sketchTab.notAnImage') : null)
  }
  const pick = async () => addFiles(await window.glassbox.attachments.pick())
  const images = (files: FileList | null | undefined) => [...(files ?? [])].filter((f) => f.type.startsWith('image/'))
  return (
    <div
      className={`work-page sketch-view${dropping ? ' dropping' : ''}`}
      onPaste={(e) => {
        const files = images(e.clipboardData?.files)
        if (!files.length || e.target instanceof HTMLInputElement) return
        e.preventDefault()
        void filesToPaths(files).then(addFiles)
      }}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const files = [...e.dataTransfer.files]
        if (!files.length) return
        e.preventDefault()
        void filesToPaths(files).then(addFiles)
      }}
    >
      {screenId ? (
        <ScreenEditor key={screenId} id={screenId} onBack={() => open(START)} />
      ) : current ? (
        <SketchView key={current.id} sketch={current} options={options} onSelect={open} onAddScreenshot={() => void pick()} problem={problem} />
      ) : (
        <>
          {/* The overview keeps the picker, and a way straight back to what you were looking at. */}
          {(list.length > 0 || screens.length > 0) && (
            <div className="preview-bar sketch-bar">
              <Icon name="home" className="muted" />
              <Select className="sketch-pick" value={START} onChange={open} aria-label={tr('sketchTab.sketch')} options={options} />
              <span className="grow" />
              {lastLabel && (
                <button className="btn quiet" onClick={() => open(last!)}>
                  <Icon name="arrow-left" /> {tr('sketchTab.backTo', { name: lastLabel })}
                </button>
              )}
            </div>
          )}
          <DesignStart sketches={list} onOpen={open} onAddScreenshot={() => void pick()} problem={problem} />
        </>
      )}
      {dropping && <div className="sketch-drop">{tr('sketchTab.dropHere')}</div>}
    </div>
  )
}

type What = { kind: string; text: string; pick: string; section: string }
type Rect = { x: number; y: number; w: number; h: number }
type Pt = { x: number; y: number }
/** The pen colours: the accent, then red, green and amber. */
type Colour = 'accent' | 'err' | 'ok' | 'warn'
const COLOURS: Colour[] = ['accent', 'err', 'ok', 'warn']
/** Glassbox's own pen colours (its accent, not the page's), sent to the page so marks match the swatches. */
const pens = () => {
  const css = getComputedStyle(document.documentElement)
  return Object.fromEntries(COLOURS.map((c) => [c, css.getPropertyValue(`--${c}`).trim()]).filter(([, v]) => v))
}
/** A note on a sketch, waiting to go to Claude with the others (nothing is sent until Send all). Points are page pixels. */
type Note =
  | { id: string; version: number; text: string; kind: 'pick'; label: string; path: string }
  | { id: string; version: number; text: string; kind: 'comment'; at: Pt; what: What | null; color?: Colour }
  | { id: string; version: number; text: string; kind: 'arrow'; from: Pt; to: Pt; start: What | null; end: What | null; color?: Colour }
  | { id: string; version: number; text: string; kind: 'draw'; strokes: [number, number][][]; rect: Rect; what: What | null; color?: Colour }
  | { id: string; version: number; text: string; kind: 'text'; path: string; before: string; after: string; what: What | null }
/** What you're writing a note for, before it's added. */
/** A mark as drawn: a pin, an arrow or a drawing, in page pixels. */
type Ink = { kind: string; at?: Pt; from?: Pt; to?: Pt; strokes?: [number, number][][]; color?: Colour; n?: number }

/**
 * The marks again, over the space around the page (the page draws its own part; this shows what
 * goes past its edge), so you can draw, point and pin in the margin.
 */
function EdgeInk({ marks, live, w, h }: { marks: Ink[]; live: Ink | null; w: number; h: number }) {
  const ink = (x: Ink) => `var(--${x.color ?? 'accent'})`
  const line = (c: string) => ({ fill: 'none', stroke: c, strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })
  const pin = (p: Pt, n: number | undefined, c: string) => (
    <g>
      <circle cx={p.x} cy={p.y} r={11} style={{ fill: c, stroke: '#fff', strokeWidth: 2 }} />
      {n ? <text x={p.x} y={p.y + 4} textAnchor="middle" style={{ fill: '#fff', font: '600 11px system-ui, sans-serif' }}>{n}</text> : null}
    </g>
  )
  const one = (x: Ink, key: string | number, faint?: boolean) => {
    const c = ink(x)
    if (x.kind === 'comment' && x.at) return <g key={key} opacity={faint ? 0.85 : 1}>{pin(x.at, x.n, c)}</g>
    if (x.kind === 'arrow' && x.from && x.to)
      return (
        <g key={key} opacity={faint ? 0.85 : 1}>
          <line x1={x.from.x} y1={x.from.y} x2={x.to.x} y2={x.to.y} style={line(c)} markerEnd={`url(#edge-head-${x.color ?? 'accent'})`} />
          {x.n ? pin(x.from, x.n, c) : null}
        </g>
      )
    if (x.kind === 'draw' && x.strokes?.length && x.strokes[0].length)
      return (
        <g key={key} opacity={faint ? 0.85 : 1}>
          {x.strokes.map((s, i) => <path key={i} d={s.map((p, j) => `${j ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ')} style={line(c)} />)}
          {x.n ? pin({ x: x.strokes[0][0][0], y: x.strokes[0][0][1] }, x.n, c) : null}
        </g>
      )
    return null
  }
  return (
    <svg className="sketch-edge-ink" width={1} height={1} aria-hidden="true">
      <defs>
        <clipPath id="edge-outside">
          <path clipRule="evenodd" d={`M-100000 -100000H100000V100000H-100000Z M0 0V${h}H${w}V0Z`} />
        </clipPath>
        {COLOURS.map((c) => (
          <marker key={c} id={`edge-head-${c}`} viewBox="0 0 10 10" refX={7} refY={5} markerWidth={5} markerHeight={5} orient="auto">
            <path d="M0 0 L10 5 L0 10 z" style={{ fill: `var(--${c})` }} />
          </marker>
        ))}
      </defs>
      <g clipPath="url(#edge-outside)">
        {marks.map((x, i) => one(x, i))}
        {live && one(live, 'live', true)}
      </g>
    </svg>
  )
}

type Pending = Note extends infer N ? (N extends Note ? Omit<N, 'id' | 'version' | 'text'> : never) : never

// Notes outlive the view (switching tab or sketch), until they're sent or cleared.
const NOTES = new Map<string, Note[]>()
const NOTE_ICON: Record<Note['kind'], string> = { pick: 'pass', comment: 'comment', arrow: 'arrow-right', draw: 'edit', text: 'case-sensitive' }
// The pen colour you last chose, for every sketch.
let lastColour: Colour = 'accent'

/** Moves a mark: all of it, or (an arrow) just its head. */
function shifted(x: Note, dx: number, dy: number, part: 'all' | 'head'): Note {
  const p = (q: Pt) => ({ x: q.x + dx, y: q.y + dy })
  if (x.kind === 'comment') return { ...x, at: p(x.at) }
  if (x.kind === 'arrow') return part === 'head' ? { ...x, to: p(x.to) } : { ...x, from: p(x.from), to: p(x.to) }
  if (x.kind === 'draw') return { ...x, strokes: x.strokes.map((s) => s.map(([a, b]) => [a + dx, b + dy] as [number, number])), rect: { ...x.rect, x: x.rect.x + dx, y: x.rect.y + dy } }
  return x
}

function SketchView({ sketch, options, onSelect, onAddScreenshot, problem }: { sketch: Sketch; options: { value: string; label: string; hint?: string }[]; onSelect: (id: string) => void; onAddScreenshot: () => void; problem: string | null }) {
  const { tab, s, send, actions } = useSession()
  const shot = !!sketch.screenshot
  const count = sketch.versions.length
  const [index, setIndex] = useState(count - 1)
  // A new version from Claude comes to the front.
  useEffect(() => setIndex(count - 1), [count])
  const version = sketch.versions[Math.min(index, count - 1)]
  const { url, base } = useSketchUrl(version)
  // As a PNG, drawn in code: saved under captures (and opened), or put on the clipboard.
  const [exporting, setExporting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  // A short word in the bar about what just happened (copied, saved), for a few seconds.
  const flash = (text: string) => {
    setExported(text)
    setTimeout(() => setExported(null), 3000)
  }
  const exportPng = async (how: 'copy' | 'save') => {
    if (!url || exporting) return
    setExporting(true)
    try {
      const file = await window.glassbox.sketch.png(url, version.width, sketch.title, how)
      if (how === 'copy') setExported(tr('sketchTab.copiedPng'))
      else {
        setExported(tr('sketchTab.savedPng', { file: file.split(/[\\/]/).pop() ?? file }))
        window.glassbox.showInFolder(file)
      }
      setTimeout(() => setExported(null), 3000)
    } catch (e) {
      setExported(String(e))
    } finally {
      setExporting(false)
    }
  }
  const [height, setHeight] = useState<number | null>(null)
  // A page whose content spills past its width (a wide diagram) is shown that wide, not cut off.
  const [wide, setWide] = useState(0)
  const frameWidth = Math.max(version.width, wide)
  const [mode, setMode] = useState<Mode>('hand')
  const [colour, setColourState] = useState<Colour>(lastColour)
  const setColour = (c: Colour) => {
    setColourState((lastColour = c))
    if (!pending || pending.kind === 'pick' || pending.kind === 'text') return
    setPending({ ...pending, color: c })
    toPage({ type: 'live', item: { ...pending, color: c } })
  }
  const [pointer, setPointer] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState('')
  const [compare, setCompare] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const noteBox = useRef<HTMLInputElement>(null)

  const notesKey = `${tab.id}:${sketch.id}`
  const [notes, setNotesState] = useState<Note[]>(() => NOTES.get(notesKey) ?? [])
  const notesRef = useRef(notes)
  notesRef.current = notes
  const setNotes = (next: Note[]) => {
    if (next.length) NOTES.set(notesKey, next)
    else NOTES.delete(notesKey)
    notesRef.current = next
    setNotesState(next)
  }
  // Undo goes back through the notes as they were before each change; redo goes forward again
  // (until a new change, which starts a fresh path).
  const past = useRef<Note[][]>([])
  const future = useRef<Note[][]>([])
  const remember = (was: Note[]) => {
    past.current = [...past.current.slice(-49), was]
    future.current = []
  }
  const change = (next: Note[]) => {
    remember(notesRef.current)
    setNotes(next)
  }
  const undo = () => {
    if (pending) return cancel()
    const prev = past.current.pop()
    if (!prev) return
    future.current = [...future.current, notesRef.current]
    setNotes(prev)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current = [...past.current, notesRef.current]
    setNotes(next)
  }
  const n = index + 1
  // Numbered in the order they were added, the same in the list and on the page.
  const numbered = notes.map((x, i) => ({ ...x, n: i + 1 }))

  // A different page measures itself afresh.
  useEffect(() => {
    setHeight(null)
    setWide(0)
  }, [version.html, version.ref])

  // The mark being made, as the page was last told: the layer around the page draws its part past the edge.
  const [liveInk, setLiveInk] = useState<Ink | null>(null)
  const toPage = (m: Record<string, unknown>) => {
    if (m.type === 'live') setLiveInk(m.item as Ink)
    else if (m.type === 'clear') setLiveInk(null)
    else if (m.type === 'drawn') setLiveInk({ kind: 'draw', strokes: m.strokes as [number, number][][], color: m.color as Colour })
    else if (m.type === 'arrowed') setLiveInk({ kind: 'arrow', from: m.from as Pt, to: m.to as Pt, color: m.color as Colour })
    frame.current?.contentWindow?.postMessage({ glassboxSketch: true, pens: pens(), ...m }, '*')
  }
  /** This version's notes as marks to draw: pins, arrows, drawings, changed words and picked parts, numbered. */
  const marks = () => numbered.filter((x) => x.version === n).map(({ id: _id, text: _text, ...x }) => x)
  const showNotes = () => toPage({ type: 'notes', notes: marks() })
  const showNotesRef = useRef(showNotes)
  showNotesRef.current = showNotes
  useEffect(() => showNotes(), [notes, n, url])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string } & Record<string, any>
      if (!m || m.glassboxSketch !== true) return
      const c = lastColour
      if (m.type === 'size') {
        setHeight(Math.max(120, m.h))
        if (typeof m.w === 'number') setWide(Math.ceil(m.w))
      } else if (m.type === 'cursor') setPointer(m.pointer)
      else if (m.type === 'pick') setPending({ kind: 'pick', label: m.label, path: m.path ?? '' })
      else if (m.type === 'comment') setPending({ kind: 'comment', at: m.at, what: m.what ?? null, color: c })
      else if (m.type === 'arrow') setPending({ kind: 'arrow', from: m.from, to: m.to, start: m.start ?? null, end: m.end ?? null, color: c })
      else if (m.type === 'drawing') setPending({ kind: 'draw', strokes: m.strokes, rect: m.rect, what: m.what ?? null, color: c })
      else if (m.type === 'retext') setPending({ kind: 'text', path: m.path, before: m.before, after: m.after, what: m.what ?? null })
      else if (m.type === 'text-cancel') setPending(null)
      else if (m.type === 'described') {
        // A mark moved to a new spot: say what's there now.
        const w = (m.whats ?? []) as (What | null)[]
        setNotes(
          notesRef.current.map((x) =>
            x.id !== m.id ? x : x.kind === 'comment' ? { ...x, what: w[0] ?? null } : x.kind === 'arrow' ? { ...x, start: w[0] ?? null, end: w[1] ?? null } : x.kind === 'draw' ? { ...x, what: w[0] ?? null } : x
          )
        )
      }
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
  function cancel() {
    setPending(null)
    setNote('')
    toPage({ type: 'clear' })
  }
  const switchMode = (m: Mode) => {
    if (pending) cancel()
    setMode(m)
    setPointer(false)
    toPage({ type: 'hover', x: null, y: null, mode: m })
  }

  // A mark already on the page, under the pointer: its pin (or an arrow's head), to drag it somewhere else.
  const handleAt = (p: Pt): { id: string; part: 'all' | 'head' } | null => {
    const near = (q: Pt) => Math.hypot(q.x - p.x, q.y - p.y) <= 14
    for (const x of [...notes].reverse()) {
      if (x.version !== n) continue
      if (x.kind === 'comment' && near(x.at)) return { id: x.id, part: 'all' }
      if (x.kind === 'arrow' && near(x.to)) return { id: x.id, part: 'head' }
      if (x.kind === 'arrow' && near(x.from)) return { id: x.id, part: 'all' }
      if (x.kind === 'draw' && x.strokes[0]?.length && near({ x: x.strokes[0][0][0], y: x.strokes[0][0][1] })) return { id: x.id, part: 'all' }
    }
    return null
  }
  const moving = useRef<{ id: string; part: 'all' | 'head'; base: Note[] } | null>(null)
  // Arrow drags an arrow and Draw a pen line; in any marking mode, a drag from a pin moves that mark.
  // Otherwise Comment drags to pan.
  const stroke = useRef<[number, number][]>([])
  const drag = (phase: 'start' | 'move' | 'end', from: Pt, to: Pt): void | boolean => {
    const a = { x: Math.round(from.x), y: Math.round(from.y) }
    const b = { x: Math.round(to.x), y: Math.round(to.y) }
    // A drawing takes more strokes until you add it (an arrow's head, a word written in several strokes).
    const drawing = mode === 'draw' && pending?.kind === 'draw' ? pending.strokes : []
    if (phase === 'start') {
      if (pending && !drawing.length) cancel()
      const h = handleAt(a)
      moving.current = h ? { ...h, base: notesRef.current } : null
      if (!h && mode === 'comment') return false
    }
    if (moving.current) {
      const { id, part, base } = moving.current
      const next = base.map((x) => (x.id === id ? shifted(x, b.x - a.x, b.y - a.y, part) : x))
      if (phase !== 'end') return setNotes(next)
      moving.current = null
      if (b.x === a.x && b.y === a.y) return setNotes(base)
      remember(base)
      setNotes(next)
      const moved = next.find((x) => x.id === id)
      const points = !moved ? [] : moved.kind === 'comment' ? [moved.at] : moved.kind === 'arrow' ? [moved.from, moved.to] : moved.kind === 'draw' ? [{ x: moved.rect.x + moved.rect.w / 2, y: moved.rect.y + moved.rect.h / 2 }] : []
      if (!shot && points.length) toPage({ type: 'describe', id, points })
      return
    }
    if (mode === 'arrow') {
      if (phase !== 'end') return toPage({ type: 'live', item: { kind: 'arrow', from: a, to: b, color: colour } })
      // Too short to be an arrow: a slip.
      if (Math.hypot(b.x - a.x, b.y - a.y) < 12) return toPage({ type: 'clear' })
      toPage({ type: 'arrowed', from: a, to: b, color: colour })
    } else if (mode === 'draw') {
      if (phase === 'start') stroke.current = [[a.x, a.y]]
      const last = stroke.current[stroke.current.length - 1]
      if (!last || Math.hypot(b.x - last[0], b.y - last[1]) >= 3) stroke.current.push([b.x, b.y])
      if (phase !== 'end') return toPage({ type: 'live', item: { kind: 'draw', strokes: [...drawing, stroke.current], color: colour } })
      // A slip (a dot) adds nothing: the drawing so far stays.
      if (stroke.current.length < 3) return toPage(drawing.length ? { type: 'live', item: { kind: 'draw', strokes: drawing, color: colour } } : { type: 'clear' })
      toPage({ type: 'drawn', strokes: [...drawing, stroke.current], color: colour })
    }
  }

  const subject = (w: What) => {
    const what = w.text ? (w.kind ? tr('sketchTab.subjectKind', { kind: w.kind, text: w.text }) : `“${w.text}”`) : tr('sketchTab.subjectPart')
    return w.pick ? tr('sketchTab.subjectInOption', { what, option: w.pick }) : w.section ? tr('sketchTab.subjectInSection', { what, section: w.section }) : what
  }
  const thing = (w: What | null) => (w ? subject(w) : tr('sketchTab.subjectEmpty'))
  const colourWord = (x: Pending) => ('color' in x && x.color && x.color !== 'accent' ? tr('sketchTab.inColour', { colour: tr(`sketchTab.colourWords.${x.color}`) }) : '')
  /** One line saying what a note is about, for the list and for the message (points in page pixels; a screenshot's are its pixels). */
  const about = (x: Pending): string =>
    (x.kind === 'pick'
      ? tr('sketchTab.picked', { option: x.label })
      : x.kind === 'text'
        ? tr('sketchTab.textNote', { before: x.before, after: x.after })
        : x.kind === 'comment'
          ? shot
            ? tr('sketchTab.pinAt', { x: x.at.x, y: x.at.y })
            : tr('sketchTab.pinNote', { subject: thing(x.what), x: x.at.x, y: x.at.y })
          : x.kind === 'arrow'
            ? shot
              ? tr('sketchTab.arrowAt', { x1: x.from.x, y1: x.from.y, x2: x.to.x, y2: x.to.y })
              : tr('sketchTab.arrowNote', { from: thing(x.start), to: thing(x.end), x1: x.from.x, y1: x.from.y, x2: x.to.x, y2: x.to.y })
            : shot
              ? tr('sketchTab.drawingAt', { x: x.rect.x, y: x.rect.y, w: x.rect.w, h: x.rect.h })
              : tr('sketchTab.drawingNote', { subject: thing(x.what), x: x.rect.x, y: x.rect.y, w: x.rect.w, h: x.rect.h })) + colourWord(x)

  // A pin needs words; a pick, a change of words, an arrow (move this there) or a drawing can say enough on its own.
  const needsText = pending?.kind === 'comment'
  const canAdd = !!pending && (!needsText || !!note.trim())
  const add = () => {
    if (!pending || !canAdd) return
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // Picking again in the same version replaces the earlier pick, and changing the same words again replaces that change.
    const keep = notes.filter((x) => !(x.version === n && ((pending.kind === 'pick' && x.kind === 'pick') || (pending.kind === 'text' && x.kind === 'text' && x.path === pending.path))))
    change([...keep, { ...pending, id, version: n, text: note.trim() } as Note])
    setPending(null)
    setNote('')
    toPage({ type: 'clear' })
  }
  const remove = (id: string) => change(notes.filter((x) => x.id !== id))
  const editText = (id: string, text: string) => setNotes(notes.map((x) => (x.id === id ? { ...x, text } : x)))

  const [sending, setSending] = useState(false)
  const canSend = notes.length > 0 && s.status !== 'stopped' && !sending
  const sendAll = async () => {
    if (!canSend) return
    const versions = new Set(notes.map((x) => x.version))
    const lines = numbered.map((x) => {
      const v = versions.size > 1 ? tr('sketchTab.inVersion', { n: x.version }) : ''
      return `${x.n}. ${about(x)}${v}${x.text ? `: ${x.text}` : '.'}`
    })
    const head = shot
      ? tr('sketchTab.shotNotesHead', { title: sketch.title, count: notes.length })
      : versions.size > 1
        ? tr('sketchTab.notesHeadVersions', { title: sketch.title, count: notes.length })
        : tr('sketchTab.notesHead', { where: tr('sketchTab.where', { title: sketch.title, n: notes[0].version }), count: notes.length })
    const changes = notes.some((x) => x.kind !== 'pick')
    // Marks are easier seen than read: a picture with them on it goes along.
    let picture = ''
    const shown = marks()
    if (url && shown.some((x) => x.kind !== 'pick')) {
      setSending(true)
      try {
        const file = await window.glassbox.sketch.png(url, version.width, `${sketch.title} notes`, 'save', shown, pens())
        picture = shot ? tr('sketchTab.shotPicture', { file, image: sketch.image ?? '' }) : tr('sketchTab.marksPicture', { n, file })
      } catch {
        /* the words still go */
      } finally {
        setSending(false)
      }
    }
    void send([head, ...lines, ...(picture ? ['', picture] : []), ...(changes ? ['', tr(shot ? 'sketchTab.shotAsk' : 'sketchTab.notesAsk')] : [])].join('\n'))
    past.current = []
    future.current = []
    setNotes([])
  }

  const hint =
    mode === 'hand'
      ? tr(shot ? 'sketchTab.hintHandShot' : 'sketchTab.hintHand')
      : mode === 'comment'
        ? tr('sketchTab.hintComment')
        : mode === 'arrow'
          ? tr('sketchTab.hintArrow')
          : mode === 'draw'
            ? tr('sketchTab.hintDraw')
            : mode === 'text'
              ? tr('sketchTab.hintText')
              : tr('sketchTab.hintUse')
  const onVersion = (i: number) => {
    if (pending) cancel()
    setIndex(i)
  }
  const marking = mode === 'comment' || mode === 'arrow' || mode === 'draw'
  return (
    <>
      <div className="preview-bar sketch-bar">
        <IconButton icon="home" title={tr('sketchTab.startPage')} onClick={() => onSelect(START)} />
        <Select className="sketch-pick" value={sketch.id} onChange={onSelect} aria-label={tr('sketchTab.sketch')} options={options} />
        {count > 1 && (
          <span className="sketch-versions">
            <IconButton icon="chevron-left" title={tr('sketchTab.older')} disabled={index === 0} onClick={() => onVersion(index - 1)} />
            <span className="num">{tr('sketchTab.version', { n, total: count })}</span>
            <IconButton icon="chevron-right" title={tr('sketchTab.newer')} disabled={index >= count - 1} onClick={() => onVersion(index + 1)} />
          </span>
        )}
        {count > 1 && <IconButton icon="diff" title={tr('sketchTab.compare')} active={compare} onClick={() => setCompare((c) => !c)} />}
        <span className="muted small ellipsis grow">{problem ?? exported ?? version.note}</span>
        <span className="muted small">{new Date(version.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <IconButton icon="device-camera" title={tr('sketchTab.addScreenshotTip')} onClick={onAddScreenshot} />
      </div>
      {compare && count > 1 ? (
        <CompareView versions={sketch.versions} index={index} />
      ) : (
        <div
          className="sketch-canvas"
          onKeyDown={(e) => {
            if (e.target instanceof HTMLInputElement) return
            if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
              e.preventDefault()
              return redo()
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
              e.preventDefault()
              return undo()
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === 'h') switchMode('hand')
            else if (e.key === 'c') switchMode('comment')
            else if (e.key === 'a') switchMode('arrow')
            else if (e.key === 'd') switchMode('draw')
            else if (e.key === 't' && !shot) switchMode('text')
            else if (e.key === 'u' && !shot) switchMode('use')
            else if (e.key === 'Escape' && pending) cancel()
          }}
        >
          {url && (
            <PanZoom
              contentKey={`${sketch.id}:${index}:${base}:${height === null ? 0 : 1}`}
              size={{ w: frameWidth, h: height ?? 800 }}
              fitWidth
              className={`sketch-${mode}${pointer && mode !== 'use' ? ' over-target' : ''}`}
              hint={hint}
              onTap={
                mode === 'use'
                  ? undefined
                  : (x, y) => {
                      // Typing goes to the page, so it needs the keyboard.
                      if (mode === 'text') frame.current?.focus()
                      toPage({ type: 'tap', x, y, mode, color: colour })
                    }
              }
              onHover={mode === 'use' ? undefined : hover}
              onDrag={marking ? drag : undefined}
              toolbar={
                <>
                  <span className="panzoom-sep" />
                  {/* Looking: pan and press, or use the page itself. Then marking it up. */}
                  <IconButton icon="move" title={tr('sketchTab.modeHand')} active={mode === 'hand'} onClick={() => switchMode('hand')} />
                  {!shot && <IconButton icon="inspect" title={tr('sketchTab.modeUse')} active={mode === 'use'} onClick={() => switchMode('use')} />}
                  <span className="panzoom-sep" />
                  <IconButton icon="comment" title={tr('sketchTab.modeComment')} active={mode === 'comment'} onClick={() => switchMode('comment')} />
                  <IconButton icon="arrow-right" title={tr('sketchTab.modeArrow')} active={mode === 'arrow'} onClick={() => switchMode('arrow')} />
                  <IconButton icon="edit" title={tr('sketchTab.modeDraw')} active={mode === 'draw'} onClick={() => switchMode('draw')} />
                  {!shot && <IconButton icon="case-sensitive" title={tr('sketchTab.modeText')} active={mode === 'text'} onClick={() => switchMode('text')} />}
                  {marking && (
                    <span className="sketch-swatches" role="radiogroup" aria-label={tr('sketchTab.colour')}>
                      {COLOURS.map((c) => (
                        <button
                          key={c}
                          role="radio"
                          aria-checked={colour === c}
                          className={`sketch-swatch${colour === c ? ' on' : ''}`}
                          style={{ background: `var(--${c})` }}
                          title={tr(`sketchTab.colours.${c}`)}
                          aria-label={tr(`sketchTab.colours.${c}`)}
                          onClick={() => setColour(c)}
                        />
                      ))}
                    </span>
                  )}
                  <IconButton icon="discard" title={tr('sketchTab.undo')} disabled={!pending && past.current.length === 0} onClick={undo} />
                  <IconButton icon="redo" title={tr('sketchTab.redo')} disabled={future.current.length === 0} onClick={redo} />
                  <span className="panzoom-sep" />
                  <span className="sketch-share">
                    <IconButton icon={exporting ? 'loading' : 'share'} title={tr('sketchTab.share')} active={sharing} onClick={() => setSharing((v) => !v)} />
                    {sharing && (
                      <>
                        <div className="menu-scrim" onMouseDown={() => setSharing(false)} />
                        {/* Each says what you get: a picture, or a web page that clicks through as it does here. */}
                        <div className="menu sketch-share-menu" role="menu">
                          <button role="menuitem" className="menu-item" onClick={() => (setSharing(false), void exportPng('copy'))}>
                            <Icon name="file-media" />
                            <span className="grow">{tr('sketchTab.shareCopyImage')}</span>
                          </button>
                          <button role="menuitem" className="menu-item" onClick={() => (setSharing(false), void exportPng('save'))}>
                            <Icon name="desktop-download" />
                            <span className="grow">{tr('sketchTab.shareSaveImage')}</span>
                          </button>
                          {!shot && (
                            <>
                              <div className="menu-sep" role="separator" />
                              <button
                                role="menuitem"
                                className="menu-item"
                                onClick={() => {
                                  setSharing(false)
                                  void (url ? window.glassbox.sketch.document(url, sketch.title) : Promise.resolve(''))
                                    .then((h) => (h ? navigator.clipboard.writeText(h) : undefined))
                                    .then(() => flash(tr('sketchTab.copiedHtml')), (e: unknown) => flash(String(e)))
                                }}
                              >
                                <Icon name="copy" />
                                <span className="grow">{tr('sketchTab.shareCopyPage')}</span>
                              </button>
                              <button
                                role="menuitem"
                                className="menu-item"
                                onClick={() => {
                                  setSharing(false)
                                  void (url ? window.glassbox.sketch.saveDocument(url, sketch.title) : Promise.reject(new Error('not ready')))
                                    .then((file) => (flash(tr('sketchTab.savedHtml', { file: file.split(/[\\/]/).pop() ?? file })), window.glassbox.showInFolder(file)))
                                    .catch((e: unknown) => flash(String(e)))
                                }}
                              >
                                <Icon name="file-code" />
                                <span className="grow">{tr('sketchTab.shareSavePage')}</span>
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </span>
                  {/* Kept apart from Share, so Delete isn't pressed by mistake. */}
                  <span className="panzoom-sep" />
                  <IconButton
                    icon="trash"
                    title={tr(shot ? 'sketchTab.deleteShot' : 'sketchTab.delete')}
                    onClick={async () => {
                      if (!(await confirm({ title: tr(shot ? 'sketchTab.deleteShotConfirm' : 'sketchTab.deleteConfirm', { title: sketch.title }), confirm: tr(shot ? 'sketchTab.deleteShot' : 'sketchTab.delete'), danger: true }))) return
                      NOTES.delete(notesKey)
                      if (shot) return removeScreenshot(tab.id, sketch.id)
                      markDeleted(tab.id, sketch.id)
                      actions.deleteSketch(tab.id, sketch.id)
                    }}
                  />
                </>
              }
            >
              <iframe
                ref={frame}
                className="sketch-frame"
                title={sketch.title}
                src={url}
                sandbox="allow-scripts"
                width={frameWidth}
                height={height ?? 800}
                style={{ pointerEvents: mode === 'use' ? 'auto' : 'none' }}
                // A page that just (re)loaded gets the notes drawn on it again.
                onLoad={() => showNotesRef.current()}
              />
              <EdgeInk
                marks={marks() as Ink[]}
                live={liveInk ?? (pending && (pending.kind === 'comment' || pending.kind === 'arrow' || pending.kind === 'draw') ? (pending as Ink) : null)}
                w={frameWidth}
                h={height ?? 800}
              />
            </PanZoom>
          )}
        </div>
      )}
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
            placeholder={tr(`sketchTab.placeholder.${pending.kind}`)}
            aria-label={tr(`sketchTab.placeholder.${pending.kind}`)}
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
            <button className="link small" onClick={() => change([])}>
              {tr('sketchTab.clearNotes')}
            </button>
            <button className="primary" disabled={!canSend} onClick={() => void sendAll()}>
              <Icon name={sending ? 'loading' : 'send'} className={sending ? 'codicon-modifier-spin' : undefined} /> {tr('sketchTab.sendAll', { count: notes.length })}
            </button>
          </div>
          <ol className="sketch-notes-list">
            {numbered.map((x) => (
              <li key={x.id} className={x.version === n ? undefined : 'other-version'} title={x.version === n ? undefined : tr('sketchTab.onVersion', { n: x.version })}>
                <span className="sketch-pin num" style={'color' in x && x.color ? { background: `var(--${x.color})` } : undefined}>
                  {x.n}
                </span>
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

/** One version drawn to fit the width it's given (never past its own size); tells its height. */
export function FitFrame({ version, onHeight }: { version: SketchVersion; onHeight?: (h: number) => void }) {
  const { url } = useSketchUrl(version)
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [room, setRoom] = useState(0)
  const [size, setSize] = useState({ w: version.width, h: 800 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoom(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string; h?: number; w?: number }
      if (m?.glassboxSketch === true && m.type === 'size' && m.h) setSize({ w: Math.max(version.width, m.w ?? 0), h: Math.max(120, m.h) })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [version.width])
  const k = room ? Math.min(1, room / size.w) : 1
  useEffect(() => onHeight?.(size.h * k), [size.h, k])
  return (
    <div ref={box} className="sketch-fit" style={{ height: size.h * k }}>
      {url && <iframe ref={frame} className="sketch-frame" src={url} sandbox="allow-scripts" width={size.w} height={size.h} style={{ transform: `scale(${k})` }} title={tr('sketchTab.compareFrame')} />}
    </div>
  )
}

/** Two versions of a sketch side by side, or one over the other with a slider between them. */
function CompareView({ versions, index }: { versions: SketchVersion[]; index: number }) {
  const [right, setRight] = useState(index)
  const [left, setLeft] = useState(index > 0 ? index - 1 : Math.min(versions.length - 1, 1))
  const [how, setHow] = useState<'side' | 'slide'>('side')
  const [split, setSplit] = useState(50)
  const [heights, setHeights] = useState<[number, number]>([0, 0])
  const options = versions.map((_, i) => ({ value: String(i), label: tr('sketchTab.version', { n: i + 1, total: versions.length }) }))
  const a = versions[left]
  const b = versions[right]
  return (
    <div className="sketch-compare">
      <div className="sketch-compare-bar">
        <Select value={String(left)} onChange={(v) => setLeft(Number(v))} options={options} aria-label={tr('sketchTab.compareLeft')} />
        <Icon name="arrow-right" className="muted" />
        <Select value={String(right)} onChange={(v) => setRight(Number(v))} options={options} aria-label={tr('sketchTab.compareRight')} />
        <span className="grow" />
        {how === 'slide' && (
          <input
            type="range"
            className="sketch-compare-range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label={tr('sketchTab.compareSplit', { left: left + 1, right: right + 1 })}
          />
        )}
        <div className="segmented" role="radiogroup" aria-label={tr('sketchTab.compareHow')}>
          <button role="radio" aria-checked={how === 'side'} className={how === 'side' ? 'active' : undefined} onClick={() => setHow('side')}>
            {tr('sketchTab.compareSide')}
          </button>
          <button role="radio" aria-checked={how === 'slide'} className={how === 'slide' ? 'active' : undefined} onClick={() => setHow('slide')}>
            {tr('sketchTab.compareSlide')}
          </button>
        </div>
      </div>
      <div className="sketch-compare-body">
        {how === 'side' ? (
          <div className="sketch-compare-side">
            <figure>
              <figcaption className="muted small">{tr('sketchTab.version', { n: left + 1, total: versions.length })}</figcaption>
              <FitFrame key={`l${left}`} version={a} />
            </figure>
            <figure>
              <figcaption className="muted small">{tr('sketchTab.version', { n: right + 1, total: versions.length })}</figcaption>
              <FitFrame key={`r${right}`} version={b} />
            </figure>
          </div>
        ) : (
          <div className="sketch-compare-slide" style={{ height: Math.max(...heights, 120), maxWidth: Math.max(a.width, b.width), ['--split' as string]: `${split}%` }}>
            <div className="sketch-compare-layer">
              <FitFrame key={`l${left}`} version={a} onHeight={(h) => setHeights((x) => [h, x[1]])} />
            </div>
            <div className="sketch-compare-layer top">
              <FitFrame key={`r${right}`} version={b} onHeight={(h) => setHeights((x) => [x[0], h])} />
            </div>
            <div className="sketch-compare-handle" aria-hidden />
          </div>
        )}
      </div>
    </div>
  )
}
