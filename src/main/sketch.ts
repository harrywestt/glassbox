import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

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
button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border, #d0d4da); background: var(--surface, #f6f7f9); cursor: pointer; }
button.primary { background: var(--accent, #2f6fde); border-color: transparent; color: var(--accent-fg, #fff); }
input, select, textarea { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border, #d0d4da); background: var(--surface2, #fff); }
table { border-collapse: collapse; } th, td { padding: 6px 10px; border-bottom: 1px solid var(--border, #d0d4da); text-align: left; }
.row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.col { display: flex; flex-direction: column; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.muted { color: var(--muted, #6b7280); }
.small { font-size: 12px; }
.card { padding: 16px; border: 1px solid var(--border, #d0d4da); border-radius: 8px; background: var(--surface, #f6f7f9); }
.box { display: flex; align-items: center; justify-content: center; min-height: 64px; padding: 12px; border: 1.5px dashed var(--subtle, #9aa1ab); border-radius: 8px; color: var(--muted, #6b7280); font-size: 12px; text-align: center; }
.note { padding: 6px 10px; border-left: 3px solid var(--info, #3b82f6); background: color-mix(in srgb, var(--info, #3b82f6) 10%, transparent); border-radius: 0 6px 6px 0; font-size: 12.5px; }
.bad { outline: 2px solid var(--err, #dc2626); outline-offset: 3px; border-radius: 4px; }
.good { outline: 2px solid var(--ok, #16a34a); outline-offset: 3px; border-radius: 4px; }
.label { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; background: var(--elevated, #eceef1); color: var(--muted, #6b7280); }
[data-pick] { cursor: pointer; }
${COLOURS.map((c) => `.text-${c} { color: var(--${c}); } .fill-${c} { background: color-mix(in srgb, var(--${c}) 16%, transparent); border-color: color-mix(in srgb, var(--${c}) 45%, transparent); } .solid-${c} { background: var(--${c}); color: ${c === 'accent' ? 'var(--accent-fg)' : '#fff'}; border-color: transparent; }`).join('\n')}
.gb-mark { position: absolute; pointer-events: none; z-index: 2147483647; border: 2px solid var(--accent, #2f6fde); border-radius: 6px; transition: all 80ms ease-out; }
.gb-mark.chosen { background: color-mix(in srgb, var(--accent, #2f6fde) 10%, transparent); }
`

/**
 * Inside the page: reports its size, and answers the view's taps and hovers (the view lays a
 * surface over the page for panning, so it passes clicks on). A tap on a [data-pick] picks it; in
 * comment mode, a tap says what was pointed at.
 */
const HELPER = `(() => {
  const post = (m) => parent.postMessage(Object.assign({ glassboxSketch: true }, m), '*')
  // The content's own height (not the frame's), so the view can fit it and the frame can shrink to it.
  const size = () => { const b = document.body; if (b) post({ type: 'size', h: Math.ceil(Math.max(b.scrollHeight, b.offsetHeight)) }) }
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
  addEventListener('message', (e) => {
    const m = e.data
    if (!m || !m.glassboxSketch) return
    if (m.type === 'hover') {
      const el = m.x == null ? null : target(m.x, m.y)
      const show = !el ? null : m.mode === 'comment' ? el : el.closest('[data-pick], button, a, input, select, textarea, label, summary, [role=button], [role=tab], [onclick]')
      mark('hover', show)
      post({ type: 'cursor', pointer: !!show })
    } else if (m.type === 'tap') {
      const el = target(m.x, m.y)
      if (!el) return
      if (m.mode === 'comment') { mark('chosen', el, true); post({ type: 'comment', what: describe(el) }); return }
      const pick = el.closest('[data-pick]')
      if (pick) { mark('chosen', pick, true); post({ type: 'pick', label: pick.getAttribute('data-pick') || clean(pick.innerText).slice(0, 60) }); return }
      if (/^(input|select|textarea)$/i.test(el.tagName)) el.focus()
      el.click()
    } else if (m.type === 'clear') {
      mark('chosen', null)
    }
  })
})()`
