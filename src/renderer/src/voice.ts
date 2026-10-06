import { useCallback, useEffect, useRef, useState } from 'react'
import { tr } from '../../shared/i18n'
import captureWorklet from './capture-worklet.js?url&no-inline'

/** 'starting': the mic is opening, so nothing is recorded yet (only on the first hold in a while). */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'transcribing'
export type ModelStatus = { status: 'downloading' | 'loading' | 'ready'; progress?: number } | null

const SAMPLE_RATE = 16_000
/** After you finish speaking the mic stays open this long, so the next hold starts at once. */
const WARM_MS = 2 * 60_000
/** Audio kept from just before a hold starts recording, so the first word isn't lost while Space is held down. */
const PRE_ROLL_S = 0.5
/** How often the words so far are transcribed while you talk. */
const LIVE_EVERY_MS = 600
/** Live transcription looks at the most recent stretch only, so it stays quick on a long take. */
const LIVE_WINDOW_S = 25

/**
 * The microphone, opened once and kept warm for a while: Windows can take a second or more to open
 * it (longer with a Bluetooth headset), which made every hold wait. Captured as 16 kHz samples
 * straight from the mic, so there's nothing to decode afterwards.
 */
type Mic = { stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode; ring: Float32Array; ringAt: number; rate: number }
let mic: Mic | null = null
let opening: Promise<Mic> | null = null
let closeTimer: ReturnType<typeof setTimeout> | undefined
/** While recording, every chunk also goes here; between holds only the short pre-roll ring is kept. */
let sink: ((chunk: Float32Array) => void) | null = null
let level = 0

/** Let go of the mic at once (its device went away, or it's no longer needed). */
function dropMic() {
  const m = mic
  mic = null
  if (!m) return
  try {
    m.node.disconnect()
  } catch {
    /* already disconnected */
  }
  m.stream.getTracks().forEach((t) => t.stop())
  void m.ctx.close().catch(() => undefined)
}

const alive = (m: Mic) => m.ctx.state !== 'closed' && m.stream.getAudioTracks().some((t) => t.readyState === 'live' && !t.muted)

async function openMic(): Promise<Mic> {
  if (mic && !alive(mic)) dropMic()
  if (mic) {
    if (mic.ctx.state === 'suspended') await mic.ctx.resume().catch(() => undefined)
    return mic
  }
  opening ??= (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    try {
      return await wire(stream)
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      throw e
    }
  })()
  try {
    return await opening
  } finally {
    opening = null
  }
}

async function wire(stream: MediaStream): Promise<Mic> {
  // Recorded at the mic's own rate (full quality) and resampled to 16 kHz properly before each
  // transcription; asking the browser for 16 kHz live cost accuracy.
  const ctx = new AudioContext()
  // Captured on the audio thread (see capture-worklet.js): a busy page can't drop samples.
  await ctx.audioWorklet.addModule(captureWorklet)
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'glassbox-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
  const m: Mic = { stream, ctx, node, ring: new Float32Array(Math.round(ctx.sampleRate * PRE_ROLL_S)), ringAt: 0, rate: ctx.sampleRate }
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const chunk = e.data
    let peak = 0
    for (const v of chunk) peak = Math.max(peak, Math.abs(v))
    level = Math.min(1, peak * 2.5)
    if (sink) sink(chunk)
    // The pre-roll ring: the last half-second, always.
    for (const v of chunk) (m.ring[m.ringAt] = v), (m.ringAt = (m.ringAt + 1) % m.ring.length)
  }
  source.connect(node)
  // Connected to the output so the audio graph keeps pulling it; it writes nothing there.
  node.connect(ctx.destination)
  // The device went away (unplugged, the PC slept): drop the mic so the next hold opens a fresh one.
  for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => mic === m && !sink && dropMic())
  mic = m
  return m
}

function closeMicSoon() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    if (!sink) dropMic()
  }, WARM_MS)
}

/** Samples at the mic's rate, as the 16 kHz the speech model wants (a proper resample, not a pick of every nth sample). */
async function to16k(x: Float32Array, rate: number): Promise<Float32Array<ArrayBuffer>> {
  const copy = new Float32Array(x)
  if (rate === SAMPLE_RATE || !copy.length) return copy
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((copy.length * SAMPLE_RATE) / rate)), SAMPLE_RATE)
  const buf = off.createBuffer(1, copy.length, rate)
  buf.copyToChannel(copy, 0)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  return new Float32Array((await off.startRendering()).getChannelData(0))
}

const preRoll = (m: Mic) => new Float32Array([...m.ring.subarray(m.ringAt), ...m.ring.subarray(0, m.ringAt)])
const join = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, at), (at += p.length)
  return out
}

/**
 * Push-to-talk. `start` records (at once if the mic is warm); while you talk, `partial` holds the
 * words so far; `stop` resolves with the final transcript. All local (Whisper in the main process),
 * so audio never leaves the machine.
 */
export function useVoice() {
  const [state, setState] = useState<VoiceState>('idle')
  const [meter, setMeter] = useState(0)
  const [partial, setPartial] = useState('')
  const [model, setModel] = useState<ModelStatus>(null)
  const [error, setError] = useState<string | null>(null)
  const take = useRef<{ parts: Float32Array[]; length: number; rate: number; raf: number; live: ReturnType<typeof setInterval>; busy: boolean; heard: number } | null>(null)
  const cancelled = useRef(false)
  const startedAt = useRef<Promise<void> | null>(null)

  useEffect(() => window.glassbox.voice.onProgress(setModel), [])

  const finishTake = () => {
    const t = take.current
    if (!t) return null
    cancelAnimationFrame(t.raf)
    clearInterval(t.live)
    sink = null
    take.current = null
    setMeter(0)
    closeMicSoon()
    return join(t.parts)
  }

  const start = useCallback(async () => {
    if (take.current || startedAt.current) return
    setError(null)
    setPartial('')
    cancelled.current = false
    clearTimeout(closeTimer)
    let done!: () => void
    startedAt.current = new Promise<void>((r) => (done = r))
    try {
      if (!mic) setState('starting')
      const m = await openMic()
      if (cancelled.current) return closeMicSoon(), setState('idle')
      const first = preRoll(m)
      const t = { parts: [first] as Float32Array[], length: first.length, rate: m.rate, raf: 0, live: 0 as unknown as ReturnType<typeof setInterval>, busy: false, heard: 0 }
      take.current = t
      sink = (chunk) => (t.parts.push(chunk), (t.length += chunk.length))
      const tick = () => {
        setMeter(level)
        if (take.current === t) t.raf = requestAnimationFrame(tick)
      }
      t.raf = requestAnimationFrame(tick)
      // Live transcription: the words so far, every LIVE_EVERY_MS, one request at a time.
      t.live = setInterval(() => {
        if (t.busy || take.current !== t) return
        if (t.length - t.heard < t.rate * 0.4) return
        t.busy = true
        t.heard = t.length
        // Only the recent stretch is joined and sent, however long the take has run.
        const want = t.rate * LIVE_WINDOW_S
        const tail: Float32Array[] = []
        let got = 0
        for (let i = t.parts.length - 1; i >= 0 && got < want; i--) tail.unshift(t.parts[i]), (got += t.parts[i].length)
        const recent = join(tail)
        const trimmed = got < t.length
        void to16k(recent, t.rate)
          .then((clip) => window.glassbox.voice.transcribe(clip, true))
          .then((text) => take.current === t && text && setPartial(trimmed ? `…${text}` : text))
          .catch(() => undefined)
          .finally(() => (t.busy = false))
      }, LIVE_EVERY_MS)
      setState('listening')
      // Load (or first-time download) the model while you speak. Only now: loading it ties up the
      // main process, which opening the mic goes through.
      void window.glassbox.voice.prepare().catch((e) => setError(tr('voice.couldNotLoadModel', { error: String(e) })))
    } catch (e) {
      setState('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? tr('voice.micBlocked') : tr('voice.couldNotOpenMic', { error: String(e) }))
    } finally {
      startedAt.current = null
      done()
    }
  }, [])

  const stop = useCallback(async (): Promise<string> => {
    if (startedAt.current) await startedAt.current
    const rate = take.current?.rate ?? SAMPLE_RATE
    const audio = finishTake()
    if (!audio || audio.length < rate * 0.3) {
      setState('idle')
      setPartial('')
      return ''
    }
    setState('transcribing')
    try {
      return await window.glassbox.voice.transcribe(await to16k(audio, rate))
    } catch (e) {
      setError(tr('voice.couldNotTranscribe', { error: String(e) }))
      return ''
    } finally {
      setState('idle')
      setPartial('')
    }
  }, [])

  const cancel = useCallback(() => {
    if (startedAt.current) {
      cancelled.current = true
      return
    }
    finishTake()
    setPartial('')
    setState('idle')
  }, [])

  useEffect(() => cancel, [cancel])

  return { state, level: meter, partial, model, error, start, stop, cancel, clearError: () => setError(null) }
}
