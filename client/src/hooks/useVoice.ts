import { useState, useRef, useCallback, useEffect } from 'react'
import { getEffectiveGain } from './useVolume'

const DEFAULT_REPLIES = [
  "I heard you! That's interesting. Keep talking whenever you need me.",
  "Got it. I'm listening and here whenever you need me.",
  "Thanks for saying that. I'm always nearby if you'd like to chat.",
  "Understood. Feel free to speak again whenever you're ready.",
  "Message received. I'm here and ready to listen anytime.",
  "That's noted. Just tap the mic again whenever you want to continue.",
]

export interface VoiceState {
  isListening: boolean
  isSpeaking: boolean
  isTranscribing: boolean
  transcript: string
  reply: string
  volume: number
  startListening: () => void
  stopListening: () => void
}

// Server base URL (Vite env var). Same one used by the audio recorder so the
// kiosk can hit the Pi/server on a different host if needed.
const API = import.meta.env.VITE_AUDIO_API ?? ''

// ── Voice Activity Detection (VAD) tuning ────────────────────────────────────
// RMS threshold below which a frame counts as "silence".
const SILENCE_RMS = 0.015
// How long (ms) of continuous silence before we auto-stop the recorder.
const SILENCE_HOLD_MS = 1500
// Don't auto-stop until we've seen at least this many ms of speech first.
const MIN_SPEECH_MS = 400
// Hard upper bound — kill any recording that runs this long.
const MAX_RECORD_MS = 20_000

// ── TTS playback ─────────────────────────────────────────────────────────────
// We can NOT use window.speechSynthesis here: TouchKio is built on Electron,
// and Electron does not implement the Web Speech API. The server runs the TTS
// (ElevenLabs or espeak-ng) and streams audio; we decode it once and play
// via an AudioBufferSourceNode — same path as the startup chime, which is
// known to route correctly through the Bluetooth A2DP sink.
let ttsCtx: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null

function getTtsCtx(): AudioContext {
  if (ttsCtx && ttsCtx.state !== 'closed') return ttsCtx
  const Ctor = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  ttsCtx = new Ctor()
  return ttsCtx
}

async function speakText(text: string, onEnd: () => void) {
  try { currentSource?.stop() } catch { /* already stopped */ }
  currentSource = null

  try {
    const c = getTtsCtx()
    if (c.state === 'suspended') {
      try { await c.resume() } catch { /* ignore */ }
    }

    const url = `${API}/api/tts?text=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`tts http ${res.status}`)
    const arrayBuf = await res.arrayBuffer()

    const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      try {
        const p = c.decodeAudioData(arrayBuf, resolve, reject)
        if (p && typeof (p as Promise<AudioBuffer>).then === 'function') {
          (p as Promise<AudioBuffer>).then(resolve, reject)
        }
      } catch (err) {
        reject(err as Error)
      }
    })

    const src = c.createBufferSource()
    src.buffer = buffer
    const gain = c.createGain()
    gain.gain.value = getEffectiveGain('voice')
    src.connect(gain)
    gain.connect(c.destination)
    src.onended = () => {
      if (currentSource === src) currentSource = null
      onEnd()
    }
    currentSource = src
    src.start(0)
  } catch (err) {
    console.warn('[voice] TTS playback failed:', err)
    onEnd()
  }
}

export function useVoice(): VoiceState {
  const [isListening,    setIsListening]    = useState(false)
  const [isSpeaking,     setIsSpeaking]     = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcript,     setTranscript]     = useState('')
  const [reply,          setReply]          = useState('')
  const [volume,         setVolume]         = useState(0)

  // Refs for the live recording session — none of these need to trigger renders.
  const streamRef    = useRef<MediaStream    | null>(null)
  const recorderRef  = useRef<MediaRecorder  | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const vadCtxRef    = useRef<AudioContext   | null>(null)
  const analyserRef  = useRef<AnalyserNode   | null>(null)
  const vadRafRef    = useRef<number | null>(null)
  const maxTimerRef  = useRef<number | null>(null)
  const stoppedRef   = useRef(false)              // prevents double-stop
  const volumeRef    = useRef(0)

  // Fully tear down mic + audio nodes + timers. Idempotent.
  const cleanup = useCallback(() => {
    if (vadRafRef.current !== null) {
      cancelAnimationFrame(vadRafRef.current)
      vadRafRef.current = null
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    try { analyserRef.current?.disconnect() } catch { /* ignore */ }
    analyserRef.current = null
    try { vadCtxRef.current?.close() } catch { /* ignore */ }
    vadCtxRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  // Manual stop — also called by VAD when silence threshold is reached.
  const stopRecording = useCallback(() => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
    } catch (err) {
      console.warn('[voice] stop() failed:', err)
      cleanup()
      setIsListening(false)
    }
  }, [cleanup])

  // Upload the recorded blob to the server and get back the transcript.
  const transcribe = useCallback(async (blob: Blob): Promise<string> => {
    if (blob.size === 0) return ''
    const fd = new FormData()
    fd.append('audio', blob, `clip-${Date.now()}.webm`)
    const res = await fetch(`${API}/api/stt`, { method: 'POST', body: fd })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`stt ${res.status}: ${detail.slice(0, 200)}`)
    }
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }, [])

  const startListening = useCallback(async () => {
    if (isListening || isTranscribing || isSpeaking) return
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[voice] getUserMedia unavailable — page must be HTTPS.')
      return
    }

    setTranscript('')
    setReply('')
    stoppedRef.current = false

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          channelCount: 1,
          sampleRate:   48000,
        },
      })
    } catch (err) {
      console.warn('[voice] mic permission denied:', err)
      return
    }
    streamRef.current = stream

    // ── MediaRecorder (audio capture for upload) ───────────────────────────
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
    recorderRef.current = rec
    chunksRef.current = []

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    rec.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mime })
      cleanup()
      setIsListening(false)
      // Fade the orb volume meter back to 0 quickly.
      const fadeStart = volumeRef.current
      const fadeMs = 250
      const t0 = performance.now()
      const fadeStep = () => {
        const t = (performance.now() - t0) / fadeMs
        if (t >= 1) { volumeRef.current = 0; setVolume(0); return }
        volumeRef.current = fadeStart * (1 - t)
        setVolume(volumeRef.current)
        requestAnimationFrame(fadeStep)
      }
      requestAnimationFrame(fadeStep)

      // Upload + display + reply.
      setIsTranscribing(true)
      let text = ''
      try {
        text = await transcribe(blob)
      } catch (err) {
        console.warn('[voice] transcribe failed:', err)
      } finally {
        setIsTranscribing(false)
      }
      setTranscript(text)

      const replyText = DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]
      setReply(replyText)
      setIsSpeaking(true)
      speakText(replyText, () => {
        setIsSpeaking(false)
        setVolume(0)
        volumeRef.current = 0
      })
    }

    rec.onerror = (e) => {
      console.warn('[voice] recorder error:', e)
      cleanup()
      setIsListening(false)
    }

    // ── VAD: AnalyserNode RMS + silence-hold timer ─────────────────────────
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ac = new Ctor()
    vadCtxRef.current = ac
    const source = ac.createMediaStreamSource(stream)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    analyserRef.current = analyser

    const buf = new Float32Array(analyser.fftSize)
    const startedAt = performance.now()
    let lastSpeechAt = performance.now()

    const tick = () => {
      if (!analyserRef.current) return
      analyser.getFloatTimeDomainData(buf)
      // RMS over the frame.
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
      const rms = Math.sqrt(sum / buf.length)

      // Drive orb pulse from live mic level.
      // Smooth + scale: clamp around a sensible range.
      const target = Math.min(1, rms * 8)
      volumeRef.current += (target - volumeRef.current) * 0.25
      setVolume(volumeRef.current)

      const now = performance.now()
      if (rms >= SILENCE_RMS) lastSpeechAt = now
      const speechElapsed = now - startedAt
      const silenceFor    = now - lastSpeechAt

      if (speechElapsed > MIN_SPEECH_MS && silenceFor > SILENCE_HOLD_MS) {
        stopRecording()
        return
      }
      vadRafRef.current = requestAnimationFrame(tick)
    }

    setIsListening(true)
    rec.start(250) // emit chunks every 250ms
    vadRafRef.current = requestAnimationFrame(tick)

    // Hard cap.
    maxTimerRef.current = window.setTimeout(() => {
      console.log('[voice] max record time reached')
      stopRecording()
    }, MAX_RECORD_MS)
  }, [isListening, isTranscribing, isSpeaking, cleanup, stopRecording, transcribe])

  const stopListening = useCallback(() => {
    stopRecording()
  }, [stopRecording])

  useEffect(() => {
    return () => {
      cleanup()
      try { currentSource?.stop() } catch { /* already stopped */ }
    }
  }, [cleanup])

  return { isListening, isSpeaking, isTranscribing, transcript, reply, volume, startListening, stopListening }
}
