import { useState, useRef, useCallback, useEffect } from 'react'

// SpeechRecognition is not declared as a global in all TypeScript DOM lib versions,
// so we define a minimal shape and access the constructor via `window`.
type SpeechRecognitionInstance = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: Event) => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance

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
  transcript: string
  reply: string
  volume: number
  startListening: () => void
  stopListening: () => void
}

// Server base URL for the TTS endpoint. Same Vite env var the recorder uses,
// so the kiosk can hit the Pi/server on a different host if needed.
const API = import.meta.env.VITE_AUDIO_API ?? ''

// Speak text by fetching a WAV from the server and playing it through WebAudio.
//
// We can NOT use window.speechSynthesis here: TouchKio is built on Electron,
// and Electron does not implement the Web Speech API (`speak()` is a silent
// no-op, `getVoices()` returns []). The server runs `espeak-ng` and streams
// back a WAV; we decode it once and play via an AudioBufferSourceNode — the
// same path our startup chime uses, which is already known to route correctly
// through the Bluetooth A2DP sink.
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
  // Stop any in-flight playback so replies don't pile up.
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

    // Older Chromium needs callback-form decodeAudioData — wrap to support both.
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
    src.connect(c.destination)
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
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking]   = useState(false)
  const [transcript, setTranscript]   = useState('')
  const [reply, setReply]             = useState('')
  const [volume, setVolume]           = useState(0)

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const fadeRafRef     = useRef<number | null>(null)
  const volumeRef      = useRef(0)

  // Smoothly fade the volume back to 0.
  const startFade = useCallback(() => {
    if (fadeRafRef.current !== null) return
    const tick = () => {
      volumeRef.current = Math.max(0, volumeRef.current - 0.04)
      setVolume(volumeRef.current)
      if (volumeRef.current > 0) {
        fadeRafRef.current = requestAnimationFrame(tick)
      } else {
        fadeRafRef.current = null
      }
    }
    fadeRafRef.current = requestAnimationFrame(tick)
  }, [])

  // Bump volume on each recognition result — drives the orb pulse.
  const bumpVolume = useCallback(() => {
    if (fadeRafRef.current !== null) {
      cancelAnimationFrame(fadeRafRef.current)
      fadeRafRef.current = null
    }
    // Randomise a little so the orb looks "alive".
    volumeRef.current = 0.7 + Math.random() * 0.3
    setVolume(volumeRef.current)
    // Fade after a short hold.
    setTimeout(startFade, 180)
  }, [startFade])

  const startListening = useCallback(() => {
    if (isListening) return

    const w = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionCtor
      webkitSpeechRecognition?: SpeechRecognitionCtor
    }
    const SR: SpeechRecognitionCtor | undefined = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!SR) {
      console.warn('SpeechRecognition is not supported in this browser.')
      return
    }

    setTranscript('')
    setReply('')
    setIsListening(true)

    const recognition = new SR()
    recognitionRef.current = recognition
    recognition.continuous     = false
    recognition.interimResults = true
    recognition.lang           = 'en-US'

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      bumpVolume()
      const text = Array.from(e.results)
        .map((r: SpeechRecognitionResult) => r[0].transcript)
        .join('')
      setTranscript(text)
    }

    recognition.onend = () => {
      setIsListening(false)
      startFade()

      const replyText = DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]
      setReply(replyText)
      setIsSpeaking(true)

      speakText(replyText, () => {
        setIsSpeaking(false)
        setVolume(0)
        volumeRef.current = 0
      })
    }

    recognition.onerror = () => {
      setIsListening(false)
      startFade()
    }

    recognition.start()
  }, [isListening, bumpVolume, startFade])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      try { currentSource?.stop() } catch { /* already stopped */ }
      if (fadeRafRef.current !== null) cancelAnimationFrame(fadeRafRef.current)
    }
  }, [])

  return { isListening, isSpeaking, transcript, reply, volume, startListening, stopListening }
}
