import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import type { LibraryComponent, LibraryScreen, ScreenItem } from '../../../shared/library'
import type { Sketch } from '../session'
import { useLibrary, useStaleComponents } from '../library'
import { Empty, Icon, IconButton } from '../components/ui'
import { PanZoom } from '../components/PanZoom'
import { Select } from '../components/Select'
import { refreshProjectStyle, useSketchUrl } from './SketchTab'
import { tr } from '../../../shared/i18n'
import { filesToPaths } from '../attachments'
import { isImagePath } from '../screenshotSketches'
import { DesignAsk } from '../components/DesignAsk'
import { confirm } from '../components/ConfirmDialog'

/**
 * Screens: build a screen from the project's own components, as a starting point for Claude. The
 * library down the side holds copies of the app's real components (Claude makes them when asked,
 * from the source); a screen starts from a blank frame or the app's shell, and you drag components
 * onto it, move, resize, retype and restyle them. Everything is kept by Glassbox, outside the repo.
 */

const FRAMES = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'tablet', width: 820, height: 1180 },
  { id: 'phone', width: 390, height: 844 }
] as const

const ASK_COMPONENTS =
  "Fill this project's component library in Glassbox (Screens view): find the app's main reusable UI components in the source (buttons, inputs, selects, checkboxes, cards, tables, badges, alerts, tabs, navigation, modals) and save each with save_component as a faithful HTML and CSS copy, in the project's colours, with its main variants, its source file and how code uses it. Also save the icons the app uses most, kind 'icon' (an inline SVG in currentColor). Check each picture against the real component. Skip any already in list_components."
const ASK_SHELL =
  "Save this app's shell to the component library in Glassbox (Screens view): read the app's layout (header, sidebar or navigation, page padding, background) and save it with save_component, kind 'shell', at its usual desktop size (width and height), with the page content area left empty and marked data-slot."
const askUpdate = (names: string[]) =>
  `These components in the Glassbox component library have changed in the source since they were copied: ${names.join(', ')}. Read each one's source again and save the updated copy with save_component (same name).`

const esc = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!)

/** The built-in icons (codicons, which ship with Glassbox): each one's viewBox and drawing, by name. */
type Icons = Map<string, { box: string; body: string }>
let iconSet: Promise<Icons> | null = null
function useIcons(): Icons | null {
  const [icons, setIcons] = useState<Icons | null>(null)
  useEffect(() => {
    iconSet ??= import('@vscode/codicons/dist/codicon.svg?raw').then((m) => {
      const map: Icons = new Map()
      for (const x of m.default.matchAll(/<symbol[^>]*?viewBox="([^"]+)"[^>]*?id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) map.set(x[2], { box: x[1], body: x[3] })
      return map
    })
    let live = true
    void iconSet.then((m) => live && setIcons(m))
    return () => {
      live = false
    }
  }, [])
  return icons
}

/** The colours you can give a placed component or icon: the project's own, by name. */
const COLOUR_TOKENS = ['accent', 'fg', 'muted', 'ok', 'warn', 'err', 'info'] as const
/** A placed thing's colour as CSS: its text, and its accent (what a component's buttons and links use). */
function colourCss(c?: string): string {
  if (!c) return ''
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return ` color: ${c}; --accent: ${c};`
  if (!(COLOUR_TOKENS as readonly string[]).includes(c)) return ''
  return c === 'accent' ? ' color: var(--accent);' : ` color: var(--${c}); --accent: var(--${c});`
}

/** New words for an element, as the page sets them: in its own text, keeping an icon beside them. */
function setWords(el: Element, text: string) {
  const own = [...el.childNodes].filter((c) => c.nodeType === 3 && c.textContent?.trim())
  if (!own.length || [...el.children].some((c) => c.textContent?.trim())) return void (el.textContent = text)
  own[0].textContent = text
  for (const n of own.slice(1)) n.textContent = ''
}

/** One placed component's HTML: its variant, with any words you changed (by the path to the element inside it). */
function itemHtml(it: ScreenItem, c: LibraryComponent): string {
  const base = (it.variant && c.variants?.find((v) => v.name === it.variant)?.html) || c.html
  if (!it.text || !Object.keys(it.text).length) return base
  const t = document.createElement('template')
  t.innerHTML = base
  for (const [path, text] of Object.entries(it.text)) {
    let e: Element | undefined
    let kids: HTMLCollection = t.content.children
    for (const i of path.split('/')) {
      e = kids[Number(i)]
      if (!e) break
      kids = e.children
    }
    if (e) setWords(e, text)
  }
  return t.innerHTML
}

/** A screen as a page: its frame (blank, or the shell with the components in its content area) and the components and icons placed on it. */
export function screenHtml(screen: LibraryScreen, comps: Record<string, LibraryComponent>, icons: Icons | null): string {
  const items = screen.items
    .filter((it) => !it.hidden)
    .map((it) => {
      const look = `${colourCss(it.color)}${it.opacity !== undefined ? ` opacity: ${it.opacity};` : ''}${it.radius ? ` border-radius: ${it.radius}px; overflow: hidden;` : ''}`
      const at = `left: ${it.x}px; top: ${it.y}px;${look}`
      const box = (w?: number, h?: number) => `${w ? ` width: ${w}px;` : ''}${h ? ` height: ${h}px;` : ''}`
      const open = (cls: string, style: string) => `<div class="gb-item${cls}" data-gb-item="${esc(it.id)}" style="${at}${style}">`
      if (it.icon) {
        const ic = icons?.get(it.icon)
        const size = it.w ?? 24
        return `${open('', box(size))}${ic ? `<svg viewBox="${esc(ic.box)}" width="${size}" height="${size}" fill="currentColor" style="display: block">${ic.body}</svg>` : ''}</div>`
      }
      // A shape: filled with its colour (a line drawn in it), or the surface colour.
      if (it.shape) {
        const fill = it.color ? 'currentColor' : it.shape === 'line' ? 'var(--muted, #888)' : 'color-mix(in srgb, var(--fg, #1d2025) 9%, var(--bg, #fff))'
        const shape = it.shape === 'ellipse' ? 'border-radius: 50%;' : it.shape === 'line' ? '' : `border-radius: ${it.radius ?? 0}px;`
        return `${open(' gb-shape', box(it.w ?? 160, it.h ?? 100))}<div style="width: 100%; height: 100%; background: ${fill}; ${shape}${it.shape !== 'line' && !it.color ? ' box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg, #1d2025) 18%, transparent);' : ''}"></div></div>`
      }
      if (it.textBox !== undefined) {
        const t = `font-size: ${it.fontSize ?? 16}px; font-weight: ${it.bold ? 700 : 400}; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere;${it.color ? '' : ' color: var(--fg, #1d2025);'}`
        return `${open('', box(it.w ?? 240, it.h))}<div style="${t}">${esc(it.textBox)}</div></div>`
      }
      if (it.image) {
        const src = encodeURI(`file:///${it.image.replace(/\\/g, '/').replace(/^\/+/, '')}`)
        return `${open('', box(it.w ?? 240, it.h ?? 160))}<img src="${src}" alt="" style="display: block; width: 100%; height: 100%; object-fit: cover;"></div>`
      }
      const c = comps[it.component]
      if (!c) return `${open(' gb-missing', '')}${esc(tr('screensTab.missing'))}</div>`
      const w = it.w ?? (c.kind !== 'shell' ? c.width : undefined)
      return `${open(it.h ? ' gb-fill' : '', box(w, it.h))}${itemHtml(it, c)}</div>`
    })
    .join('')
  const base = `<style>html { scrollbar-width: none; } html, body { margin: 0; padding: 0; background: var(--bg, #fff); color: var(--fg, #1d2025); font: 14px/1.5 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; } .gb-item { position: absolute; } .gb-item.gb-fill > :not(style) { height: 100%; box-sizing: border-box; } .gb-missing { padding: 8px 12px; border: 1px dashed var(--err, #dc2626); color: var(--err, #dc2626); }</style>`
  const f = screen.frame
  if (f.kind === 'shell') {
    const shell = comps[f.shell]
    if (shell) {
      const t = document.createElement('template')
      t.innerHTML = shell.html
      const slot = t.content.querySelector<HTMLElement>('[data-slot]')
      if (slot) {
        slot.setAttribute('data-gb-area', '')
        slot.style.position = 'relative'
        if (!slot.style.minHeight) slot.style.minHeight = '240px'
        slot.innerHTML = items
        return `${base}<div style="width: ${f.width}px; min-height: ${f.height}px">${t.innerHTML}</div>`
      }
    }
  }
  return `${base}<div data-gb-area style="position: relative; width: ${f.width}px; min-height: ${f.height}px">${items}</div>`
}

/** What the Sketches view opens: the start page, one of Claude's sketches or your screenshots (by id), or one of your screens. */
export const screenKey = (id: string) => `screen:${id}`
export const START = 'start'

/**
 * The start page of Sketches: ask Claude to design something, start a screen or add a screenshot,
 * and everything made so far (Claude's sketches, your screenshots and screens), with the component library.
 */
export function DesignStart({ sketches, onOpen, onAddScreenshot, problem }: { sketches: Sketch[]; onOpen: (key: string) => void; onAddScreenshot: () => void; problem: string | null }) {
  const { tab } = useSession()
  const comps = useLibrary(tab.cwd, 'components')
  const screens = useLibrary(tab.cwd, 'screens')
  return (
    <div className="work-page screens">
      <ScreensHome screens={screens ?? []} comps={comps ?? []} sketches={sketches} onOpen={onOpen} onAddScreenshot={onAddScreenshot} problem={problem} />
    </div>
  )
}

/** One of your screens, open in the builder (the library, layers and settings only show here). */
export function ScreenEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { tab } = useSession()
  const comps = useLibrary(tab.cwd, 'components')
  const screens = useLibrary(tab.cwd, 'screens')
  if (!comps || !screens) return null
  const screen = screens.find((x) => x.id === id)
  if (!screen)
    return (
      <div className="work-page">
        <Empty icon="window" title={tr('screensTab.goneTitle')} center>
          <button className="btn" onClick={onBack}>
            {tr('screensTab.allScreens')}
          </button>
        </Empty>
      </div>
    )
  return (
    <div className="work-page screens building">
      <Builder key={screen.id} screen={screen} comps={comps} onBack={onBack} />
    </div>
  )
}

/** Asking Claude to copy the app's components and shell, or to update the ones whose source changed (each a message in the conversation). */
function LibraryActions({ comps, stale }: { comps: LibraryComponent[]; stale: Set<string> }) {
  const { s, send } = useSession()
  const canAsk = s.status !== 'stopped'
  const changed = comps.filter((c) => stale.has(c.id))
  const hasParts = comps.some((c) => c.kind === 'component')
  const hasShell = comps.some((c) => c.kind === 'shell')
  return (
    <>
      <div className="screens-library-ask">
        <button className="btn quiet" disabled={!canAsk} onClick={() => void send(ASK_COMPONENTS)} title={tr('screensTab.usesTokens')}>
          <Icon name="sparkle" /> {tr(hasParts ? 'screensTab.askMore' : 'screensTab.askComponents')}
        </button>
        {!hasShell && (
          <button className="btn quiet" disabled={!canAsk} onClick={() => void send(ASK_SHELL)} title={tr('screensTab.usesTokens')}>
            <Icon name="layout" /> {tr('screensTab.askShell')}
          </button>
        )}
      </div>
      {changed.length > 0 && (
        <div className="screens-library-stale">
          <span className="small">{tr('screensTab.staleCount', { count: changed.length })}</span>
          <button className="link small" disabled={!canAsk} onClick={() => void send(askUpdate(changed.map((c) => c.name)))} title={tr('screensTab.usesTokens')}>
            {tr('screensTab.askUpdate')}
          </button>
        </div>
      )}
    </>
  )
}

/** A library component drawn small: the whole of it, scaled to fit its tile and centred. */
function Thumb({ comp }: { comp: LibraryComponent }) {
  const pad = comp.kind === 'shell' ? 0 : 12
  const natural = comp.kind === 'shell' ? (comp.width ?? 1440) : (comp.width ?? (comp.kind === 'icon' ? 24 : 320)) + pad * 2
  const version = useMemo(
    () => ({ html: `<style>html { overflow: hidden; } html, body { margin: 0; padding: ${pad}px; background: var(--bg, #fff); color: var(--fg, #1d2025); font: 14px/1.5 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; }</style>${comp.html}`, width: natural, at: 0, bare: true }),
    [comp.html, natural, pad]
  )
  const { url } = useSketchUrl(version)
  const box = useRef<HTMLSpanElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [room, setRoom] = useState({ w: 0, h: 0 })
  const [height, setHeight] = useState(comp.kind === 'shell' ? (comp.height ?? 900) : 80)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string; h?: number }
      if (m?.glassboxSketch === true && m.type === 'size' && m.h) setHeight(m.h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  const k = room.w ? Math.min(1, (room.w - 8) / natural, (room.h - 8) / height) : 0
  return (
    <span ref={box} className="screens-thumb">
      {url && (
        <iframe
          ref={frame}
          src={url}
          sandbox="allow-scripts"
          tabIndex={-1}
          aria-hidden
          width={natural}
          height={height}
          style={{ transform: `translate(${(room.w - natural * k) / 2}px, ${(room.h - height * k) / 2}px) scale(${k})`, opacity: k ? 1 : 0 }}
        />
      )}
    </span>
  )
}

/** The component library: the app's components (and shells), to drag onto a screen. */
function Library({ comps, onAdd, onAddIcon }: { comps: LibraryComponent[]; onAdd?: (id: string) => void; onAddIcon?: (name: string) => void }) {
  const { tab } = useSession()
  const stale = useStaleComponents(tab.cwd, comps)
  const shells = comps.filter((c) => c.kind === 'shell')
  const parts = comps.filter((c) => c.kind === 'component')
  const appIcons = comps.filter((c) => c.kind === 'icon')
  const icons = useIcons()
  const [find, setFind] = useState('')
  const found = useMemo(() => {
    const q = find.trim().toLowerCase()
    return [...(icons?.keys() ?? [])].filter((n) => !q || n.includes(q)).slice(0, 120)
  }, [icons, find])
  const tile = (c: LibraryComponent) => (
    <li
      key={c.id}
      className={`screens-tile ${c.kind}${stale.has(c.id) ? ' stale' : ''}`}
      draggable={c.kind !== 'shell'}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-glassbox-component', c.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={[c.name, c.source, c.usage].filter(Boolean).join('\n')}
    >
      <button className="screens-tile-face" disabled={!onAdd || c.kind === 'shell'} onClick={() => onAdd?.(c.id)} aria-label={tr('screensTab.addToScreen', { name: c.name })}>
        <Thumb comp={c} />
      </button>
      <span className="screens-tile-name ellipsis">{c.name}</span>
      {stale.has(c.id) && <span className="screens-tile-stale" title={tr('screensTab.staleTip')}>{tr('screensTab.stale')}</span>}
      <IconButton
        icon="trash"
        title={tr('screensTab.deleteComponent', { name: c.name })}
        onClick={() => void confirm({ title: tr('screensTab.deleteComponentConfirm', { name: c.name }), confirm: tr('screensTab.remove'), danger: true }).then((ok) => void (ok && window.glassbox.library.delete(tab.cwd, 'components', c.id)))}
      />
    </li>
  )
  return (
    <div className="screens-library" aria-label={tr('screensTab.library')}>
      <div className="screens-library-head">
        <span className="muted small">{tr('screensTab.libraryCountShort', { count: comps.length })}</span>
        <span className="grow" />
        <IconButton icon="sync" title={tr('screensTab.refreshStyles')} onClick={() => refreshProjectStyle(tab.cwd)} />
      </div>
      <LibraryActions comps={comps} stale={stale} />
      <div className="screens-library-list">
        {!comps.length && <p className="muted small screens-library-empty">{tr('screensTab.libraryEmpty')}</p>}
        {shells.length > 0 && (
          <>
            <h3 className="screens-library-group">{tr('screensTab.shells')}</h3>
            <ul>{shells.map(tile)}</ul>
          </>
        )}
        {parts.length > 0 && (
          <>
            <h3 className="screens-library-group">{tr('screensTab.components')}</h3>
            <ul>{parts.map(tile)}</ul>
          </>
        )}
        {appIcons.length > 0 && (
          <>
            <h3 className="screens-library-group">{tr('screensTab.appIcons')}</h3>
            <ul>{appIcons.map(tile)}</ul>
          </>
        )}
        <h3 className="screens-library-group">{tr('screensTab.icons')}</h3>
        <div className="screens-icons">
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={tr('screensTab.iconSearch')} aria-label={tr('screensTab.iconSearch')} />
          <div className="screens-icon-grid">
            {found.map((n) => (
              <button
                key={n}
                className="screens-icon"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-glassbox-icon', n)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onAddIcon?.(n)}
                title={n}
                aria-label={tr('screensTab.addIcon', { name: n })}
              >
                <Icon name={n} />
              </button>
            ))}
          </div>
          {icons && !found.length && <p className="muted small">{tr('screensTab.iconNone')}</p>}
        </div>
      </div>
    </div>
  )
}

/** The project's screens, and starting a new one from a blank frame or the app's shell. */
function ScreensHome({ screens, comps, sketches, onOpen, onAddScreenshot, problem }: { screens: LibraryScreen[]; comps: LibraryComponent[]; sketches: Sketch[]; onOpen: (key: string) => void; onAddScreenshot: () => void; problem: string | null }) {
  const { tab } = useSession()
  const shells = comps.filter((c) => c.kind === 'shell')
  const create = async (frame: LibraryScreen['frame']) => {
    const saved = await window.glassbox.library.save(tab.cwd, 'screens', { name: tr('screensTab.newName', { n: screens.length + 1 }), frame, items: [] })
    onOpen(screenKey(saved.id))
  }
  // Everything made so far, newest first: your screens, Claude's sketches and your screenshots.
  const made = [
    ...screens.map((x) => ({ key: screenKey(x.id), at: x.at, icon: 'window', name: x.name, meta: `${frameLabel(x.frame)} · ${tr('screensTab.itemCount', { count: x.items.length })}`, screen: x })),
    ...sketches.map((x) => ({ key: x.id, at: x.at, icon: x.screenshot ? 'device-camera' : 'edit', name: x.title, meta: x.screenshot ? tr('sketchTab.screenshot') : tr('screensTab.sketchMeta', { count: x.versions.length }), screen: undefined }))
  ].sort((a, b) => b.at - a.at)
  function frameLabel(f: LibraryScreen['frame']) {
    return f.kind === 'shell' ? tr('screensTab.inShell', { name: comps.find((c) => c.id === f.shell)?.name ?? tr('screensTab.shell') }) : tr('screensTab.size', { w: f.width, h: f.height })
  }
  const parts = comps.filter((c) => c.kind === 'component').length
  const stale = useStaleComponents(tab.cwd, comps)
  return (
    <div className="screens-home">
      <section className="screens-home-ask">
        <h2>{tr('screensTab.askDesign')}</h2>
        <DesignAsk placeholder={tr('screensTab.askDesignPlaceholder')} />
      </section>
      <h2>{tr('screensTab.newScreen')}</h2>
      <div className="screens-frames">
        {FRAMES.map((f) => (
          <button key={f.id} className="screens-frame-pick" onClick={() => void create({ kind: 'blank', width: f.width, height: f.height })}>
            <span className={`screens-frame-shape ${f.id}`} aria-hidden />
            <strong>{tr(`screensTab.frames.${f.id}`)}</strong>
            <span className="muted small">{tr('screensTab.size', { w: f.width, h: f.height })}</span>
          </button>
        ))}
        {shells.map((sh) => (
          <button key={sh.id} className="screens-frame-pick" onClick={() => void create({ kind: 'shell', shell: sh.id, width: sh.width ?? 1440, height: sh.height ?? 900 })}>
            <span className="screens-frame-shape shell" aria-hidden />
            <strong>{sh.name}</strong>
            <span className="muted small">{tr('screensTab.appShell')}</span>
          </button>
        ))}
        <button className="screens-frame-pick" onClick={onAddScreenshot} title={tr('sketchTab.addScreenshotHint')}>
          <span className="screens-frame-shape shot" aria-hidden>
            <Icon name="device-camera" />
          </span>
          <strong>{tr('sketchTab.addScreenshot')}</strong>
          <span className="muted small">{tr('screensTab.shotNote')}</span>
        </button>
      </div>
      {problem ? <p className="small screens-problem">{problem}</p> : !shells.length && <p className="muted small">{tr('screensTab.noShell')}</p>}
      {made.length > 0 ? (
        <>
          <h2>{tr('screensTab.yourDesigns')}</h2>
          <ul className="screens-list">
            {made.map((x) => (
              <li key={x.key}>
                <button className="screens-list-open" onClick={() => onOpen(x.key)}>
                  <Icon name={x.icon} />
                  <strong className="ellipsis">{x.name}</strong>
                  <span className="muted small">{x.meta}</span>
                  <span className="muted small">{new Date(x.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                </button>
                {x.screen && <IconButton icon="trash" title={tr('screensTab.deleteScreen')} onClick={() => void confirm({ title: tr('screensTab.deleteScreenConfirm', { name: x.name }), confirm: tr('screensTab.deleteScreenButton'), danger: true }).then((ok) => void (ok && window.glassbox.library.delete(tab.cwd, 'screens', x.screen!.id)))} />}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Empty icon="edit" title={tr('sketchTab.emptyTitle')}>
          {tr('sketchTab.emptyBody')}
        </Empty>
      )}
      <section className="screens-home-library">
        <div className="screens-home-library-head">
          <Icon name="library" />
          <strong>{tr('screensTab.library')}</strong>
          <span className="muted small">{parts ? tr('screensTab.libraryCount', { count: parts, shells: shells.length }) : tr('screensTab.libraryNone')}</span>
          <span className="grow" />
          <IconButton icon="sync" title={tr('screensTab.refreshStyles')} onClick={() => refreshProjectStyle(tab.cwd)} />
        </div>
        <LibraryActions comps={comps} stale={stale} />
      </section>
    </div>
  )
}

type Rect = { x: number; y: number; w: number; h: number }
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The tools along the top of the canvas: select, pan, and drawing a shape or a text box. */
type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'line' | 'text'
const TOOLS: { id: Tool; icon: string; key: string }[] = [
  { id: 'select', icon: 'inspect', key: 'V' },
  { id: 'hand', icon: 'move', key: 'H' },
  { id: 'rect', icon: 'primitive-square', key: 'R' },
  { id: 'ellipse', icon: 'circle-large', key: 'O' },
  { id: 'line', icon: 'dash', key: 'L' },
  { id: 'text', icon: 'text-size', key: 'T' }
]
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
type Align = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom'

/** Copied things, kept between screens (Ctrl+C here, Ctrl+V on another screen). */
let clipboard: ScreenItem[] = []

/** The align and distribute icons (codicons has none). */
function AlignIcon({ how }: { how: Align | 'spread-x' | 'spread-y' }) {
  const bars: Record<string, string> = {
    left: 'M2 1v14M4 4h8v3H4zM4 9h5v3H4z',
    centre: 'M8 1v14M3 4h10v3H3zM5 9h6v3H5z',
    right: 'M14 1v14M4 4h8v3H4zM7 9h5v3H7z',
    top: 'M1 2h14M4 4h3v8H4zM9 4h3v5H9z',
    middle: 'M1 8h14M4 3h3v10H4zM9 5h3v6H9z',
    bottom: 'M1 14h14M4 4h3v8H4zM9 7h3v5H9z',
    'spread-x': 'M1 2v12M15 2v12M5 5h2v6H5zM9 5h2v6H9z',
    'spread-y': 'M2 1h12M2 15h12M5 5h6v2H5zM5 9h6v2H5z'
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <path d={bars[how]} />
    </svg>
  )
}

/** What a layer is called: your name for it, or what it is. */
function layerName(it: ScreenItem, comps: Record<string, LibraryComponent>): string {
  if (it.name) return it.name
  if (it.icon) return tr('screensTab.layerIcon', { name: it.icon })
  if (it.shape) return tr(`screensTab.shapes.${it.shape}`)
  if (it.textBox !== undefined) return it.textBox.trim().slice(0, 40) || tr('screensTab.textBox')
  if (it.image) return it.image.split(/[\\/]/).pop() ?? tr('screensTab.image')
  return comps[it.component]?.name ?? tr('screensTab.missing')
}
const layerIcon = (it: ScreenItem) => (it.icon ? 'symbol-misc' : it.shape === 'ellipse' ? 'circle-large' : it.shape === 'line' ? 'dash' : it.shape ? 'primitive-square' : it.textBox !== undefined ? 'text-size' : it.image ? 'file-media' : 'symbol-class')

/** Building one screen, like a design tool: the library and layers, the canvas, and the selection's settings. */
function Builder({ screen, comps, onBack }: { screen: LibraryScreen; comps: LibraryComponent[]; onBack: () => void }) {
  const { tab, openFile } = useSession()
  const [model, setModel] = useState(screen)
  const modelRef = useRef(model)
  modelRef.current = model
  const [selection, setSelection] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [left, setLeft] = useState<'library' | 'layers'>('library')
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [focus, setFocus] = useState<Rect & { key: number }>()
  const [space, setSpace] = useState(false)
  const [moving, setMoving] = useState(false)
  // The pointer is over words you can change (double-click): a text caret, as in a design tool.
  const [overText, setOverText] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const past = useRef<LibraryScreen[]>([])
  const future = useRef<LibraryScreen[]>([])
  const compMap = useMemo(() => Object.fromEntries(comps.map((c) => [c.id, c])), [comps])

  const change = (next: LibraryScreen, record = true) => {
    if (record) {
      past.current = [...past.current.slice(-99), modelRef.current]
      future.current = []
    }
    modelRef.current = next
    setModel(next)
  }
  const setItems = (items: ScreenItem[], record = true) => change({ ...modelRef.current, items }, record)
  const updateItems = (ids: string[], patch: Partial<ScreenItem> | ((it: ScreenItem) => Partial<ScreenItem>), record = true) =>
    setItems(modelRef.current.items.map((x) => (ids.includes(x.id) ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)), record)
  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current = [...future.current, modelRef.current]
    change(prev, false)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current = [...past.current, modelRef.current]
    change(next, false)
  }
  // Kept as you go (a moment after each change), and straight away if you leave before that moment.
  const unsaved = useRef(false)
  useEffect(() => {
    if (model === screen) return
    unsaved.current = true
    const t = setTimeout(() => {
      unsaved.current = false
      void window.glassbox.library.save(tab.cwd, 'screens', model)
    }, 400)
    return () => clearTimeout(t)
  }, [model])
  useEffect(() => () => void (unsaved.current && window.glassbox.library.save(tab.cwd, 'screens', modelRef.current)), [])

  // The page is drawn again only when what's on it changes (not when things move or resize: those are sent to it).
  const icons = useIcons()
  const structure = JSON.stringify([
    model.frame,
    model.items.map((i) => [i.id, i.component, i.icon, i.color, i.variant, i.text, i.shape, i.textBox, i.fontSize, i.bold, i.image, i.radius, i.opacity, i.hidden, i.icon ? i.w : 0]),
    comps.map((c) => [c.id, c.at]),
    !!icons
  ])
  const html = useMemo(() => screenHtml(modelRef.current, compMap, icons), [structure])
  const { url, base, colours: pageColours } = useSketchUrl({ html, width: model.frame.width, at: 0, bare: true })
  const frame = useRef<HTMLIFrameElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [rects, setRects] = useState<{ area: Rect; items: Record<string, Rect> } | null>(null)
  const toPage = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ glassboxSketch: true, ...m }, '*')
  const ownWidth = (i: ScreenItem) => (i.icon || i.shape || i.textBox !== undefined || i.image ? undefined : compMap[i.component]?.kind === 'component' || compMap[i.component]?.kind === 'icon' ? compMap[i.component]?.width : undefined)
  const place = () => toPage({ type: 'place', items: modelRef.current.items.map((i) => ({ id: i.id, x: i.x, y: i.y, w: i.w ?? ownWidth(i), h: i.icon ? undefined : i.h })) })
  useEffect(place, [model.items])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string } & Record<string, any>
      if (!m || m.glassboxSketch !== true) return
      if (m.type === 'size') setSize({ w: Math.max(modelRef.current.frame.width, m.w ?? 0), h: Math.max(200, m.h) })
      else if (m.type === 'cursor') setOverText(!!m.pointer)
      else if (m.type === 'items') setRects({ area: m.area, items: Object.fromEntries((m.items as (Rect & { id: string })[]).map((r) => [r.id, r])) })
      else if (m.type === 'retext' && m.item) {
        const it = modelRef.current.items.find((x) => x.id === m.item)
        if (!it) return
        if (it.textBox !== undefined) updateItems([it.id], { textBox: typeof m.raw === 'string' ? m.raw : m.after })
        else updateItems([it.id], { text: { ...(it.text ?? {}), [m.rel]: m.after } })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Space held: drag to pan, as in a design tool.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable
    const down = (e: KeyboardEvent) => e.key === ' ' && !typing(e) && wrap.current?.contains(document.activeElement) && (e.preventDefault(), setSpace(true))
    const up = (e: KeyboardEvent) => e.key === ' ' && setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const W = size?.w ?? model.frame.width
  const H = size?.h ?? model.frame.height
  const k = view.k || 1
  const area = rects?.area ?? { x: 0, y: 0, w: model.frame.width, h: model.frame.height }
  const sizeOf = (it: ScreenItem) => {
    const r = rects?.items[it.id]
    if (it.icon) return { w: it.w ?? 24, h: it.w ?? 24 }
    return { w: it.w ?? r?.w ?? ownWidth(it) ?? 120, h: it.h ?? r?.h ?? 40 }
  }
  const boxOf = (it: ScreenItem): Rect => ({ x: it.x, y: it.y, ...sizeOf(it) })
  const boundsOf = (list: ScreenItem[]): Rect | null => {
    if (!list.length) return null
    const bs = list.map(boxOf)
    const x = Math.min(...bs.map((b) => b.x))
    const y = Math.min(...bs.map((b) => b.y))
    return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }
  }
  /** Content-area point under the pointer. */
  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k - area.x, y: (e.clientY - r.top) / k - area.y }
  }

  const items = model.items
  const selected = items.filter((x) => selection.includes(x.id))
  const sel = selected.length === 1 ? selected[0] : undefined
  const selComp = sel ? compMap[sel.component] : undefined
  /** An item, with the rest of its group. */
  const withGroup = (id: string) => {
    const it = items.find((x) => x.id === id)
    return it?.group ? items.filter((x) => x.group === it.group).map((x) => x.id) : [id]
  }
  const select = (id: string, add: boolean) => {
    const ids = withGroup(id)
    if (!add) return setSelection(ids)
    setSelection((s) => (ids.every((x) => s.includes(x)) ? s.filter((x) => !ids.includes(x)) : [...new Set([...s, ...ids])]))
  }

  const add = (item: Omit<ScreenItem, 'id'>) => {
    const it = { ...item, id: uid(), x: Math.max(0, Math.round(item.x)), y: Math.max(0, Math.round(item.y)) }
    setItems([...modelRef.current.items, it])
    setSelection([it.id])
    return it
  }
  const nextSpot = () => 24 + ((items.length * 16) % 160)
  const addImage = async (path: string, at?: { x: number; y: number }) => {
    const s = await window.glassbox.sketch.imageSize(path)
    if (!s) return
    const w = Math.min(480, s.width)
    add({ component: '', image: path, x: at?.x ?? nextSpot(), y: at?.y ?? nextSpot(), w, h: Math.round((s.height * w) / s.width) })
  }
  const pickImage = async () => {
    for (const p of await window.glassbox.attachments.pick()) if (isImagePath(p)) await addImage(p)
    setTool('select')
  }

  // Moving (everything selected) or resizing (one thing), snapped to the content area and to other things' edges and centres.
  const drag = (e: React.PointerEvent, id: string, handle?: Handle) => {
    if (e.button !== 0 || tool !== 'select' || space) return
    e.stopPropagation()
    e.preventDefault()
    setMenu(null)
    wrap.current?.focus()
    const it0 = items.find((x) => x.id === id)
    if (!it0) return
    let ids = selection
    if (!selection.includes(id)) {
      ids = e.shiftKey ? [...new Set([...selection, ...withGroup(id)])] : withGroup(id)
      setSelection(ids)
    } else if (e.shiftKey && !handle) return select(id, true)
    if (it0.locked) return
    const base = modelRef.current
    const moved0 = base.items.filter((x) => ids.includes(x.id) && !x.locked)
    const b0 = handle ? boxOf(it0) : boundsOf(moved0)
    if (!b0) return
    const others = base.items.filter((x) => !ids.includes(x.id) && !x.hidden).map(boxOf)
    const xs = [0, area.w / 2, area.w, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])]
    const ys = [0, area.h / 2, area.h, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])]
    const tol = 6 / k
    const snap = (v: number, offs: number[], lines: number[]) => {
      let best: { d: number; to: number; line: number } | null = null
      for (const off of offs) for (const l of lines) if (Math.abs(v + off - l) < tol && (!best || Math.abs(v + off - l) < best.d)) best = { d: Math.abs(v + off - l), to: l - off, line: l }
      return best
    }
    const start = { x: e.clientX, y: e.clientY }
    let did = false
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / k
      const dy = (ev.clientY - start.y) / k
      if (!did && Math.hypot(dx, dy) < 2) return
      if (!did) setMoving(true)
      did = true
      const free = ev.altKey
      if (!handle) {
        let x = b0.x + dx
        let y = b0.y + dy
        const sx = free ? null : snap(x, [0, b0.w / 2, b0.w], xs)
        const sy = free ? null : snap(y, [0, b0.h / 2, b0.h], ys)
        if (sx) x = sx.to
        if (sy) y = sy.to
        setGuides(sx || sy ? { x: sx?.line, y: sy?.line } : null)
        const mx = Math.round(x - b0.x)
        const my = Math.round(y - b0.y)
        setItems(base.items.map((x) => (moved0.some((m) => m.id === x.id) ? { ...x, x: Math.max(0, x.x + mx), y: Math.max(0, x.y + my) } : x)), false)
        return
      }
      // Resizing: the edges the handle holds move; the others stay.
      let { x, y, w, h } = b0
      let gx: number | undefined
      let gy: number | undefined
      if (handle.includes('e')) {
        let r = b0.x + b0.w + dx
        const s = free ? null : snap(r, [0], xs)
        if (s) (r = s.to), (gx = s.line)
        w = r - x
      }
      if (handle.includes('w')) {
        let l = b0.x + dx
        const s = free ? null : snap(l, [0], xs)
        if (s) (l = s.to), (gx = s.line)
        w = b0.x + b0.w - l
        x = l
      }
      if (handle.includes('s')) {
        let bt = b0.y + b0.h + dy
        const s = free ? null : snap(bt, [0], ys)
        if (s) (bt = s.to), (gy = s.line)
        h = bt - y
      }
      if (handle.includes('n')) {
        let t = b0.y + dy
        const s = free ? null : snap(t, [0], ys)
        if (s) (t = s.to), (gy = s.line)
        h = b0.y + b0.h - t
        y = t
      }
      // Shift keeps the shape; an icon always stays square.
      if (it0.icon || (ev.shiftKey && b0.w && b0.h)) {
        const r = b0.w / b0.h
        if (handle === 'n' || handle === 's') w = h * r
        else h = w / r
      }
      w = Math.max(8, Math.round(w))
      h = Math.max(it0.shape === 'line' ? 2 : 8, Math.round(h))
      setGuides(gx !== undefined || gy !== undefined ? { x: gx, y: gy } : null)
      const vertical = handle.includes('n') || handle.includes('s') || it0.shape === 'line' || it0.shape === 'rect' || it0.shape === 'ellipse' || it0.image || it0.textBox !== undefined
      updateItems([id], { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w, ...(it0.icon ? {} : vertical ? { h } : {}) }, false)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      setGuides(null)
      setMoving(false)
      if (did) {
        past.current = [...past.current.slice(-99), base]
        future.current = []
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  // On empty canvas: a box to select what it touches, or the shape or text box being drawn.
  const startCanvas = (e: React.PointerEvent) => {
    if (e.button !== 0 || space || tool === 'hand') return
    e.stopPropagation()
    e.preventDefault()
    setMenu(null)
    wrap.current?.focus()
    const a = pointAt(e)
    const additive = e.shiftKey
    const before = selection
    const onMove = (ev: PointerEvent) => {
      const b = pointAt(ev)
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
      if (tool === 'select') {
        setMarquee(r)
        const hit = items.filter((it) => !it.hidden && !it.locked).filter((it) => {
          const bx = boxOf(it)
          return bx.x < r.x + r.w && bx.x + bx.w > r.x && bx.y < r.y + r.h && bx.y + bx.h > r.y
        })
        const ids = [...new Set(hit.flatMap((it) => withGroup(it.id)))]
        setSelection(additive ? [...new Set([...before, ...ids])] : ids)
      } else setDraft(tool === 'line' ? { x: r.x, y: a.y, w: r.w, h: 2 } : r)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      setMarquee(null)
      setDraft(null)
      const b = pointAt(ev)
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
      if (tool === 'select') {
        if (r.w < 3 && r.h < 3 && !additive) setSelection([])
        return
      }
      // A click (no drag) makes one at its usual size.
      const small = r.w < 6 && r.h < 6
      if (tool === 'text') add({ component: '', textBox: tr('screensTab.newText'), fontSize: 16, x: r.x, y: r.y, w: small ? 240 : Math.round(r.w), h: small ? undefined : Math.round(r.h) })
      else if (tool === 'line') add({ component: '', shape: 'line', x: r.x, y: a.y, w: small ? 200 : Math.round(r.w), h: 2 })
      else add({ component: '', shape: tool, x: r.x, y: r.y, w: small ? 160 : Math.round(r.w), h: small ? (tool === 'ellipse' ? 160 : 100) : Math.round(r.h) })
      setTool('select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  // Whether the pointer is over words: the page says (and outlines them), once per frame.
  const hoverFrame = useRef<number | null>(null)
  const hoverWords = (e: React.PointerEvent) => {
    if (tool !== 'select' || moving || e.buttons) return
    const r = overlay.current?.getBoundingClientRect()
    if (!r) return
    const at = { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = requestAnimationFrame(() => toPage({ type: 'hover', ...at, mode: 'text' }))
  }

  // Double-click a thing to change its words, in place.
  const retype = (e: React.MouseEvent) => {
    const r = overlay.current?.getBoundingClientRect()
    if (!r) return
    frame.current?.focus()
    toPage({ type: 'tap', mode: 'text', x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k })
  }

  const ids = selection
  const remove = () => {
    setItems(items.filter((x) => !ids.includes(x.id)))
    setSelection([])
  }
  /** Copies with new ids (and new groups, kept together), a little down and right. */
  const copies = (list: ScreenItem[], by = 16) => {
    const groups = new Map<string, string>()
    return list.map((x) => ({ ...x, id: uid(), x: x.x + by, y: x.y + by, group: x.group ? (groups.get(x.group) ?? groups.set(x.group, uid()).get(x.group)) : undefined }))
  }
  const duplicate = () => {
    const made = copies(selected)
    setItems([...items, ...made])
    setSelection(made.map((x) => x.id))
  }
  const copy = () => (clipboard = selected.map((x) => ({ ...x })))
  const paste = () => {
    if (!clipboard.length) return
    const made = copies(clipboard)
    clipboard = made
    setItems([...modelRef.current.items, ...made])
    setSelection(made.map((x) => x.id))
  }
  const toFront = () => setItems([...items.filter((x) => !ids.includes(x.id)), ...selected])
  const toBack = () => setItems([...selected, ...items.filter((x) => !ids.includes(x.id))])
  const group = () => selected.length > 1 && updateItems(ids, { group: uid() })
  const ungroup = () => updateItems(ids, { group: undefined })
  const grouped = selected.some((x) => x.group)
  const align = (how: Align) => {
    const b = boundsOf(selected)
    if (!b || selected.length < 2) return
    updateItems(ids, (x) => {
      const s = sizeOf(x)
      return how === 'left' ? { x: b.x } : how === 'right' ? { x: Math.round(b.x + b.w - s.w) } : how === 'centre' ? { x: Math.round(b.x + (b.w - s.w) / 2) } : how === 'top' ? { y: b.y } : how === 'bottom' ? { y: Math.round(b.y + b.h - s.h) } : { y: Math.round(b.y + (b.h - s.h) / 2) }
    })
  }
  const spread = (axis: 'x' | 'y') => {
    if (selected.length < 3) return
    const dim = axis === 'x' ? 'w' : 'h'
    const order = [...selected].sort((a, b) => a[axis] - b[axis])
    const first = boxOf(order[0])
    const last = boxOf(order[order.length - 1])
    const total = order.reduce((n, x) => n + sizeOf(x)[dim], 0)
    const gap = (last[axis] + last[dim] - first[axis] - total) / (order.length - 1)
    let at = first[axis]
    const pos = new Map<string, number>()
    for (const x of order) {
      pos.set(x.id, Math.round(at))
      at += sizeOf(x)[dim] + gap
    }
    updateItems(ids, (x) => ({ [axis]: pos.get(x.id) }))
  }
  const zoomToSelection = () => {
    const b = boundsOf(selected.length ? selected : items)
    if (b) setFocus({ x: area.x + b.x, y: area.y + b.y, w: b.w, h: b.h, key: Date.now() })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const run = (f: () => void) => (e.preventDefault(), f())
    if (mod && key === 'z') return run(e.shiftKey ? redo : undo)
    if (mod && key === 'y') return run(redo)
    if (mod && key === 'a') return run(() => setSelection(items.filter((x) => !x.hidden && !x.locked).map((x) => x.id)))
    if (mod && key === 'v') return run(paste)
    if (e.key === 'Escape') return run(() => (setMenu(null), setTool('select'), setSelection([])))
    if (!mod && !e.altKey) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === key)
      if (t) return run(() => setTool(t.id))
      if (key === 'i') return run(() => void pickImage())
      if (e.shiftKey && key === '1') return run(() => setFocus({ x: 0, y: 0, w: W, h: H, key: Date.now() }))
      if (e.shiftKey && key === '2') return run(zoomToSelection)
    }
    if (!selected.length) return
    if (e.key === 'Delete' || e.key === 'Backspace') return run(remove)
    if (mod && key === 'c') return run(copy)
    if (mod && key === 'x') return run(() => (copy(), remove()))
    if (mod && key === 'd') return run(duplicate)
    if (mod && key === 'g') return run(e.shiftKey ? ungroup : group)
    if (mod && e.key === ']') return run(toFront)
    if (mod && e.key === '[') return run(toBack)
    const step = e.shiftKey ? 10 : 1
    const by = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key]
    if (by) run(() => updateItems(ids, (x) => ({ x: Math.max(0, x.x + by[0]), y: Math.max(0, x.y + by[1]) })))
  }

  const num = (v: string, min: number) => Math.max(min, Math.round(Number(v) || 0))
  const frameName = model.frame.kind === 'shell' ? tr('screensTab.inShell', { name: compMap[model.frame.shell]?.name ?? tr('screensTab.shell') }) : tr('screensTab.size', { w: model.frame.width, h: model.frame.height })
  const sb = boundsOf(selected)
  const shared = <K extends keyof ScreenItem>(key: K): ScreenItem[K] | undefined => (selected.every((x) => x[key] === selected[0]?.[key]) ? selected[0]?.[key] : undefined)
  const colour = shared('color')
  const custom = colour?.startsWith('#') ? colour : undefined
  // On screen (in the canvas), where content is.
  const onScreen = (x: number, y: number) => ({ left: view.x + (area.x + x) * k, top: view.y + (area.y + y) * k })

  const swatches = (
    <div className="screens-swatches" role="radiogroup" aria-label={tr('screensTab.colour')}>
      <button role="radio" aria-checked={!colour} className={`screens-swatch none${!colour ? ' on' : ''}`} aria-label={tr('screensTab.colourNone')} title={tr('screensTab.colourNone')} onClick={() => updateItems(ids, { color: undefined })} />
      {COLOUR_TOKENS.map((c) => (
        <button key={c} role="radio" aria-checked={colour === c} className={`screens-swatch${colour === c ? ' on' : ''}`} style={{ background: pageColours?.[c] ?? `var(--${c})` }} aria-label={tr(`screensTab.colours.${c}`)} title={tr(`screensTab.colours.${c}`)} onClick={() => updateItems(ids, { color: c })} />
      ))}
      <label className={`screens-swatch custom${custom ? ' on' : ''}`} style={custom ? { background: custom } : undefined} title={tr('screensTab.colourCustom')}>
        <input type="color" value={custom ?? '#3b82f6'} onChange={(e) => updateItems(ids, { color: e.target.value })} aria-label={tr('screensTab.colourCustom')} />
      </label>
    </div>
  )
  const alignButtons = (
    <div className="screens-align">
      {(['left', 'centre', 'right', 'top', 'middle', 'bottom'] as Align[]).map((a) => (
        <button key={a} className="icon-btn" onClick={() => align(a)} disabled={selected.length < 2} aria-label={tr(`screensTab.align.${a}`)} title={tr(`screensTab.align.${a}`)}>
          <AlignIcon how={a} />
        </button>
      ))}
      <span className="screens-align-sep" />
      <button className="icon-btn" onClick={() => spread('x')} disabled={selected.length < 3} aria-label={tr('screensTab.align.spreadX')} title={tr('screensTab.align.spreadX')}>
        <AlignIcon how="spread-x" />
      </button>
      <button className="icon-btn" onClick={() => spread('y')} disabled={selected.length < 3} aria-label={tr('screensTab.align.spreadY')} title={tr('screensTab.align.spreadY')}>
        <AlignIcon how="spread-y" />
      </button>
    </div>
  )
  const menuItems: ({ label: string; keys?: string; run: () => void; danger?: boolean } | 'sep')[] = selected.length
    ? [
        { label: tr('screensTab.menu.copy'), keys: 'Ctrl+C', run: copy },
        { label: tr('screensTab.menu.paste'), keys: 'Ctrl+V', run: paste },
        { label: tr('screensTab.menu.duplicate'), keys: 'Ctrl+D', run: duplicate },
        'sep',
        { label: tr('screensTab.menu.front'), keys: 'Ctrl+]', run: toFront },
        { label: tr('screensTab.menu.back'), keys: 'Ctrl+[', run: toBack },
        ...(selected.length > 1 ? [{ label: tr('screensTab.menu.group'), keys: 'Ctrl+G', run: group }] : []),
        ...(grouped ? [{ label: tr('screensTab.menu.ungroup'), keys: 'Ctrl+Shift+G', run: ungroup }] : []),
        'sep',
        { label: tr(selected.every((x) => x.locked) ? 'screensTab.menu.unlock' : 'screensTab.menu.lock'), run: () => updateItems(ids, { locked: !selected.every((x) => x.locked) || undefined }) },
        { label: tr('screensTab.menu.hide'), run: () => (updateItems(ids, { hidden: true }), setSelection([])) },
        { label: tr('screensTab.menu.zoom'), keys: 'Shift+2', run: zoomToSelection },
        'sep',
        { label: tr('screensTab.menu.delete'), keys: 'Del', run: remove, danger: true }
      ]
    : [
        { label: tr('screensTab.menu.paste'), keys: 'Ctrl+V', run: paste },
        { label: tr('screensTab.menu.selectAll'), keys: 'Ctrl+A', run: () => setSelection(items.filter((x) => !x.hidden && !x.locked).map((x) => x.id)) },
        { label: tr('screensTab.menu.zoomFit'), keys: 'Shift+1', run: () => setFocus({ x: 0, y: 0, w: W, h: H, key: Date.now() }) }
      ]
  const openMenu = (e: React.MouseEvent, id?: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (id && !selection.includes(id)) setSelection(withGroup(id))
    if (!id) setSelection([])
    const r = wrap.current!.getBoundingClientRect()
    setMenu({ x: Math.min(e.clientX - r.left, r.width - 230), y: Math.min(e.clientY - r.top, r.height - 330) })
  }

  // Layers: front first; drag one onto another to put it there.
  const [dragLayer, setDragLayer] = useState<string | null>(null)
  const reorder = (from: string, to: string) => {
    if (from === to) return
    const list = items.filter((x) => x.id !== from)
    const moved = items.find((x) => x.id === from)
    const at = list.findIndex((x) => x.id === to)
    if (!moved || at < 0) return
    list.splice(at + 1, 0, moved)
    setItems(list)
  }
  const layers = (
    <ul className="screens-layers" aria-label={tr('screensTab.layers')}>
      {!items.length && <li className="muted small screens-layers-empty">{tr('screensTab.layersEmpty')}</li>}
      {[...items].reverse().map((it) => (
        <li
          key={it.id}
          className={`screens-layer${selection.includes(it.id) ? ' on' : ''}${it.hidden ? ' hidden' : ''}${it.group ? ' grouped' : ''}${dragLayer === it.id ? ' dragging' : ''}`}
          draggable={renaming !== it.id}
          onDragStart={(e) => {
            setDragLayer(it.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => setDragLayer(null)}
          onDragOver={(e) => dragLayer && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (dragLayer) reorder(dragLayer, it.id)
            setDragLayer(null)
          }}
          onClick={(e) => (e.shiftKey ? select(it.id, true) : setSelection([it.id]))}
          onDoubleClick={() => setRenaming(it.id)}
          onContextMenu={(e) => openMenu(e, it.id)}
        >
          <Icon name={layerIcon(it)} className="muted" />
          {renaming === it.id ? (
            <input
              autoFocus
              defaultValue={layerName(it, compMap)}
              onBlur={(e) => (updateItems([it.id], { name: e.target.value.trim() || undefined }), setRenaming(null))}
              onKeyDown={(e) => (e.key === 'Enter' ? (e.target as HTMLInputElement).blur() : e.key === 'Escape' && setRenaming(null))}
              aria-label={tr('screensTab.rename')}
            />
          ) : (
            <span className="ellipsis grow">{layerName(it, compMap)}</span>
          )}
          <button className={`icon-btn${it.locked ? ' active' : ''}`} onClick={(e) => (e.stopPropagation(), updateItems([it.id], { locked: !it.locked || undefined }))} aria-label={tr(it.locked ? 'screensTab.menu.unlock' : 'screensTab.menu.lock')} title={tr(it.locked ? 'screensTab.menu.unlock' : 'screensTab.menu.lock')}>
            <Icon name={it.locked ? 'lock' : 'unlock'} />
          </button>
          <button className="icon-btn" onClick={(e) => (e.stopPropagation(), updateItems([it.id], { hidden: !it.hidden || undefined }))} aria-label={tr(it.hidden ? 'screensTab.show' : 'screensTab.menu.hide')} title={tr(it.hidden ? 'screensTab.show' : 'screensTab.menu.hide')}>
            <Icon name={it.hidden ? 'eye-closed' : 'eye'} />
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="screens-builder">
      <aside className="screens-left">
        <div className="screens-left-tabs" role="tablist">
          <button role="tab" aria-selected={left === 'library'} className={left === 'library' ? 'on' : undefined} onClick={() => setLeft('library')}>
            {tr('screensTab.library')}
          </button>
          <button role="tab" aria-selected={left === 'layers'} className={left === 'layers' ? 'on' : undefined} onClick={() => setLeft('layers')}>
            {tr('screensTab.layers')} <span className="muted small">{items.length}</span>
          </button>
        </div>
        {left === 'library' ? (
          <Library comps={comps} onAdd={(id) => add({ component: id, x: nextSpot(), y: nextSpot() })} onAddIcon={(icon) => add({ component: '', icon, w: 24, x: nextSpot(), y: nextSpot() })} />
        ) : (
          layers
        )}
      </aside>
      <div className="screens-main">
        <div className="preview-bar screens-bar">
          <IconButton icon="arrow-left" title={tr('screensTab.allScreens')} onClick={onBack} />
          <input className="screens-name" value={model.name} onChange={(e) => change({ ...model, name: e.target.value }, false)} aria-label={tr('screensTab.screenName')} />
          <span className="screens-frame-chip">{frameName}</span>
          <span className="grow" />
          <IconButton icon="discard" title={tr('screensTab.undo')} onClick={undo} />
          <IconButton icon="redo" title={tr('screensTab.redo')} onClick={redo} />
        </div>
        <div className="screens-body">
          <div ref={wrap} className={`screens-canvas tool-${space ? 'hand' : tool}`} tabIndex={-1} onKeyDown={onKey} onContextMenu={(e) => openMenu(e)}>
            <div className="screens-tools" role="toolbar" aria-label={tr('screensTab.tools')}>
              {TOOLS.map((t) => (
                <button key={t.id} className={`icon-btn${tool === t.id ? ' active' : ''}`} onClick={() => setTool(t.id)} aria-label={tr(`screensTab.toolNames.${t.id}`)} title={`${tr(`screensTab.toolNames.${t.id}`)} (${t.key})`}>
                  <Icon name={t.icon} />
                </button>
              ))}
              <button className="icon-btn" onClick={() => void pickImage()} aria-label={tr('screensTab.toolNames.image')} title={`${tr('screensTab.toolNames.image')} (I)`}>
                <Icon name="file-media" />
              </button>
            </div>
            {url && (
              <PanZoom contentKey={`${model.id}:${base}:${size ? 1 : 0}`} size={{ w: W, h: H }} fitWidth className="screens-panzoom" hint={tr(space || tool === 'hand' ? 'screensTab.panHint' : 'screensTab.canvasHint')} onTap={() => (setSelection([]), setMenu(null))} focus={focus} onView={setView}>
                <iframe ref={frame} className="sketch-frame" title={model.name} src={url} sandbox="allow-scripts" width={W} height={H} style={{ pointerEvents: 'none' }} onLoad={place} />
                <div
                  ref={overlay}
                  className={`screens-overlay${overText && tool === 'select' && !moving ? ' over-text' : ''}`}
                  style={{ pointerEvents: space || tool === 'hand' ? 'none' : 'auto', ['--k' as string]: k }}
                  onPointerDown={startCanvas}
                  onPointerMove={(e) => hoverWords(e)}
                  onPointerLeave={() => (toPage({ type: 'hover', x: null, y: null, mode: 'text' }), setOverText(false))}
                  onDragOver={(e) => {
                    const t = e.dataTransfer.types
                    if (!t.includes('application/x-glassbox-component') && !t.includes('application/x-glassbox-icon') && !t.includes('Files')) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(e) => {
                    const component = e.dataTransfer.getData('application/x-glassbox-component')
                    const icon = e.dataTransfer.getData('application/x-glassbox-icon')
                    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
                    if (!component && !icon && !files.length) return
                    e.preventDefault()
                    e.stopPropagation()
                    const p = pointAt(e)
                    if (files.length) return void filesToPaths(files).then(async (paths) => { for (const path of paths) await addImage(path, p) })
                    add(icon ? { component: '', icon, w: 24, x: p.x, y: p.y } : { component, x: p.x, y: p.y })
                  }}
                >
                  {items.map((it) => {
                    if (it.hidden) return null
                    const sz = sizeOf(it)
                    const on = selection.includes(it.id)
                    return (
                      <div
                        key={it.id}
                        className={`screens-box${on ? ' on' : ''}${it.locked ? ' locked' : ''}`}
                        style={{ left: area.x + it.x, top: area.y + it.y, width: sz.w, height: sz.h, ['--k' as string]: k }}
                        onPointerDown={(e) => (tool === 'select' ? drag(e, it.id) : undefined)}
                        onDoubleClick={retype}
                        onContextMenu={(e) => openMenu(e, it.id)}
                      >
                        {on && sel?.id === it.id && !it.locked && !moving && HANDLES.filter((h) => (it.icon || it.shape === 'line' ? h.length === 2 || h === 'e' || h === 'w' : true)).map((h) => <span key={h} className={`screens-handle ${h}`} onPointerDown={(e) => drag(e, it.id, h)} />)}
                      </div>
                    )
                  })}
                  {selected.length > 1 && sb && <div className="screens-selection" style={{ left: area.x + sb.x, top: area.y + sb.y, width: sb.w, height: sb.h }} />}
                  {marquee && <div className="screens-marquee" style={{ left: area.x + marquee.x, top: area.y + marquee.y, width: marquee.w, height: marquee.h }} />}
                  {draft && <div className={`screens-draft ${tool}`} style={{ left: area.x + draft.x, top: area.y + draft.y, width: draft.w, height: Math.max(2, draft.h) }} />}
                  {guides?.x !== undefined && <div className="screens-guide v" style={{ left: area.x + guides.x, top: area.y, height: Math.max(area.h, H - area.y) }} />}
                  {guides?.y !== undefined && <div className="screens-guide h" style={{ top: area.y + guides.y, left: area.x, width: area.w }} />}
                </div>
              </PanZoom>
            )}
            {sb && !moving && !menu && (
              <div className={`screens-float${onScreen(sb.x, sb.y).top < 72 ? ' below' : ''}`} style={onScreen(sb.x, sb.y).top < 72 ? onScreen(sb.x, sb.y + sb.h) : onScreen(sb.x, sb.y)} onPointerDown={(e) => e.stopPropagation()}>
                {sel && selComp?.variants?.length ? (
                  <Select className="screens-float-select" value={sel.variant ?? ''} onChange={(v) => updateItems([sel.id], { variant: v || undefined })} options={[{ value: '', label: tr('screensTab.defaultVariant') }, ...selComp.variants.map((v) => ({ value: v.name, label: v.name }))]} aria-label={tr('screensTab.variant')} />
                ) : null}
                <span className="screens-float-colours">
                  {(['accent', 'fg', 'ok', 'warn', 'err'] as const).map((c) => (
                    <button key={c} className={`screens-swatch small${colour === c ? ' on' : ''}`} style={{ background: pageColours?.[c] ?? `var(--${c})` }} onClick={() => updateItems(ids, { color: c })} aria-label={tr(`screensTab.colours.${c}`)} title={tr(`screensTab.colours.${c}`)} />
                  ))}
                </span>
                {selected.length > 1 && (
                  <>
                    <button className="icon-btn" onClick={() => align('left')} aria-label={tr('screensTab.align.left')} title={tr('screensTab.align.left')}>
                      <AlignIcon how="left" />
                    </button>
                    <button className="icon-btn" onClick={() => align('top')} aria-label={tr('screensTab.align.top')} title={tr('screensTab.align.top')}>
                      <AlignIcon how="top" />
                    </button>
                    <IconButton icon={grouped ? 'ungroup-by-ref-type' : 'group-by-ref-type'} title={tr(grouped ? 'screensTab.menu.ungroup' : 'screensTab.menu.group')} onClick={grouped ? ungroup : group} />
                  </>
                )}
                <IconButton icon="copy" title={tr('screensTab.duplicateTip')} onClick={duplicate} />
                <IconButton icon="trash" title={tr('screensTab.removeTip')} onClick={remove} />
                <button
                  className="icon-btn"
                  aria-label={tr('screensTab.more')}
                  title={tr('screensTab.more')}
                  onClick={(e) => {
                    const r = wrap.current!.getBoundingClientRect()
                    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({ x: Math.min(b.left - r.left, r.width - 230), y: Math.min(b.bottom - r.top + 4, r.height - 330) })
                  }}
                >
                  <Icon name="ellipsis" />
                </button>
              </div>
            )}
            {menu && (
              <>
                <div className="menu-scrim" onMouseDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
                <div className="menu screens-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
                  {menuItems.map((m, i) =>
                    m === 'sep' ? (
                      <div key={i} className="menu-sep" />
                    ) : (
                      <button key={i} role="menuitem" className={`menu-item${m.danger ? ' danger' : ''}`} onClick={() => (setMenu(null), m.run())}>
                        <span className="grow">{m.label}</span>
                        {m.keys && <kbd>{m.keys}</kbd>}
                      </button>
                    )
                  )}
                </div>
              </>
            )}
            {!items.length && <div className="screens-drop-hint muted">{tr(comps.some((c) => c.kind === 'component') ? 'screensTab.dropHint' : 'screensTab.dropHintEmpty')}</div>}
          </div>
          <aside className="screens-props" aria-label={tr('screensTab.properties')}>
            {selected.length > 1 ? (
              <>
                <header className="screens-props-head">
                  <span className="screens-props-icon">
                    <Icon name="layers" />
                  </span>
                  <span className="screens-props-title">
                    <strong>{tr('screensTab.selectedCount', { count: selected.length })}</strong>
                    <span className="muted small">{grouped ? tr('screensTab.grouped') : tr('screensTab.notGrouped')}</span>
                  </span>
                </header>
                <section className="screens-props-section">
                  <h4>{tr('screensTab.alignHeading')}</h4>
                  {alignButtons}
                </section>
                <section className="screens-props-section">
                  <h4>{tr('screensTab.colour')}</h4>
                  {swatches}
                </section>
                <section className="screens-props-section">
                  <button className="btn quiet" onClick={grouped ? ungroup : group}>
                    <Icon name={grouped ? 'ungroup-by-ref-type' : 'group-by-ref-type'} /> {tr(grouped ? 'screensTab.menu.ungroup' : 'screensTab.menu.group')}
                  </button>
                </section>
                <footer className="screens-props-actions">
                  <IconButton icon="copy" title={tr('screensTab.duplicateTip')} onClick={duplicate} />
                  <IconButton icon="layers" title={tr('screensTab.menu.front')} onClick={toFront} />
                  <span className="grow" />
                  <button className="btn quiet danger" onClick={remove} title={tr('screensTab.removeTip')}>
                    <Icon name="trash" /> {tr('screensTab.remove')}
                  </button>
                </footer>
              </>
            ) : sel ? (
              <>
                <header className="screens-props-head">
                  <span className="screens-props-icon">{sel.icon ? <Icon name={sel.icon} /> : <Icon name={layerIcon(sel)} />}</span>
                  <span className="screens-props-title">
                    <strong className="ellipsis">{layerName(sel, compMap)}</strong>
                    {selComp?.source ? (
                      <button className="link small ellipsis" onClick={() => openFile(selComp.source!)} title={selComp.usage}>
                        {selComp.source}
                      </button>
                    ) : (
                      <span className="muted small">{tr(sel.icon ? 'screensTab.builtInIcon' : sel.shape ? 'screensTab.shape' : sel.textBox !== undefined ? 'screensTab.textBox' : sel.image ? 'screensTab.image' : 'screensTab.component')}</span>
                    )}
                  </span>
                </header>
                {!!selComp?.variants?.length && (
                  <section className="screens-props-section">
                    <h4>{tr('screensTab.variant')}</h4>
                    <Select value={sel.variant ?? ''} onChange={(v) => updateItems([sel.id], { variant: v || undefined })} options={[{ value: '', label: tr('screensTab.defaultVariant') }, ...selComp.variants.map((v) => ({ value: v.name, label: v.name }))]} aria-label={tr('screensTab.variant')} />
                  </section>
                )}
                <section className="screens-props-section">
                  <h4>{tr('screensTab.placement')}</h4>
                  <div className="screens-prop-grid">
                    {(
                      [
                        ['X', sel.x, (v: string) => updateItems([sel.id], { x: num(v, 0) })],
                        ['Y', sel.y, (v: string) => updateItems([sel.id], { y: num(v, 0) })],
                        ['W', Math.round(sizeOf(sel).w), (v: string) => updateItems([sel.id], { w: num(v, 8) })],
                        ...(sel.icon ? [] : [['H', Math.round(sizeOf(sel).h), (v: string) => updateItems([sel.id], { h: num(v, 2) })]])
                      ] as [string, number, (v: string) => void][]
                    ).map(([label, value, set]) => (
                      <label key={label} className="screens-prop">
                        <span>{label}</span>
                        <input type="number" value={value} onChange={(e) => set(e.target.value)} />
                      </label>
                    ))}
                  </div>
                  {sel.h !== undefined && !sel.shape && !sel.image && sel.textBox === undefined && (
                    <button className="link small" onClick={() => updateItems([sel.id], { h: undefined })}>
                      {tr('screensTab.autoHeight')}
                    </button>
                  )}
                </section>
                {sel.textBox !== undefined && (
                  <section className="screens-props-section">
                    <h4>{tr('screensTab.textHeading')}</h4>
                    <div className="screens-prop-inline">
                      <label className="screens-prop">
                        <span>{tr('screensTab.fontSize')}</span>
                        <input type="number" value={sel.fontSize ?? 16} onChange={(e) => updateItems([sel.id], { fontSize: num(e.target.value, 8) })} />
                      </label>
                      <button className={`icon-btn${sel.bold ? ' active' : ''}`} onClick={() => updateItems([sel.id], { bold: !sel.bold || undefined })} aria-label={tr('screensTab.bold')} title={tr('screensTab.bold')}>
                        <Icon name="bold" />
                      </button>
                    </div>
                  </section>
                )}
                <section className="screens-props-section">
                  <h4 title={sel.icon || sel.shape ? undefined : tr('screensTab.colourTip')}>{tr(sel.shape && sel.shape !== 'line' ? 'screensTab.fill' : 'screensTab.colour')}</h4>
                  {swatches}
                  <div className="screens-prop-inline">
                    {!sel.icon && sel.shape !== 'line' && (
                      <label className="screens-prop">
                        <span>{tr('screensTab.radius')}</span>
                        <input type="number" value={sel.radius ?? 0} onChange={(e) => updateItems([sel.id], { radius: num(e.target.value, 0) || undefined })} />
                      </label>
                    )}
                    <label className="screens-prop grow">
                      <span>{tr('screensTab.opacity', { n: Math.round((sel.opacity ?? 1) * 100) })}</span>
                      <input type="range" min={5} max={100} value={Math.round((sel.opacity ?? 1) * 100)} onChange={(e) => updateItems([sel.id], { opacity: Number(e.target.value) >= 100 ? undefined : Number(e.target.value) / 100 })} />
                    </label>
                  </div>
                </section>
                {sel.text && Object.keys(sel.text).length > 0 && (
                  <section className="screens-props-section">
                    <button className="link small" onClick={() => updateItems([sel.id], { text: undefined })}>
                      {tr('screensTab.resetText')}
                    </button>
                  </section>
                )}
                <footer className="screens-props-actions">
                  <IconButton icon="copy" title={tr('screensTab.duplicateTip')} onClick={duplicate} />
                  <IconButton icon="layers" title={tr('screensTab.menu.front')} onClick={toFront} />
                  <IconButton icon={sel.locked ? 'lock' : 'unlock'} title={tr(sel.locked ? 'screensTab.menu.unlock' : 'screensTab.menu.lock')} onClick={() => updateItems([sel.id], { locked: !sel.locked || undefined })} />
                  <span className="grow" />
                  <button className="btn quiet danger" onClick={remove} title={tr('screensTab.removeTip')}>
                    <Icon name="trash" /> {tr('screensTab.remove')}
                  </button>
                </footer>
              </>
            ) : (
              <>
                <header className="screens-props-head">
                  <span className="screens-props-icon">
                    <Icon name="window" />
                  </span>
                  <span className="screens-props-title">
                    <strong className="ellipsis">{model.name}</strong>
                    <span className="muted small">{tr('screensTab.itemCount', { count: items.length })}</span>
                  </span>
                </header>
                <section className="screens-props-section">
                  <h4>{tr('screensTab.howTo')}</h4>
                  <ul className="screens-tips">
                    {(['add', 'draw', 'move', 'select', 'words', 'resize', 'group', 'pan', 'menu'] as const).map((t) => (
                      <li key={t}>{tr(`screensTab.tips.${t}`)}</li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
