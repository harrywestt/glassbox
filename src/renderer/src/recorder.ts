/**
 * The encoding half of Browser recordings. The main process sends a tab's frames; they're drawn on
 * a canvas and MediaRecorder turns the canvas into a WebM, which goes back to be saved. Runs for the
 * app's lifetime, outside React.
 *
 * Made to be watched: each frame is drawn at the page's own proportions (never stretched); the
 * time Claude spends deciding its next step is left out (the recording pauses while nothing on the
 * page changes); and every click shows a ripple where it landed, with a caption saying what was
 * clicked, typed or pressed.
 */

type Mark = { label: string; fx?: number; fy?: number; at: number }
type Job = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; media: MediaRecorder | null; chunks: Blob[]; latest: ImageBitmap | null; timer: number; fps: number; lastChange: number; marks: Mark[] }

/** A still page is kept for this long, then the recording pauses until something happens. */
const HOLD_MS = 1200
/** How long a click's ripple and an action's caption stay on screen. */
const RIPPLE_MS = 700
const CAPTION_MS = 1800

const jobs = new Map<string, Job>()
let started = false

/** Where the frame sits on the canvas: scaled to fit, centred, never stretched. */
function fit(job: Job, bmp: ImageBitmap) {
  const { width: cw, height: ch } = job.canvas
  const s = Math.min(cw / bmp.width, ch / bmp.height)
  const w = bmp.width * s
  const h = bmp.height * s
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h }
}

function draw(job: Job, now: number) {
  const { ctx, canvas, latest } = job
  if (!latest) return
  const r = fit(job, latest)
  if (r.w < canvas.width - 1 || r.h < canvas.height - 1) {
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(latest, r.x, r.y, r.w, r.h)
  job.marks = job.marks.filter((m) => now - m.at < CAPTION_MS)
  const unit = Math.max(1, canvas.width / 1280)
  for (const m of job.marks) {
    const t = now - m.at
    if (m.fx === undefined || m.fy === undefined || t >= RIPPLE_MS) continue
    const x = r.x + m.fx * r.w
    const y = r.y + m.fy * r.h
    const p = t / RIPPLE_MS
    ctx.save()
    ctx.globalAlpha = 1 - p
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 3 * unit
    ctx.beginPath()
    ctx.arc(x, y, (10 + 26 * p) * unit, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 0.9 * (1 - p * 0.6)
    ctx.fillStyle = '#3b82f6'
    ctx.beginPath()
    ctx.arc(x, y, 7 * unit, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  // The newest action's caption, bottom centre.
  const last = job.marks[job.marks.length - 1]
  if (!last) return
  const t = now - last.at
  ctx.save()
  ctx.globalAlpha = t < 150 ? t / 150 : t > CAPTION_MS - 300 ? Math.max(0, (CAPTION_MS - t) / 300) : 1
  ctx.font = `600 ${Math.round(18 * unit)}px "Segoe UI", system-ui, -apple-system, sans-serif`
  const text = last.label.length > 70 ? last.label.slice(0, 69) + '…' : last.label
  const padX = 16 * unit
  const h = 40 * unit
  const w = ctx.measureText(text).width + padX * 2
  const x = (canvas.width - w) / 2
  const y = canvas.height - h - 28 * unit
  ctx.fillStyle = 'rgba(17, 19, 24, 0.86)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 10 * unit)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, y + h / 2 + 1)
  ctx.restore()
}

/** Records while something happens; pauses (leaving it out of the video) while the page sits still. */
function pace(job: Job, now: number) {
  const m = job.media
  if (!m) return
  const busy = now - job.lastChange < HOLD_MS || job.marks.length > 0
  if (busy && m.state === 'paused') m.resume()
  else if (!busy && m.state === 'recording') m.pause()
}

export function startRecorder() {
  if (started) return
  started = true
  window.glassbox.recorder.on((m) => {
    if (m.kind === 'start') {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const job: Job = { canvas, ctx, media: null, chunks: [], latest: null, timer: 0, fps: m.fps, lastChange: performance.now(), marks: [] }
      // Redraw at the frame rate even when no new frame came, so ripples and captions animate.
      job.timer = window.setInterval(() => {
        const now = performance.now()
        draw(job, now)
        pace(job, now)
      }, 1000 / m.fps)
      jobs.set(m.id, job)
    } else if (m.kind === 'mark') {
      const job = jobs.get(m.id)
      if (!job) return
      job.marks.push({ label: m.label, fx: m.fx, fy: m.fy, at: performance.now() })
      job.lastChange = performance.now()
      pace(job, job.lastChange)
    } else if (m.kind === 'frame') {
      const job = jobs.get(m.id)
      if (!job) return
      void createImageBitmap(new Blob([m.jpeg as BlobPart], { type: 'image/jpeg' })).then((bmp) => {
        job.latest?.close()
        job.latest = bmp
        job.lastChange = performance.now()
        // The first frame sets the video's size (the page's own shape); later frames fit inside it.
        if (!job.media) {
          job.canvas.width = Math.max(2, bmp.width - (bmp.width % 2))
          job.canvas.height = Math.max(2, bmp.height - (bmp.height % 2))
          draw(job, performance.now())
          const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
          job.media = new MediaRecorder(job.canvas.captureStream(job.fps), { mimeType: type, videoBitsPerSecond: 5_000_000 })
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
