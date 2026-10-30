import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron'

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

/** Keeps a sketch's HTML and returns the address it's served at. */
export function sketchUrl(html: string): string {
  const name = `${createHash('sha1').update(html).digest('hex').slice(0, 20)}.html`
  const file = join(dir(), name)
  if (!existsSync(file)) writeFileSync(file, html, 'utf8')
  return `sketch://page/${name}`
}

/** Scripts and inline styles only; nothing from anywhere else. */
export const SKETCH_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"

const TOKEN = /^[\w#%(),. -]{1,60}$/

/** The page, with Glassbox's colours and a small kit of sketching styles, and the helper the view talks to. */
export function sketchPage(url: string): Response {
  const u = new URL(url)
  const name = u.pathname.replace(/^\/+/, '')
  if (!/^[0-9a-f]{20}\.html$/.test(name)) return new Response('Not found', { status: 404 })
  const file = join(dir(), name)
  if (!existsSync(file)) return new Response('Not found', { status: 404 })
  let theme: Record<string, string> = {}
  try {
    theme = JSON.parse(u.searchParams.get('t') ?? '{}')
  } catch {
    /* defaults */
  }
  const vars = Object.entries(theme)
    .filter(([k, v]) => /^[a-z0-9]+$/i.test(k) && typeof v === 'string' && TOKEN.test(v))
    .map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${v};`)
    .join(' ')
  const dark = theme.base === 'dark'
  const palette = (dark ? CAT_DARK : CAT_LIGHT).map((v, i) => `--cat-${i + 1}: ${v};`).join(' ')
  const head = `<meta charset="utf-8"><style>:root { color-scheme: ${dark ? 'dark' : 'light'}; ${palette} ${vars} }</style><style>${KIT}</style>`
  const html = readFileSync(file, 'utf8')
  // A full document gets the head bits inside its own head; a fragment gets a document around it.
  const page = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + head)
    : /<html[^>]*>/i.test(html)
      ? html.replace(/<html[^>]*>/i, (m) => m + `<head>${head}</head>`)
      : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
  return new Response(page + `<script>${HELPER}</script>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SKETCH_CSP, 'Cache-Control': 'no-store' }
  })
}

/** Glassbox's own chart palette (as in styles.css --cat-1…8), for a sketch's categories. */
const CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#d55181', '#c98500', '#008300', '#e66767']
const CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#e87ba4', '#eda100', '#008300', '#e34948']
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
${COLOURS.map((c) => `.text-${c} { color: var(--${c}); } .fill-${c} { background: color-mix(in srgb, var(--${c}) 16%, transparent); border-color: color-mix(in srgb, var(--${c}) 45%, transparent); } .solid-${c} { background: var(--${c}); color: ${c === 'accent' ? 'var(--accent-fg)' : '#fff'}; border-color: transparent; }`).join('\n')}
.gb-mark { position: absolute; pointer-events: none; z-index: 2147483647; border: 2px solid var(--accent, #2f6fde); border-radius: 6px; transition: all 80ms ease-out; }
.gb-mark.chosen { background: color-mix(in srgb, var(--accent, #2f6fde) 10%, transparent); }
.gb-mark.draw, .gb-note.draw { border-style: dashed; background: color-mix(in srgb, var(--accent, #2f6fde) 8%, transparent); }
html { scrollbar-width: none; }
.gb-notes { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483646; }
.gb-note { position: absolute; border: 2px solid var(--accent, #2f6fde); border-radius: 6px; }
.gb-note.move { border-style: dotted; }
.gb-pin { position: absolute; left: -11px; top: -11px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--accent, #2f6fde); color: var(--accent-fg, #fff); font: 600 11px/20px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }
[data-gb-moved] { position: relative; z-index: 2; outline: 1px dotted var(--accent, #2f6fde); outline-offset: 2px; }
`

/**
 * Inside the page: reports its size, and answers the view's taps and hovers (the view lays a
 * surface over the page for panning, so it passes clicks on). A tap on a [data-pick] picks it; in
 * comment mode, a tap says what was pointed at. In move mode a drag moves a part of the page, and
 * in draw mode it draws a box; the user's notes are drawn over the page as numbered pins, and the
 * parts they moved stay moved (the notes are the record: the page redraws from them).
 */
const HELPER = `(() => {
  const post = (m) => parent.postMessage(Object.assign({ glassboxSketch: true }, m), '*')
  // The content's own height (not the frame's), so the view can fit it and the frame can shrink to it.
  // Parts moved below it, and boxes drawn there, count too, so the frame grows to show them.
  const size = () => {
    const b = document.body
    if (!b) return
    let h = Math.max(b.scrollHeight, b.offsetHeight)
    document.querySelectorAll('[data-gb-moved], .gb-note, .gb-mark').forEach((e) => { const r = e.getBoundingClientRect(); if (r.height) h = Math.max(h, r.bottom + scrollY + 16) })
    post({ type: 'size', h: Math.ceil(h) })
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
    const text = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('alt')).slice(0, 80)
    const pick = el.closest('[data-pick]')
    let section = ''
    for (let e = el; e && e !== document.body && !section; e = e.parentElement) {
      const h = e.querySelector && e.querySelector('h1, h2, h3')
      if (h && h !== el) section = clean(h.innerText).slice(0, 60)
    }
    return { kind, text, pick: pick ? pick.getAttribute('data-pick') : '', section }
  }
  const target = (x, y) => { const el = document.elementFromPoint(x - scrollX, y - scrollY); return el && el !== document.documentElement && el !== document.body ? el : null }
  // A part to move: the nearest whole thing (a button, a card, a heading), not a run of text inside it.
  const MOVABLE = '[data-pick], button, a, input, select, textarea, img, svg, label, li, tr, table, h1, h2, h3, h4, h5, h6, p, section, article, aside, nav, header, footer, form, figure, .card, .box, .note'
  const movable = (el) => (el && el.closest(MOVABLE)) || el
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } }
  // Where a part is in the page (child indexes from the body), so a reloaded page finds it again.
  const pathOf = (el) => { const p = []; for (let e = el; e && e !== document.body && e.parentElement; e = e.parentElement) p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); return p.join('/') }
  const byPath = (s) => { if (!s) return null; let e = document.body; for (const i of s.split('/')) { e = e && e.children[+i] } return e || null }
  let layer = null
  let grabbed = null
  const showNotes = (list) => {
    document.querySelectorAll('[data-gb-moved]').forEach((e) => { e.style.translate = ''; e.removeAttribute('data-gb-moved') })
    for (const n of list) {
      const e = n.kind === 'move' && byPath(n.path)
      if (e) { e.style.translate = n.dx + 'px ' + n.dy + 'px'; e.setAttribute('data-gb-moved', '') }
    }
    if (!layer) { layer = document.createElement('div'); layer.className = 'gb-notes'; document.body.appendChild(layer) }
    layer.textContent = ''
    for (const n of list) {
      const e = n.path ? byPath(n.path) : null
      const r = e ? rectOf(e) : n.rect
      if (!r) continue
      const box = document.createElement('div')
      box.className = 'gb-note ' + n.kind
      Object.assign(box.style, { left: (r.x - 4) + 'px', top: (r.y - 4) + 'px', width: (r.w + 8) + 'px', height: (r.h + 8) + 'px' })
      const pin = document.createElement('span')
      pin.className = 'gb-pin'
      pin.textContent = n.n
      box.appendChild(pin)
      layer.appendChild(box)
    }
    size()
  }
  addEventListener('message', (e) => {
    const m = e.data
    if (!m || !m.glassboxSketch) return
    if (m.type === 'hover') {
      const el = m.x == null ? null : target(m.x, m.y)
      const show = !el ? null : m.mode === 'comment' ? el : m.mode === 'move' ? movable(el) : m.mode === 'draw' ? null : el.closest('[data-pick], button, a, input, select, textarea, label, summary, [role=button], [role=tab], [onclick]')
      mark('hover', show)
      post({ type: 'cursor', pointer: !!show })
    } else if (m.type === 'tap') {
      const el = target(m.x, m.y)
      if (!el) return
      if (m.mode === 'comment') { mark('chosen', el, true); post({ type: 'comment', what: describe(el), path: pathOf(el) }); return }
      if (m.mode === 'move' || m.mode === 'draw') return
      const pick = el.closest('[data-pick]')
      if (pick) { mark('chosen', pick, true); post({ type: 'pick', label: pick.getAttribute('data-pick') || clean(pick.innerText).slice(0, 60), path: pathOf(pick) }); return }
      if (/^(input|select|textarea)$/i.test(el.tagName)) el.focus()
      el.click()
    } else if (m.type === 'clear') {
      mark('chosen', null)
      mark('draw', null)
    } else if (m.type === 'notes') {
      showNotes(m.notes || [])
    } else if (m.type === 'grab') {
      const el = movable(target(m.x, m.y))
      if (!el) return
      const t = (el.style.translate || '').split(' ').map(parseFloat)
      grabbed = { el, dx: t[0] || 0, dy: t[1] || 0 }
      el.setAttribute('data-gb-moved', '')
    } else if (m.type === 'drag' && grabbed) {
      grabbed.el.style.translate = (grabbed.dx + m.dx) + 'px ' + (grabbed.dy + m.dy) + 'px'
      mark('hover', grabbed.el)
    } else if (m.type === 'drop' && grabbed) {
      const g = grabbed
      grabbed = null
      const dx = Math.round(g.dx + m.dx), dy = Math.round(g.dy + m.dy)
      g.el.style.translate = dx + 'px ' + dy + 'px'
      // What it now sits on or beside: whatever is under its middle, with it out of the way.
      const r = g.el.getBoundingClientRect()
      g.el.style.pointerEvents = 'none'
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      g.el.style.pointerEvents = ''
      const near = under && under !== document.body && under !== document.documentElement && !g.el.contains(under) && !(layer && layer.contains(under)) ? describe(under) : null
      mark('hover', null)
      size()
      post({ type: 'moved', what: describe(g.el), path: pathOf(g.el), dx, dy, near })
    } else if (m.type === 'drawing') {
      const r = m.rect
      let d = marks.draw
      if (!d) { d = marks.draw = document.createElement('div'); d.className = 'gb-mark draw'; document.body.appendChild(d) }
      Object.assign(d.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' })
      size()
    } else if (m.type === 'drawn') {
      const r = m.rect
      const el = target(r.x + r.w / 2, r.y + r.h / 2)
      post({ type: 'area', rect: r, what: el ? describe(el) : { kind: '', text: '', pick: '', section: '' } })
    }
  })
})()`

/**
 * A sketch as a PNG, drawn in code (no model): the page drawn off screen at its own width and full
 * height (off screen, so a tall page isn't cut to the screen's height), on a clear background, and
 * cropped to what's drawn on it. Copied to the clipboard, or saved under captures.
 */
export async function sketchPng(url: string, width: number, title: string, outDir: string, how: 'copy' | 'save' = 'save'): Promise<string> {
  const w = new BrowserWindow({ show: false, width, height: 800, useContentSize: true, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { sandbox: true, javascript: true, offscreen: true } })
  try {
    await w.loadURL(url)
    await w.webContents.insertCSS('html, body { background: transparent !important; }')
    // Its scripts settle, then the window takes the page's full height.
    await new Promise((r) => setTimeout(r, 400))
    const height = Math.min(12000, Math.ceil(Number(await w.webContents.executeJavaScript('Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'))) || 800)
    w.setContentSize(width, height)
    await new Promise((r) => setTimeout(r, 300))
    // The box around everything drawn (the body's padding and empty space left out), with a small margin.
    const box = (await w.webContents.executeJavaScript(`(() => {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
      for (const el of document.body.children) {
        if (/^(SCRIPT|STYLE)$/.test(el.tagName) || /\bgb-/.test(el.className)) continue
        const x = el.getBoundingClientRect()
        if (!x.width || !x.height) continue
        l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom)
      }
      return l === Infinity ? null : { x: l + scrollX, y: t + scrollY, w: r - l, h: b - t }
    })()`)) as { x: number; y: number; w: number; h: number } | null
    const pad = 8
    const rect = box
      ? { x: Math.max(0, Math.floor(box.x - pad)), y: Math.max(0, Math.floor(box.y - pad)), width: Math.min(width, Math.ceil(box.w + pad * 2)), height: Math.min(height, Math.ceil(box.h + pad * 2)) }
      : { x: 0, y: 0, width, height }
    w.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 120))
    const image = await w.webContents.capturePage(rect)
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
