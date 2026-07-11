// Plays a short in-character TTS clip for an assistant profile, used by the
// Settings picker so the user can hear the voice + personality before committing.
//
// It hits the same /api/tts endpoint the voice loop uses, but passes ?as=<id> so
// the server voices that specific profile regardless of which one is currently
// selected. Playback is routed to the user's chosen output sink (Hardware tab)
// and respects the "voice" volume level, mirroring useVoice's speakText.

import { getEffectiveGain } from '../hooks/useVolume'
import type { AssistantId } from '../config/assistant'

const API = import.meta.env.VITE_AUDIO_API ?? ''
const LS_OUTPUT_KEY = 'ts_audio_output_device'

// Only one preview plays at a time — a new selection interrupts the previous clip.
let current: HTMLAudioElement | null = null

/** Stop any in-flight preview clip. */
export function stopVoicePreview(): void {
  if (current) {
    try { current.pause() } catch { /* ignore */ }
    current = null
  }
}

/**
 * Speak `text` in the given assistant's voice. `onEnded` fires when the clip
 * finishes (or errors), so callers can clear a "playing" indicator.
 */
export async function playVoicePreview(
  assistantId: AssistantId,
  text: string,
  onEnded?: () => void,
): Promise<void> {
  stopVoicePreview()
  try {
    const url = `${API}/api/tts?as=${encodeURIComponent(assistantId)}&text=${encodeURIComponent(text)}`
    const audio = new Audio(url)
    audio.preload = 'auto'
    audio.volume = Math.max(0, Math.min(1, getEffectiveGain('voice')))
    current = audio

    const finish = () => {
      if (current === audio) current = null
      onEnded?.()
    }
    audio.onended = finish
    audio.onerror = () => {
      console.warn('[preview] TTS audio error')
      finish()
    }

    // Route to the user-selected speaker if the browser supports setSinkId.
    type AudioWithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    const a = audio as AudioWithSink
    const outId = localStorage.getItem(LS_OUTPUT_KEY) ?? 'default'
    if (outId && outId !== 'default' && typeof a.setSinkId === 'function') {
      try { await a.setSinkId(outId) } catch (err) {
        console.warn('[preview] setSinkId failed, using default sink:', err)
      }
    }

    await audio.play()
  } catch (err) {
    console.warn('[preview] playback failed:', err)
    if (current) current = null
    onEnded?.()
  }
}
