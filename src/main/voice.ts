import { join } from 'node:path'
import { app } from 'electron'

/** Speech model: English Whisper, quantised (~80 MB, downloaded once into the app's data folder). */
const MODEL = 'onnx-community/whisper-base.en'

export type VoiceProgress = { status: 'downloading' | 'loading' | 'ready'; progress?: number; file?: string }

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

let loading: Promise<Transcriber> | undefined

/**
 * Local speech-to-text. Runs Whisper on the CPU in the main process, so audio never leaves the
 * machine and nothing is sent to a speech service.
 */
export function prepareVoice(onProgress: (p: VoiceProgress) => void): Promise<Transcriber> {
  loading ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(app.getPath('userData'), 'models')
    const files = new Map<string, number>()
    const asr = await pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === 'progress' && p.file) {
          files.set(p.file, p.progress ?? 0)
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size
          onProgress({ status: 'downloading', progress: Math.round(avg), file: p.file })
        } else if (p.status === 'ready') onProgress({ status: 'loading' })
      }
    })
    onProgress({ status: 'ready' })
    return asr as unknown as Transcriber
  })()
  // A failed load (e.g. offline on first use) can be retried.
  loading.catch(() => (loading = undefined))
  return loading
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
  const turn = busy.then(() => run(audio, onProgress))
  busy = turn.catch(() => undefined)
  try {
    return await turn
  } finally {
    running--
  }
}

async function run(audio: Float32Array, onProgress: (p: VoiceProgress) => void): Promise<string> {
  // Too short to be speech, or effectively silent: Whisper hallucinates on these, so skip them.
  if (audio.length < 16_000 * 0.8 || !hasSpeech(audio)) return ''
  const asr = await prepareVoice(onProgress)
  const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 })
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
  // Whisper emits these for silence or noise.
  if (/^[[(](blank_audio|silence|music|inaudible|no speech)[\])]$/i.test(text)) return ''
  // Runaway repetition ("AHHHH…", "the the the …") is a hallucination, not what was said.
  if (/(.)\1{11,}/.test(text) || /\b(\w+)(?:\W+\1\b){5,}/i.test(text)) return ''
  return text
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
