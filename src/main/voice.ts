import { join } from 'node:path'
import { app } from 'electron'
import { automation } from './automation'

/**
 * Speech models: English Whisper, quantised, downloaded once into the app's data folder. The small
 * one (~80 MB) writes the live words while you talk; the larger one (~240 MB) writes the final
 * transcript when you let go: about half the mistakes on regional accents, a second or two slower.
 */
const LIVE_MODEL = 'onnx-community/whisper-base.en'
const FINAL_MODEL = 'onnx-community/whisper-small.en'

export type VoiceProgress = { status: 'downloading' | 'loading' | 'ready'; progress?: number; file?: string }

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

const loading = new Map<string, Promise<Transcriber>>()
const ready = new Set<string>()

function loadModel(model: string, onProgress?: (p: VoiceProgress) => void): Promise<Transcriber> {
  let job = loading.get(model)
  if (job) return job
  job = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(app.getPath('userData'), 'models')
    const files = new Map<string, number>()
    const asr = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (!onProgress) return
        if (p.status === 'progress' && p.file) {
          files.set(p.file, p.progress ?? 0)
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size
          onProgress({ status: 'downloading', progress: Math.round(avg), file: p.file })
        } else if (p.status === 'ready') onProgress({ status: 'loading' })
      }
    })
    ready.add(model)
    onProgress?.({ status: 'ready' })
    return asr as unknown as Transcriber
  })()
  loading.set(model, job)
  // A failed load (e.g. offline on first use) can be retried.
  job.catch(() => loading.delete(model))
  return job
}

/**
 * Local speech-to-text. Runs Whisper on the CPU in the main process, so audio never leaves the
 * machine and nothing is sent to a speech service. Readies the live model (with progress shown),
 * then the final one quietly in the background.
 */
export function prepareVoice(onProgress: (p: VoiceProgress) => void): Promise<Transcriber> {
  const live = loadModel(LIVE_MODEL, onProgress)
  if (automation().voiceAccurate) void live.then(() => loadModel(FINAL_MODEL)).catch(() => undefined)
  return live
}

/**
 * One transcription at a time: running the model on two clips at once (a live pass still going as
 * the final one starts) garbles both. A live pass is skipped when the model is busy; the final pass
 * waits its turn and then runs alone.
 */
let busy: Promise<unknown> = Promise.resolve()
let running = 0

/** Transcribes 16 kHz mono samples. `live`: a quick pass while you're still talking, skipped if the model is busy. */
export async function transcribe(audio: Float32Array, onProgress: (p: VoiceProgress) => void, live = false): Promise<string> {
  if (live && running) return ''
  running++
  const turn = busy.then(() => run(audio, onProgress, live))
  busy = turn.catch(() => undefined)
  try {
    return await turn
  } finally {
    running--
  }
}

/**
 * Whisper hears 30 seconds at a time. Its own chunking of a longer recording garbled or dropped
 * whole stretches when the windows held long pauses or room noise (a third of a 90-second take
 * lost). So a recording is cut at natural pauses into pieces of up to 28 seconds; pieces with no
 * speech are skipped (Whisper invents sentences for silence); each piece is transcribed on its own.
 *
 * While you talk, finished pieces are transcribed once and kept: each live pass only redoes the
 * piece you're still speaking, so the live words stay quick however long you go on.
 */
const live = { length: 0, done: new Map<string, string>() }

async function run(audio: Float32Array, onProgress: (p: VoiceProgress) => void, isLive: boolean): Promise<string> {
  // Too short to be speech, or effectively silent: Whisper hallucinates on these, so skip them.
  if (audio.length < 16_000 * 0.8 || !hasSpeech(audio)) return ''
  // The final transcript uses the larger model once it's ready (until its first download finishes, the small one).
  const asr = !isLive && automation().voiceAccurate && ready.has(FINAL_MODEL) ? await loadModel(FINAL_MODEL) : await prepareVoice(onProgress)
  // A new recording starts the live pieces afresh.
  if (!isLive || audio.length < live.length) live.done.clear()
  live.length = isLive ? audio.length : 0
  const pieces = segments(audio)
  const texts: string[] = []
  for (let i = 0; i < pieces.length; i++) {
    const { from, to } = pieces[i]
    const key = `${from}:${to}`
    const last = i === pieces.length - 1
    // Live: a finished piece is transcribed once; the one still being spoken every pass.
    if (isLive && !last && live.done.has(key)) {
      texts.push(live.done.get(key)!)
      continue
    }
    const out = await asr(audio.subarray(from, to))
    const text = clean((Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim())
    if (isLive && !last) live.done.set(key, text)
    texts.push(text)
  }
  return texts.filter(Boolean).join(' ')
}

/** A piece's text, without what Whisper says for silence or noise, and without runaway repetition. */
function clean(text: string): string {
  if (/^[[(](blank_audio|silence|music|inaudible|no speech)[\])]$/i.test(text)) return ''
  // Runaway repetition ("AHHHH…", "the the the …") is a hallucination, not what was said.
  if (/(.)\1{11,}/.test(text) || /\b(\w+)(?:\W+\1\b){5,}/i.test(text)) return ''
  return text
}

/**
 * Where to cut a recording: at pauses, into pieces of at most `max` seconds, leaving out pieces
 * with no speech in them. Sample offsets into the 16 kHz audio.
 */
export function segments(audio: Float32Array, max = 28): { from: number; to: number }[] {
  const frame = 480 // 30 ms
  const rms: number[] = []
  for (let i = 0; i + frame <= audio.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += audio[j] * audio[j]
    rms.push(Math.sqrt(sum / frame))
  }
  // Quiet is relative to this recording's own background (a fan, a hum), with a floor.
  const sorted = [...rms].sort((a, b) => a - b)
  const quiet = Math.max(0.008, (sorted[Math.floor(sorted.length * 0.1)] ?? 0) * 3)
  const maxFrames = Math.floor((max * 16_000) / frame)
  const cuts: [number, number][] = []
  let start = 0
  while (start < rms.length) {
    if (rms.length - start <= maxFrames) {
      cuts.push([start, rms.length])
      break
    }
    // The middle of the longest pause in the second half of the window; failing that, its quietest moment.
    let cut = -1
    let best = 0
    let run = 0
    for (let f = start + Math.floor(maxFrames / 2); f < start + maxFrames; f++) {
      if (rms[f] < quiet) {
        run++
        if (run > best) (best = run), (cut = f - Math.floor(run / 2))
      } else run = 0
    }
    if (cut < 0) {
      let lowest = Infinity
      for (let f = start + Math.floor(maxFrames * 0.6); f < start + maxFrames; f++) if (rms[f] < lowest) (lowest = rms[f]), (cut = f)
    }
    cuts.push([start, cut])
    start = cut
  }
  return cuts
    .filter(([a, b]) => b - a > 15 && rms.slice(a, b).some((v) => v > 0.02))
    .map(([a, b]) => ({ from: a * frame, to: Math.min(audio.length, b * frame) }))
}

/** True if any 50 ms window is loud enough to be speech rather than room noise. */
function hasSpeech(audio: Float32Array): boolean {
  const win = 800
  for (let i = 0; i + win <= audio.length; i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += audio[j] * audio[j]
    if (Math.sqrt(sum / win) > 0.02) return true
  }
  return false
}
