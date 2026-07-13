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
const LS_BACKEND_KEY = 'ts_avatar_backend'

/** Where the VRM model is served from. Drop a .vrm at client/public/avatar.vrm. */
export const AVATAR_MODEL_URL = '/avatar.vrm'

/** Where the Live2D model manifest is served from. */
export const LIVE2D_MODEL_URL = '/live2d/Frieren/Frieren.model3.json'

// Two very different avatar technologies, both valid:
//   'live2d' — 2D rigged model (.moc3). What VTubers actually use. Much lighter
//              on the GPU, which matters on the Pi.
//   'vrm'    — 3D humanoid model (.vrm). Real depth, but a heavier scene.
export type AvatarBackend = 'live2d' | 'vrm'

let backendValue: AvatarBackend = (() => {
  try {
    const v = localStorage.getItem(LS_BACKEND_KEY)
    if (v === 'live2d' || v === 'vrm') return v
  } catch { /* ignore */ }
  return 'live2d'
})()

const backendListeners = new Set<() => void>()

export function setAvatarBackend(v: AvatarBackend) {
  if (backendValue === v) return
  backendValue = v
  try { localStorage.setItem(LS_BACKEND_KEY, v) } catch { /* quota */ }
  // Swapping renderers means a fresh load — clear the previous one's status.
  setAvatarRuntime('loading')
  setAvatarFps(0)
  backendListeners.forEach(cb => cb())
}

export function useAvatarBackend(): AvatarBackend {
  return useSyncExternalStore(
    cb => { backendListeners.add(cb); return () => { backendListeners.delete(cb) } },
    () => backendValue,
    () => backendValue,
  )
}

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

// ── Framing (zoom + vertical position) ───────────────────────────────────────
// How close the avatar sits to the camera and where she's centred. Models are
// authored at wildly different scales and crops — one ships framed head-to-toe,
// another bust-only — so there's no single default that suits every model. This
// is a per-device visual preference, so it lives in localStorage like the rest
// of the avatar settings rather than being pushed to the server.

const LS_ZOOM_KEY    = 'ts_avatar_zoom'
const LS_OFFSETY_KEY = 'ts_avatar_offset_y'

/** 1 = fit the whole model on screen. Higher = closer. */
export const ZOOM_MIN = 0.6
export const ZOOM_MAX = 3.5
export const ZOOM_DEFAULT = 1.3
/** Fraction of screen height to shift her by. Negative = up, positive = down. */
export const OFFSET_MIN = -0.5
export const OFFSET_MAX = 0.5

export interface AvatarFraming { zoom: number; offsetY: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function readNumber(key: string, fallback: number, lo: number, hi: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback
  } catch { return fallback }
}

let framing: AvatarFraming = {
  zoom:    readNumber(LS_ZOOM_KEY,    ZOOM_DEFAULT, ZOOM_MIN,   ZOOM_MAX),
  offsetY: readNumber(LS_OFFSETY_KEY, 0,            OFFSET_MIN, OFFSET_MAX),
}
const framingListeners = new Set<() => void>()

export function setAvatarFraming(next: Partial<AvatarFraming>) {
  const zoom    = clamp(next.zoom    ?? framing.zoom,    ZOOM_MIN,   ZOOM_MAX)
  const offsetY = clamp(next.offsetY ?? framing.offsetY, OFFSET_MIN, OFFSET_MAX)
  if (zoom === framing.zoom && offsetY === framing.offsetY) return
  framing = { zoom, offsetY }
  try {
    localStorage.setItem(LS_ZOOM_KEY, String(zoom))
    localStorage.setItem(LS_OFFSETY_KEY, String(offsetY))
  } catch { /* quota */ }
  framingListeners.forEach(cb => cb())
}

export function resetAvatarFraming() {
  setAvatarFraming({ zoom: ZOOM_DEFAULT, offsetY: 0 })
}

export function useAvatarFraming(): AvatarFraming {
  return useSyncExternalStore(
    cb => { framingListeners.add(cb); return () => { framingListeners.delete(cb) } },
    () => framing,
    () => framing,
  )
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
