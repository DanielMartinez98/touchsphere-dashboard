// Tiny global volume store — 4 categories, persisted to localStorage.
//
// Categories:
//   master — multiplier applied on top of everything (system-wide)
//   sfx    — short UI sounds / chimes (e.g. start.mp3)
//   music  — longer audio clips
//   voice  — TTS replies and TTS test
//
// Effective gain for a sound = master * category. Both 0..1.
//
// We deliberately keep this outside React state (module-level store) so
// non-component code (utils/sound.ts, useVoice.ts speak helper) can read
// the current value without prop-drilling, while React components can
// subscribe via the useVolume() hook.

import { useSyncExternalStore } from 'react'

export type VolumeCategory = 'master' | 'sfx' | 'music' | 'voice'

const LS_KEY = 'ts_volumes_v1'

type State = Record<VolumeCategory, number>

const DEFAULTS: State = { master: 1, sfx: 1, music: 1, voice: 1 }

function load(): State {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      master: clamp(parsed.master ?? 1),
      sfx:    clamp(parsed.sfx    ?? 1),
      music:  clamp(parsed.music  ?? 1),
      voice:  clamp(parsed.voice  ?? 1),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function clamp(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 1
  return Math.max(0, Math.min(1, n))
}

let state: State = load()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** Read the current effective gain (0..1) for a category, including master. */
export function getEffectiveGain(category: Exclude<VolumeCategory, 'master'>): number {
  return state.master * state[category]
}

/** Read raw value for one category (no master multiplier applied). */
export function getVolume(category: VolumeCategory): number {
  return state[category]
}

/** Update one category. Persists immediately. */
export function setVolume(category: VolumeCategory, value: number) {
  const v = clamp(value)
  if (state[category] === v) return
  state = { ...state, [category]: v }
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch { /* quota */ }
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
function getSnapshot(): State { return state }

/** React hook — re-renders when any volume changes. */
export function useVolume() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
