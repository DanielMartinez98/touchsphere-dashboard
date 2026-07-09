// Virtual mic mute — a software equivalent of the mute switch on a smart
// speaker. When muted:
//   • the wake-word listener is torn down entirely (the mic device is released,
//     so the browser's recording indicator goes dark — this is a privacy mute,
//     not just a software gate)
//   • useVoice() refuses to open the mic, so orb taps do nothing
//
// Kept in a module-level store (not React state) so non-component code —
// useVoice's startListening guard — can read it synchronously, while components
// subscribe via useMuted(). Same pattern as useVolume / useWakeWordEnabled.

import { useSyncExternalStore } from 'react'

const LS_KEY = 'ts_mic_muted'

let mutedValue: boolean = (() => {
  try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
})()

const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot(): boolean { return mutedValue }

/** Read the current mute state synchronously (for non-React callers). */
export function getMuted(): boolean { return mutedValue }

/**
 * Subscribe to mute changes, receiving the new value. Lets consumers react to a
 * mute *event* (e.g. killing a live recording) from a callback rather than from
 * an effect body, which is the pattern React wants for external stores.
 * Returns an unsubscribe function.
 */
export function subscribeMuted(cb: (muted: boolean) => void) {
  const wrapped = () => cb(mutedValue)
  listeners.add(wrapped)
  return () => { listeners.delete(wrapped) }
}

/** Set the mute state. Persists immediately. */
export function setMuted(v: boolean) {
  if (mutedValue === v) return
  mutedValue = v
  try { localStorage.setItem(LS_KEY, v ? '1' : '0') } catch { /* quota */ }
  listeners.forEach(cb => cb())
}

export function toggleMuted() { setMuted(!mutedValue) }

/** React hook — re-renders when the mute state changes. */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
