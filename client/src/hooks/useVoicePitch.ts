// Voice pitch (RVC transpose), per assistant.
//
// Only meaningful for assistants voiced through RVC (Miku): RVC swaps the timbre
// of the TTS audio but INHERITS its pitch, so a character in a high register ends
// up sounding like the TTS voice wearing their tone. Transposing fixes that — but
// there's no correct number, it depends on the voice model and the source voice,
// so it has to be tuned by ear.
//
// Persisted server-side (POST /api/state/voice-pitch), because the point is to
// dial it in on a laptop and have the Pi kiosk speak with it. localStorage is a
// boot cache only; the server wins. Same shape as the avatar framing store.

import { useSyncExternalStore } from 'react'

const LS_KEY = 'ts_voice_pitch'

export const PITCH_MIN = -12
export const PITCH_MAX = 12
export const PITCH_DEFAULT = 4

const clamp = (v: number) => Math.round(Math.min(PITCH_MAX, Math.max(PITCH_MIN, v)))

let pitches: Record<string, number> = (() => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, number>
  } catch { return {} }
})()

const listeners = new Set<() => void>()

// Dragging a slider fires a change per pixel; we don't want a POST per pixel.
// The UI updates instantly, the server catches up once the user settles.
const SAVE_DEBOUNCE_MS = 500
const pending = new Map<string, number>()

function persist(assistantId: string, pitch: number) {
  const existing = pending.get(assistantId)
  if (existing !== undefined) window.clearTimeout(existing)
  pending.set(assistantId, window.setTimeout(() => {
    pending.delete(assistantId)
    fetch('/api/state/voice-pitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantId, pitch }),
    }).catch(err => console.warn('[voice-pitch] failed to persist:', err))
  }, SAVE_DEBOUNCE_MS))
}

export function setVoicePitch(assistantId: string, pitch: number) {
  const next = clamp(pitch)
  if (pitches[assistantId] === next) return
  pitches = { ...pitches, [assistantId]: next }
  try { localStorage.setItem(LS_KEY, JSON.stringify(pitches)) } catch { /* quota */ }
  persist(assistantId, next)
  listeners.forEach(cb => cb())
}

export function getVoicePitch(assistantId: string): number {
  const v = pitches[assistantId]
  return Number.isFinite(v) ? v! : PITCH_DEFAULT
}

export function useVoicePitch(assistantId: string): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => getVoicePitch(assistantId),
    () => getVoicePitch(assistantId),
  )
}

/** Adopt the server's saved pitches on boot — the server is the source of truth. */
let loaded = false
export function loadVoicePitchFromServer(): void {
  if (loaded) return
  loaded = true
  fetch('/api/state/voice-pitch')
    .then(r => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
    .then(data => {
      if (!data || typeof data !== 'object') return
      let changed = false
      for (const [id, v] of Object.entries(data)) {
        if (!Number.isFinite(v) || pitches[id] === v) continue
        pitches[id] = clamp(v)
        changed = true
      }
      if (!changed) return
      try { localStorage.setItem(LS_KEY, JSON.stringify(pitches)) } catch { /* quota */ }
      listeners.forEach(cb => cb())
    })
    .catch(() => { /* offline — keep the cached value */ })
}
