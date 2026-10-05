import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { tr } from '../../shared/i18n'

marked.setOptions({ gfm: true, breaks: false })

export type MediaKind = 'image' | 'video' | 'audio'
const MEDIA_EXT: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio'
}

/** Whether a file is an image, video or audio (shown as media, not text). */
export function mediaKind(path: string): MediaKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && MEDIA_EXT[ext]) || null
}

/** A URL the window can load a local media file from (served by the main process's media: scheme). */
export function mediaUrl(absPath: string): string {
  return `media://file/${encodeURIComponent(absPath.replace(/\\/g, '/'))}`
}

const isAbsPath = (p: string) => /^([a-z]:[\\/]|\/|\\\\)/i.test(p)
/** A path relative to `base` (the session's folder) made absolute, forward slashes. */
export function absPath(base: string, p: string): string {
  if (isAbsPath(p)) return p
  return `${base.replace(/[\\/]+$/, '')}/${p.replace(/^\.\//, '')}`
}

// DOMPurify's default URI rule, plus media: so local images in Claude's replies survive.
const URI_OK = /^(?:(?:https?|mailto|tel|media|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/**
 * Markdown to safe HTML. With `base` (the session's folder), images that point at local files
 * (![](screenshot.png), ![](C:/…/shot.png)) are shown from disk.
 */
/** Formatted messages, by their text: a conversation redraws often, and its messages rarely change. */
const formatted = new Map<string, string>()
const FORMATTED_MAX = 600

export function renderMarkdown(text: string, base?: string, live = false): string {
  // A draft still streaming in changes every frame: caching its snapshots would only push out finished messages.
  if (live) return formatMarkdown(text, base)
  const key = `${base ?? ''}\u0000${text}`
  const hit = formatted.get(key)
  if (hit !== undefined) {
    // Most recently used goes to the back, so the oldest are dropped first.
    formatted.delete(key)
    formatted.set(key, hit)
    return hit
  }
  const html = formatMarkdown(text, base)
  formatted.set(key, html)
  if (formatted.size > FORMATTED_MAX) formatted.delete(formatted.keys().next().value!)
  return html
}

function formatMarkdown(text: string, base?: string): string {
  const html = marked.parse(text, {
    async: false,
    walkTokens: (t) => {
      if (t.type !== 'image' || !base) return
      const href = String((t as { href?: string }).href ?? '')
      if (!href || /^(https?:|data:|media:)/i.test(href) || !mediaKind(href)) return
      ;(t as { href: string }).href = mediaUrl(absPath(base, decodeURI(href.replace(/^file:\/\/\/?/i, ''))))
    }
  })
  return DOMPurify.sanitize(cellLists(html), { ALLOWED_URI_REGEXP: URI_OK })
}

/**
 * A table row is one line of markdown, so a list inside a cell comes as "- one<br>- two". Turned
 * into a real bulleted list here (any text before the first bullet stays above it).
 */
function cellLists(html: string): string {
  if (!html.includes('<td')) return html
  return html.replace(/<td([^>]*)>([\s\S]*?)<\/td>/g, (whole, attrs: string, body: string) => {
    const lines = body.split(/<br\s*\/?>/i)
    const bullet = /^\s*(?:[-*•‣▪]|\d+[.)])\s+/
    const first = lines.findIndex((l) => bullet.test(l))
    if (first < 0 || lines.slice(first).filter((l) => bullet.test(l)).length < 2) return whole
    const numbered = /^\s*\d+[.)]\s/.test(lines[first])
    const items = lines.slice(first).map((l) => `<li>${l.replace(bullet, '').trim()}</li>`).join('')
    const lead = lines.slice(0, first).join('<br>').trim()
    return `<td${attrs}>${lead ? `${lead}` : ''}${numbered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`}</td>`
  })
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

export function timeUntil(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return tr('lib.now')
  const mins = Math.round(ms / 60000)
  if (mins < 60) return tr('lib.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 48) return tr('lib.hoursMinutes', { h: hours, m: mins % 60 })
  return tr('lib.daysHours', { d: Math.floor(hours / 24), h: hours % 24 })
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return tr('lib.justNow')
  if (s < 3600) return tr('lib.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return tr('lib.hoursAgo', { n: Math.floor(s / 3600) })
  if (s < 7 * 86400) return tr('lib.daysAgo', { n: Math.floor(s / 86400) })
  // Older than a week: a short date, in the same compact style ("18 Sep").
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/** A duration people can read at a glance: 4.2s, 2m 14s, 1h 05m, 1d 14h. */
export function formatDuration(ms: number): string {
  const n = Math.max(0, ms / 1000)
  if (n < 10) return tr('lib.seconds', { n: n.toFixed(1) })
  const sec = Math.round(n)
  if (sec < 60) return tr('lib.seconds', { n: sec })
  if (sec < 3600) return tr('lib.minutesSeconds', { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, '0') })
  if (sec < 86_400) return tr('lib.hoursMinutesPadded', { h: Math.floor(sec / 3600), m: String(Math.floor((sec % 3600) / 60)).padStart(2, '0') })
  return tr('lib.daysHours', { d: Math.floor(sec / 86_400), h: Math.floor((sec % 86_400) / 3600) })
}

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Path relative to cwd with forward slashes; unchanged when outside cwd. */
export function relPath(cwd: string, path: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const c = norm(cwd).toLowerCase()
  const p = norm(path)
  return p.toLowerCase().startsWith(c + '/') ? p.slice(c.length + 1) : p
}

export const newId = () => crypto.randomUUID()
