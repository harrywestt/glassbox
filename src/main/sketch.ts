import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, ClipboardItem, nativeImage, type NativeImage } from 'electron'

/**
 * Claude's sketches: rough HTML pages to show an idea or a problem. Each version is kept by its
 * content (the same page is the same file, so a resumed session finds it again) and served as
 * sketch://page/<hash>.html: its own scripts run, but it can't reach the network, the app or files.
 */

const dir = () => {
  const d = join(app.getPath('userData'), 'sketches')
  mkdirSync(d, { recursive: true })
  return d
}

const sub = (name: string) => {
  const d = join(dir(), name)
  mkdirSync(d, { recursive: true })
  return d
}
const hash = (data: string | Buffer) => createHash('sha1').update(data).digest('hex').slice(0, 20)

/** Files a sketch may show: images, video and fonts. */
const ASSET_FILE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|woff2?|ttf|otf)$/i
const ASSET_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
}

/**
 * The files on disk a sketch refers to (in src, href, poster or a CSS url(): a path relative to the
 * project, an absolute path or a file:// address), copied into the sketch store by their content and
 * pointed at there. The page still can't reach the disk or the network: only these copies.
 */
export function withAssets(html: string, cwd?: string): { html: string; found: number; missing: string[] } {
  const missing: string[] = []
  let found = 0
  const swap = (raw: string): string | null => {
    const v = raw.trim()
    if (!v || /^(data:|blob:|https?:|sketch:|#|mailto:|javascript:)/i.test(v)) return null
    let path: string
    try {
      path = v.startsWith('file:') ? fileURLToPath(v) : decodeURI(v.split(/[?#]/)[0])
    } catch {
      return null
    }
    if (!ASSET_FILE.test(path)) return null
    const abs = isAbsolute(path) || /^[a-z]:[\\/]/i.test(path) ? path : cwd ? resolve(cwd, path) : null
    if (!abs) return null
    try {
      const st = statSync(abs)
      if (!st.isFile() || st.size > 25 * 1024 * 1024) throw new Error('not a file')
      const data = readFileSync(abs)
      const name = `${hash(data)}${extname(abs).toLowerCase()}`
      const file = join(sub('assets'), name)
      if (!existsSync(file)) writeFileSync(file, data)
      found++
      return `sketch://asset/${name}`
    } catch {
      missing.push(v)
      return null
    }
  }
  const out = html
    .replace(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi, (m, attr: string, q: string, val: string) => {
      const s = swap(val)
      return s ? `${attr}=${q}${s}${q}` : m
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q: string, val: string) => {
      const s = swap(val)
      return s ? `url(${q}${s}${q})` : m
    })
  return { html: out, found, missing }
}

/** Keeps a sketch's HTML (its local images and fonts brought along) and returns the address it's served at. */
export function sketchUrl(html: string, cwd?: string): string {
  const page = withAssets(html, cwd).html
  const name = `${hash(page)}.html`
  const file = join(dir(), name)
  if (!existsSync(file)) writeFileSync(file, page, 'utf8')
  return `sketch://page/${name}`
}

/**
 * A sketch version as Claude wrote it, kept by its content so a later version can be an edit of it
 * and a resumed session can find it again (the reference goes in the tool's answer).
 */
export function keepSketch(html: string): string {
  const ref = hash(html)
  const file = join(sub('raw'), `${ref}.html`)
  if (!existsSync(file)) writeFileSync(file, html, 'utf8')
  return ref
}
export function readSketch(ref: string): string | null {
  if (!/^[0-9a-f]{20}$/.test(ref)) return null
  try {
    return readFileSync(join(sub('raw'), `${ref}.html`), 'utf8')
  } catch {
    return null
  }
}
/** The latest version of each sketch, per project, for edits and snapshots (kept across restarts). */
const LATEST = () => join(dir(), 'latest.json')
type Latest = Record<string, { ref: string; width: number; stylesheet?: string; bare?: boolean }>
let latest: Latest | null = null
const latestAll = (): Latest => (latest ??= (() => {
  try {
    return JSON.parse(readFileSync(LATEST(), 'utf8')) as Latest
  } catch {
    return {} as Latest
  }
})())
const latestKey = (cwd: string, id: string) => `${cwd.replace(/\\/g, '/').toLowerCase()}|${id}`
export function latestSketch(cwd: string, id: string) {
  return latestAll()[latestKey(cwd, id)]
}
export function setLatestSketch(cwd: string, id: string, v: { ref: string; width: number; stylesheet?: string; bare?: boolean } | null) {
  const all = latestAll()
  if (v) all[latestKey(cwd, id)] = v
  else delete all[latestKey(cwd, id)]
  try {
    writeFileSync(LATEST(), JSON.stringify(all))
  } catch {
    /* this run only */
  }
}

/** Scripts and inline styles; images, fonts and video only from the sketch's own copies. Nothing from anywhere else. */
export const SKETCH_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob: sketch:; font-src data: sketch:; media-src data: blob: sketch:"

const TOKEN = /^[\w#%(),. -]{1,60}$/

/**
 * A sketch as a whole page: its colours (Glassbox's under the project's, from `themeJson`), the
 * sketching kit underneath its own styles (unless `bare`), and the sketch itself.
 */
function composePage(html: string, themeJson: string | null, bare: boolean): string {
  let theme: Record<string, string> = {}
  try {
    theme = JSON.parse(themeJson ?? '{}')
  } catch {
    /* defaults */
  }
  const vars = Object.entries(theme)
    .filter(([k, v]) => /^[a-z0-9]+$/i.test(k) && typeof v === 'string' && TOKEN.test(v))
    .map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${v};`)
    .join(' ')
  const dark = theme.base === 'dark'
  const palette = (dark ? CAT_DARK : CAT_LIGHT).map((v, i) => `--cat-${i + 1}: ${v};`).join(' ')
  // Bare: the page's own styles only, without Glassbox's sketching kit. Otherwise the kit sits in a
  // layer underneath the sketch's styles, and a class the sketch styles itself (its own .note,
  // .card…) is left out of it altogether, so none of Glassbox's look (a border, a tint) leaks in.
  const own = new Set([...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]))
  const kitRules = KIT.split('\n')
    .filter((line) => !line.includes('{') || ![...line.slice(0, line.indexOf('{')).matchAll(/\.([A-Za-z_][\w-]*)/g)].some((m) => own.has(m[1])))
    .join('\n')
  const kit = bare ? '' : `<style>@layer glassbox-kit {${kitRules}}</style>`
  // Glassbox's colours first, then the project's over them: a colour the project doesn't set (no
  // error red, say) is still there, so .solid-err or var(--warn) never draws as nothing.
  const head = `<meta charset="utf-8"><style>:root { color-scheme: ${dark ? 'dark' : 'light'}; ${dark ? BASE_DARK : BASE_LIGHT} ${palette} ${vars} }</style>${kit}`
  // A full document gets the head bits inside its own head; a fragment gets a document around it.
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + head)
    : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (m) => m + `<head>${head}</head>`)
      : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

/**
 * A sketch as a page that works anywhere, to share: its colours, styles and click-through
 * behaviour built in, and its images and fonts inlined, so it opens in any browser as it does here.
 */
export function sketchDocument(url: string, title: string): string {
  const u = new URL(url)
  const name = u.pathname.replace(/^\/+/, '')
  if (!/^[0-9a-f]{20}\.html$/.test(name)) throw new Error('Not a sketch')
  let page = composePage(readFileSync(join(dir(), name), 'utf8'), u.searchParams.get('t'), u.searchParams.get('b') === '1')
  page = page.replace(/sketch:\/\/asset\/([0-9a-f]{20}\.[a-z0-9]{2,5})/g, (m, asset: string) => {
    const file = join(sub('assets'), asset)
    return existsSync(file) ? `data:${ASSET_TYPES[asset.split('.').pop() ?? ''] ?? 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}` : m
  })
  const safe = title.replace(/[<>&]/g, '')
  page = /<title>/i.test(page) ? page : page.replace(/<head[^>]*>/i, (h) => `${h}<title>${safe}</title>`)
  return page.replace(/<\/body>(?![\s\S]*<\/body>)/i, `<script>${INTERACTIONS}</script></body>`)
}

/** The page, with Glassbox's colours and a small kit of sketching styles, and the helper the view talks to. */
export function sketchPage(url: string): Response {
  const u = new URL(url)
  const name = u.pathname.replace(/^\/+/, '')
  // A copied image, font or video the sketch shows.
  if (u.hostname === 'asset') {
    if (!/^[0-9a-f]{20}\.[a-z0-9]{2,5}$/.test(name)) return new Response('Not found', { status: 404 })
    const file = join(sub('assets'), name)
    if (!existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(readFileSync(file), { headers: { 'Content-Type': ASSET_TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream', 'Cache-Control': 'max-age=31536000' } })
  }
  if (!/^[0-9a-f]{20}\.html$/.test(name)) return new Response('Not found', { status: 404 })
  const file = join(dir(), name)
  if (!existsSync(file)) return new Response('Not found', { status: 404 })
  const page = composePage(readFileSync(file, 'utf8'), u.searchParams.get('t'), u.searchParams.get('b') === '1')
  return new Response(page + `<script>${INTERACTIONS}</script><script>${HELPER}</script>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SKETCH_CSP, 'Cache-Control': 'no-store' }
  })
}

/** Glassbox's own chart palette (as in styles.css --cat-1…8), for a sketch's categories. */
const CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#d55181', '#c98500', '#008300', '#e66767']
const CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#e87ba4', '#eda100', '#008300', '#e34948']
/** Every colour a sketch can use, as Glassbox draws it, under whatever the project sets itself. */
const BASE_LIGHT = '--bg: #ffffff; --surface: #f6f7f9; --surface2: #ffffff; --elevated: #ffffff; --border: #d0d4da; --fg: #1d2025; --muted: #6b7280; --subtle: #9aa1ab; --accent: #2f6fde; --accent-fg: #ffffff; --ok: #16a34a; --warn: #d97706; --err: #dc2626; --info: #2563eb; --radius: 8px;'
const BASE_DARK = '--bg: #16181d; --surface: #1d2026; --surface2: #23272e; --elevated: #2b3037; --border: #353a42; --fg: #e6e8eb; --muted: #9aa1ab; --subtle: #6b7280; --accent: #4c8dff; --accent-fg: #ffffff; --ok: #3fb950; --warn: #e3a008; --err: #f85149; --info: #58a6ff; --radius: 8px;'
/** The app's colours a sketch can use by name: its accent, its status colours and its chart palette. */
const COLOURS = ['accent', 'ok', 'warn', 'err', 'info', ...CAT_DARK.map((_, i) => `cat-${i + 1}`)]

/** Plain defaults that match Glassbox, and a few pieces for sketching (described to Claude in show_sketch). */
const KIT = `
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg, #fff); }
body { margin: 0; padding: 24px; color: var(--fg, #1d2025); font: 14px/1.5 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif; }
h1, h2, h3 { line-height: 1.25; margin: 0 0 8px; }
h1 { font-size: 22px; } h2 { font-size: 17px; } h3 { font-size: 14px; }
p { margin: 0 0 8px; }
code, pre, .mono { font-family: 'Cascadia Code', Consolas, ui-monospace, monospace; font-size: 12.5px; }
button, input, select, textarea { font: inherit; color: inherit; }
button { padding: 6px 12px; border-radius: var(--radius, 8px); border: 1px solid var(--border, #d0d4da); background: var(--surface, #f6f7f9); cursor: pointer; }
button.primary { background: var(--accent, #2f6fde); border-color: transparent; color: var(--accent-fg, #fff); }
input, select, textarea { padding: 6px 8px; border-radius: var(--radius, 8px); border: 1px solid var(--border, #d0d4da); background: var(--surface2, #fff); }
table { border-collapse: collapse; } th, td { padding: 6px 10px; border-bottom: 1px solid var(--border, #d0d4da); text-align: left; }
.row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.col { display: flex; flex-direction: column; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.muted { color: var(--muted, #6b7280); }
.small { font-size: 12px; }
.card { padding: 16px; border: 1px solid var(--border, #d0d4da); border-radius: var(--radius, 8px); background: var(--surface, #f6f7f9); }
.box { display: flex; align-items: center; justify-content: center; min-height: 64px; padding: 12px; border: 1.5px dashed var(--subtle, #9aa1ab); border-radius: 8px; color: var(--muted, #6b7280); font-size: 12px; text-align: center; }
.note { padding: 6px 10px; border-left: 3px solid var(--info, #3b82f6); background: color-mix(in srgb, var(--info, #3b82f6) 10%, transparent); border-radius: 0 6px 6px 0; font-size: 12.5px; }
.bad { outline: 2px solid var(--err, #dc2626); outline-offset: 3px; border-radius: 4px; }
.good { outline: 2px solid var(--ok, #16a34a); outline-offset: 3px; border-radius: 4px; }
.label { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; background: var(--elevated, #eceef1); color: var(--muted, #6b7280); }
[data-pick] { cursor: pointer; }
[data-open], [data-close], [data-toggle], [data-tab], [data-goto], [data-toast] { cursor: pointer; }
.modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding: 72px 24px; background: rgba(12, 14, 18, .5); }
.modal > .panel { width: min(520px, 100%); max-height: calc(100vh - 144px); overflow: auto; padding: 20px; border: 1px solid var(--border, #d0d4da); border-radius: calc(var(--radius, 8px) + 4px); background: var(--surface, #fff); box-shadow: 0 24px 60px rgba(0, 0, 0, .35); }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 1000; width: min(420px, 90vw); overflow: auto; padding: 20px; border-left: 1px solid var(--border, #d0d4da); background: var(--surface, #fff); box-shadow: -16px 0 48px rgba(0, 0, 0, .3); }
.popover { position: absolute; z-index: 900; min-width: 180px; padding: 4px; border: 1px solid var(--border, #d0d4da); border-radius: var(--radius, 8px); background: var(--elevated, #fff); box-shadow: 0 10px 28px rgba(0, 0, 0, .22); }
.popover > * { display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: none; text-align: left; }
.popover > *:hover { background: var(--surface2, #f1f3f5); }
[data-tabs]:has(> [data-tab]) { display: flex; gap: 4px; border-bottom: 1px solid var(--border, #d0d4da); }
[data-tab] { padding: 8px 12px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted, #6b7280); }
[data-tab].active { border-bottom-color: var(--accent, #2f6fde); color: var(--fg, #1d2025); font-weight: 600; }
${COLOURS.map((c) => `.text-${c} { color: var(--${c}); } .fill-${c} { background: color-mix(in srgb, var(--${c}) 16%, transparent); border-color: color-mix(in srgb, var(--${c}) 45%, transparent); } .solid-${c} { background: var(--${c}); color: ${c === 'accent' ? 'var(--accent-fg)' : '#fff'}; border-color: transparent; }`).join('\n')}
.gb-mark { position: absolute; pointer-events: none; z-index: 2147483647; border: 2px solid var(--accent, #2f6fde); border-radius: 6px; transition: all 80ms ease-out; }
.gb-mark.chosen { background: color-mix(in srgb, var(--accent, #2f6fde) 10%, transparent); }
html { scrollbar-width: none; }
`

/**
 * Interactions a sketch declares with attributes, so a prototype works without a script of its own.
 * Runs in Glassbox's view and in a copy shared as its own page (Copy HTML, Save as HTML).
 */
const INTERACTIONS = `(() => {
  // Interactions a sketch declares with attributes, so a prototype works without a script of its own:
  // data-open / data-close / data-toggle (modals, drawers, dialogs, menus), data-tab in a data-tabs
  // bar, data-goto between data-screen sections, and data-toast. They use the hidden attribute (or a
  // dialog's own showModal), so they work in a bare sketch too.
  const find = (sel) => {
    if (!sel) return null
    let el = null
    try { el = document.querySelector(sel) } catch (e) { el = null }
    if (el || !/^[\\w-]+$/.test(sel)) return el
    return document.getElementById(sel) || document.querySelector('[data-modal="' + sel + '"], [data-panel="' + sel + '"], [data-dialog="' + sel + '"]')
  }
  const setShown = (el, on) => {
    if (!el) return
    if (el.tagName === 'DIALOG') { if (on && !el.open) el.showModal(); else if (!on && el.open) el.close(); return }
    el.hidden = !on
  }
  const overlays = 'dialog, .modal, .drawer, .popover, [role=dialog], [data-modal]'
  const showToast = (text) => {
    const t = document.createElement('div')
    t.className = 'gb-toast'
    t.textContent = text
    t.setAttribute('style', 'position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2000; padding: 10px 16px; border-radius: 8px; background: var(--fg, #1d2025); color: var(--bg, #fff); font: 500 13px system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.3)')
    document.body.appendChild(t)
    setTimeout(() => t.remove(), 2600)
  }
  const pickTab = (bar, btn) => {
    for (const b of bar.querySelectorAll('[data-tab]')) {
      const on = b === btn
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
      const name = b.getAttribute('data-tab')
      const panel = bar.querySelector('[data-panel="' + name + '"]') || find(name)
      if (panel) panel.hidden = !on
    }
  }
  const goTo = (id) => {
    const all = [...document.querySelectorAll('[data-screen]')]
    if (!all.some((s) => s.getAttribute('data-screen') === id)) return
    for (const s of all) s.hidden = s.getAttribute('data-screen') !== id
    scrollTo(0, 0)
  }
  const startUp = () => {
    // Hidden means hidden, even for an overlay the sketch styles as display: flex.
    const rule = document.createElement('style')
    rule.textContent = '[hidden] { display: none !important; }'
    const host = document.head || document.documentElement
    host.appendChild(rule)
    // Overlays start closed unless marked open; tab bars on their active tab; the first screen showing.
    document.querySelectorAll('.modal, .drawer, .popover').forEach((el) => { if (!el.classList.contains('open') && !el.hasAttribute('data-open-at-start')) el.hidden = true })
    document.querySelectorAll('[data-tabs]').forEach((bar) => { const first = bar.querySelector('[data-tab].active') || bar.querySelector('[data-tab]'); if (first) pickTab(bar, first) })
    const screens = [...document.querySelectorAll('[data-screen]')]
    if (screens.length) goTo((screens.find((s) => s.classList.contains('current')) || screens[0]).getAttribute('data-screen'))
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', startUp)
  else startUp()
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    // A click on a modal's backdrop (not its panel) closes it.
    if (t.matches('.modal')) { setShown(t, false); return }
    if (t.tagName === 'DIALOG') { const r = t.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { setShown(t, false); return } }
    const el = t.closest('[data-open], [data-close], [data-toggle], [data-tab], [data-goto], [data-toast]')
    if (!el) return
    if (el.tagName === 'A') e.preventDefault()
    if (el.hasAttribute('data-close')) setShown(find(el.getAttribute('data-close')) || el.closest(overlays), false)
    if (el.hasAttribute('data-open')) setShown(find(el.getAttribute('data-open')), true)
    if (el.hasAttribute('data-toggle')) { const x = find(el.getAttribute('data-toggle')); if (x) setShown(x, x.tagName === 'DIALOG' ? !x.open : x.hidden) }
    if (el.hasAttribute('data-tab')) { const bar = el.closest('[data-tabs]'); if (bar) pickTab(bar, el) }
    if (el.hasAttribute('data-goto')) goTo(el.getAttribute('data-goto'))
    if (el.hasAttribute('data-toast')) showToast(el.getAttribute('data-toast'))
  }, true)
  addEventListener('keydown', (e) => {
    // Not while words are being changed in place (Esc ends that instead).
    if (e.key !== 'Escape' || (document.activeElement && document.activeElement.isContentEditable)) return
    document.querySelectorAll(overlays).forEach((el) => { if (el.tagName === 'DIALOG' ? el.open : !el.hidden && !el.hasAttribute('data-open-at-start')) setShown(el, false) })
  })
})()`

/**
 * Inside the page: reports its size, and answers the view's taps and hovers (the view lays a
 * surface over the page for panning, so it passes clicks on). A tap on a [data-pick] picks it; in
 * comment mode, a tap pins a note to that point and says what is there. Arrows and drawings are
 * made in the view and drawn here, with the notes' numbered pins, in one SVG over the page (styled
 * inline, so a bare page draws them too; the notes are the record: the marks redraw from them).
 */
const HELPER = `(() => {
  const post = (m) => parent.postMessage(Object.assign({ glassboxSketch: true }, m), '*')
  // The content's own size (not the frame's), so the view can fit it and the frame can match it,
  // with anything that spills past the page's width (a wide diagram) included.
  const size = () => {
    const b = document.body
    if (!b) return
    let h = Math.max(b.scrollHeight, b.offsetHeight)
    const w = Math.max(b.scrollWidth, document.documentElement.scrollWidth)
    document.querySelectorAll('.gb-note, .gb-mark').forEach((e) => { const r = e.getBoundingClientRect(); if (r.height) h = Math.max(h, r.bottom + scrollY + 16) })
    post({ type: 'size', h: Math.ceil(h), w: Math.ceil(w) })
    // A screen being built: where its content area and each placed component are.
    const area = document.querySelector('[data-gb-area]')
    if (area) post({ type: 'items', area: rectOf(area), items: [...document.querySelectorAll('[data-gb-item]')].map((e) => Object.assign({ id: e.getAttribute('data-gb-item') }, rectOf(e))) })
  }
  new ResizeObserver(size).observe(document.body || document.documentElement)

  addEventListener('load', size)
  const marks = {}
  const mark = (key, el, chosen) => {
    let m = marks[key]
    if (!el) { if (m) m.style.display = 'none'; return }
    if (!m) { m = marks[key] = document.createElement('div'); m.className = 'gb-mark'; document.body.appendChild(m) }
    const r = el.getBoundingClientRect()
    m.classList.toggle('chosen', !!chosen)
    Object.assign(m.style, { display: 'block', left: (r.left + scrollX - 4) + 'px', top: (r.top + scrollY - 4) + 'px', width: (r.width + 8) + 'px', height: (r.height + 8) + 'px' })
  }
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const describe = (el) => {
    const tag = el.tagName.toLowerCase()
    const kind = el.closest('button, [role=button]') ? 'button' : /^h[1-6]$/.test(tag) ? 'heading' : tag === 'a' ? 'link' : /^(input|select|textarea)$/.test(tag) ? 'field' : tag === 'img' ? 'image' : tag === 'table' || el.closest('table') ? 'table' : ''
    const text = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || el.getAttribute('alt')).slice(0, 80)
    const pick = el.closest('[data-pick]')
    let section = ''
    for (let e = el; e && e !== document.body && !section; e = e.parentElement) {
      const h = e.querySelector && e.querySelector('h1, h2, h3')
      if (h && h !== el) section = clean(h.innerText).slice(0, 60)
    }
    return { kind, text, pick: pick ? pick.getAttribute('data-pick') : '', section }
  }
  const target = (x, y) => { const el = document.elementFromPoint(x - scrollX, y - scrollY); return el && el !== document.documentElement && el !== document.body && !el.closest('.gb-ink, .gb-notes, .gb-mark') ? el : null }
  const whatAt = (p) => { const e = p && target(p.x, p.y); return e ? describe(e) : null }
  // Where a part is in the page (child indexes from the body), so a reloaded page finds it again.
  const pathOf = (el) => { const p = []; for (let e = el; e && e !== document.body && e.parentElement; e = e.parentElement) p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); return p.join('/') }
  const byPath = (s) => { if (!s) return null; let e = document.body; for (const i of s.split('/')) { e = e && e.children[+i] } return e || null }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } }

  // The marks: each note's pin, arrow or drawing, and the one being made.
  const NS = 'http://www.w3.org/2000/svg'
  // The pen colours: the accent, and red, green and amber. Glassbox sends its own (marks are drawn
  // over the page, not part of it); the page's are only the fallback.
  const COLOUR = { accent: 'var(--accent, #2f6fde)', err: 'var(--err, #dc2626)', ok: 'var(--ok, #16a34a)', warn: 'var(--warn, #d97706)' }
  const inkOf = (n) => COLOUR[n && n.color] || COLOUR.accent
  let ink = null, boxes = null, saved = [], live = null
  const svg = (tag, attrs, parent, style) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (style) e.setAttribute('style', style); parent.appendChild(e); return e }
  const pin = (g, x, y, n, colour) => {
    svg('circle', { cx: x, cy: y, r: 11 }, g, 'fill: ' + (colour || COLOUR.accent) + '; stroke: #fff; stroke-width: 2; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35))')
    const t = svg('text', { x, y: y + 4, 'text-anchor': 'middle' }, g, 'fill: #fff; font: 600 11px system-ui, sans-serif')
    t.textContent = n
  }
  const line = (c) => 'fill: none; stroke: ' + c + '; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round'
  const draw = (n, live) => {
    const g = svg('g', {}, ink, live ? 'opacity: .85' : '')
    const c = inkOf(n)
    if (n.kind === 'comment' && n.at) pin(g, n.at.x, n.at.y, n.n || '', c)
    else if (n.kind === 'arrow' && n.from && n.to) {
      svg('line', { x1: n.from.x, y1: n.from.y, x2: n.to.x, y2: n.to.y, class: 'gb-stroke', 'marker-end': 'url(#gb-head-' + (COLOUR[n.color] ? n.color : 'accent') + ')' }, g, line(c))
      if (n.n) pin(g, n.from.x, n.from.y, n.n, c)
    } else if (n.kind === 'draw' && n.strokes && n.strokes.length && n.strokes[0].length) {
      for (const s of n.strokes) svg('path', { d: s.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' '), class: 'gb-stroke' }, g, line(c))
      if (n.n) pin(g, n.strokes[0][0][0], n.strokes[0][0][1], n.n, c)
    } else if (n.kind === 'text' && n.n) {
      const e = byPath(n.path)
      if (e) { const r = rectOf(e); pin(g, r.x - 4, r.y - 4, n.n, c) }
    }
  }
  // Text you changed shows changed: each element's own content is kept to put back.
  const orig = new Map()
  const restoreText = () => { for (const [el, html] of orig) el.innerHTML = html; orig.clear() }
  // New words for an element: in its own text, so an icon beside them (a button's svg) stays; one whose words are spread over child elements gets them as one.
  const setWords = (el, text) => { const own = [...el.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim()); const spread = [...el.children].some((c) => c.textContent.trim()); if (!own.length || spread) { el.textContent = text; return } own[0].textContent = text; own.slice(1).forEach((n) => (n.textContent = '')) }
  const retext = (path, text) => { const el = byPath(path); if (!el) return; if (!orig.has(el)) orig.set(el, el.innerHTML); setWords(el, text) }
  // The element whose own words were pointed at (a label, not the card around it).
  const wordsAt = (x, y) => {
    for (let e = target(x, y); e && e !== document.body; e = e.parentElement) {
      if ([...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return e
      if (/^(svg|img|input|select|textarea)$/i.test(e.tagName)) return null
    }
    return null
  }
  let editing = null
  const startEdit = (x, y) => {
    const el = wordsAt(x, y)
    if (!el) return post({ type: 'no-text' })
    if (!orig.has(el)) orig.set(el, el.innerHTML)
    const before = clean(el.innerText)
    editing = { el, before, path: pathOf(el) }
    el.setAttribute('contenteditable', 'plaintext-only')
    el.style.outline = '2px solid ' + COLOUR.accent
    el.style.outlineOffset = '2px'
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    mark('hover', null)
  }
  const endEdit = (keep) => {
    const ed = editing
    if (!ed) return
    editing = null
    ed.el.removeAttribute('contenteditable')
    ed.el.style.outline = ''
    ed.el.style.outlineOffset = ''
    getSelection().removeAllRanges()
    const after = clean(ed.el.innerText)
    if (!keep || !after || after === ed.before) {
      render()
      return post({ type: 'text-cancel' })
    }
    live = { kind: 'text', path: ed.path, after }
    render()
    // On a screen being built: which placed component the words are in, and where inside it.
    const item = ed.el.closest('[data-gb-item]')
    const rel = item ? ed.path.split('/').slice(pathOf(item).split('/').length).join('/') : ''
    // raw: the words with their line breaks, for a text box on a screen.
    post({ type: 'retext', path: ed.path, before: ed.before, after, raw: ed.el.innerText.replace(/\\n$/, ''), what: describe(ed.el), item: item ? item.getAttribute('data-gb-item') : null, rel })
  }
  addEventListener('keydown', (e) => {
    if (!editing) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endEdit(true) }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false) }
  }, true)
  addEventListener('focusout', () => editing && endEdit(true), true)
  const render = () => {
    if (!document.body) return
    if (!ink) {
      ink = document.createElementNS(NS, 'svg')
      ink.setAttribute('class', 'gb-ink')
      ink.setAttribute('style', 'position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; z-index: 2147483647')
      document.body.appendChild(ink)
    }
    ink.textContent = ''
    const defs = svg('defs', {}, ink)
    for (const k in COLOUR) svg('path', { d: 'M0 0 L10 5 L0 10 z' }, svg('marker', { id: 'gb-head-' + k, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto' }, defs), 'fill: ' + COLOUR[k])
    // Changed text first, so the marks land where the words now are.
    if (!editing) {
      restoreText()
      for (const n of saved) if (n.kind === 'text') retext(n.path, n.after)
      if (live && live.kind === 'text') retext(live.path, live.after)
    }
    // A picked option keeps a box round it, numbered.
    if (!boxes) { boxes = document.createElement('div'); boxes.className = 'gb-notes'; boxes.setAttribute('style', 'position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483646'); document.body.appendChild(boxes) }
    boxes.textContent = ''
    for (const n of saved) {
      if (n.kind !== 'pick') { draw(n, false); continue }
      const e = byPath(n.path)
      if (!e) continue
      const r = rectOf(e)
      const box = document.createElement('div')
      box.className = 'gb-note'
      box.setAttribute('style', 'position: absolute; border: 2px solid ' + COLOUR.accent + '; border-radius: 6px; left: ' + (r.x - 4) + 'px; top: ' + (r.y - 4) + 'px; width: ' + (r.w + 8) + 'px; height: ' + (r.h + 8) + 'px')
      boxes.appendChild(box)
      pin(ink, r.x - 4, r.y - 4, n.n)
    }
    if (live) draw(live, true)
    size()
  }
  addEventListener('message', (e) => {
    const m = e.data
    if (!m || !m.glassboxSketch) return
    if (m.pens) for (const k in COLOUR) if (typeof m.pens[k] === 'string' && /^[#\\w(),. %-]{1,60}$/.test(m.pens[k])) COLOUR[k] = m.pens[k]
    if (m.type === 'hover') {
      const el = m.x == null ? null : target(m.x, m.y)
      if (editing) return
      const show = !el ? null : m.mode === 'comment' ? el : m.mode === 'text' ? wordsAt(m.x, m.y) : m.mode === 'hand' ? el.closest('[data-pick], button, a, input, select, textarea, label, summary, [role=button], [role=tab], [onclick]') : null
      mark('hover', show)
      post({ type: 'cursor', pointer: !!show })
    } else if (m.type === 'tap') {
      if (editing) return endEdit(true)
      if (m.mode === 'text') return startEdit(m.x, m.y)
      if (m.mode === 'comment') {
        const at = { x: Math.round(m.x), y: Math.round(m.y) }
        live = { kind: 'comment', at, color: m.color }
        render()
        post({ type: 'comment', at, what: whatAt(at) })
        return
      }
      if (m.mode !== 'hand') return
      const el = target(m.x, m.y)
      if (!el) return
      const pick = el.closest('[data-pick]')
      if (pick) { mark('chosen', pick, true); post({ type: 'pick', label: pick.getAttribute('data-pick') || clean(pick.innerText).slice(0, 60), path: pathOf(pick) }); return }
      if (/^(input|select|textarea)$/i.test(el.tagName)) el.focus()
      el.click()
    } else if (m.type === 'clear') {
      if (editing) endEdit(false)
      mark('chosen', null)
      live = null
      render()
    } else if (m.type === 'place') {
      // A component on a screen moved or resized (without reloading the page).
      for (const p of m.items || []) {
        const e = document.querySelector('[data-gb-item="' + p.id + '"]')
        if (e) { Object.assign(e.style, { left: p.x + 'px', top: p.y + 'px', width: p.w ? p.w + 'px' : '', height: p.h ? p.h + 'px' : '' }); e.classList.toggle('gb-fill', !!p.h) }
      }
      size()
    } else if (m.type === 'describe') {
      // What is at these points now (a mark moved to a new spot).
      post({ type: 'described', id: m.id, whats: (m.points || []).map(whatAt) })
    } else if (m.type === 'notes') {
      saved = m.notes || []
      render()
    } else if (m.type === 'live') {
      live = m.item
      render()
    } else if (m.type === 'arrowed') {
      live = { kind: 'arrow', from: m.from, to: m.to, color: m.color }
      render()
      post({ type: 'arrow', from: m.from, to: m.to, start: whatAt(m.from), end: whatAt(m.to) })
    } else if (m.type === 'drawn') {
      // Every stroke of the drawing so far: where it is, and what's in the middle of it (a ring round a button, a line under a heading).
      const all = m.strokes.flat()
      const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
      live = { kind: 'draw', strokes: m.strokes, color: m.color }
      render()
      post({ type: 'drawing', strokes: m.strokes, rect, what: whatAt({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }) })
    }
  })
})()`

type Region = { x: number; y: number; w: number; h: number }

/** A rough sketch page drawn off screen, for pictures: its window, and what its console said while it loaded. */
async function offscreen(url: string, width: number, transparent = false): Promise<{ w: BrowserWindow; logs: string[] }> {
  const logs: string[] = []
  const w = new BrowserWindow({ show: false, width, height: 800, useContentSize: true, frame: false, ...(transparent ? { transparent: true, backgroundColor: '#00000000' } : {}), webPreferences: { sandbox: true, javascript: true, offscreen: true } })
  w.webContents.on('console-message', (e: unknown, ...rest: unknown[]) => {
    const ev = e as { message?: string; level?: string | number }
    const message = ev.message ?? String(rest[1] ?? '')
    const level = ev.level ?? rest[0]
    if (message && !/^\[glassbox\]/.test(message)) logs.push(`${typeof level === 'number' ? ['log', 'info', 'warning', 'error'][level] ?? 'log' : level}: ${message}`.slice(0, 400))
  })
  // A page that fails to load (or navigates away as it starts) mustn't leave a hidden window behind.
  try {
    await w.loadURL(url)
  } catch (e) {
    w.destroy()
    throw e
  }
  return { w, logs }
}

/** How big the page draws: its height, and its width with anything that spills past the window. */
/**
 * Room for marks past the page's edge (a drawing in the margin): the whole page shifts right and
 * down past any that are above or left of it, and a spacer reaches the furthest one, so the page
 * scrolls to all of them. True when it changed anything.
 */
const MAKE_ROOM = `(() => {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  document.querySelectorAll('.gb-ink circle, .gb-ink .gb-stroke').forEach((e) => { const x = e.getBoundingClientRect(); if (!x.width && !x.height) return; l = Math.min(l, x.left + scrollX); t = Math.min(t, x.top + scrollY); r = Math.max(r, x.right + scrollX); b = Math.max(b, x.bottom + scrollY) })
  if (l === Infinity) return false
  const de = document.documentElement
  const W = Math.max(document.body.scrollWidth, de.scrollWidth), H = Math.max(document.body.scrollHeight, de.scrollHeight)
  const L = l < 0 ? Math.ceil(-l) + 16 : 0, T = t < 0 ? Math.ceil(-t) + 16 : 0
  if (!L && !T && r <= W && b <= H) return false
  // Moved over by a margin on the page itself, which marks and the spacer are placed against.
  Object.assign(de.style, { position: 'relative', marginLeft: L + 'px', marginTop: T + 'px' })
  const s = document.createElement('div')
  s.className = 'gb-room'
  s.setAttribute('style', 'position: absolute; width: 1px; height: 1px; pointer-events: none; left: ' + Math.ceil(Math.max(r, W - L) + 16) + 'px; top: ' + Math.ceil(Math.max(b, H - T) + 16) + 'px')
  document.body.appendChild(s)
  return true
})()`

async function measure(w: BrowserWindow): Promise<{ W: number; H: number }> {
  const [W, H] = (await w.webContents.executeJavaScript(
    '[Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)]'
  )) as [number, number]
  return { W: Math.ceil(W) || 1, H: Math.ceil(H) || 1 }
}

/** Lets the page settle at its width, then sizes the window to a screenful of it (at most 4000px) for capturing. */
async function prepare(w: BrowserWindow, width: number): Promise<{ W: number; H: number }> {
  await new Promise((r) => setTimeout(r, 450))
  const first = await measure(w)
  w.setContentSize(width, Math.max(200, Math.min(4000, first.H)))
  await new Promise((r) => setTimeout(r, 300))
  return measure(w)
}

/** One capture, tried again while it comes back empty (an off-screen page that hasn't painted yet). */
async function grab(w: BrowserWindow, rect: { x: number; y: number; width: number; height: number }) {
  for (let i = 0; ; i++) {
    w.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 120 + i * 150))
    const img = await w.webContents.capturePage(rect)
    if (!img.isEmpty() || i >= 5) return img
  }
}

/**
 * A part of the page as one picture at full size, however big: scrolled into view a window at a
 * time and joined, so a diagram wider or taller than the window comes out whole.
 */
async function shoot(w: BrowserWindow, r: Region): Promise<NativeImage> {
  const [vw, vh] = w.getContentSize()
  const out = Buffer.alloc(r.w * r.h * 4)
  for (let ty = r.y; ty < r.y + r.h; ty += vh) {
    for (let tx = r.x; tx < r.x + r.w; tx += vw) {
      const tw = Math.min(vw, r.x + r.w - tx)
      const th = Math.min(vh, r.y + r.h - ty)
      // The page may not scroll all the way (its end): the part is then lower in the window.
      const [sx, sy] = (await w.webContents.executeJavaScript(`scrollTo(${tx}, ${ty}); [scrollX, scrollY]`)) as [number, number]
      let img = await grab(w, { x: Math.round(tx - sx), y: Math.round(ty - sy), width: tw, height: th })
      if (img.isEmpty()) continue
      if (img.getSize().width !== tw || img.getSize().height !== th) img = img.resize({ width: tw, height: th })
      const bmp = img.toBitmap()
      for (let row = 0; row < th; row++) bmp.copy(out, ((ty - r.y + row) * r.w + (tx - r.x)) * 4, row * tw * 4, (row + 1) * tw * 4)
    }
  }
  await w.webContents.executeJavaScript('scrollTo(0, 0)')
  return nativeImage.createFromBitmap(out, { width: r.w, height: r.h })
}

/** Keeps a region on the page and small enough to hold in memory (about 60 million pixels). */
function clampRegion(r: Region, W: number, H: number): Region {
  const x = Math.max(0, Math.min(Math.floor(r.x), W - 1))
  const y = Math.max(0, Math.min(Math.floor(r.y), H - 1))
  const w = Math.max(1, Math.min(Math.ceil(r.w), W - x))
  const h = Math.max(1, Math.min(Math.ceil(r.h), H - y, Math.floor(60_000_000 / w)))
  return { x, y, w, h }
}

/** A note's marks for drawing on a picture (see HELPER: pins, arrows, drawings and picked parts). */
export type SketchMark = Record<string, unknown> & { n: number; kind: string }

/**
 * A sketch as a PNG, drawn in code (no model): the whole page at its own width (and anything that
 * spills past it), cropped to what's drawn on it. Copied to the clipboard on the page's own
 * background (many apps paste a transparent picture as black), or saved under captures, clear
 * behind unless it carries notes' marks.
 */
export async function sketchPng(url: string, width: number, title: string, outDir: string, how: 'copy' | 'save' = 'save', marks?: SketchMark[], pens?: Record<string, string>): Promise<string> {
  const clear = how === 'save' && !marks?.length
  const { w } = await offscreen(url, width, clear)
  try {
    if (clear) await w.webContents.insertCSS('html, body { background: transparent !important; }')
    if (marks?.length) await w.webContents.executeJavaScript(`postMessage(${JSON.stringify({ glassboxSketch: true, type: 'notes', notes: marks, pens })}, '*')`)
    let { W, H } = await prepare(w, width)
    // Marks drawn in the margin past the page's edge: the page is moved over and given room so they're in the picture too.
    if (marks?.length && (await w.webContents.executeJavaScript(MAKE_ROOM))) ({ W, H } = await prepare(w, width))
    // The box around everything drawn (the body's padding and empty space left out), marks included, with a small margin.
    const box = (await w.webContents.executeJavaScript(`(() => {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
      const add = (x) => { if (!x.width && !x.height) return; l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom) }
      for (const el of document.body.children) {
        if (/^(SCRIPT|STYLE)$/.test(el.tagName) || /\\bgb-/.test(el.getAttribute('class') || '')) continue
        add(el.getBoundingClientRect())
        if (el.scrollWidth > el.clientWidth) { const x = el.getBoundingClientRect(); add({ left: x.left, top: x.top, right: x.left + el.scrollWidth, bottom: x.bottom, width: 1, height: 1 }) }
      }
      document.querySelectorAll('.gb-ink circle, .gb-ink .gb-stroke, .gb-note').forEach((e) => add(e.getBoundingClientRect()))
      return l === Infinity ? null : { x: l + scrollX, y: t + scrollY, w: r - l, h: b - t }
    })()`)) as Region | null
    const pad = 12
    const region = clampRegion(box ? { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 } : { x: 0, y: 0, w: W, h: H }, W, H)
    const image = await shoot(w, region)
    if (image.isEmpty()) throw new Error('The sketch could not be drawn. Try again.')
    if (how === 'copy') {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
      return ''
    }
    const name = `${title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'sketch'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, name)
    writeFileSync(file, image.toPNG())
    return file
  } finally {
    w.destroy()
  }
}

/** Which part of a sketch to picture: one element (a CSS selector), or an area in page pixels. */
export type SnapshotArea = { selector?: string; top?: number; left?: number; height?: number; width?: number }

/**
 * A sketch drawn off screen for Claude to look at. With no area, the whole page (and anything that
 * spills past its width) in one picture, scaled to at most 1600 by 3000px; with an area, that part
 * at full size (2400px down from `top` by default), or one element, so detail can be read.
 */
export async function sketchSnapshot(
  url: string,
  width: number,
  area?: SnapshotArea,
  clicks: string[] = []
): Promise<{ png: Buffer; width: number; height: number; region: Region; scale: number; next?: number; logs: string[]; missed: string[] }> {
  const { w, logs } = await offscreen(url, width)
  try {
    await prepare(w, width)
    // Clicked first, in order, as the user would (open a modal, go to the next screen), then pictured.
    const missed: string[] = []
    for (const sel of clicks) {
      const hit = (await w.webContents.executeJavaScript(`(() => { try { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true } catch (x) { return false } })()`)) as boolean
      if (!hit) missed.push(sel)
      await new Promise((r) => setTimeout(r, 250))
    }
    const { W, H } = clicks.length ? await prepare(w, width) : await measure(w)
    let region: Region
    let next: number | undefined
    let part = true
    if (area?.selector) {
      const r = (await w.webContents.executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(area.selector)})
        if (!e) return null
        const r = e.getBoundingClientRect()
        return { x: r.left + scrollX, y: r.top + scrollY, w: Math.max(r.width, e.scrollWidth), h: Math.max(r.height, e.scrollHeight) }
      })()`)) as Region | null
      if (!r) throw new Error(`Nothing in the sketch matches "${area.selector}".`)
      region = clampRegion({ x: r.x - 12, y: r.y - 12, w: r.w + 24, h: r.h + 24 }, W, H)
    } else if (area && (area.top !== undefined || area.left !== undefined || area.height !== undefined || area.width !== undefined)) {
      const y = area.top ?? 0
      region = clampRegion({ x: area.left ?? 0, y, w: area.width ?? W, h: area.height ?? 2400 }, W, H)
      if (region.y + region.h < H) next = region.y + region.h
    } else {
      part = false
      region = clampRegion({ x: 0, y: 0, w: W, h: Math.min(H, 16000) }, W, H)
      if (region.h < H) next = region.h
    }
    // The whole page fits in 1600px across; a part, there to be read, may take 2000px.
    const scale = Math.min(1, (part ? 2000 : 1600) / region.w, 3000 / region.h)
    let image = await shoot(w, region)
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(region.w * scale)), quality: 'good' })
    return { png: image.toPNG(), width: W, height: H, region, scale, next, logs: logs.slice(0, 40), missed }
  } finally {
    w.destroy()
  }
}
