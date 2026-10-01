import { useCallback, useEffect, useRef, useState } from 'react'

/** 'starting': the mic is opening (about half a second on Windows), so nothing is recorded yet. */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'transcribing'
export type ModelStatus = { status: 'downloading' | 'loading' | 'ready'; progress?: number } | null

const SAMPLE_RATE = 16_000

/**
 * Push-to-talk recording. `start` opens the mic; `stop` resolves with the transcript, made
 * locally by the main process (Whisper), so audio never leaves the machine.
 */
export function useVoice() {
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [model, setModel] = useState<ModelStatus>(null)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; ctx: AudioContext; raf: number } | null>(null)
  // The microphone takes a moment to open; the UI says so ('starting') until it's recording, and a
  // stop or cancel that lands in that gap waits for it rather than leaving the mic recording.
  const opening = useRef<Promise<void> | null>(null)
  const cancelled = useRef(false)

  useEffect(() => window.glassbox.voice.onProgress(setModel), [])

  const release = () => {
    const r = rec.current
    if (!r) return
    cancelAnimationFrame(r.raf)
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close()
    rec.current = null
    setLevel(0)
  }

  const start = useCallback(async () => {
    if (rec.current || opening.current) return
    setError(null)
    setState('starting')
    cancelled.current = false
    let done!: () => void
    opening.current = new Promise<void>((r) => (done = r))
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      // Input level for the meter.
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
        setLevel(Math.min(1, peak / 64))
        if (rec.current) rec.current.raf = requestAnimationFrame(tick)
      }
      rec.current = { recorder, stream, chunks, ctx, raf: requestAnimationFrame(tick) }
      recorder.start()
      if (cancelled.current) {
        recorder.onstop = null
        recorder.stop()
        release()
        setState('idle')
      } else {
        setState('listening')
        // Load (or first-time download) the model while the user is speaking. Only now: loading it
        // ties up the main process, which opening the mic goes through, so doing it first made the
        // first hold after launch take seconds to start recording.
        void window.glassbox.voice.prepare().catch((e) => setError(`Couldn't load the speech model: ${String(e)}`))
      }
    } catch (e) {
      release()
      setState('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow desktop apps to use the microphone in Windows privacy settings.' : `Couldn't open the microphone: ${String(e)}`)
    } finally {
      opening.current = null
      done()
    }
  }, [])

  const stop = useCallback(async (): Promise<string> => {
    if (opening.current) await opening.current
    const r = rec.current
    if (!r) return ''
    const stopped = new Promise<void>((done) => (r.recorder.onstop = () => done()))
    r.recorder.stop()
    await stopped
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType })
    release()
    // A hold released before any audio arrived: nothing to transcribe, and not an error.
    if (blob.size < 2000) {
      setState('idle')
      return ''
    }
    setState('transcribing')
    try {
      const decoder = new AudioContext({ sampleRate: SAMPLE_RATE })
      const audio = await decoder.decodeAudioData(await blob.arrayBuffer())
      void decoder.close()
      return await window.glassbox.voice.transcribe(audio.getChannelData(0))
    } catch (e) {
      if (e instanceof DOMException && e.name === 'EncodingError') return '' // too short to hold any audio
      setError(`Couldn't transcribe that: ${String(e)}`)
      return ''
    } finally {
      setState('idle')
    }
  }, [])

  const cancel = useCallback(() => {
    if (opening.current) {
      cancelled.current = true
      return
    }
    const r = rec.current
    if (!r) return
    r.recorder.onstop = null
    r.recorder.stop()
    release()
    setState('idle')
  }, [])

  useEffect(() => cancel, [cancel])

  return { state, level, model, error, start, stop, cancel, clearError: () => setError(null) }
}
