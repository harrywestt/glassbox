import type { SessionState } from './session'
import { CHANGE_TOOLS, isClaudeOwnFile } from './session'
import { absPath, baseName } from './lib'
import { tr } from '../../shared/i18n'

/**
 * Files that go with a conversation: the ones you attach to a message, and the ones Claude makes
 * or shows you. Attachments travel as a block of paths at the end of your message, so Claude can
 * open them and a resumed session still knows what you sent.
 */

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'web' | 'doc' | 'sheet' | 'slides' | 'text' | 'archive' | 'other'

const KINDS: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  pdf: 'pdf',
  html: 'web', htm: 'web',
  doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', ods: 'sheet', numbers: 'sheet', csv: 'sheet', tsv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  md: 'text', txt: 'text', json: 'text', yaml: 'text', yml: 'text', xml: 'text', log: 'text',
  zip: 'archive', gz: 'archive', tar: 'archive', '7z': 'archive'
}

export function fileKind(path: string): FileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && KINDS[ext]) || 'other'
}

export const KIND_ICON: Record<FileKind, string> = {
  image: 'file-media', video: 'device-camera-video', audio: 'music', pdf: 'file-pdf', web: 'globe', doc: 'file-text',
  sheet: 'table', slides: 'preview', text: 'file-code', archive: 'file-zip', other: 'file'
}

export const KIND_LABEL: Record<FileKind, string> = {
  image: tr('attachments.kind.image'), video: tr('attachments.kind.video'), audio: tr('attachments.kind.audio'), pdf: tr('attachments.kind.pdf'), web: tr('attachments.kind.web'), doc: tr('attachments.kind.doc'), sheet: tr('attachments.kind.sheet'), slides: tr('attachments.kind.slides'), text: tr('attachments.kind.text'), archive: tr('attachments.kind.archive'), other: tr('attachments.kind.other')
}

/** Kinds worth listing as something Claude made for you (code and config aren't). */
const DELIVERABLE = new Set<FileKind>(['image', 'video', 'audio', 'pdf', 'web', 'doc', 'sheet', 'slides', 'archive'])

const OPEN = '<attachments>'
const CLOSE = '</attachments>'

/** Your message plus the files attached to it, as Claude receives it. */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text
  return `${text.trim() || 'See the attached files.'}\n\n${OPEN}\n${paths.join('\n')}\n${CLOSE}`
}

/** A message split back into what you wrote and the files you attached. */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const at = text.lastIndexOf(OPEN)
  const end = text.lastIndexOf(CLOSE)
  if (at < 0 || end < at) return { text, paths: [] }
  const paths = text.slice(at + OPEN.length, end).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return { text: text.slice(0, at).trimEnd(), paths }
}

export type Attachment = { path: string; name: string; kind: FileKind; from: 'you' | 'claude'; at: number; title?: string; why?: string }

/** Everything attached to or made in this conversation, newest first: your files, then Claude's. */
export function sessionAttachments(s: SessionState, cwd: string): Attachment[] {
  const out = new Map<string, Attachment>()
  const add = (a: Attachment) => {
    const key = `${a.from}:${a.path.replace(/\\/g, '/').toLowerCase()}`
    const had = out.get(key)
    out.set(key, had ? { ...had, ...a, at: Math.max(had.at, a.at), title: a.title ?? had.title, why: a.why ?? had.why } : a)
  }
  for (const i of s.timeline) {
    if (i.kind !== 'user' && i.kind !== 'comment') continue
    for (const p of splitAttachments(i.text).paths) add({ path: p, name: baseName(p), kind: fileKind(p), from: 'you', at: i.at })
  }
  for (const p of s.presented ?? []) {
    const path = absPath(cwd, p.path)
    add({ path, name: baseName(path), kind: fileKind(path), from: 'claude', at: p.at, title: p.title, why: p.why })
  }
  // Files Claude wrote that are documents, images or media (not code), even if it didn't present them.
  for (const f of s.files) {
    if (!CHANGE_TOOLS.has(f.tool) || isClaudeOwnFile(f.path) || s.toolCalls[f.toolId]?.status === 'error') continue
    const kind = fileKind(f.path)
    if (DELIVERABLE.has(kind)) add({ path: f.path, name: baseName(f.path), kind, from: 'claude', at: f.at })
  }
  return [...out.values()].sort((a, b) => b.at - a.at)
}

/** Open inside Glassbox when it can show the file, otherwise in its own app. */
export function opensInside(kind: FileKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'web' || kind === 'text'
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return tr('attachments.bytes', { n: bytes })
  if (bytes < 1024 * 1024) return tr('attachments.kilobytes', { n: Math.round(bytes / 1024) })
  return tr('attachments.megabytes', { n: (bytes / 1024 / 1024).toFixed(1) })
}

/** Paths on disk for dropped or pasted files; ones with no file behind them (a pasted screenshot) are saved first. */
export async function filesToPaths(files: File[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    const path = window.glassbox.attachments.pathFor(f)
    if (path) out.push(path)
    else {
      const ext = f.type.startsWith('image/') ? `.${f.type.slice(6).replace('jpeg', 'jpg').replace(/\+.*$/, '')}` : ''
      out.push(await window.glassbox.attachments.save(f.name || `Pasted ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${ext}`, await f.arrayBuffer()))
    }
  }
  return out
}
