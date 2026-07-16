import { useState, useRef, useCallback, useEffect } from 'react'
import { getEffectiveGain } from './useVolume'
import { getMuted, subscribeMuted } from './useMuted'
import { getAvatarEnabled } from './useAvatar'
import { attachLipSync, resetLipSync } from '../utils/lipsync'
import { startThinkingSound, stopThinkingSound } from '../utils/sound'

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
  // True from the moment we start uploading audio for STT until TTS playback
  // begins (or the conversation ends early). Covers both transcription and the
  // LLM round-trip so the wake word stays paused through the whole "thinking"
  // window — otherwise the recognizer would hear the user / its own voice in
  // the gap between STT returning and TTS starting.
  isThinking: boolean
  transcript: string
  reply: string
  // Human-readable error shown to the user when voice can't start (mic blocked,
  // not a secure context, etc.). Empty when there's nothing to report. Auto-clears.
  error: string
  volume: number
  startListening: () => void
  // End the capture and submit what was recorded for transcription. Wired to
  // the orb tap, which reads as "I'm done talking, go answer."
  stopListening: () => void
  // Abandon the capture without transcribing it, and end the conversation.
  // Wired to the on-screen "Stop listening" button that shows while the mic is
  // open — tapping it means "stop hearing me", so the audio is discarded.
  cancelListening: () => void
  // Interrupt the assistant mid-reply and end the conversation. Wired to the
  // on-screen "Stop" button that shows while it's talking.
  stopSpeaking: () => void
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
// After TTS finishes, wait this long before re-opening the mic so speaker tail,
// reverb, and any AEC convergence don't get picked up as user speech.
const POST_TTS_GRACE_MS = 500

// Whether the mic should reopen after TTS is now decided explicitly by the
// assistant via the end_conversation / keep_listening tool calls. The server
// returns `keepListening: boolean` on every chat reply; we just forward that
// value through. Default = false (end the turn) when the field is missing.
// ── TTS playback ─────────────────────────────────────────────────────────────
// We use HTMLAudioElement (not WebAudio) so we can call setSinkId() and route
// the reply to whichever speaker the user picked in the Hardware tab. WebAudio
// has no equivalent. The browser handles MP3/WAV decoding natively.
//
// ── Why the reply is spoken sentence by sentence ─────────────────────────────
// /api/tts buffers the whole clip before it responds, and for the RVC-voiced
// assistant (Miku) synthesis is a two-model pass whose cost scales with clip
// length. Asking for the reply in one piece therefore means waiting for EVERY
// sentence to be synthesised and converted before hearing the first word — a
// four-sentence answer pays four sentences of latency up front.
//
// So we split the reply and pipeline it: fetch sentence 1, start playing it,
// and fetch the following sentences while it plays. Time-to-first-word becomes
// the cost of one SHORT chunk instead of the whole reply, and the remaining
// fetches hide underneath playback. Up to two requests are kept in flight —
// the server serialises the expensive RVC conversion itself, so the second
// request's Kokoro synthesis overlaps the first one's conversion instead of
// fighting it for the single conversion model.
const MIN_CHUNK_CHARS = 45    // below this, merge forward — don't pay a round-trip for "Sure."
const MAX_CHUNK_CHARS = 180   // above this, split at a comma/space so no chunk is a long wait
// The first chunk is special: its synthesis time IS the time-to-first-word, and
// for the RVC-voiced assistant that time scales with clip length. So it gets a
// much tighter cap — start speaking after one clause, synthesise the rest
// underneath playback.
const FIRST_CHUNK_CHARS = 70

/** Split a reply into speakable chunks at sentence boundaries. Exported for tests. */
export function splitForSpeech(text: string): string[] {
  // Keep the terminator with its sentence; also break on hard newlines.
  const pieces = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)

  const merged: string[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    // Top up a chunk that's still too short to be worth its own round-trip
    // ("Hi there!"), but never grow one that already is — the whole point is to
    // get the first chunk playing early, and merging into a big chunk just
    // rebuilds the long wait we're trying to avoid. A short chunk at the END is
    // harmless: it's fetched while an earlier one is already playing.
    if (last && last.length < MIN_CHUNK_CHARS
        && last.length + piece.length + 1 <= MAX_CHUNK_CHARS) {
      merged[merged.length - 1] = `${last} ${piece}`
    } else {
      merged.push(piece)
    }
  }

  // A single sentence can still be long enough to be a noticeable wait on its
  // own; break those at the last comma (else the last space) before the cap.
  // The first chunk uses the tighter FIRST_CHUNK_CHARS cap (see above).
  const out: string[] = []
  for (let chunk of merged) {
    let cap = out.length === 0 ? FIRST_CHUNK_CHARS : MAX_CHUNK_CHARS
    while (chunk.length > cap) {
      const head = chunk.slice(0, cap)
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '))
      const at = cut > MIN_CHUNK_CHARS ? cut + 1 : head.lastIndexOf(' ')
      if (at <= 0) break   // one unbroken cap-length token; let it through whole
      out.push(chunk.slice(0, at).trim())
      chunk = chunk.slice(at).trim()
      cap = MAX_CHUNK_CHARS
    }
    if (chunk) out.push(chunk)
  }
  return out
}

let currentAudio: HTMLAudioElement | null = null
// Resolver for the clip currently playing, so an interrupt can unblock the
// sequencer's `await` instead of leaving it hanging on an 'ended' that a
// pause() will never fire.
let currentClipDone: (() => void) | null = null
// Bumped on every interrupt. The sequencer compares its own token after each
// await and bails out if it's been superseded, so a stopped reply can't resume
// with its next sentence.
let playToken = 0

/** Stop playback immediately and invalidate any in-flight reply sequence. */
function haltPlayback() {
  playToken++
  if (currentAudio) {
    try { currentAudio.pause() } catch { /* ignore */ }
    currentAudio = null
  }
  const done = currentClipDone
  currentClipDone = null
  done?.()
}

/** Synthesise one chunk. Fetched as a blob (not an <audio src>) so playback of
 *  the previous chunk and the fetch of the next can overlap. */
async function fetchClip(text: string): Promise<string> {
  const res = await fetch(`${API}/api/tts?text=${encodeURIComponent(text)}`)
  if (!res.ok) throw new Error(`tts ${res.status}`)
  return URL.createObjectURL(await res.blob())
}

/** Play one clip to completion. Resolves on end, on error, or on interrupt. */
function playClip(objectUrl: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const audio = new Audio(objectUrl)
    audio.preload = 'auto'
    audio.volume = Math.max(0, Math.min(1, getEffectiveGain('voice')))

    const finish = () => {
      if (currentAudio === audio) currentAudio = null
      if (currentClipDone === finish) currentClipDone = null
      URL.revokeObjectURL(objectUrl)
      resolve()
    }
    audio.onended = finish
    audio.onerror = () => { console.warn('[voice] TTS audio error'); finish() }

    currentAudio = audio
    currentClipDone = finish

    const outId = localStorage.getItem(LS_OUTPUT_KEY) ?? 'default'

    // With the avatar on, playback is routed through a WebAudio analyser so the
    // mouth can follow the waveform. That tap also takes over speaker selection
    // (an element routed into WebAudio no longer honours its own setSinkId), so
    // it only reports success when it can preserve the chosen output — otherwise
    // we fall through to the untapped path below and simply don't lip-sync.
    void (async () => {
      try {
        const tapped = getAvatarEnabled() ? await attachLipSync(audio, outId) : false
        if (!tapped) {
          // Route to the user-selected speaker if supported.
          type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
          const a = audio as AudioWithSink
          if (outId && outId !== 'default' && typeof a.setSinkId === 'function') {
            try { await a.setSinkId(outId) } catch (err) {
              console.warn('[voice] setSinkId failed, using default sink:', err)
            }
          }
        }
        // Interrupted while we were setting up routing — never start.
        if (currentAudio !== audio) return
        await audio.play()
      } catch (err) {
        console.warn('[voice] TTS playback failed:', err)
        finish()
      }
    })()
  })
}

async function speakText(text: string, onEnd: () => void) {
  haltPlayback()                 // stop any in-flight reply so they don't pile up
  const token = playToken
  const chunks = splitForSpeech(text)
  if (chunks.length === 0) { onEnd(); return }

  const t0 = performance.now()
  // Keep up to two synth requests running ahead of playback. The server
  // serialises the RVC conversion leg, so the second request's (cheap) Kokoro
  // synthesis overlaps the first one's (expensive) conversion — that overlap is
  // the whole point of the second slot.
  const pending: Array<Promise<string> | undefined> = []
  const prefetch = (i: number) => {
    if (i >= chunks.length || pending[i]) return
    const p = fetchClip(chunks[i]!)
    // Awaited when its turn comes; the no-op catch only stops a failure from
    // being reported as an unhandled rejection in the meantime.
    p.catch(() => {})
    pending[i] = p
  }
  // After a bail-out (interrupt or a failed chunk), in-flight fetches would
  // otherwise resolve to object URLs nobody ever revokes.
  const abandonFrom = (i: number) => {
    for (let j = i; j < pending.length; j++) {
      pending[j]?.then(u => URL.revokeObjectURL(u)).catch(() => {})
    }
  }
  try {
    prefetch(0)
    prefetch(1)
    for (let i = 0; i < chunks.length; i++) {
      let url: string
      try {
        url = await pending[i]!
      } catch (err) {
        console.warn(`[voice] TTS chunk ${i + 1}/${chunks.length} failed:`, err)
        abandonFrom(i + 1)
        break                    // speak what we have rather than nothing
      }
      if (token !== playToken) { URL.revokeObjectURL(url); abandonFrom(i + 1); return }
      if (i === 0) console.log(`[voice] first audio in ${Math.round(performance.now() - t0)}ms (${chunks.length} chunks)`)

      // Top the pipeline back up before playing, so the wait for upcoming
      // chunks happens underneath the audio the user is already hearing.
      prefetch(i + 1)
      prefetch(i + 2)

      await playClip(url)
      if (token !== playToken) { abandonFrom(i + 1); return }
    }
  } finally {
    if (token === playToken) {
      resetLipSync()
      onEnd()
    }
  }
}

// ── Chat (LLM reply) ─────────────────────────────────────────────────────────
// One entry in the running conversation. The server prepends the system
// message and forwards the rest to Ollama, so the model sees prior turns.
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

// Cap history to keep the request payload (and the model's context) bounded.
// Server enforces its own cap too, but we trim here so we don't ship junk.
const MAX_HISTORY_TURNS = 20

interface ChatReply { text: string; keepListening: boolean }

async function fetchReply(messages: ChatTurn[]): Promise<ChatReply> {
  try {
    const res = await fetch(`${API}/api/chat`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ messages }),
    })
    if (!res.ok) {
      console.warn('[voice] /api/chat http', res.status)
      return { text: FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]!, keepListening: false }
    }
    const json = (await res.json()) as { reply?: string; changed?: string[]; keepListening?: boolean }
    // Tell affected widgets to re-fetch their data (e.g. the media list after
    // the assistant added an item via add_media_item).
    const changed = Array.isArray(json.changed) ? json.changed : []
    if (changed.length > 0) {
      console.log('[voice] state changed by chat tools:', changed)
      window.dispatchEvent(new CustomEvent('ts:state-changed', { detail: { slices: changed } }))
    }
    const text = (json.reply ?? '').trim() || FALLBACK_REPLIES[0]!
    return { text, keepListening: json.keepListening === true }
  } catch (err) {
    console.warn('[voice] /api/chat failed:', err)
    return { text: FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]!, keepListening: false }
  }
}

export function useVoice(): VoiceState {
  const [isListening,    setIsListening]    = useState(false)
  const [isSpeaking,     setIsSpeaking]     = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isThinking,     setIsThinking]     = useState(false)
  const [transcript,     setTranscript]     = useState('')
  const [reply,          setReply]          = useState('')
  const [error,          setError]          = useState('')
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
    if (isListening || isTranscribing || isThinking || isSpeaking) return
    // Virtual mute — never open the mic. Read from the store (not the hook's
    // `muted` binding) so the check reflects the value at call time even if the
    // caller is holding a stale closure (e.g. the follow-up timer below).
    if (getMuted()) {
      console.log('[voice] mic is muted — ignoring start request')
      setError('Microphone is muted — tap Unmute to talk.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[voice] getUserMedia unavailable — page must be HTTPS.')
      setError('Microphone needs a secure (HTTPS) connection.')
      return
    }

    setTranscript('')
    setReply('')
    setError('')
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
      const name = (err as DOMException)?.name
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access blocked — allow it to use voice.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : 'Couldn’t access the microphone.',
      )
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

      // Start the "thinking" loop the moment we begin uploading audio. It
      // covers the entire transcribe + LLM round and is faded out just before
      // TTS playback (or on any early exit below).
      void startThinkingSound()

      // Upload + display + reply.
      setIsThinking(true)
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
        stopThinkingSound()
        setIsThinking(false)
        historyRef.current = []
        return
      }

      // Append this user turn to the running history, then ask the LLM with
      // full context so multi-turn conversations actually remember prior turns.
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text } as ChatTurn,
      ].slice(-MAX_HISTORY_TURNS)
      const { text: replyText, keepListening: wantFollowUp } = await fetchReply(historyRef.current)
      console.log(`[voice] reply: "${replyText}" keepListening=${wantFollowUp}`)
      historyRef.current = [
        ...historyRef.current,
        { role: 'assistant', content: replyText } as ChatTurn,
      ].slice(-MAX_HISTORY_TURNS)
      setReply(replyText)
      // Hand off audio focus from the thinking loop to the TTS reply.
      stopThinkingSound()
      setIsThinking(false)
      setIsSpeaking(true)
      speakText(replyText, () => {
        setIsSpeaking(false)
        setVolume(0)
        volumeRef.current = 0
        // The assistant decides explicitly via end_conversation / keep_listening
        // tool calls. If it didn't opt in to another turn, end the conversation
        // — the next wake-word starts fresh.
        if (!wantFollowUp) {
          console.log('[voice] assistant ended the conversation (no keep_listening)')
          historyRef.current = []
          return
        }
        // Grace delay so speaker tail / room reverb doesn't trigger VAD on the
        // freshly-reopened mic. Also gives React time to flush setIsSpeaking
        // and re-bind startListeningRef to the latest closure (the guard
        // inside startListening would otherwise still see isSpeaking=true).
        setTimeout(() => startListeningRef.current?.(true), POST_TTS_GRACE_MS)
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
  }, [isListening, isTranscribing, isThinking, isSpeaking, cleanup, stopRecording, transcribe])

  const stopListening = useCallback(() => {
    stopRecording()
  }, [stopRecording])

  // `aborted` = true short-circuits the recorder's onstop handler: the blob is
  // dropped, nothing is uploaded, and history is cleared so the next wake word
  // starts a fresh conversation.
  const cancelListening = useCallback(() => {
    stopRecording(true)
  }, [stopRecording])

  // Interrupt an in-flight spoken reply and end the conversation. haltPlayback
  // stops the audio AND invalidates the rest of the sentence queue, so nothing
  // more is spoken and speakText's onEnd (which would reopen the mic) is
  // skipped. We therefore replicate the end-of-turn teardown here: silence the
  // thinking loop, drop out of speaking/thinking, reset the volume meter, and
  // clear history so the next wake-word starts fresh.
  const stopSpeaking = useCallback(() => {
    haltPlayback()
    stopThinkingSound()
    resetLipSync()
    setIsSpeaking(false)
    setIsThinking(false)
    setVolume(0)
    volumeRef.current = 0
    historyRef.current = []
  }, [])

  // Muting mid-utterance kills the live capture immediately. `aborted` skips
  // transcription and the LLM round-trip entirely, so nothing the mic already
  // picked up ever leaves the device — that's the point of a privacy mute.
  // `stoppedRef` guards against a recorder that's already winding down.
  useEffect(() => subscribeMuted((isMuted) => {
    if (!isMuted) return
    if (!recorderRef.current || stoppedRef.current) return
    console.log('[voice] muted while listening — aborting capture')
    stopRecording(true)
  }), [stopRecording])

  // The TTS onEnd callback needs to call startListening, but startListening is
  // declared after the recorder's onstop closes over it. Use a ref to break
  // the chicken-and-egg, and keep it in sync after every render.
  const startListeningRef = useRef<((followUp: boolean) => void) | null>(null)
  startListeningRef.current = startListening

  useEffect(() => {
    return () => {
      cleanup()
      stopThinkingSound()
      historyRef.current = []
      haltPlayback()
    }
  }, [cleanup])

  // Auto-clear the on-screen transcript/reply after 30 s of inactivity, so the
  // dashboard doesn't keep stale conversation text hanging over the orb. Any
  // active voice state (listening, transcribing, speaking) cancels the timer
  // and re-arms it on the next render once activity stops.
  useEffect(() => {
    const busy = isListening || isTranscribing || isThinking || isSpeaking
    if (busy) return
    if (!transcript && !reply) return
    const t = window.setTimeout(() => {
      setTranscript('')
      setReply('')
    }, 30_000)
    return () => window.clearTimeout(t)
  }, [isListening, isTranscribing, isThinking, isSpeaking, transcript, reply])

  // Auto-dismiss a voice error after a few seconds so the toast doesn't linger.
  useEffect(() => {
    if (!error) return
    const t = window.setTimeout(() => setError(''), 6000)
    return () => window.clearTimeout(t)
  }, [error])

  return { isListening, isSpeaking, isTranscribing, isThinking, transcript, reply, error, volume, startListening, stopListening, cancelListening, stopSpeaking }
}
