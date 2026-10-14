import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { logsText, newProblems } from './browserLogs'
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
  const list = await bridge.tabs()
  if (!list.length) return 'No browser tabs are open. Use browser_open first.'
  const t = tab ? list.find((x) => x.tab === tab) : list.find((x) => x.active) ?? list[0]
  if (!t) return `No tab "${tab}". Open tabs: ${list.map((x) => `${x.tab} (${x.title ?? x.url})`).join(', ')}`
  const wc = t.wcId !== undefined ? webContents.fromId(t.wcId) : undefined
  if (!wc || wc.isDestroyed()) return 'That tab is still starting; try again in a moment.'
  return { wc, tab: t.tab }
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
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 60) }
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
  record?: { start: (wcId: number) => { started: number }; stop: (wcId: number) => Promise<string | null> }
}

export function browserTools(bridge: BrowserBridge, shotsDir: string, hooks: BrowserHooks = {}) {
  const TAB = z.string().optional().describe('Browser tab id (from browser_open or browser_tabs); defaults to the tab showing')
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
          const { tab, wcId } = await bridge.open(url, new_tab === true)
          const { webContents } = await import('electron')
          const wc = webContents.fromId(wcId)
          if (!wc) return fail('The tab opened but its page is not ready.')
          // Reusing a tab: give the new address a moment to start loading before waiting on it.
          await new Promise((r) => setTimeout(r, 350))
          await settle(wc)
          return ok(`Tab ${tab}.\n${await inTime(wc.executeJavaScript(SNAPSHOT(find ?? '', 4000)), PAGE_MS)}`)
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      },
      { alwaysLoad: true }
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
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_click',
      'Click a numbered control from the latest browser_snapshot (a real mouse click at its position). Returns where the page is afterwards; take a new snapshot to read it.',
      { ref: z.number().int().positive(), tab: TAB },
      async ({ ref, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const at = (await inTime(c.wc.executeJavaScript(LOCATE(ref)), PAGE_MS)) as { x: number; y: number; name: string } | null
        if (!at) return fail(`No control [${ref}] on the page now. Take a new browser_snapshot.`)
        await new Promise((r) => setTimeout(r, 120))
        c.wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
        c.wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
        c.wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
        await settle(c.wc, 8000)
        return ok(`Clicked [${ref}] "${at.name}". ${where(c.wc)}`)
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_type',
      'Type into a numbered input from the latest browser_snapshot (replacing what is there unless append is set). Optionally press Enter after.',
      { ref: z.number().int().positive(), text: z.string(), submit: z.boolean().optional().describe('Press Enter afterwards'), append: z.boolean().optional(), tab: TAB },
      async ({ ref, text, submit, append, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const found = await inTime(c.wc.executeJavaScript(`(() => { const el = document.querySelector('[data-gb="${ref}"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); ${append ? '' : "if ('select' in el) el.select(); else document.execCommand('selectAll')"}; return true })()`), PAGE_MS)
        if (!found) return fail(`No control [${ref}] on the page now. Take a new browser_snapshot.`)
        if (!append) press(c.wc, 'Backspace')
        await c.wc.insertText(text)
        if (submit) {
          press(c.wc, 'Enter')
          await settle(c.wc, 8000)
        }
        return ok(`Typed into [${ref}]${submit ? ' and pressed Enter' : ''}. ${where(c.wc)}`)
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_press',
      'Press a key in a Browser tab: Enter, Escape, Tab, arrows, PageDown, or a single character.',
      { key: z.string(), tab: TAB },
      async ({ key, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        press(c.wc, key)
        await settle(c.wc, 4000)
        return ok(`Pressed ${key}. ${where(c.wc)}`)
      },
      { alwaysLoad: true }
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
      },
      { alwaysLoad: true }
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
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_record',
      'Record a video of a Browser tab: start before you go through a flow, stop after; stopping saves a WebM and gives its path (present_file it so the user can watch). Use it when the user wants a video (a bug reproduction, a walkthrough, evidence of a flow), not routinely. Stops by itself after 10 minutes.',
      { action: z.enum(['start', 'stop']), tab: TAB },
      async ({ action, tab }) => {
        if (!hooks.record) return fail('Recording is not available here.')
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        try {
          if (action === 'start') {
            hooks.record.start(c.wc.id)
            return ok(`Recording ${where(c.wc)} Call browser_record with action stop when you're done.`)
          }
          const path = await hooks.record.stop(c.wc.id)
          return path ? ok(`Saved the recording to ${path}. Use present_file to show it.`) : fail('Nothing was recorded (no recording was running in that tab, or the page showed nothing).')
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      },
      { alwaysLoad: true }
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
      },
      { alwaysLoad: true }
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
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_close',
      'Close Browser tabs you no longer need: the ones named, or every tab except the one showing (others). Keep the Browser tidy: close tabs when you are done with them rather than leaving many open.',
      { tabs: z.array(z.string()).optional().describe('Tab ids to close (from browser_tabs)'), others: z.boolean().optional().describe('Close every tab except the one showing') },
      async ({ tabs, others }) => {
        if (!tabs?.length && !others) return fail('Say which tabs to close (tabs), or pass others to close all but the one showing.')
        const r = await bridge.close(tabs ?? [], !!others)
        return ok(`Closed ${r.closed} tab${r.closed === 1 ? '' : 's'}; ${r.left} open.`)
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_tabs',
      'List the Browser tabs: id, title, address, and which one is showing.',
      {},
      async () => {
        const list = await bridge.tabs()
        return ok(list.length ? list.map((t) => `${t.tab}${t.active ? ' (showing)' : ''}: ${t.title ?? ''} ${t.url}`).join('\n') : 'No tabs open.')
      },
      { alwaysLoad: true }
    ),
    tool(
      'browser_wait',
      'Wait for text to appear on the page (or just wait a moment), e.g. after starting something slow.',
      { text: z.string().optional(), seconds: z.number().positive().max(60).optional(), tab: TAB },
      async ({ text, seconds, tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        const until = Date.now() + (seconds ?? (text ? 15 : 2)) * 1000
        while (Date.now() < until) {
          if (text && (await inTime(c.wc.executeJavaScript(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`), PAGE_MS))) return ok(`"${text}" is on the page. ${where(c.wc)}`)
          await new Promise((r) => setTimeout(r, 300))
        }
        return text ? fail(`"${text}" didn't appear within ${seconds ?? 15}s. ${where(c.wc)}`) : ok(`Waited. ${where(c.wc)}`)
      },
      { alwaysLoad: true }
    )
  ]
}

export const BROWSER_TOOL_NAMES = ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_eval', 'browser_screenshot', 'browser_record', 'browser_logs', 'browser_viewport', 'browser_close', 'browser_tabs', 'browser_wait'].map((n) => `mcp__glassbox__${n}`)
