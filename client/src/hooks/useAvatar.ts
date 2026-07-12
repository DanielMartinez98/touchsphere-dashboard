// Avatar toggle — swaps the centre visual between the particle sphere (default)
// and a 3D VRM "VTuber" avatar that lip-syncs to the assistant's TTS reply.
//
// Off by default, and deliberately cheap to turn off: when disabled, no VRM is
// fetched, no extra WebGL scene is built, and the TTS audio path stays exactly
// as it was (see utils/lipsync.ts — the WebAudio tap is only attached when the
// avatar is on, because tapping the audio element moves speaker routing from
// HTMLAudioElement.setSinkId to AudioContext.setSinkId).
//
// Module-level store rather than React state so non-component code (useVoice's
// speakText, which is a plain module function) can read it synchronously.
// Same pattern as useMuted / useVolume.

import { useSyncExternalStore } from 'react'

const LS_KEY = 'ts_avatar_enabled'

/** Where the VRM model is served from. Drop a .vrm at client/public/avatar.vrm. */
export const AVATAR_MODEL_URL = '/avatar.vrm'

let enabledValue: boolean = (() => {
  try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
})()

const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot(): boolean { return enabledValue }

/** Read the avatar state synchronously (for non-React callers like speakText). */
export function getAvatarEnabled(): boolean { return enabledValue }

export function setAvatarEnabled(v: boolean) {
  if (enabledValue === v) return
  enabledValue = v
  try { localStorage.setItem(LS_KEY, v ? '1' : '0') } catch { /* quota */ }
  // Turning it off unmounts the Avatar, so clear any stale error/fps it left
  // behind — otherwise re-enabling would show last run's failure before the
  // fresh load attempt has even started.
  if (!v) {
    setAvatarRuntime('loading')
    setAvatarFps(0)
  }
  listeners.forEach(cb => cb())
}

/** React hook — re-renders when the avatar is toggled. */
export function useAvatarEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Runtime status ───────────────────────────────────────────────────────────
// Reported by the Avatar component. App reads it to fall back to the sphere when
// the model can't be loaded; Settings reads it to explain *why*.

export type AvatarStatus = 'loading' | 'ready' | 'error'
export interface AvatarRuntime { status: AvatarStatus; detail?: string }

let runtime: AvatarRuntime = { status: 'loading' }
const runtimeListeners = new Set<() => void>()

export function setAvatarRuntime(status: AvatarStatus, detail?: string) {
  if (runtime.status === status && runtime.detail === detail) return
  runtime = { status, detail }
  runtimeListeners.forEach(cb => cb())
}

export function useAvatarRuntime(): AvatarRuntime {
  return useSyncExternalStore(
    cb => { runtimeListeners.add(cb); return () => { runtimeListeners.delete(cb) } },
    () => runtime,
    () => runtime,
  )
}

// ── Measured framerate ───────────────────────────────────────────────────────
// Kept in its own store so the once-a-second FPS tick only re-renders the
// Settings panel that displays it — never App, which would restart the scene's
// neighbours for nothing. This is how you check the avatar is viable on the Pi.

let fps = 0
const fpsListeners = new Set<() => void>()

export function setAvatarFps(v: number) {
  if (fps === v) return
  fps = v
  fpsListeners.forEach(cb => cb())
}

export function useAvatarFps(): number {
  return useSyncExternalStore(
    cb => { fpsListeners.add(cb); return () => { fpsListeners.delete(cb) } },
    () => fps,
    () => fps,
  )
}
