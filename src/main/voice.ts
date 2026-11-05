import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as pipe } from 'node:stream/promises'
import { app } from 'electron'
import { automation } from './automation'

/**
 * Speech models, downloaded once into the app's data folder. Whisper base (English, ~80 MB) is the
 * quick one: ready first, and it writes the live words while you talk. With "More accurate
 * dictation" on, NVIDIA's Parakeet Unified English (0.6B, int8, ~630 MB, run by sherpa-onnx)
 * downloads in the background and writes the final transcript when you let go: noticeably fewer
 * mistakes than Whisper, about two seconds for ten seconds of speech on a laptop CPU (too slow to
 * keep up live).
 */
const LIVE_MODEL = 'onnx-community/whisper-base.en'
const PARAKEET = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming.tar.bz2',
  folder: 'sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming'
}

export type VoiceProgress = { status: 'downloading' | 'loading' | 'ready'; progress?: number; file?: string }

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

const loading = new Map<string, Promise<Transcriber>>()

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
    onProgress?.({ status: 'ready' })
    return asr as unknown as Transcriber
  })()
  loading.set(model, job)
  // A failed load (e.g. offline on first use) can be retried.
  job.catch(() => loading.delete(model))
  return job
}

/** Where Parakeet is, and how its download is going (Settings shows this). */
export type ParakeetStatus = { state: 'missing' | 'downloading' | 'unpacking' | 'loading' | 'ready' | 'failed'; progress?: number; error?: string }
let parakeetStatus: ParakeetStatus = { state: 'missing' }
let parakeet: Promise<Transcriber> | null = null
const parakeetRoot = () => join(app.getPath('userData'), 'models', 'parakeet')
const parakeetFiles = () => {
  const dir = join(parakeetRoot(), PARAKEET.folder)
  return { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx'), tokens: join(dir, 'tokens.txt') }
}
/** Downloaded already, but not loaded yet this run. */
const parakeetOnDisk = () => existsSync(parakeetFiles().encoder) && existsSync(parakeetFiles().tokens)
export function getParakeetStatus(): ParakeetStatus {
  return parakeetStatus.state === 'missing' && parakeetOnDisk() ? { state: 'loading' } : parakeetStatus
}

/** Downloads a file with progress, by way of a .part file (so a half download is never taken for a whole one). */
async function download(url: string, file: string, onProgress: (percent: number) => void) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let shown = -1
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct !== shown) onProgress((shown = pct))
  })
  await pipe(body, createWriteStream(`${file}.part`))
  renameSync(`${file}.part`, file)
}

type Recognizer = {
  createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void }
  decodeAsync: (s: unknown) => Promise<void>
  getResult: (s: unknown) => { text?: string }
}

/** Parakeet: downloaded and unpacked on first use, then loaded. After a failure, calling again tries again. */
export function loadParakeet(): Promise<Transcriber> {
  if (parakeet) return parakeet
  parakeet = (async () => {
    const f = parakeetFiles()
    if (!parakeetOnDisk()) {
      mkdirSync(parakeetRoot(), { recursive: true })
      const archive = join(parakeetRoot(), 'model.tar.bz2')
      // A whole download from an earlier try (only a finished one loses its .part) is unpacked, not fetched again.
      if (!existsSync(archive)) {
        parakeetStatus = { state: 'downloading', progress: 0 }
        await download(PARAKEET.url, archive, (progress) => (parakeetStatus = { state: 'downloading', progress }))
      }
      // tar comes with Windows 10 and later (System32's, by its full path: Git's tar, often first on
      // PATH, reads "C:" as a remote host), and with macOS. Run in the folder with a relative name,
      // so no drive letter reaches it at all.
      parakeetStatus = { state: 'unpacking' }
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      await new Promise<void>((done, fail) => execFile(tar, ['-xjf', 'model.tar.bz2'], { cwd: parakeetRoot(), windowsHide: true, timeout: 10 * 60_000 }, (err) => (err ? fail(err) : done())))
      rmSync(archive, { force: true })
    }
    parakeetStatus = { state: 'loading' }
    const mod = (await import('sherpa-onnx-node')) as { default?: unknown }
    const lib = (mod.default ?? mod) as { OfflineRecognizer: { createAsync: (config: unknown) => Promise<Recognizer> } }
    const recognizer = await lib.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, tokens: f.tokens, numThreads: Math.max(1, Math.min(4, cpus().length - 1)), provider: 'cpu', modelType: 'nemo_transducer', debug: 0 },
      decodingMethod: 'greedy_search'
    })
    parakeetStatus = { state: 'ready' }
    const transcribe: Transcriber = async (audio) => {
      const stream = recognizer.createStream()
      // Its own copy: a piece is a view into the whole recording, which the addon mustn't be handed.
      stream.acceptWaveform({ sampleRate: 16_000, samples: new Float32Array(audio) })
      await recognizer.decodeAsync(stream)
      return { text: recognizer.getResult(stream).text ?? '' }
    }
    return transcribe
  })()
  // Offline on first use, say: tried again next time.
  parakeet.catch((e: unknown) => {
    parakeetStatus = { state: 'failed', error: e instanceof Error ? e.message : String(e) }
    parakeet = null
    rmSync(join(parakeetRoot(), 'model.tar.bz2.part'), { force: true })
  })
  return parakeet
}

/**
 * Local speech-to-text. Runs on the CPU in the main process, so audio never leaves the machine and
 * nothing is sent to a speech service. Readies Whisper (with progress shown), then Parakeet quietly
 * in the background.
 */
export function prepareVoice(onProgress: (p: VoiceProgress) => void): Promise<Transcriber> {
  const live = loadModel(LIVE_MODEL, onProgress)
  if (automation().voiceAccurate) void live.then(() => loadParakeet()).catch(() => undefined)
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
export async function transcribe(audio: Float32Array, onProgress: (p: VoiceProgress) => void, live = false, offset = 0): Promise<string> {
  if (live && running) return ''
  running++
  const turn = busy.then(() => run(audio, onProgress, live, offset))
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
const live = { end: 0, done: new Map<string, string>() }

/**
 * `offset`: where this clip starts in the whole recording (samples at 16 kHz). Live passes send only
 * the recent stretch, so pieces are remembered by their place in the whole recording: a piece of an
 * earlier window must never stand in for different audio that happens to sit at the same place in
 * a later one (that's what made long dictation turn into unrelated sentences after ~25 seconds).
 */
async function run(audio: Float32Array, onProgress: (p: VoiceProgress) => void, isLive: boolean, offset: number): Promise<string> {
  // Too short to be speech, or effectively silent: Whisper hallucinates on these, so skip them.
  if (audio.length < 16_000 * 0.8 || !hasSpeech(audio)) return ''
  // The final transcript: Parakeet once it's ready (until its first download finishes, Whisper).
  const asr = !isLive && automation().voiceAccurate && parakeetStatus.state === 'ready' ? await loadParakeet() : await prepareVoice(onProgress)
  // A new recording (it ends earlier than the last live pass did) starts the live pieces afresh.
  if (!isLive || offset + audio.length < live.end) live.done.clear()
  live.end = isLive ? offset + audio.length : 0
  const pieces = segments(audio)
  const texts: string[] = []
  for (let i = 0; i < pieces.length; i++) {
    const { from, to } = pieces[i]
    const key = `${offset + from}:${offset + to}`
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
  return applyWords(texts.filter(Boolean).join(' '))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * Your words, written your way: each thing the model heard instead ("skew") becomes the word ("SKU"),
 * whole words only and whatever the case. An all-capitals word also replaces itself spelled out
 * letter by letter ("S K U", "S.K.U.") and in other cases ("sku").
 */
export function applyWords(text: string): string {
  let out = text
  for (const { word, heard } of automation().voiceWords ?? []) {
    const w = word.trim()
    if (!w) continue
    const forms = new Set(heard.map((h) => h.trim()).filter(Boolean))
    forms.add(w)
    if (/^[A-Z0-9]{2,6}$/.test(w)) {
      forms.add(w.split('').join(' '))
      forms.add(w.split('').join('. ') + '.')
      forms.add(w.split('').join('.') + '.')
    }
    for (const f of [...forms].sort((a, b) => b.length - a.length)) {
      const parts = f.split(/\s+/).map(escapeRe).join('[\\s,.-]*')
      out = out.replace(new RegExp(`(?<![\\w])${parts}(?![\\w])`, 'gi'), w)
    }
  }
  return out
}

/** A piece's text, without what a model says for silence or noise, and without runaway repetition. */
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
