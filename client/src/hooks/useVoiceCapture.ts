import { useCallback, useEffect, useRef, useState } from 'react'

// One-shot dictation. Lighter than useVoice — no chat loop, no TTS — just the
// microphone resolving with the transcribed text. Used for quick-capture flows
// like "speak a task title" and dictating into a Notion block.
//
// It records with MediaRecorder and sends the clip to /api/stt, exactly as the
// main voice loop does, rather than using the browser's SpeechRecognition. Two
// reasons, both of which made the old version the wrong tool:
//
//   • SpeechRecognition is NOT local. In Chromium it streams the audio to
//     Google's servers — so on a box where every other AI tool runs on its
//     own hardware this one button was quietly sending speech to the cloud,
//     and no setting on the server could change that.
//   • TouchKio is Electron, which does not implement SpeechRecognition at
//     all (`webkitSpeechRecognition` is undefined; it needs Google API keys the
//     Electron build doesn't carry), so `supported` was false on the kiosk
//     itself and the dictate buttons never appeared where they were most
//     wanted — the device with no keyboard.
//
// Going through /api/stt means the transcriber is whatever the server is
// configured with — the local Whisper first, ElevenLabs behind it — and the
// kiosk gets the buttons.
//
// End-of-utterance is decided here the same way useVoice decides it: RMS over
// an AnalyserNode, and a hold of silence after speech. There is no interim
// text (server-side transcription answers once, at the end), so `interim`
// carries a short status line instead — the callers already show it under a
// "Listening…" label, and "speak now" is a better thing to read there than a
// blank box.

const API = import.meta.env.VITE_AUDIO_API ?? ''
const LS_INPUT_KEY = 'ts_audio_input_device'

// Same numbers as useVoice, for the same reasons.
const SILENCE_RMS     = 0.015
const SILENCE_HOLD_MS = 1500
const MIN_SPEECH_MS   = 400
// Nothing said at all: give up rather than record a minute of room tone.
const NO_SPEECH_MS    = 8_000
const MAX_RECORD_MS   = 20_000

export function useVoiceCapture() {
  const [listening, setListening] = useState(false)
  const [interim,   setInterim]   = useState('')
  const recRef      = useRef<MediaRecorder | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const ctxRef      = useRef<AudioContext | null>(null)
  const rafRef      = useRef<number>(0)
  const timerRef    = useRef<number>(0)
  const stoppedRef  = useRef(false)
  const abortedRef  = useRef(false)

  // Server-side transcription needs a microphone and a recorder — no vendor
  // API. Both are in every browser this app runs in, TouchKio included; the
  // check exists for an http:// page, where getUserMedia is absent.
  const supported = typeof window !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined'

  const cleanup = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = 0 }
    try { ctxRef.current?.close() } catch { /* ignore */ }
    ctxRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    recRef.current = null
  }, [])

  const finish = useCallback((aborted = false) => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    if (aborted) abortedRef.current = true
    const rec = recRef.current
    try {
      if (rec && rec.state !== 'inactive') rec.stop()
      else { cleanup(); setListening(false); setInterim('') }
    } catch {
      cleanup()
      setListening(false)
      setInterim('')
    }
  }, [cleanup])

  const start = useCallback((): Promise<string> => {
    return new Promise<string>((resolve) => {
      if (!supported || recRef.current) { resolve(''); return }
      stoppedRef.current = false
      abortedRef.current = false

      void (async () => {
        let stream: MediaStream
        try {
          // Honour the mic selected in the Hardware tab, as useVoice does.
          const inId = localStorage.getItem(LS_INPUT_KEY) ?? 'default'
          const audio: MediaTrackConstraints = {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            channelCount: 1, sampleRate: 48000,
          }
          if (inId && inId !== 'default') audio.deviceId = { exact: inId }
          stream = await navigator.mediaDevices.getUserMedia({ audio })
        } catch (err) {
          console.warn('[dictate] mic unavailable:', err)
          resolve('')
          return
        }
        streamRef.current = stream

        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
        const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        recRef.current = rec
        const chunks: Blob[] = []
        rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

        rec.onstop = async () => {
          const blob = new Blob(chunks, { type: mime })
          const aborted = abortedRef.current
          cleanup()
          setListening(false)
          if (aborted || blob.size === 0) { setInterim(''); resolve(''); return }
          setInterim('Transcribing…')
          try {
            const fd = new FormData()
            fd.append('audio', blob, `dictate-${Date.now()}.webm`)
            const res = await fetch(`${API}/api/stt`, { method: 'POST', body: fd })
            if (!res.ok) {
              const detail = await res.text().catch(() => '')
              console.warn(`[dictate] /api/stt ${res.status}: ${detail.slice(0, 200)}`)
              resolve('')
              return
            }
            const json = await res.json() as { text?: string; provider?: string }
            const text = (json.text ?? '').trim()
            console.log(`[dictate] heard via ${json.provider ?? '?'}: "${text.slice(0, 80)}"`)
            resolve(text)
          } catch (err) {
            console.warn('[dictate] transcription failed:', err)
            resolve('')
          } finally {
            setInterim('')
          }
        }
        rec.onerror = (e) => {
          console.warn('[dictate] recorder error:', e)
          abortedRef.current = true
          finish(true)
        }

        // ── Silence detection ────────────────────────────────────────────────
        const Ctor = window.AudioContext
          || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ac = new Ctor()
        ctxRef.current = ac
        const analyser = ac.createAnalyser()
        analyser.fftSize = 1024
        ac.createMediaStreamSource(stream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const startedAt = performance.now()
        let lastSpeechAt = startedAt
        let sawSpeech = false

        const tick = () => {
          if (!ctxRef.current) return
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
          const rms = Math.sqrt(sum / buf.length)
          const now = performance.now()
          if (rms >= SILENCE_RMS) {
            if (!sawSpeech) setInterim('Heard you — keep going, stops on silence')
            lastSpeechAt = now
            sawSpeech = true
          }
          if (!sawSpeech && now - startedAt > NO_SPEECH_MS) { finish(true); return }
          if (sawSpeech && now - startedAt > MIN_SPEECH_MS && now - lastSpeechAt > SILENCE_HOLD_MS) { finish(); return }
          rafRef.current = requestAnimationFrame(tick)
        }

        setInterim('Speak now — stops on silence')
        setListening(true)
        rec.start(250)
        rafRef.current = requestAnimationFrame(tick)
        timerRef.current = window.setTimeout(() => finish(), MAX_RECORD_MS)
      })()
    })
  }, [supported, cleanup, finish])

  /** Stop now and transcribe what was said so far. */
  const stop = useCallback(() => { finish() }, [finish])

  /** Stop and throw the recording away — resolves the pending start() with ''. */
  const cancel = useCallback(() => { finish(true) }, [finish])

  useEffect(() => () => { abortedRef.current = true; cleanup() }, [cleanup])

  return { supported, listening, interim, start, stop, cancel }
}
