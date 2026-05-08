import { useState, useRef, useCallback, useEffect } from 'react'
import { getEffectiveGain } from './useVolume'

// Fallback replies if /api/chat fails or returns nothing usable. We still want
// the user to hear *something* so they know the loop completed.
const FALLBACK_REPLIES = [
  "Sorry, I'm having trouble reaching my brain right now.",
  "I heard you, but I can't think of a reply at the moment.",
  "Hmm, I lost my train of thought. Try again in a second?",
]

// localStorage keys for the selected I/O devices (kept in sync by useAudioDevices).
const LS_INPUT_KEY  = 'ts_audio_input_device'
const LS_OUTPUT_KEY = 'ts_audio_output_device'

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
const SILENCE_RMS = 0.015
const SILENCE_HOLD_MS = 1500
const MIN_SPEECH_MS = 400
const MAX_RECORD_MS = 20_000// In follow-up turns (after the AI just spoke) we wait this long for the user
// to start talking. If they don't, the conversation ends silently — no empty
// transcript, no fallback reply, no TTS.
const FOLLOWUP_NO_SPEECH_MS = 10_000
// ── TTS playback ─────────────────────────────────────────────────────────────
// We use HTMLAudioElement (not WebAudio) so we can call setSinkId() and route
// the reply to whichever speaker the user picked in the Hardware tab. WebAudio
// has no equivalent. The browser handles MP3/WAV decoding natively.
let currentAudio: HTMLAudioElement | null = null

async function speakText(text: string, onEnd: () => void) {
  // Stop any in-flight playback so replies don't pile up.
  if (currentAudio) {
    try { currentAudio.pause() } catch { /* ignore */ }
    currentAudio = null
  }

  try {
    const url = `${API}/api/tts?text=${encodeURIComponent(text)}`
    const audio = new Audio(url)
    audio.preload = 'auto'
    audio.volume = Math.max(0, Math.min(1, getEffectiveGain('voice')))
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null
      onEnd()
    }
    audio.onerror = () => {
      console.warn('[voice] TTS audio error')
      if (currentAudio === audio) currentAudio = null
      onEnd()
    }
    currentAudio = audio

    // Route to the user-selected speaker if supported.
    type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    const a = audio as AudioWithSink
    const outId = localStorage.getItem(LS_OUTPUT_KEY) ?? 'default'
    if (outId && outId !== 'default' && typeof a.setSinkId === 'function') {
      try { await a.setSinkId(outId) } catch (err) {
        console.warn('[voice] setSinkId failed, using default sink:', err)
      }
    }

    await audio.play()
  } catch (err) {
    console.warn('[voice] TTS playback failed:', err)
    onEnd()
  }
}

// ── Chat (LLM reply) ─────────────────────────────────────────────────────────
// One entry in the running conversation. The server prepends the system
// message and forwards the rest to Ollama, so the model sees prior turns.
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

// Cap history to keep the request payload (and the model's context) bounded.
// Server enforces its own cap too, but we trim here so we don't ship junk.
const MAX_HISTORY_TURNS = 20

async function fetchReply(messages: ChatTurn[]): Promise<string> {
  try {
    const res = await fetch(`${API}/api/chat`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ messages }),
    })
    if (!res.ok) {
      console.warn('[voice] /api/chat http', res.status)
      return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]!
    }
    const json = (await res.json()) as { reply?: string }
    return (json.reply ?? '').trim() || FALLBACK_REPLIES[0]!
  } catch (err) {
    console.warn('[voice] /api/chat failed:', err)
    return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]!
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
  const abortedRef   = useRef(false)              // follow-up timed out — don't transcribe
  const volumeRef    = useRef(0)
  // Running conversation. Lives in a ref because it's mutated from the
  // recorder's onstop closure and we don't want every append to re-render.
  // Cleared when the conversation ends (timeout, no-speech, or unmount).
  const historyRef   = useRef<ChatTurn[]>([])

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
  // `aborted` = true means the user never spoke during a follow-up turn, so the
  // onstop handler should skip transcription and just end the conversation.
  const stopRecording = useCallback((aborted = false) => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    if (aborted) abortedRef.current = true
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

  const startListening = useCallback(async (isFollowUp = false) => {
    if (isListening || isTranscribing || isSpeaking) return
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[voice] getUserMedia unavailable — page must be HTTPS.')
      return
    }

    setTranscript('')
    setReply('')
    stoppedRef.current = false
    abortedRef.current = false
    // Fresh wake-word activation — start a new conversation. Follow-up turns
    // keep the existing history so the model has context.
    if (!isFollowUp) historyRef.current = []

    let stream: MediaStream
    try {
      // Honor the mic selected in the Hardware tab. 'default' = OS default.
      const inId = localStorage.getItem(LS_INPUT_KEY) ?? 'default'
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount: 1,
        sampleRate:   48000,
      }
      if (inId && inId !== 'default') {
        audioConstraints.deviceId = { exact: inId }
      }
      console.log('[voice] requesting mic with constraints:', audioConstraints)
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      const track = stream.getAudioTracks()[0]
      console.log('[voice] got track:', track?.label, track?.getSettings?.())
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
      const aborted = abortedRef.current
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

      // Follow-up turn that timed out without any speech — end the
      // conversation silently. No transcribe call, no LLM call, no TTS.
      // Reset history so the next wake-word starts a fresh conversation.
      if (aborted) {
        console.log('[voice] follow-up timed out — conversation ended')
        historyRef.current = []
        return
      }

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
      console.log('[voice] transcript:', text)

      // Treat very short or punctuation-only transcripts as no-speech. The
      // server already strips audio-event tags, but Scribe can still emit a
      // single short word ("uh", "yeah") for pure-noise clips. If we got
      // nothing meaningful, end the conversation instead of replying to noise.
      const cleaned = text.replace(/[^\p{L}\p{N}]/gu, '').trim()
      if (cleaned.length < 2) {
        console.log('[voice] no meaningful speech detected — ending conversation')
        historyRef.current = []
        return
      }

      // Append this user turn to the running history, then ask the LLM with
      // full context so multi-turn conversations actually remember prior turns.
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
      ].slice(-MAX_HISTORY_TURNS)
      const replyText = await fetchReply(historyRef.current)
      console.log('[voice] reply:', replyText)
      historyRef.current = [
        ...historyRef.current,
        { role: 'assistant', content: replyText },
      ].slice(-MAX_HISTORY_TURNS)
      setReply(replyText)
      setIsSpeaking(true)
      speakText(replyText, () => {
        setIsSpeaking(false)
        setVolume(0)
        volumeRef.current = 0
        // Continuous conversation: re-open the mic after the AI finishes.
        // The follow-up flag activates the 10 s no-speech timeout so an
        // unanswered prompt ends the conversation cleanly.
        //
        // Defer to the next tick so React can flush setIsSpeaking(false) and
        // reassign startListeningRef to the new closure. Otherwise the guard
        // inside startListening still sees isSpeaking=true and bails out,
        // killing the conversation after the first turn.
        setTimeout(() => startListeningRef.current?.(true), 0)
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
    let sawSpeech = false

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
      if (rms >= SILENCE_RMS) {
        lastSpeechAt = now
        sawSpeech = true
      }
      const elapsedSinceStart = now - startedAt
      const silenceFor        = now - lastSpeechAt

      // Follow-up turn: if the user never spoke within the grace window, abort.
      if (isFollowUp && !sawSpeech && elapsedSinceStart > FOLLOWUP_NO_SPEECH_MS) {
        stopRecording(true)
        return
      }

      // Normal end-of-utterance: spoke for at least MIN_SPEECH_MS and then went
      // quiet for SILENCE_HOLD_MS.
      if (sawSpeech && elapsedSinceStart > MIN_SPEECH_MS && silenceFor > SILENCE_HOLD_MS) {
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

  // The TTS onEnd callback needs to call startListening, but startListening is
  // declared after the recorder's onstop closes over it. Use a ref to break
  // the chicken-and-egg, and keep it in sync after every render.
  const startListeningRef = useRef<((followUp: boolean) => void) | null>(null)
  startListeningRef.current = startListening

  useEffect(() => {
    return () => {
      cleanup()
      historyRef.current = []
      if (currentAudio) {
        try { currentAudio.pause() } catch { /* already stopped */ }
        currentAudio = null
      }
    }
  }, [cleanup])

  return { isListening, isSpeaking, isTranscribing, transcript, reply, volume, startListening, stopListening }
}
