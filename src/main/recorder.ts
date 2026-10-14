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
const MAX_WIDTH = 1600

type Active = { id: string; wcId: number; started: number; timer: NodeJS.Timeout; limit: NodeJS.Timeout; latest?: Electron.NativeImage; sent?: Electron.NativeImage; done?: (path: string | null) => void }

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

export function startRecording(win: BrowserWindow | undefined, wcId: number): { started: number } {
  const existing = active.get(wcId)
  if (existing) return { started: existing.started }
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) throw new Error('That Browser tab is not open.')
  if (!win || win.isDestroyed()) throw new Error('Glassbox has no window open.')
  const id = `rec${++seq}`
  const a: Active = {
    id,
    wcId,
    started: Date.now(),
    // Frames go to the window at a steady rate (the newest one, when it changed).
    timer: setInterval(() => {
      if (!a.latest || a.latest === a.sent || win.isDestroyed()) return
      a.sent = a.latest
      const img = a.latest.getSize().width > MAX_WIDTH ? a.latest.resize({ width: MAX_WIDTH }) : a.latest
      win.webContents.send('glassbox:recorder', { kind: 'frame', id, jpeg: img.toJPEG(82) })
    }, 1000 / FPS),
    limit: setTimeout(() => void stopRecording(win, wcId), MAX_MS)
  }
  active.set(wcId, a)
  byId.set(id, a)
  // Encoding happens in the window: keep its timers running at full speed while recording.
  win.webContents.setBackgroundThrottling(false)
  win.webContents.send('glassbox:recorder', { kind: 'start', id, fps: FPS })
  wc.beginFrameSubscription(false, (image) => (a.latest = image))
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
    if (wc && !wc.isDestroyed()) wc.endFrameSubscription()
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
