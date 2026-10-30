/**
 * The encoding half of Browser recordings. The main process sends a tab's frames; they're drawn on
 * a canvas and MediaRecorder turns the canvas into a WebM, which goes back to be saved. Runs for the
 * app's lifetime, outside React.
 *
 * Made to be watched: each frame is drawn at the page's own proportions (never stretched, letterboxed
 * in a 720p or 1080p frame when asked); the time Claude spends deciding its next step is left out
 * (the recording pauses while nothing on the page changes); a pointer glides to each click, which
 * ripples where it landed, with a caption saying what was clicked, typed or pressed. Claude can add
 * title cards (chapters), narration captions and a spotlight on a control, and pause the recording.
 */
import type { RecordCue, RecordOptions } from '../../main/recorder'

type Mark = { label: string; fx?: number; fy?: number; at: number }
type Timed = { at: number; until: number }
type Title = Timed & { text: string; subtitle?: string }
type Caption = Timed & { text: string }
type Highlight = Timed & { fx: number; fy: number; fw: number; fh: number; label?: string }
type Job = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  media: MediaRecorder | null
  chunks: Blob[]
  latest: ImageBitmap | null
  timer: number
  fps: number
  lastChange: number
  marks: Mark[]
  opts: RecordOptions
  title: Title | null
  /** The opening card, shown once the video has its first frame. */
  opening: { text: string; subtitle?: string } | null
  caption: Caption | null
  highlights: Highlight[]
  paused: boolean
  /** The pointer, as shares of the page: where it was, where it's going, and when it set off. */
  pointer: { fx: number; fy: number; tx: number; ty: number; at: number } | null
}

/** A still page is kept for this long, then the recording pauses until something happens. */
const HOLD_MS = 1200
/** How long a click's ripple and an action's caption stay on screen. */
const RIPPLE_MS = 700
const CAPTION_MS = 1800
const GLIDE_MS = 380
const FADE_MS = 250
const SIZES = { '720p': [1280, 720], '1080p': [1920, 1080] } as const
const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif'

const jobs = new Map<string, Job>()
let started = false

/** The user's accent, so a recording's marks match Glassbox. */
function accent(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6'
  } catch {
    return '#3b82f6'
  }
}

/** Where the frame sits on the canvas: scaled to fit, centred, never stretched. */
function fit(job: Job, bmp: ImageBitmap) {
  const { width: cw, height: ch } = job.canvas
  const s = Math.min(cw / bmp.width, ch / bmp.height)
  const w = bmp.width * s
  const h = bmp.height * s
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h }
}

/** 0 to 1 to 0 over a timed item's life, for fading it in and out. */
function fade(t: Timed, now: number): number {
  return Math.max(0, Math.min(1, (now - t.at) / FADE_MS, (t.until - now) / FADE_MS))
}

const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3)

/** Text in a rounded pill, centred on x, with its top at y (or bottom, when from 'bottom'). */
function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, unit: number, alpha: number, maxW: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `600 ${Math.round(size * unit)}px ${FONT}`
  let t = text
  while (ctx.measureText(t).width > maxW && t.length > 4) t = t.slice(0, -2)
  if (t !== text) t = t.slice(0, -1) + '…'
  const padX = 16 * unit
  const h = (size + 22) * unit
  const w = ctx.measureText(t).width + padX * 2
  ctx.fillStyle = 'rgba(17, 19, 24, 0.86)'
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y, w, h, 10 * unit)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(t, x - w / 2 + padX, y + h / 2 + 1)
  ctx.restore()
  return h
}

/** Narration: up to two lines, wrapped, in a wider band at the bottom. */
function narration(ctx: CanvasRenderingContext2D, text: string, cw: number, ch: number, unit: number, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `500 ${Math.round(22 * unit)}px ${FONT}`
  const maxW = cw * 0.78
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line)
      line = w
    } else line = next
  }
  if (line) lines.push(line)
  const shown = lines.slice(0, 2)
  if (lines.length > 2) shown[1] = shown[1].replace(/\s*\S*$/, '') + '…'
  const lh = 32 * unit
  const padX = 22 * unit
  const padY = 14 * unit
  const w = Math.max(...shown.map((l) => ctx.measureText(l).width)) + padX * 2
  const h = shown.length * lh + padY * 2
  const x = (cw - w) / 2
  const y = ch - h - 32 * unit
  ctx.fillStyle = 'rgba(17, 19, 24, 0.88)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 12 * unit)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  shown.forEach((l, i) => ctx.fillText(l, cw / 2, y + padY + lh * i + lh / 2 + 1))
  ctx.restore()
  return h + 32 * unit
}

/** The pointer: an arrow with a soft outline, tip at (x, y). */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, unit: number) {
  const s = 1.15 * unit
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(s, s)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 22)
  ctx.lineTo(6, 16.5)
  ctx.lineTo(10, 25)
  ctx.lineTo(13.5, 23.5)
  ctx.lineTo(9.5, 15.5)
  ctx.lineTo(17, 15.5)
  ctx.closePath()
  ctx.shadowColor = 'rgba(0, 0, 0, .35)'
  ctx.shadowBlur = 4
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.lineWidth = 1.6
  ctx.strokeStyle = '#111'
  ctx.stroke()
  ctx.restore()
}

function draw(job: Job, now: number) {
  const { ctx, canvas, latest } = job
  if (!latest) return
  const cw = canvas.width
  const ch = canvas.height
  const unit = Math.max(1, cw / 1280)
  const tint = accent()
  const r = fit(job, latest)
  if (r.w < cw - 1 || r.h < ch - 1) {
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, cw, ch)
  }
  ctx.drawImage(latest, r.x, r.y, r.w, r.h)

  // A title card covers the page (dimmed behind it) while it shows.
  if (job.title && now >= job.title.until) job.title = null
  if (job.title) {
    const a = fade(job.title, now)
    ctx.save()
    ctx.globalAlpha = 0.86 * a
    ctx.fillStyle = '#0f1115'
    ctx.fillRect(0, 0, cw, ch)
    ctx.globalAlpha = a
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = tint
    ctx.fillRect(cw / 2 - 24 * unit, ch / 2 - 64 * unit, 48 * unit, 4 * unit)
    ctx.fillStyle = '#fff'
    ctx.font = `600 ${Math.round(44 * unit)}px ${FONT}`
    ctx.fillText(job.title.text, cw / 2, ch / 2 - (job.title.subtitle ? 14 * unit : 0), cw * 0.86)
    if (job.title.subtitle) {
      ctx.fillStyle = 'rgba(255, 255, 255, .72)'
      ctx.font = `400 ${Math.round(22 * unit)}px ${FONT}`
      ctx.fillText(job.title.subtitle, cw / 2, ch / 2 + 34 * unit, cw * 0.86)
    }
    ctx.restore()
    return
  }

  // A spotlight: the page dimmed around the control, a ring round it, and its label above.
  job.highlights = job.highlights.filter((h) => now < h.until)
  for (const h of job.highlights) {
    const a = fade(h, now)
    const pad = 6 * unit
    const x = r.x + h.fx * r.w - pad
    const y = r.y + h.fy * r.h - pad
    const w = h.fw * r.w + pad * 2
    const hh = h.fh * r.h + pad * 2
    ctx.save()
    ctx.globalAlpha = 0.5 * a
    ctx.fillStyle = '#000'
    ctx.beginPath()
    ctx.rect(0, 0, cw, ch)
    ctx.roundRect(x, y, w, hh, 8 * unit)
    ctx.fill('evenodd')
    ctx.globalAlpha = a
    ctx.strokeStyle = tint
    ctx.lineWidth = 3 * unit
    ctx.beginPath()
    ctx.roundRect(x, y, w, hh, 8 * unit)
    ctx.stroke()
    ctx.restore()
    if (h.label) {
      const above = y - (40 + 10) * unit
      pill(ctx, h.label, Math.min(cw - 120 * unit, Math.max(120 * unit, x + w / 2)), above > 8 * unit ? above : y + hh + 10 * unit, 16, unit, a, cw * 0.6)
    }
  }

  const actions = job.opts.showActions !== false
  job.marks = job.marks.filter((m) => now - m.at < CAPTION_MS)
  if (actions) {
    for (const m of job.marks) {
      const t = now - m.at
      if (m.fx === undefined || m.fy === undefined || t >= RIPPLE_MS) continue
      const x = r.x + m.fx * r.w
      const y = r.y + m.fy * r.h
      const p = t / RIPPLE_MS
      ctx.save()
      ctx.globalAlpha = 1 - p
      ctx.strokeStyle = tint
      ctx.lineWidth = 3 * unit
      ctx.beginPath()
      ctx.arc(x, y, (10 + 26 * p) * unit, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 0.9 * (1 - p * 0.6)
      ctx.fillStyle = tint
      ctx.beginPath()
      ctx.arc(x, y, 7 * unit, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    // The pointer glides to where it clicked, and stays there.
    if (job.opts.cursor !== false && job.pointer) {
      const p = ease((now - job.pointer.at) / GLIDE_MS)
      const fx = job.pointer.fx + (job.pointer.tx - job.pointer.fx) * p
      const fy = job.pointer.fy + (job.pointer.ty - job.pointer.fy) * p
      arrow(ctx, r.x + fx * r.w, r.y + fy * r.h, unit)
    }
  }

  // Narration along the bottom; the newest action's caption sits above it (or at the bottom alone).
  if (job.caption && now >= job.caption.until) job.caption = null
  const band = job.caption ? narration(ctx, job.caption.text, cw, ch, unit, fade(job.caption, now)) : 0
  const last = actions ? job.marks[job.marks.length - 1] : undefined
  if (!last) return
  const t = now - last.at
  const alpha = t < 150 ? t / 150 : t > CAPTION_MS - 300 ? Math.max(0, (CAPTION_MS - t) / 300) : 1
  const h = (18 + 22) * unit
  pill(ctx, last.label, cw / 2, ch - h - 28 * unit - band, 18, unit, alpha, cw * 0.7)
}

/** Records while something happens; pauses (leaving it out of the video) while the page sits still. */
function pace(job: Job, now: number) {
  const m = job.media
  if (!m) return
  const showing = !!job.title || !!job.caption || job.highlights.length > 0
  const busy = !job.paused && (job.opts.keepStill || showing || now - job.lastChange < HOLD_MS || job.marks.length > 0)
  if (busy && m.state === 'paused') m.resume()
  else if (!busy && m.state === 'recording') m.pause()
}

function cue(job: Job, c: RecordCue) {
  const now = performance.now()
  if (c.type === 'pause') job.paused = true
  else if (c.type === 'resume') {
    job.paused = false
    job.lastChange = now
  } else if (c.type === 'title') job.title = { text: c.text, subtitle: c.subtitle, at: now, until: now + (c.seconds ?? 2.5) * 1000 }
  else if (c.type === 'caption') job.caption = { text: c.text, at: now, until: now + (c.seconds ?? 3) * 1000 }
  else job.highlights.push({ fx: c.fx, fy: c.fy, fw: c.fw, fh: c.fh, label: c.label, at: now, until: now + (c.seconds ?? 3) * 1000 })
  pace(job, now)
}

export function startRecorder() {
  if (started) return
  started = true
  window.glassbox.recorder.on((m) => {
    if (m.kind === 'start') {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const opts = m.opts ?? {}
      const job: Job = {
        canvas,
        ctx,
        media: null,
        chunks: [],
        latest: null,
        timer: 0,
        fps: m.fps,
        lastChange: performance.now(),
        marks: [],
        opts,
        title: null,
        opening: opts.title ? { text: opts.title, subtitle: opts.subtitle } : null,
        caption: null,
        highlights: [],
        paused: false,
        pointer: null
      }
      // Redraw at the frame rate even when no new frame came, so ripples, captions and cards animate.
      job.timer = window.setInterval(() => {
        const now = performance.now()
        draw(job, now)
        pace(job, now)
      }, 1000 / m.fps)
      jobs.set(m.id, job)
    } else if (m.kind === 'mark') {
      const job = jobs.get(m.id)
      if (!job) return
      const now = performance.now()
      job.marks.push({ label: m.label, fx: m.fx, fy: m.fy, at: now })
      if (m.fx !== undefined && m.fy !== undefined) {
        // From where it last was (or just short of the target the first time).
        const from = job.pointer ? { x: job.pointer.tx, y: job.pointer.ty } : { x: Math.min(1, m.fx + 0.08), y: Math.min(1, m.fy + 0.1) }
        job.pointer = { fx: from.x, fy: from.y, tx: m.fx, ty: m.fy, at: now }
      }
      job.lastChange = now
      pace(job, now)
    } else if (m.kind === 'cue') {
      const job = jobs.get(m.id)
      if (job) cue(job, m.cue)
    } else if (m.kind === 'frame') {
      const job = jobs.get(m.id)
      if (!job) return
      void createImageBitmap(new Blob([m.jpeg as BlobPart], { type: 'image/jpeg' })).then((bmp) => {
        job.latest?.close()
        job.latest = bmp
        job.lastChange = performance.now()
        // The first frame sets the video's size (the page's own shape, or the standard frame asked
        // for); later frames fit inside it.
        if (!job.media) {
          const fixed = job.opts.size && job.opts.size !== 'page' ? SIZES[job.opts.size] : null
          job.canvas.width = fixed ? fixed[0] : Math.max(2, bmp.width - (bmp.width % 2))
          job.canvas.height = fixed ? fixed[1] : Math.max(2, bmp.height - (bmp.height % 2))
          if (job.opening) {
            const now = performance.now()
            // Already up when the video starts (no fade in over the bare page).
            job.title = { ...job.opening, at: now - FADE_MS, until: now + 2500 }
            job.opening = null
          }
          draw(job, performance.now())
          const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
          job.media = new MediaRecorder(job.canvas.captureStream(job.fps), { mimeType: type, videoBitsPerSecond: fixed && fixed[0] > 1280 ? 8_000_000 : 5_000_000 })
          job.media.ondataavailable = (e) => e.data.size && job.chunks.push(e.data)
          job.media.start(1000)
        }
      })
    } else if (m.kind === 'stop') {
      const job = jobs.get(m.id)
      jobs.delete(m.id)
      if (!job) return void window.glassbox.recorder.encoded(m.id, null)
      clearInterval(job.timer)
      const finish = () => {
        job.latest?.close()
        const blob = new Blob(job.chunks, { type: 'video/webm' })
        void blob.arrayBuffer().then((buf) => window.glassbox.recorder.encoded(m.id, buf.byteLength ? buf : null))
      }
      if (!job.media || job.media.state === 'inactive') return finish()
      if (job.media.state === 'paused') job.media.resume()
      job.media.onstop = finish
      job.media.stop()
    }
  })
}
