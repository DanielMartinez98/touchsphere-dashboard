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

// Speak text, waiting for voices to load first (required on Chromium/Linux).
function speakText(
  text: string,
  onEnd: () => void,
) {
  const doSpeak = () => {
    window.speechSynthesis.cancel()
    const utterance   = new SpeechSynthesisUtterance(text)
    utterance.rate    = 1
    utterance.pitch   = 1.1
    utterance.volume  = 1
    // Prefer a local (offline) voice when available — more reliable in kiosk.
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) {
      utterance.voice = voices.find(v => v.localService) ?? voices[0]
    }
    utterance.onend   = onEnd
    utterance.onerror = onEnd
    window.speechSynthesis.speak(utterance)
  }

  if (window.speechSynthesis.getVoices().length > 0) {
    doSpeak()
  } else {
    // Chromium loads voices asynchronously — wait for the event.
    window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true })
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
      window.speechSynthesis.cancel()
      if (fadeRafRef.current !== null) cancelAnimationFrame(fadeRafRef.current)
    }
  }, [])

  return { isListening, isSpeaking, transcript, reply, volume, startListening, stopListening }
}
}
