// Always-on, fully-offline wake-word detection using Vosk (WASM).
//
// Vosk runs the speech model inside a Web Worker, so the main thread (and the
// orb animation) stay smooth. Audio never leaves the browser — Scribe is only
// invoked AFTER the wake word fires, via the existing useVoice() flow. That's
// what makes this "free" compared to streaming everything to ElevenLabs.
//
// Setup (one-time):
//   1. Download vosk-model-small-en-us-0.15.zip from
//      https://alphacephei.com/vosk/models (~40 MB).
//   2. Place it at client/public/vosk-model-small-en-us-0.15.zip
//      (so it's served at /vosk-model-small-en-us-0.15.zip).
//
// The hook is opt-in (off by default) and persists the user's choice in
// localStorage so it survives reloads.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createModel, type KaldiRecognizer, type Model } from 'vosk-browser'

// localStorage keys.
const LS_INPUT_KEY   = 'ts_audio_input_device'
const LS_ENABLED_KEY = 'ts_wake_word_enabled'

// ── Shared toggle store ────────────────────────────────────────────────
// The enabled flag is read by both <App> (which actually runs the listener)
// and <SettingsPanel> (which renders the toggle), so we keep it in a tiny
// useSyncExternalStore-backed store. Toggling in Settings updates App on the
// next render without prop drilling or context.
let enabledValue: boolean = (() => {
  try { return localStorage.getItem(LS_ENABLED_KEY) === '1' } catch { return false }
})()
const enabledListeners = new Set<() => void>()
function subscribeEnabled(cb: () => void) { enabledListeners.add(cb); return () => { enabledListeners.delete(cb) } }
function getEnabled() { return enabledValue }
export function setWakeWordEnabled(v: boolean) {
  if (enabledValue === v) return
  enabledValue = v
  try { localStorage.setItem(LS_ENABLED_KEY, v ? '1' : '0') } catch { /* ignore */ }
  enabledListeners.forEach(cb => cb())
}
export function useWakeWordEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, getEnabled, getEnabled)
}

// Bundled model path — relative to the public root.
const MODEL_URL    = '/vosk-model-small-en-us-0.15.zip'
const SAMPLE_RATE  = 16_000   // Vosk small-en wants 16 kHz mono PCM.
const COOLDOWN_MS  = 3_000    // Ignore further wakes for this long after a hit.

// Words that should trigger the assistant. We check substring match so that
// "hey jarvis", "ok jarvis", or just "jarvis" all fire the same callback.
// Vosk sometimes mishears the name as "jervis" or "jarbis" → include those.
const WAKE_PATTERNS = ['jarvis', 'jervis', 'jarbis']

export type WakeStatus =
  | 'idle'        // disabled
  | 'loading'    // fetching/decompressing the model
  | 'listening' // mic is open, recognizer is running
  | 'cooldown'  // just woke; ignoring further hits briefly
  | 'error'

export interface UseWakeWordReturn {
  enabled: boolean
  status:  WakeStatus
  error:   string | null
  lastHit: string | null   // The phrase that triggered the last wake.
  setEnabled: (v: boolean) => void
}

interface UseWakeWordOptions {
  // Called when the wake word is detected. Should be cheap; the hook handles
  // its own cooldown so the parent doesn't need to debounce.
  onWake: () => void
  // While the parent is actively recording (mic in use by useVoice) or speaking
  // (TTS playing), we should pause to avoid triggering on the assistant's own
  // voice and to stop competing for the mic device.
  pause: boolean
}

export function useWakeWord({ onWake, pause }: UseWakeWordOptions): UseWakeWordReturn {
  const enabled = useWakeWordEnabled()
  const [status,  setStatus]  = useState<WakeStatus>('idle')
  const [error,   setError]   = useState<string | null>(null)
  const [lastHit, setLastHit] = useState<string | null>(null)

  // Refs for the live session. Kept out of state so they don't cause re-renders.
  const modelRef        = useRef<Model | null>(null)
  const recognizerRef   = useRef<KaldiRecognizer | null>(null)
  const streamRef       = useRef<MediaStream | null>(null)
  const ctxRef          = useRef<AudioContext | null>(null)
  const sourceRef       = useRef<MediaStreamAudioSourceNode | null>(null)
  // ScriptProcessorNode is deprecated but still works in Chromium and is the
  // simplest way to feed PCM frames to the recognizer without an AudioWorklet
  // module file. If it ever stops working we'd switch to AudioWorklet.
  const processorRef    = useRef<ScriptProcessorNode | null>(null)
  const onWakeRef       = useRef(onWake)
  const pauseRef        = useRef(pause)
  const lastWakeAtRef   = useRef<number>(0)

  // Keep latest callback / pause flag without retriggering effect.
  useEffect(() => { onWakeRef.current = onWake }, [onWake])
  useEffect(() => { pauseRef.current  = pause  }, [pause])

  const setEnabled = useCallback((v: boolean) => {
    setWakeWordEnabled(v)
  }, [])

  const teardown = useCallback(() => {
    try { processorRef.current?.disconnect() } catch { /* ignore */ }
    try { sourceRef.current?.disconnect()    } catch { /* ignore */ }
    try { ctxRef.current?.close()             } catch { /* ignore */ }
    try { recognizerRef.current?.remove?.()  } catch { /* ignore */ }
    try { modelRef.current?.terminate?.()    } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach(t => t.stop())
    processorRef.current = null
    sourceRef.current    = null
    ctxRef.current       = null
    recognizerRef.current = null
    modelRef.current     = null
    streamRef.current    = null
  }, [])

  useEffect(() => {
    if (!enabled) {
      teardown()
      setStatus('idle')
      setError(null)
      return
    }

    let cancelled = false

    ;(async () => {
      try {
        setError(null)
        setStatus('loading')
        console.log('[wake] loading vosk model:', MODEL_URL)

        // 1. Load the model (downloads + initializes the worker on first call).
        const model = await createModel(MODEL_URL)
        if (cancelled) { try { model.terminate?.() } catch { /* ignore */ }; return }
        modelRef.current = model

        // 2. Open the mic with the user-selected device. Vosk needs mono.
        //    We let the browser resample (Vosk recognizer is configured for
        //    16 kHz; AudioContext output runs at the device rate, and we pass
        //    the buffer's sampleRate-tagged AudioBuffer so vosk-browser does
        //    the conversion internally).
        const inId = localStorage.getItem(LS_INPUT_KEY) ?? 'default'
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          channelCount: 1,
        }
        if (inId && inId !== 'default') {
          audioConstraints.deviceId = { exact: inId }
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const track = stream.getAudioTracks()[0]
        console.log('[wake] mic acquired:', track?.label, track?.getSettings?.())

        // 3. Build the audio graph: source → processor → destination.
        const Ctor = window.AudioContext
          || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctor()
        ctxRef.current = ctx

        const recognizer = new model.KaldiRecognizer(SAMPLE_RATE)
        recognizerRef.current = recognizer

        // Both 'result' (final, after a pause) and 'partialresult' (interim,
        // every few hundred ms) come through. Wake words tend to surface in
        // the partial first, so we watch both.
        const handleHit = (text: string, source: 'partial' | 'final') => {
          if (pauseRef.current) return
          const lower = text.toLowerCase()
          const matched = WAKE_PATTERNS.find(p => lower.includes(p))
          if (!matched) return
          const now = performance.now()
          if (now - lastWakeAtRef.current < COOLDOWN_MS) return
          lastWakeAtRef.current = now
          console.log(`[wake] HIT (${source}):`, lower)
          setLastHit(lower)
          setStatus('cooldown')
          window.setTimeout(() => {
            // Only restore "listening" if the hook is still active.
            if (!cancelled && enabled) setStatus('listening')
          }, COOLDOWN_MS)
          try { onWakeRef.current() } catch (err) {
            console.warn('[wake] onWake handler threw:', err)
          }
        }

        recognizer.on('result', (msg: { result?: { text?: string } }) => {
          const t = msg.result?.text ?? ''
          if (t) handleHit(t, 'final')
        })
        recognizer.on('partialresult', (msg: { result?: { partial?: string } }) => {
          const t = msg.result?.partial ?? ''
          if (t) handleHit(t, 'partial')
        })

        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source
        // bufferSize 4096 is a good balance: ~85 ms latency at 48 kHz, low CPU.
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor
        processor.onaudioprocess = (event) => {
          if (pauseRef.current) return
          try {
            recognizer.acceptWaveform(event.inputBuffer)
          } catch (err) {
            // Recognizer can throw if the worker is mid-shutdown — log once and bail.
            console.warn('[wake] acceptWaveform failed:', err)
          }
        }
        source.connect(processor)
        // Must connect to destination, otherwise onaudioprocess never fires in
        // some Chromium builds. Routing through a muted gain prevents echo.
        const muted = ctx.createGain()
        muted.gain.value = 0
        processor.connect(muted)
        muted.connect(ctx.destination)

        if (cancelled) { teardown(); return }
        setStatus('listening')
        console.log('[wake] listening for:', WAKE_PATTERNS.join(', '))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[wake] startup failed:', msg)
        if (!cancelled) {
          setError(msg)
          setStatus('error')
        }
        teardown()
      }
    })()

    return () => {
      cancelled = true
      teardown()
    }
    // We deliberately don't depend on `pause` here — pause is read live via
    // pauseRef inside the audio callbacks, so toggling it doesn't tear down
    // the whole pipeline.
  }, [enabled, teardown])

  return { enabled, status, error, lastHit, setEnabled }
}
