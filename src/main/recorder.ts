import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, webContents, type BrowserWindow } from 'electron'

/**
 * Video of a Browser tab. The page's frames come from its webContents (while it paints, which it
 * does even out of sight); the window encodes them to a WebM with the browser's own video encoder
 * (MediaRecorder), and the file is written here. One recording per tab at a time.
 */

/** Recordings stop by themselves after this long. */
const MAX_MS = 10 * 60_000
const FPS = 12
const MAX_WIDTH = 1920

/** How a recording looks, chosen when it starts. */
export type RecordOptions = {
  /** The video's size: the page's own shape, or a standard frame with the page letterboxed in it. */
  size?: 'page' | '720p' | '1080p'
  fps?: 12 | 24 | 30
  /** A title card the video opens on. */
  title?: string
  subtitle?: string
  /** Ripples and captions for each click, keypress and bit of typing (default on). */
  showActions?: boolean
  /** A pointer that glides to each click (default on). */
  cursor?: boolean
  /** Keep the still moments in (default: they're cut, so the video doesn't sit through thinking time). */
  keepStill?: boolean
}

/** Something put into the video as it records. Positions are shares of the page's view (0 to 1). */
export type RecordCue =
  | { type: 'caption'; text: string; seconds?: number }
  | { type: 'title'; text: string; subtitle?: string; seconds?: number }
  | { type: 'highlight'; fx: number; fy: number; fw: number; fh: number; label?: string; seconds?: number }
  | { type: 'pause' }
  | { type: 'resume' }

type Active = { id: string; wcId: number; started: number; timer: NodeJS.Timeout; limit: NodeJS.Timeout; latest?: Electron.NativeImage; latestAt: number; capturing?: boolean; nudges: number; nudgeKey?: string; sent?: Electron.NativeImage; done?: (path: string | null) => void; win: BrowserWindow; sig?: Buffer }

/** Something Claude did in a recorded tab: a click (where, as a share of the page's view) or a caption. */
export type RecordMark = { label: string; fx?: number; fy?: number }

/** Shows an action in the tab's recording, if it's being recorded: a ripple where it clicked and a caption. */
export function markRecording(wcId: number, mark: RecordMark) {
  const a = active.get(wcId)
  if (!a || a.win.isDestroyed()) return
  a.win.webContents.send('glassbox:recorder', { kind: 'mark', id: a.id, ...mark })
}

export const capturesDir = () => {
  const d = join(app.getPath('userData'), 'captures')
  mkdirSync(d, { recursive: true })
  return d
}

let seq = 0
const active = new Map<number, Active>()
const byId = new Map<string, Active>()

export function isRecording(wcId: number): { started: number } | null {
  const a = active.get(wcId)
  return a ? { started: a.started } : null
}

/** Puts a caption, title card or highlight into a tab's recording, or pauses and resumes it. */
export function cueRecording(wcId: number, cue: RecordCue): boolean {
  const a = active.get(wcId)
  if (!a || a.win.isDestroyed()) return false
  a.win.webContents.send('glassbox:recorder', { kind: 'cue', id: a.id, cue })
  return true
}

export function startRecording(win: BrowserWindow | undefined, wcId: number, opts: RecordOptions = {}): { started: number } {
  const existing = active.get(wcId)
  if (existing) return { started: existing.started }
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) throw new Error('That Browser tab is not open.')
  if (!win || win.isDestroyed()) throw new Error('Glassbox has no window open.')
  const id = `rec${++seq}`
  const fps = opts.fps ?? FPS
  const a: Active = {
    id,
    wcId,
    win,
    started: Date.now(),
    latestAt: 0,
    nudges: 0,
    // Frames go to the window at a steady rate (the newest one, when it changed).
    timer: setInterval(() => {
      // A tab that isn't showing (another view, another window on top) paints rarely or not at all, so
      // the frames stop coming: then it's asked to draw afresh and captured directly (without the
      // redraw, a hidden page hands back its last picture, from before whatever just changed).
      if (Date.now() - a.latestAt > 250 && !a.capturing && !wc.isDestroyed()) {
        a.capturing = true
        void nudge(wc, a)
          .then(() => wc.capturePage())
          .then((img) => {
            if (!img.isEmpty() && Date.now() - a.latestAt > 250) a.latest = img
          })
          .catch(() => undefined)
          .finally(() => (a.capturing = false))
      }
      if (!a.latest || a.latest === a.sent || win.isDestroyed()) return
      a.sent = a.latest
      // A frame that looks the same as the last (a blinking caret, a spinner's tick) isn't news: the
      // recording can pause through it rather than keep every second Claude spends thinking.
      const sig = a.latest.resize({ width: 240, quality: 'good' }).toBitmap()
      if (a.sig && sig.length === a.sig.length && changedShare(sig, a.sig) < 0.0004) return
      a.sig = sig
      const img = a.latest.getSize().width > MAX_WIDTH ? a.latest.resize({ width: MAX_WIDTH }) : a.latest
      win.webContents.send('glassbox:recorder', { kind: 'frame', id, jpeg: img.toJPEG(82) })
    }, 1000 / fps),
    limit: setTimeout(() => void stopRecording(win, wcId), MAX_MS)
  }
  active.set(wcId, a)
  byId.set(id, a)
  // Encoding happens in the window: keep its timers running at full speed while recording.
  win.webContents.setBackgroundThrottling(false)
  win.webContents.send('glassbox:recorder', { kind: 'start', id, fps, opts })
  wc.beginFrameSubscription(false, (image) => ((a.latest = image), (a.latestAt = Date.now())))
  // A still page sends no new frames: ask for one now so the video starts with a picture.
  wc.invalidate()
  wc.once('destroyed', () => void stopRecording(win, wcId))
  return { started: a.started }
}

/** Stops a recording and resolves with the saved file (null if nothing was recorded). */
export function stopRecording(win: BrowserWindow | undefined, wcId: number): Promise<string | null> {
  const a = active.get(wcId)
  if (!a) return Promise.resolve(null)
  active.delete(wcId)
  clearInterval(a.timer)
  clearTimeout(a.limit)
  const wc = webContents.fromId(wcId)
  try {
    if (wc && !wc.isDestroyed()) {
      wc.endFrameSubscription()
      if (a.nudgeKey) void wc.removeInsertedCSS(a.nudgeKey).catch(() => {})
    }
  } catch {
    /* already ended */
  }
  if (!active.size && win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(true)
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => (byId.delete(a.id), resolve(null)), 30_000)
    a.done = (path) => (clearTimeout(timeout), resolve(path))
    win.webContents.send('glassbox:recorder', { kind: 'stop', id: a.id })
  })
}

/** The window finished encoding: write the video. */
export function recordingEncoded(id: string, data: ArrayBuffer | null): string | null {
  const a = byId.get(id)
  byId.delete(id)
  if (!a) return null
  let path: string | null = null
  if (data && data.byteLength) {
    path = join(capturesDir(), `recording-${new Date(a.started).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`)
    writeFileSync(path, Buffer.from(data))
  }
  a.done?.(path)
  return path
}

/**
 * Makes a hidden page draw afresh: an invisible style change (a transparent outline, toggled) is
 * the one thing that gets a page Chromium thinks is out of sight to repaint before it's captured.
 */
async function nudge(wc: Electron.WebContents, a: Active) {
  const old = a.nudgeKey
  a.nudgeKey = await wc.insertCSS(`html { outline: ${++a.nudges % 2}px solid transparent !important; }`, { cssOrigin: 'user' }).catch(() => undefined)
  if (old) void wc.removeInsertedCSS(old).catch(() => {})
}

/**
 * The share of pixels that visibly changed between two small bitmaps (BGRA). Counting changed
 * pixels, rather than averaging the difference, catches a quiet change (a pale panel opening on a
 * pale page) that an average washes out, while a blinking caret is still too few pixels to count.
 */
function changedShare(a: Buffer, b: Buffer): number {
  let changed = 0
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++
  return changed / (a.length / 4)
}
