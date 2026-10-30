import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { logsText, newProblems } from './browserLogs'
import { markRecording, type RecordCue, type RecordOptions } from './recorder'
import { z } from 'zod'

/**
 * Claude's browser: the tabs in Glassbox's Browser view, driven directly (the user watches, and the
 * tabs share the user's saved sign-ins). Built to spend few tokens: a page is read as a short text
 * outline with numbered controls ("[12] button "Save""), narrowed with `find`; scripts pull out
 * exactly what's needed; a screenshot only when looking is the point.
 */

export type BrowserBridge = {
  /** Open a URL in a new tab (or the current one); resolves once the page is attached. */
  open(url: string, newTab: boolean): Promise<{ tab: string; wcId: number }>
  tabs(): Promise<{ tab: string; url: string; title?: string; wcId?: number; active: boolean }[]>
  /** Show a tab at this width (0: the full view); resolves once it's laid out. */
  resize(tab: string, width: number): Promise<void>
  /** Close these tabs, or (others) every tab but the one showing; resolves with how many are left. */
  close(ids: string[], others: boolean): Promise<{ closed: number; left: number }>
}

type WC = Electron.WebContents

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ ...ok(text), isError: true })

/** Thrown when a page doesn't answer in time. */
class TimedOut extends Error {}

/**
 * Every call into a page has its own short time limit: a stalled or hidden page, or a script that
 * waits for something that never happens, used to hold Claude until the 15-minute connector timeout.
 */
function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimedOut(`The page didn't answer within ${Math.round(ms / 1000)}s, so Glassbox stopped waiting. It may be stalled or still loading: check it with browser_snapshot or browser_screenshot, or reload it with browser_open, rather than retrying the same thing.`)), ms)))]).finally(() => clearTimeout(timer))
}
const PAGE_MS = 20_000
const slow = (what: string, ms: number) =>
  fail(`${what} didn't answer within ${Math.round(ms / 1000)}s, so Glassbox stopped waiting. The page may be stalled, still loading, or waiting on something. Don't retry the same thing: check the page with browser_snapshot or browser_screenshot, reload it with browser_open, or take another approach.`)

async function contents(bridge: BrowserBridge, tab?: string): Promise<{ wc: WC; tab: string } | string> {
  const { webContents } = await import('electron')
  // A tab just opened gets a few seconds to attach its page before Glassbox says why it can't use it.
  const until = Date.now() + 8000
  for (;;) {
    const list = await bridge.tabs()
    if (!list.length) return 'No browser tabs are open. Use browser_open first.'
    const t = tab ? list.find((x) => x.tab === tab) : (list.find((x) => x.active) ?? list[0])
    if (!t) return `No tab "${tab}". Open tabs: ${list.map((x) => `${x.tab} (${x.title ?? x.url})`).join(', ')}`
    const wc = t.wcId !== undefined ? webContents.fromId(t.wcId) : undefined
    if (wc && !wc.isDestroyed()) return { wc, tab: t.tab }
    if (Date.now() > until)
      return `Tab ${t.tab} has no page attached after 8s (it was opening ${t.url}${t.title ? `, "${t.title}"` : ''}). Its page never started: close it with browser_close and open the address again with browser_open; if that fails too, check the address answers (a sign-in redirect or a server that isn't up shows here as a page that never loads).`
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Opens an address: in a new tab, or by loading it into `tab` (the active one when unset) directly, so
 * it navigates even when the tab's page has moved on by clicks or scripts since Glassbox last sent it there.
 */
async function openTo(bridge: BrowserBridge, url: string, newTab: boolean, tab?: string): Promise<{ wc: WC; tab: string }> {
  if (!newTab && (await bridge.tabs()).length) {
    const c = await contents(bridge, tab)
    if (typeof c === 'string') throw new Error(c)
    // A redirect or a page that stops the load early rejects; the outcome shows in the page itself.
    await c.wc.loadURL(url).catch(() => {})
    return c
  }
  const opened = await bridge.open(url, newTab)
  const c = await contents(bridge, opened.tab)
  if (typeof c === 'string') throw new Error(c)
  return c
}

/** Waits for the page to settle: loading done, then a short quiet spell for scripts to render. */
async function settle(wc: WC, ms = 12000) {
  const start = Date.now()
  while (wc.isLoading() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 150))
  await new Promise((r) => setTimeout(r, 400))
}

/** The page as a compact outline: headings, text, and every visible control numbered for click/type. */
export const SNAPSHOT = (find: string, limit: number) => `(() => {
  const find = ${JSON.stringify(find.toLowerCase())}.split(/\\s+/).filter(Boolean)
  const limit = ${limit}
  document.querySelectorAll('[data-gb]').forEach((e) => e.removeAttribute('data-gb'))
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' }
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim()
  const nameOf = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '').slice(0, 80)
  const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[contenteditable=true]'
  const lines = []
  let n = 0
  const walk = (root) => {
    for (const el of root.children) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(el.tagName)) continue
      if (el.matches(CONTROL)) {
        if (!shown(el)) continue
        const id = ++n
        el.setAttribute('data-gb', String(id))
        const tag = el.tagName.toLowerCase()
        const kind = el.getAttribute('role') || (tag === 'input' ? 'input:' + (el.type || 'text') : tag === 'a' ? 'link' : tag)
        let extra = ''
        if (tag === 'input' || tag === 'textarea') extra += el.type === 'password' ? ' (filled: ' + (el.value ? 'yes' : 'no') + ')' : el.value ? ' = "' + clean(el.value).slice(0, 60) + '"' : ''
        if (tag === 'select') extra += ' = "' + clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text) + '"'
        if (el.checked) extra += ' checked'
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') extra += ' disabled'
        if (el.getAttribute('aria-expanded')) extra += ' expanded=' + el.getAttribute('aria-expanded')
        lines.push('[' + id + '] ' + kind + ' "' + nameOf(el) + '"' + extra)
        continue
      }
      if (/^H[1-6]$/.test(el.tagName)) { if (shown(el)) lines.push('#'.repeat(+el.tagName[1]) + ' ' + clean(el.innerText).slice(0, 120)); continue }
      // A block with no controls or headings inside is one line of text (however it's split into
      // spans); otherwise its own text is kept and its children are read in turn.
      if (!el.querySelector(CONTROL + ',h1,h2,h3,h4,h5,h6')) {
        const t = clean(el.innerText)
        if (t.length > 1 && shown(el)) lines.push('  ' + (t.length > 300 ? t.slice(0, 300) + '…' : t))
        continue
      }
      // Text the element holds itself (not its children's), when it's visible.
      let own = ''
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.textContent
      own = clean(own)
      if (own.length > 1 && shown(el)) lines.push('  ' + own.slice(0, 200))
      walk(el)
    }
  }
  if (document.body) walk(document.body)
  const dialogs = [...document.querySelectorAll('[role=dialog],dialog[open]')].filter(shown).length
  let out = lines
  if (find.length) out = lines.filter((l) => l.startsWith('#') || find.some((w) => l.toLowerCase().includes(w)))
  let text = ''
  let used = 0
  for (const l of out) { if (text.length + l.length > limit) break; text += l + '\\n'; used++ }
  const rest = out.length - used
  return 'Title: ' + document.title + '\\nURL: ' + location.href + (dialogs ? '\\nA dialog is open.' : '') + '\\n\\n' + text + (rest > 0 ? '(' + rest + ' more lines not shown. Pass find to narrow, or a larger limit.)' : '')
})()`

/** Where a numbered control is on screen (scrolled into view first), for a real click. */
const LOCATE = (ref: number) => `(() => {
  const el = document.querySelector('[data-gb="${ref}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight, name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 60) }
})()`

/** How a step finds a control: by its number from the latest snapshot, or by something that stays valid between pages. */
export type Locator = { ref?: number; selector?: string; role?: string; name?: string; contains?: string }
const describe = (l: Locator) => (l.ref ? `[${l.ref}]` : l.selector ? `"${l.selector}"` : l.role ? `${l.role} "${l.name ?? ''}"` : `"${l.contains ?? ''}"`)

/** Finds a control (number, CSS selector, role and accessible name, or visible text), marks it, scrolls it into view and says where it is. */
const FIND = (l: Locator) => `(() => {
  const L = ${JSON.stringify(l)}
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' }
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const nameOf = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
  const ROLE = { button: 'button,[role=button],input[type=submit],input[type=button]', link: 'a[href],[role=link]', textbox: 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]),textarea,[contenteditable=true],[role=textbox]', checkbox: 'input[type=checkbox],[role=checkbox]', radio: 'input[type=radio],[role=radio]', tab: '[role=tab]', menuitem: '[role=menuitem]', option: '[role=option],option', combobox: 'select,[role=combobox]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]', switch: '[role=switch]' }
  let el = null
  if (L.ref) el = document.querySelector('[data-gb="' + L.ref + '"]')
  else if (L.selector) el = [...document.querySelectorAll(L.selector)].find(shown) || null
  else if (L.role) {
    const want = norm(L.name)
    const all = [...document.querySelectorAll(ROLE[L.role] || '[role="' + L.role + '"]')].filter(shown)
    el = all.find((e) => nameOf(e) === want) || all.find((e) => nameOf(e).includes(want)) || null
  } else if (L.contains) {
    const want = norm(L.contains)
    const all = [...document.querySelectorAll('button,a,[role],label,summary,span,div,p,li,td,th,h1,h2,h3,h4,h5,h6')].filter((e) => shown(e) && nameOf(e).includes(want))
    el = all.sort((a, b) => nameOf(a).length - nameOf(b).length)[0] || null
  }
  if (!el) return null
  document.querySelectorAll('[data-gb-target]').forEach((e) => e.removeAttribute('data-gb-target'))
  el.setAttribute('data-gb-target', '1')
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight, name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60) }
})()`

/** Clicks a control like a person would (a real mouse click at its middle). */
/** Finds a control, giving the page up to `ms` for it to appear (after a navigation it may still be loading). */
async function findSoon(wc: WC, l: Locator, ms = 5000): Promise<{ x: number; y: number; vw: number; vh: number; name: string } | null> {
  const until = Date.now() + ms
  for (;;) {
    const at = (await inTime(wc.executeJavaScript(FIND(l)), PAGE_MS).catch(() => null)) as { x: number; y: number; vw: number; vh: number; name: string } | null
    if (at || Date.now() > until) return at
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function clickAt(wc: WC, l: Locator): Promise<string> {
  const at = await findSoon(wc, l)
  if (!at) throw new Error(`No control ${describe(l)} on the page now.${l.ref ? ' Take a new browser_snapshot.' : ''}`)
  await new Promise((r) => setTimeout(r, 120))
  markRecording(wc.id, { label: at.name ? `Click “${at.name}”` : 'Click', fx: at.x / Math.max(1, at.vw), fy: at.y / Math.max(1, at.vh) })
  wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await settle(wc, 8000)
  return `Clicked ${describe(l)} "${at.name}".`
}

/** Types into a control (replacing what's there unless append), optionally pressing Enter after. */
async function typeInto(wc: WC, l: Locator, text: string, submit?: boolean, append?: boolean): Promise<string> {
  const at = await findSoon(wc, l)
  if (!at) throw new Error(`No control ${describe(l)} on the page now.${l.ref ? ' Take a new browser_snapshot.' : ''}`)
  await inTime(wc.executeJavaScript(`(() => { const el = document.querySelector('[data-gb-target]'); el.focus(); ${append ? '' : "if ('select' in el) el.select(); else document.execCommand('selectAll')"} })()`), PAGE_MS)
  if (!append) press(wc, 'Backspace')
  markRecording(wc.id, { label: `Type “${text.length > 40 ? text.slice(0, 40) + '…' : text}”${submit ? ' ↵' : ''}` })
  await wc.insertText(text)
  if (submit) {
    press(wc, 'Enter')
    await settle(wc, 8000)
  }
  return `Typed into ${describe(l)}${submit ? ' and pressed Enter' : ''}.`
}

/** What a wait can wait for; checked by Glassbox every half second, each check a quick look at the page. */
export type WaitFor = { text?: string; gone?: string; until?: string; stable?: number; seconds?: number; /** A control to appear (selector, role and name, or text it shows). */ el?: Locator }
async function waitFor(wc: WC, w: WaitFor): Promise<{ ok: boolean; what: string; took: number }> {
  const start = Date.now()
  const el = w.el && (w.el.selector || w.el.role || w.el.contains || w.el.ref) ? w.el : undefined
  const any = !!(w.text || w.gone || w.until || w.stable || el)
  const limit = Math.min(600, w.seconds ?? (any ? 60 : 2)) * 1000
  const cond = w.until ? (/\breturn\b/.test(w.until) ? `(async () => { ${w.until} })()` : `(async () => (${w.until}))()`) : null
  let last = ''
  let quietSince = Date.now()
  const what = [el && `${describe(el)} is there`, w.text && `"${w.text}" appears`, w.gone && `"${w.gone}" is gone`, w.until && 'the condition holds', w.stable && `the page stops changing for ${w.stable}s`].filter(Boolean).join(' and ') || 'a moment'
  while (Date.now() - start < limit) {
    const probe = (await inTime(
      wc.executeJavaScript(`(async () => { const t = document.body ? document.body.innerText : ''; return { t: t.length + ':' + t.slice(-400), has: ${JSON.stringify(w.text ?? '')} ? t.includes(${JSON.stringify(w.text ?? '')}) : true, gone: ${JSON.stringify(w.gone ?? '')} ? !(t.includes(${JSON.stringify(w.gone ?? '')}) || !!document.querySelector(${JSON.stringify(/^[.#\[]/.test(w.gone ?? '') ? w.gone : 'gb-none')})) : true, cond: ${cond ? `!!(await ${cond})` : 'true'} } })()`),
      PAGE_MS
    ).catch(() => null)) as { t: string; has: boolean; gone: boolean; cond: boolean } | null
    if (probe) {
      if (probe.t !== last) (last = probe.t), (quietSince = Date.now())
      const quiet = !w.stable || Date.now() - quietSince >= w.stable * 1000
      const found = !el || !!(await inTime(wc.executeJavaScript(FIND(el)), PAGE_MS).catch(() => null))
      if (probe.has && probe.gone && probe.cond && quiet && found && any) return { ok: true, what, took: Date.now() - start }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: !any, what, took: Date.now() - start }
}

/** One step of browser_steps. */
type Step = Locator & { do: 'open' | 'click' | 'type' | 'press' | 'wait' | 'read' | 'screenshot' | 'eval'; url?: string; new_tab?: boolean; value?: string; submit?: boolean; append?: boolean; key?: string; find?: string; limit?: number; code?: string; label?: string } & WaitFor

/** Background runs of browser_steps, by id: where they are and what each step gave. */
const jobs = new Map<string, { total: number; done: number; failed: number; lines: string[]; status: 'running' | 'done' | 'failed'; started: number; ended?: number; record?: string }>()
let jobSeq = 0

/** A numbered control's box on screen (scrolled into view first), for a recording's highlight. */
const BOX = (ref: number) => `(() => {
  const el = document.querySelector('[data-gb="${ref}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
})()`

const KEYS: Record<string, string> = { enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'Space', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' }

function press(wc: WC, key: string) {
  const code = KEYS[key.toLowerCase()] ?? key
  wc.sendInputEvent({ type: 'keyDown', keyCode: code })
  // The character too: without it Enter doesn't submit a form, nor Space press a button, in a page that isn't focused.
  const char = code.length === 1 ? code : code === 'Enter' ? '\r' : code === 'Space' ? ' ' : null
  if (char) wc.sendInputEvent({ type: 'char', keyCode: char })
  wc.sendInputEvent({ type: 'keyUp', keyCode: code })
}

/** Where the tab is now, and any errors the page reported since Claude last heard (so it notices a 500 behind a spinner). */
const where = (wc: WC) => `Now on "${wc.getTitle()}" (${wc.getURL()}).${newProblems(wc.id)}`

/**
 * A picture of a tab: what shows, or the whole page top to bottom. A page that sets no background
 * is see-through, which a JPEG turns black, so it gets the white a browser would.
 */
export async function captureTab(wc: WC, fullPage = false): Promise<Electron.NativeImage> {
  const white = await wc.insertCSS('html { background-color: #fff }', { cssOrigin: 'user' }).catch(() => null)
  try {
    if (fullPage) {
      const whole = await stitchPage(wc).catch(() => null)
      if (whole) return whole
    }
    return await inTime(wc.capturePage(), PAGE_MS)
  } finally {
    if (white) void wc.removeInsertedCSS(white).catch(() => {})
  }
}

/**
 * The whole page, top to bottom: scrolled a screenful at a time, each captured as it shows, and
 * stitched into one picture. (The page's own full-page screenshot command stalls in an embedded
 * page.) Fixed and sticky parts, like a header, appear once at the top rather than on every slice.
 * Pages taller than 12,000px stop there; the scroll position is put back afterwards.
 */
async function stitchPage(wc: WC): Promise<Electron.NativeImage | null> {
  const { nativeImage } = await import('electron')
  // Scrollbars would be drawn into every slice.
  const bars = await wc.insertCSS('::-webkit-scrollbar { display: none !important } html { scrollbar-width: none !important }', { cssOrigin: 'user' }).catch(() => null)
  try {
    return await stitchSlices(wc, nativeImage)
  } finally {
    if (bars) void wc.removeInsertedCSS(bars).catch(() => {})
  }
}

async function stitchSlices(wc: WC, nativeImage: typeof Electron.nativeImage): Promise<Electron.NativeImage | null> {
  const m = (await inTime(wc.executeJavaScript('({ h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), vh: innerHeight, y: scrollY, x: scrollX })'), PAGE_MS)) as { h: number; vh: number; y: number; x: number }
  if (!m.vh || m.h <= m.vh + 2) return null
  const total = Math.min(m.h, 12_000)
  const slices: { img: Electron.NativeImage; at: number }[] = []
  try {
    for (let want = 0; want < total; want += m.vh) {
      const at = (await wc.executeJavaScript(`new Promise((r) => { scrollTo(0, ${want}); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(scrollY), 60))) })`)) as number
      slices.push({ img: await inTime(wc.capturePage(), PAGE_MS), at })
      // After the first screenful, fixed and sticky parts (a header, a cookie bar) are hidden so they don't repeat.
      if (slices.length === 1)
        await wc.executeJavaScript(`for (const el of document.querySelectorAll('body *')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') { el.dataset.gbHid = el.style.visibility; el.style.visibility = 'hidden' } }`)
      if (at + m.vh >= total) break
    }
  } finally {
    await wc.executeJavaScript(`for (const el of document.querySelectorAll('[data-gb-hid]')) { el.style.visibility = el.dataset.gbHid; delete el.dataset.gbHid } scrollTo(${m.x}, ${m.y})`).catch(() => {})
  }
  const first = slices[0].img.getSize()
  const scale = first.height / m.vh
  const width = first.width
  const height = Math.round(Math.min(total, slices.at(-1)!.at + m.vh) * scale)
  const out = Buffer.alloc(width * height * 4)
  let filled = 0
  for (const s of slices) {
    const top = Math.round(s.at * scale)
    const bmp = s.img.toBitmap()
    const size = s.img.getSize()
    // Only the rows this slice adds below what's already there.
    for (let row = Math.max(0, filled - top); row < size.height && top + row < height; row++) {
      const src = row * size.width * 4
      bmp.copy(out, (top + row) * width * 4, src, src + Math.min(size.width, width) * 4)
    }
    filled = Math.max(filled, Math.min(height, top + size.height))
  }
  return nativeImage.createFromBitmap(out, { width, height })
}

/** What else the browser tools hand on: each screenshot (for the UX reviewer), and video recording. */
export type BrowserHooks = {
  shot?: (s: { path: string; url: string; title: string; review: boolean; note?: string }) => void
  record?: { start: (wcId: number, opts?: RecordOptions) => { started: number }; stop: (wcId: number) => Promise<string | null>; cue: (wcId: number, cue: RecordCue) => boolean }
}

export function browserTools(bridge: BrowserBridge, shotsDir: string, hooks: BrowserHooks = {}) {
  const TAB = z.string().optional().describe('Browser tab id (from browser_open or browser_tabs); defaults to the tab showing')
  const LOCATOR = {
    ref: z.number().int().positive().optional().describe('Its number from the latest browser_snapshot'),
    selector: z.string().optional().describe('Or a CSS selector'),
    role: z.string().optional().describe('Or its role: button, link, textbox, checkbox, radio, tab, menuitem, option, combobox, heading, switch'),
    name: z.string().optional().describe('With role: its accessible name or label (exact, else contains)'),
    contains: z.string().optional().describe('Or text it shows (the smallest element containing it)')
  }
  const WAIT = {
    text: z.string().optional().describe('Wait until this text is on the page'),
    gone: z.string().optional().describe('Wait until this text (or a CSS selector starting with . # or [) is gone, e.g. a spinner'),
    until: z.string().optional().describe('Wait until this JavaScript is true, e.g. document.querySelectorAll(".msg").length >= 4 (a short check, run every half second)'),
    stable: z.number().positive().max(120).optional().describe('Wait until the page text has stopped changing for this many seconds, e.g. a streamed answer finishing'),
    seconds: z.number().positive().max(600).optional().describe('Give up after this many seconds (default 60, at most 600)')
  }

  /** Runs browser_steps: each step in turn, a short line each, written to the record folder as it goes. */
  const runSteps = async (steps: Step[], tab: string | undefined, record: string | undefined, onLine: (line: string, ok: boolean) => void, stopOnError: boolean) => {
    let current = tab
    if (record) mkdirSync(record, { recursive: true })
    let failed = false
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const n = i + 1
      const started = Date.now()
      let line: string
      let ok = true
      let shot: string | undefined
      try {
        if (s.do === 'open') {
          const c = await openTo(bridge, s.url ?? 'about:blank', s.new_tab === true, current)
          current = c.tab
          await new Promise((r) => setTimeout(r, 350))
          await settle(c.wc)
          line = `opened ${c.wc.getURL()} (tab ${current})`
        } else {
          const c = await contents(bridge, current)
          if (typeof c === 'string') throw new Error(c)
          if (s.do === 'click') line = await clickAt(c.wc, s)
          else if (s.do === 'type') line = await typeInto(c.wc, s, s.value ?? '', s.submit, s.append)
          else if (s.do === 'press') {
            press(c.wc, s.key ?? 'Enter')
            await settle(c.wc, 4000)
            line = `pressed ${s.key ?? 'Enter'}`
          } else if (s.do === 'wait') {
            const w = await waitFor(c.wc, { ...s, el: { ref: s.ref, selector: s.selector, role: s.role, name: s.name, contains: s.contains } })
            ok = w.ok
            line = `${w.ok ? 'waited for' : 'gave up waiting for'} ${w.what} (${(w.took / 1000).toFixed(1)}s)`
          } else if (s.do === 'read') {
            line = String(await inTime(c.wc.executeJavaScript(SNAPSHOT(s.find ?? '', s.limit ?? 1500)), PAGE_MS))
          } else if (s.do === 'eval') {
            const v = await inTime(c.wc.executeJavaScript(`(async () => { ${s.code ?? ''} })().then((v) => { try { return JSON.stringify(v) } catch { return String(v) } })`), 30_000)
            line = String(v).slice(0, 4000)
          } else {
            const img = await captureTab(c.wc)
            const dir = record ?? shotsDir
            mkdirSync(dir, { recursive: true })
            shot = join(dir, `step-${String(n).padStart(3, '0')}${s.label ? '-' + s.label.replace(/[^\w-]+/g, '-').slice(0, 40) : ''}.png`)
            writeFileSync(shot, img.toPNG())
            line = `screenshot ${shot}`
          }
        }
      } catch (e) {
        ok = false
        line = e instanceof Error ? e.message : String(e)
      }
      const text = `${n}. ${s.do}${s.label ? ` (${s.label})` : ''}: ${ok ? '' : 'FAILED '}${line}`
      onLine(text, ok)
      if (record) {
        const c = await contents(bridge, current).catch(() => null)
        const url = c && typeof c !== 'string' ? c.wc.getURL() : undefined
        appendFileSync(join(record, 'steps.jsonl'), JSON.stringify({ n, do: s.do, label: s.label, ok, result: line, url, screenshot: shot, ms: Date.now() - started, at: new Date().toISOString() }) + '\n')
      }
      if (!ok) failed = true
      if (!ok && stopOnError) break
    }
    return failed
  }

  return [
    tool(
      'browser_open',
      "Open a web page in the Glassbox Browser (the user sees it; sign-ins they've made there are kept). Returns the page as a short text outline with numbered controls. Use this, never an external browser, Playwright or curl, to look at or try a web page.",
      {
        url: z.string().describe('The address, e.g. http://localhost:5173/login'),
        new_tab: z.boolean().optional().describe('Open in a new tab instead of the current one (default: reuse the current tab). Only when you need two pages side by side'),
        find: z.string().optional().describe('Only show outline lines containing these words (plus headings)')
      },
      async ({ url, new_tab, find }) => {
        try {
          const { wc, tab } = await openTo(bridge, url, new_tab === true)
          await new Promise((r) => setTimeout(r, 350))
          await settle(wc)
          return ok(`Tab ${tab}.\n${await inTime(wc.executeJavaScript(SNAPSHOT(find ?? '', 4000)), PAGE_MS)}`)
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      }
    ),
    tool(
      'browser_snapshot',
      'Read the page in a Browser tab as a short text outline: headings, visible text and every control numbered ([12] button "Save"), for browser_click and browser_type. Far cheaper than a screenshot; narrow it with find.',
      { tab: TAB, find: z.string().optional().describe('Only lines containing these words (plus headings)'), limit: z.number().int().positive().max(20000).optional().describe('Characters to return (default 4000)') },
      async ({ tab, find, limit }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        await settle(c.wc, 3000)
        return ok((await inTime(c.wc.executeJavaScript(SNAPSHOT(find ?? '', limit ?? 4000)), PAGE_MS)) + newProblems(c.wc.id))
      }
    ),
    tool(
      'browser_click',
      'Click a control (a real mouse click at its position): by its number from the latest browser_snapshot, or by something that stays valid without a fresh snapshot: role and name (role "button", name "Details"), text it shows (contains), or a CSS selector. Returns where the page is afterwards.',
      { ...LOCATOR, tab: TAB },
      async ({ ref, selector, role, name, contains, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        try {
          return ok(`${await clickAt(c.wc, { ref, selector, role, name, contains })} ${where(c.wc)}`)
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      }
    ),
    tool(
      'browser_type',
      'Type into an input (replacing what is there unless append is set), found by its number from the latest browser_snapshot or by role and name, the text it shows (contains) or a CSS selector. Optionally press Enter after.',
      { ...LOCATOR, text: z.string().describe('What to type'), submit: z.boolean().optional().describe('Press Enter afterwards'), append: z.boolean().optional(), tab: TAB },
      async ({ ref, selector, role, name, contains, text, submit, append, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        try {
          return ok(`${await typeInto(c.wc, { ref, selector, role, name, contains }, text, submit, append)} ${where(c.wc)}`)
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      }
    ),
    tool(
      'browser_press',
      'Press a key in a Browser tab: Enter, Escape, Tab, arrows, PageDown, or a single character.',
      { key: z.string(), tab: TAB },
      async ({ key, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        markRecording(c.wc.id, { label: `Press ${key}` })
        press(c.wc, key)
        await settle(c.wc, 4000)
        return ok(`Pressed ${key}. ${where(c.wc)}`)
      }
    ),
    tool(
      'browser_eval',
      "Run JavaScript in the page and get back its result as JSON (the body of an async function: use return). The most efficient way to pull out exactly what you need (a table's rows, an element's state, console-free checks) or to do several steps at once. Keep each call to one page and a few seconds: it gives up after timeout_seconds (default 30). Never loop through page navigations with sleeps in one script; open each page with browser_open and check it with its own call.",
      {
        code: z.string().describe('e.g. return [...document.querySelectorAll("tr")].map(r => r.innerText)'),
        tab: TAB,
        timeout_seconds: z.number().min(1).max(120).optional().describe('How long to wait for the script (default 30, at most 120)')
      },
      async ({ code, tab, timeout_seconds }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const ms = (timeout_seconds ?? 30) * 1000
        try {
          const value = await inTime(c.wc.executeJavaScript(`(async () => { ${code} })().then((v) => { try { return JSON.stringify(v) } catch { return String(v) } })`), ms)
          const text = value === undefined ? 'undefined' : String(value)
          return ok(text.length > 12000 ? `${text.slice(0, 12000)}\n(cut at 12000 characters)` : text)
        } catch (e) {
          if (e instanceof TimedOut) return slow('The script', ms)
          return fail(`The script failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    ),
    tool(
      'browser_screenshot',
      'A picture of what a Browser tab shows (or the whole page, top to bottom, with full_page). Use it when the look matters (layout, styling, a chart) and as evidence; for content and controls, browser_snapshot is far cheaper. With review, the screenshot also goes to the UX reviewer, a separate agent that checks it for bad UX, inconsistencies and AI slop in the background (its findings arrive on their own; carry on meanwhile).',
      {
        tab: TAB,
        full_page: z.boolean().optional().describe('The whole page, not just what fits in the window'),
        review: z.boolean().optional().describe('Also send it to the UX reviewer'),
        note: z.string().optional().describe('For the reviewer: what this screen is or what state it shows, e.g. "checkout, card declined"')
      },
      async ({ tab, full_page, review, note }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        await settle(c.wc, 4000)
        let img: Electron.NativeImage
        try {
          img = await captureTab(c.wc, full_page)
        } catch (e) {
          return e instanceof TimedOut ? slow('The screenshot', PAGE_MS) : fail(`Couldn't take the screenshot: ${e instanceof Error ? e.message : String(e)}`)
        }
        mkdirSync(shotsDir, { recursive: true })
        const file = join(shotsDir, `shot-${Date.now()}.jpg`)
        // The saved copy at full detail (the reviewer and the report use it); Claude gets a smaller one.
        const saved = img.getSize().width > 1600 ? img.resize({ width: 1600 }) : img
        writeFileSync(file, saved.toJPEG(85))
        const size = img.getSize()
        const forClaude = size.height > size.width * 2.5 ? img.resize({ width: Math.min(size.width, 900) }) : size.width > 1400 ? img.resize({ width: 1400 }) : img
        const jpeg = forClaude.toJPEG(72)
        hooks.shot?.({ path: file, url: c.wc.getURL(), title: c.wc.getTitle(), review: !!review, note })
        return { content: [{ type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text' as const, text: `Saved to ${file}. ${where(c.wc)}` }] }
      }
    ),
    tool(
      'browser_record',
      "Record a video of a Browser tab, made to be watched: start before a flow, stop after; stopping saves a WebM and gives its path (present_file it). Clicks show a pointer and ripple, typing and keys show captions, and still moments are cut. While recording you can add a caption (narration on screen), a title card (a chapter, e.g. each test case), a highlight around a numbered control (ref from browser_snapshot) to point something out, or pause and resume to leave set-up out. Use it when the user wants a video (a bug reproduction, a walkthrough, evidence), not routinely. Stops by itself after 10 minutes.",
      {
        action: z.enum(['start', 'stop', 'caption', 'title', 'highlight', 'pause', 'resume']),
        tab: TAB,
        text: z.string().max(140).optional().describe('caption: what to say on screen. title: the card\'s title. start: an opening title card. stop: a closing card'),
        subtitle: z.string().max(140).optional().describe('title (or start/stop with text): a smaller line under the title'),
        ref: z.number().int().positive().optional().describe('highlight: the numbered control to point out'),
        seconds: z.number().positive().max(15).optional().describe('caption, title, highlight: how long it shows (default 3, title 2.5)'),
        size: z.enum(['page', '720p', '1080p']).optional().describe("start: the video's frame (default page: the tab's own shape; 720p/1080p letterbox it for sharing)"),
        fps: z.union([z.literal(12), z.literal(24), z.literal(30)]).optional().describe('start: frames per second (default 12; 24 or 30 for smoother scrolling and animation)'),
        show_actions: z.boolean().optional().describe('start: show the pointer, click ripples and action captions (default true)'),
        keep_still: z.boolean().optional().describe('start: keep moments where nothing changes (default false: cut them)')
      },
      async ({ action, tab, text, subtitle, ref, seconds, size, fps, show_actions, keep_still }) => {
        if (!hooks.record) return fail('Recording is not available here.')
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const rec = hooks.record
        const notRunning = () => fail('No recording is running in that tab. Start one with action start.')
        try {
          if (action === 'start') {
            rec.start(c.wc.id, { size, fps, title: text, subtitle, showActions: show_actions, cursor: show_actions, keepStill: keep_still })
            return ok(`Recording ${where(c.wc)} Call browser_record with action stop when you're done.`)
          }
          if (action === 'stop') {
            // A closing card first, held for a moment so it's in the video.
            if (text && rec.cue(c.wc.id, { type: 'title', text, subtitle, seconds: seconds ?? 2.5 })) await new Promise((r) => setTimeout(r, (seconds ?? 2.5) * 1000 + 200))
            const path = await rec.stop(c.wc.id)
            return path ? ok(`Saved the recording to ${path}. Use present_file to show it.`) : fail('Nothing was recorded (no recording was running in that tab, or the page showed nothing).')
          }
          if (action === 'pause' || action === 'resume') return rec.cue(c.wc.id, { type: action }) ? ok(action === 'pause' ? 'Paused: nothing is recorded until you resume.' : 'Recording again.') : notRunning()
          if (action === 'caption') {
            if (!text) return fail('Say what the caption says (text).')
            return rec.cue(c.wc.id, { type: 'caption', text, seconds }) ? ok('Caption shown.') : notRunning()
          }
          if (action === 'title') {
            if (!text) return fail('Give the title card its text.')
            if (!rec.cue(c.wc.id, { type: 'title', text, subtitle, seconds })) return notRunning()
            // The card is in the video while it shows: wait it out, so what comes next follows it.
            await new Promise((r) => setTimeout(r, (seconds ?? 2.5) * 1000))
            return ok('Title card shown.')
          }
          if (!ref) return fail('Say which control to highlight (ref, from browser_snapshot).')
          const box = (await inTime(c.wc.executeJavaScript(BOX(ref)), PAGE_MS)) as { x: number; y: number; w: number; h: number; vw: number; vh: number } | null
          if (!box) return fail(`No control [${ref}] on the page now. Take a new browser_snapshot.`)
          const vw = Math.max(1, box.vw)
          const vh = Math.max(1, box.vh)
          return rec.cue(c.wc.id, { type: 'highlight', fx: box.x / vw, fy: box.y / vh, fw: box.w / vw, fh: box.h / vh, label: text, seconds }) ? ok('Highlighted.') : notRunning()
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      }
    ),
    tool(
      'browser_logs',
      "What a Browser page reported behind the scenes: console errors and warnings, and its requests (API calls with their status and time, and any request that failed). Use it to check a page actually worked (an error or a 500 the page doesn't show), after an action that should call an API, or when something looks stuck. By default it shows problems since you last asked; other tools' results tell you when there are new ones.",
      {
        show: z.enum(['problems', 'console', 'network', 'all']).optional().describe('problems (default): console errors and warnings, and failed requests; console: every console message; network: API calls and failed requests; all: everything'),
        all: z.boolean().optional().describe('Everything kept for the page, not just what is new since you last asked'),
        find: z.string().optional().describe('Only lines containing this, e.g. "/api/orders"'),
        tab: TAB
      },
      async ({ show, all, find, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        return ok(logsText(c.wc.id, { show: show ?? 'problems', all, find }))
      }
    ),
    tool(
      'browser_viewport',
      'Show a Browser tab at a phone or tablet width (or a width you give, or back to desktop), to test how a page works and looks there: the page lays out as it would on that screen. Everything after (snapshots, clicks, screenshots) uses that width until you change it back.',
      { size: z.union([z.enum(['phone', 'tablet', 'desktop']), z.number().int().min(280).max(2400)]).describe('phone (390px), tablet (820px), desktop (the full view), or a width in px'), tab: TAB },
      async ({ size, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const width = size === 'phone' ? 390 : size === 'tablet' ? 820 : size === 'desktop' ? 0 : size
        await bridge.resize(c.tab, width)
        await new Promise((r) => setTimeout(r, 400))
        const w = (await inTime(c.wc.executeJavaScript('innerWidth'), PAGE_MS).catch(() => null)) as number | null
        return ok(`${width ? `Showing at ${w ?? width}px wide` : `Back to the full view (${w ?? '?'}px wide)`}. ${where(c.wc)}`)
      }
    ),
    tool(
      'browser_close',
      'Close Browser tabs you no longer need: the ones named, or every tab except the one showing (others). Keep the Browser tidy: close tabs when you are done with them rather than leaving many open.',
      { tabs: z.array(z.string()).optional().describe('Tab ids to close (from browser_tabs)'), others: z.boolean().optional().describe('Close every tab except the one showing') },
      async ({ tabs, others }) => {
        if (!tabs?.length && !others) return fail('Say which tabs to close (tabs), or pass others to close all but the one showing.')
        const r = await bridge.close(tabs ?? [], !!others)
        return ok(`Closed ${r.closed} tab${r.closed === 1 ? '' : 's'}; ${r.left} open.`)
      }
    ),
    tool(
      'browser_tabs',
      'List the Browser tabs: id, title, address, and which one is showing.',
      {},
      async () => {
        const list = await bridge.tabs()
        return ok(list.length ? list.map((t) => `${t.tab}${t.active ? ' (showing)' : ''}: ${t.title ?? ''} ${t.url}`).join('\n') : 'No tabs open.')
      }
    ),
    tool(
      'browser_wait',
      'Wait until something is true on the page: a control is there (selector, role and name, or contains), text appears, text or a spinner is gone, a JavaScript condition holds, or the page has stopped changing (a streamed answer has finished); any combination, for up to 10 minutes. Glassbox checks every half second, so never loop in browser_eval to wait. With none given, just waits a moment.',
      { ...WAIT, selector: LOCATOR.selector, role: LOCATOR.role, name: LOCATOR.name, contains: LOCATOR.contains, tab: TAB },
      async ({ text, gone, until, stable, seconds, selector, role, name, contains, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const w = await waitFor(c.wc, { text, gone, until, stable, seconds, el: { selector, role, name, contains } })
        return w.ok ? ok(`Done waiting: ${w.what} (${(w.took / 1000).toFixed(1)}s). ${where(c.wc)}`) : fail(`Gave up waiting for ${w.what} after ${(w.took / 1000).toFixed(0)}s. ${where(c.wc)}`)
      }
    ),
    tool(
      'browser_steps',
      'Run a sequence of browser steps in one call: open, click, type, press, wait (as browser_wait), read (an outline, narrowed with find), eval and screenshot. Find controls by role and name, text or selector, so no snapshot is needed in between. Returns one short line per step. For long runs (many conversations or pages), set background: true to carry on with other work and check with browser_job; set record_dir to keep a JSON line per step (steps.jsonl) and the screenshots there, to compare runs afterwards.',
      {
        steps: z
          .array(
            z.object({
              do: z.enum(['open', 'click', 'type', 'press', 'wait', 'read', 'screenshot', 'eval']),
              label: z.string().optional().describe('A name for the step in the results'),
              url: z.string().optional().describe('open: the address'),
              new_tab: z.boolean().optional(),
              ...LOCATOR,
              value: z.string().optional().describe('type: what to type'),
              submit: z.boolean().optional(),
              append: z.boolean().optional(),
              key: z.string().optional().describe('press: the key'),
              find: z.string().optional().describe('read: only lines with these words'),
              limit: z.number().int().positive().max(20000).optional(),
              code: z.string().optional().describe('eval: an async function body; use return'),
              ...WAIT
            })
          )
          .min(1)
          .max(500),
        tab: TAB,
        background: z.boolean().optional().describe('Run in the background and return a job id at once (check it with browser_job)'),
        record_dir: z.string().optional().describe('Folder to write steps.jsonl and screenshots to (an absolute path; a relative one goes under the screenshots folder for this session)'),
        stop_on_error: z.boolean().optional().describe('Stop at the first failed step (default true)')
      },
      async ({ steps, tab, background, record_dir, stop_on_error }) => {
        const record = record_dir ? (isAbsolute(record_dir) ? record_dir : join(shotsDir, record_dir)) : undefined
        const stop = stop_on_error !== false
        if (background) {
          const id = `j${++jobSeq}`
          const job: { total: number; done: number; failed: number; lines: string[]; status: 'running' | 'done' | 'failed'; started: number; ended?: number; record?: string } = { total: steps.length, done: 0, failed: 0, lines: [], status: 'running', started: Date.now(), record }
          jobs.set(id, job)
          // Stopping at the first failure, a failure fails the job; carrying on, the job is done when it reaches the end.
          void runSteps(steps as Step[], tab, record, (l, ok) => (job.lines.push(l), job.done++, ok || job.failed++), stop)
            .then((failed) => (job.status = failed && stop ? 'failed' : 'done'))
            .catch((e) => (job.lines.push(`stopped: ${e instanceof Error ? e.message : String(e)}`), (job.status = 'failed')))
            .finally(() => (job.ended = Date.now()))
          return ok(`Started job ${id} (${steps.length} steps) in the background${record ? `, recording to ${record}` : ''}. Check it with browser_job.`)
        }
        const lines: string[] = []
        let failures = 0
        const failed = await runSteps(steps as Step[], tab, record, (l, good) => (lines.push(l), good || failures++), stop)
        const out = (lines.join('\n') + (failures && !stop ? `\n${failures} step${failures === 1 ? '' : 's'} failed; the rest ran.` : '')).slice(0, 16000)
        return failed && stop ? fail(out) : ok(out)
      }
    ),
    tool(
      'browser_job',
      'How a background browser_steps run is going: steps done, its latest lines, and whether it finished. Optionally wait up to wait_seconds for it to finish first.',
      { id: z.string(), wait_seconds: z.number().min(0).max(600).optional(), lines: z.number().int().min(1).max(200).optional().describe('How many of its latest lines to show (default 20)') },
      async ({ id, wait_seconds, lines }) => {
        const job = jobs.get(id)
        if (!job) return fail(`No job ${id}. Jobs: ${[...jobs.keys()].join(', ') || 'none'}`)
        const until = Date.now() + (wait_seconds ?? 0) * 1000
        while (job.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 500))
        const took = Math.round(((job.ended ?? Date.now()) - job.started) / 1000)
        return ok(`Job ${id}: ${job.status}, ${job.done} of ${job.total} steps${job.failed ? ` (${job.failed} failed)` : ''}, ${took}s.${job.record ? ` Record: ${job.record}` : ''}\n${job.lines.slice(-(lines ?? 20)).join('\n')}`)
      }
    )
  ]
}

export const BROWSER_TOOL_NAMES = ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_eval', 'browser_screenshot', 'browser_record', 'browser_logs', 'browser_viewport', 'browser_close', 'browser_tabs', 'browser_wait', 'browser_steps', 'browser_job'].map((n) => `mcp__glassbox__${n}`)
