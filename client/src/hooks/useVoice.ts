import { useState, useRef, useCallback, useEffect } from 'react'

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

export function useVoice(): VoiceState {
  const [isListening, setIsListening]   = useState(false)
  const [isSpeaking, setIsSpeaking]     = useState(false)
  const [transcript, setTranscript]     = useState('')
  const [reply, setReply]               = useState('')
  const [volume, setVolume]             = useState(0)

  const recognitionRef  = useRef<SpeechRecognition | null>(null)
  const analyserRef     = useRef<AnalyserNode | null>(null)
  const audioCtxRef     = useRef<AudioContext | null>(null)
  const sourceRef       = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef       = useRef<MediaStream | null>(null)
  const rafRef          = useRef<number | null>(null)

  const stopAudio = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (sourceRef.current)  { sourceRef.current.disconnect(); sourceRef.current = null }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
    analyserRef.current = null
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    setVolume(0)
  }, [])

  const startListening = useCallback(async () => {
    if (isListening) return

    const SR = (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
      ?? (typeof SpeechRecognition !== 'undefined' ? SpeechRecognition : null)
    if (!SR) {
      console.warn('SpeechRecognition is not supported in this browser.')
      return
    }

    setTranscript('')
    setReply('')
    setIsListening(true)

    // Microphone volume tracking
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser
      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setVolume(avg / 255)
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // mic permission denied — continue without volume
    }

    const recognition = new SR()
    recognitionRef.current = recognition
    recognition.continuous     = false
    recognition.interimResults = true
    recognition.lang           = 'en-US'

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const text = Array.from(e.results)
        .map((r: SpeechRecognitionResult) => r[0].transcript)
        .join('')
      setTranscript(text)
    }

    recognition.onend = () => {
      setIsListening(false)
      stopAudio()

      const replyText = DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)]
      setReply(replyText)
      setIsSpeaking(true)

      window.speechSynthesis.cancel()
      const utterance         = new SpeechSynthesisUtterance(replyText)
      utterance.rate          = 1
      utterance.pitch         = 1.1
      utterance.volume        = 1
      utterance.onend         = () => setIsSpeaking(false)
      utterance.onerror       = () => setIsSpeaking(false)
      window.speechSynthesis.speak(utterance)
    }

    recognition.onerror = () => {
      setIsListening(false)
      stopAudio()
    }

    recognition.start()
  }, [isListening, stopAudio])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop()
  }, [])

  useEffect(() => {
    return () => {
      stopAudio()
      window.speechSynthesis.cancel()
    }
  }, [stopAudio])

  return { isListening, isSpeaking, transcript, reply, volume, startListening, stopListening }
}
