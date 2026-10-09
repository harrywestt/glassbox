import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
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

const where = (wc: WC) => `Now on "${wc.getTitle()}" (${wc.getURL()}).`

export function browserTools(bridge: BrowserBridge, shotsDir: string) {
  const TAB = z.string().optional().describe('Browser tab id (from browser_open or browser_tabs); defaults to the tab showing')
  return [
    tool(
      'browser_open',
      "Open a web page in the Glassbox Browser (the user sees it; sign-ins they've made there are kept). Returns the page as a short text outline with numbered controls. Use this, never an external browser, Playwright or curl, to look at or try a web page.",
      {
        url: z.string().describe('The address, e.g. http://localhost:5173/login'),
        new_tab: z.boolean().optional().describe('Open in a new tab (default) or reuse the current one'),
        find: z.string().optional().describe('Only show outline lines containing these words (plus headings)')
      },
      async ({ url, new_tab, find }) => {
        try {
          const { tab, wcId } = await bridge.open(url, new_tab !== false)
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
        return ok(await inTime(c.wc.executeJavaScript(SNAPSHOT(find ?? '', limit ?? 4000)), PAGE_MS))
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
      'A picture of what a Browser tab shows. Use it when the look matters (layout, styling, a chart); for content and controls, browser_snapshot is far cheaper.',
      { tab: TAB },
      async ({ tab }) => {
        const c = await contents(bridge, tab)
        if (typeof c === 'string') return fail(c)
        await settle(c.wc, 4000)
        let img: Electron.NativeImage
        // A page that sets no background is see-through, which a JPEG turns black: give it the white a browser would.
        const white = await c.wc.insertCSS('html { background-color: #fff }', { cssOrigin: 'user' }).catch(() => null)
        try {
          img = await inTime(c.wc.capturePage(), PAGE_MS)
        } catch (e) {
          return e instanceof TimedOut ? slow('The screenshot', PAGE_MS) : fail(`Couldn't take the screenshot: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          if (white) void c.wc.removeInsertedCSS(white).catch(() => {})
        }
        const small = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img
        const jpeg = small.toJPEG(72)
        mkdirSync(shotsDir, { recursive: true })
        const file = join(shotsDir, `shot-${Date.now()}.jpg`)
        writeFileSync(file, jpeg)
        return { content: [{ type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text' as const, text: `Saved to ${file}. ${where(c.wc)}` }] }
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

export const BROWSER_TOOL_NAMES = ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_eval', 'browser_screenshot', 'browser_tabs', 'browser_wait'].map((n) => `mcp__glassbox__${n}`)
