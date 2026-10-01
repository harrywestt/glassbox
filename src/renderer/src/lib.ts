import DOMPurify from 'dompurify'
import { marked } from 'marked'

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
export function renderMarkdown(text: string, base?: string): string {
  const html = marked.parse(text, {
    async: false,
    walkTokens: (t) => {
      if (t.type !== 'image' || !base) return
      const href = String((t as { href?: string }).href ?? '')
      if (!href || /^(https?:|data:|media:)/i.test(href) || !mediaKind(href)) return
      ;(t as { href: string }).href = mediaUrl(absPath(base, decodeURI(href.replace(/^file:\/\/\/?/i, ''))))
    }
  })
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: URI_OK })
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
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  // Older than a week: a short date, in the same compact style ("18 Sep").
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/** A duration people can read at a glance: 4.2s, 2m 14s, 1h 05m, 1d 14h. */
export function formatDuration(ms: number): string {
  const n = Math.max(0, ms / 1000)
  if (n < 10) return `${n.toFixed(1)}s`
  const sec = Math.round(n)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`
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
