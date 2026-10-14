/**
 * The encoding half of Browser recordings. The main process sends a tab's frames; they're drawn on
 * a canvas at a steady rate (a still page keeps its last frame) and MediaRecorder turns the canvas
 * into a WebM, which goes back to be saved. Runs for the app's lifetime, outside React.
 */

type Job = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; media: MediaRecorder | null; chunks: Blob[]; latest: ImageBitmap | null; timer: number; fps: number }

const jobs = new Map<string, Job>()
let started = false

export function startRecorder() {
  if (started) return
  started = true
  window.glassbox.recorder.on((m) => {
    if (m.kind === 'start') {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const job: Job = { canvas, ctx, media: null, chunks: [], latest: null, timer: 0, fps: m.fps }
      // Redraw at the frame rate even when no new frame came: the video keeps time while the page is still.
      job.timer = window.setInterval(() => job.latest && ctx.drawImage(job.latest, 0, 0), 1000 / m.fps)
      jobs.set(m.id, job)
    } else if (m.kind === 'frame') {
      const job = jobs.get(m.id)
      if (!job) return
      void createImageBitmap(new Blob([m.jpeg as BlobPart], { type: 'image/jpeg' })).then((bmp) => {
        job.latest?.close()
        job.latest = bmp
        // The first frame sets the size; the recording starts with it.
        if (!job.media) {
          job.canvas.width = bmp.width - (bmp.width % 2)
          job.canvas.height = bmp.height - (bmp.height % 2)
          job.ctx.drawImage(bmp, 0, 0)
          const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
          job.media = new MediaRecorder(job.canvas.captureStream(job.fps), { mimeType: type, videoBitsPerSecond: 4_000_000 })
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
      job.media.onstop = finish
      job.media.stop()
    }
  })
}
