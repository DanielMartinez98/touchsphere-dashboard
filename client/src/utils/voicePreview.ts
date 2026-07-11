// Plays a short in-character TTS clip for an assistant profile, used by the
// Settings picker so the user can hear the voice + personality before committing.
//
// It hits the same /api/tts endpoint the voice loop uses, but passes ?as=<id> so
// the server voices that specific profile regardless of which one is currently
// selected. Playback is routed to the user's chosen output sink (Hardware tab)
// and respects the "voice" volume level, mirroring useVoice's speakText.
//
// We fetch() the audio first (rather than handing the URL straight to <audio>)
// so that when synthesis FAILS we can read the server's JSON error body and log
// the real reason (e.g. an unavailable ElevenLabs voice) to the Debug tab —
// otherwise HTMLAudioElement only surfaces an opaque, detail-free error event.

import { getEffectiveGain } from '../hooks/useVolume'
import type { AssistantId } from '../config/assistant'

const API = import.meta.env.VITE_AUDIO_API ?? ''
const LS_OUTPUT_KEY = 'ts_audio_output_device'

// Only one preview plays at a time — a new selection interrupts the previous clip.
let current: HTMLAudioElement | null = null
let currentObjectUrl: string | null = null

/** Stop any in-flight preview clip and release its blob URL. */
export function stopVoicePreview(): void {
  if (current) {
    try { current.pause() } catch { /* ignore */ }
    current = null
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
}

/**
 * Speak `text` in the given assistant's voice. `onEnded` fires when the clip
 * finishes, errors, or fails to synthesize, so callers can clear a "playing"
 * indicator. Failures are logged via console.error, which the Settings → Debug
 * error log captures.
 */
export async function playVoicePreview(
  assistantId: AssistantId,
  text: string,
  onEnded?: () => void,
): Promise<void> {
  stopVoicePreview()
  const url = `${API}/api/tts?as=${encodeURIComponent(assistantId)}&text=${encodeURIComponent(text)}`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      // Pull the server's error detail so the reason is visible in the Debug tab.
      let detail = `HTTP ${res.status}`
      try {
        const j = await res.json() as { error?: string; detail?: string }
        if (j.detail) detail += ` — ${j.detail}`
        else if (j.error) detail += ` — ${j.error}`
      } catch { /* non-JSON body */ }
      console.error(`[voice-preview] "${assistantId}" voice failed: ${detail}`)
      onEnded?.()
      return
    }

    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    currentObjectUrl = objUrl
    const audio = new Audio(objUrl)
    audio.preload = 'auto'
    audio.volume = Math.max(0, Math.min(1, getEffectiveGain('voice')))
    current = audio

    const finish = () => {
      if (currentObjectUrl === objUrl) { URL.revokeObjectURL(objUrl); currentObjectUrl = null }
      if (current === audio) current = null
      onEnded?.()
    }
    audio.onended = finish
    audio.onerror = () => {
      console.error(`[voice-preview] "${assistantId}" clip decoded but failed to play`)
      finish()
    }

    // Route to the user-selected speaker if the browser supports setSinkId.
    type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    const a = audio as AudioWithSink
    const outId = localStorage.getItem(LS_OUTPUT_KEY) ?? 'default'
    if (outId && outId !== 'default' && typeof a.setSinkId === 'function') {
      try { await a.setSinkId(outId) } catch (err) {
        console.warn('[voice-preview] setSinkId failed, using default sink:', err)
      }
    }

    await audio.play()
  } catch (err) {
    console.error(`[voice-preview] "${assistantId}" request error: ${err instanceof Error ? err.message : String(err)}`)
    onEnded?.()
  }
}
