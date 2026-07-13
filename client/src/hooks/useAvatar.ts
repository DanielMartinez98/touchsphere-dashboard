// Avatar toggle — swaps the centre visual between the particle sphere (default)
// and a "VTuber" avatar that lip-syncs to the assistant's TTS reply.
//
// WHICH avatar is not decided here: each assistant owns its own face, declared
// as `avatar` on its profile in config/assistant.ts, alongside its voice and
// persona. Switching assistant therefore switches the model. TouchSphere's face
// is the orb itself, so it stays a sphere even with this toggle on.
//
// Off by default, and deliberately cheap to turn off: when disabled, no model is
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

// ── Model choice, per assistant ──────────────────────────────────────────────
// Each assistant has a default face (its profile's `defaultModelId`), but the
// user can point any assistant at any model in the catalogue. Stored per
// assistant so choosing Cortana for Jess doesn't also change Martin.
//
// Only the *override* is stored — an assistant with no entry here falls back to
// its profile default, so changing a default in code still takes effect for
// anyone who never overrode it.

const LS_MODELS_KEY = 'ts_avatar_models'

let modelOverrides: Record<string, string> = (() => {
  try {
    const raw = localStorage.getItem(LS_MODELS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, string>
  } catch { return {} }
})()

const modelListeners = new Set<() => void>()

export function setAvatarModelId(assistantId: string, modelId: string) {
  if (modelOverrides[assistantId] === modelId) return
  modelOverrides = { ...modelOverrides, [assistantId]: modelId }
  try { localStorage.setItem(LS_MODELS_KEY, JSON.stringify(modelOverrides)) } catch { /* quota */ }
  // A different model means a fresh load — don't leave the old one's status up.
  setAvatarRuntime('loading')
  setAvatarFps(0)
  modelListeners.forEach(cb => cb())
}

/** The model id chosen for this assistant, or undefined to use its default. */
export function useAvatarModelOverride(assistantId: string): string | undefined {
  return useSyncExternalStore(
    cb => { modelListeners.add(cb); return () => { modelListeners.delete(cb) } },
    () => modelOverrides[assistantId],
    () => modelOverrides[assistantId],
  )
}

// ── Framing (zoom + vertical position), per assistant ────────────────────────
// How close the avatar sits to the camera and where she's centred. Models are
// authored at wildly different scales and crops — one ships framed head-to-toe,
// another bust-only — so there's no single number that suits every model. That's
// why framing is stored PER ASSISTANT: once assistants have their own models,
// each one's good framing is different, and a single shared value would be wrong
// for all but one of them.
//
// A per-device visual preference, so it lives in localStorage like the rest of
// the avatar settings rather than being pushed to the server.

const LS_FRAMING_KEY = 'ts_avatar_framing'

/** 1 = fit the whole model on screen. Higher = closer. */
export const ZOOM_MIN = 0.6
export const ZOOM_MAX = 3.5
export const ZOOM_DEFAULT = 1.3
/**
 * Fraction of the frame to shift her by. Negative = up, positive = down.
 * Ranges a full frame each way: zooming a full-body model to a bust shot means
 * travelling from the body's centre all the way up to the face, and ±50% wasn't
 * enough to get there — it cropped the head.
 */
export const OFFSET_MIN = -1
export const OFFSET_MAX = 1

export interface AvatarFraming { zoom: number; offsetY: number }

export const DEFAULT_FRAMING: AvatarFraming = { zoom: ZOOM_DEFAULT, offsetY: 0 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** assistant id → framing. Missing entries fall back to DEFAULT_FRAMING. */
type FramingMap = Record<string, AvatarFraming>

let framings: FramingMap = (() => {
  try {
    const raw = localStorage.getItem(LS_FRAMING_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as FramingMap
  } catch { return {} }
})()

const framingListeners = new Set<() => void>()

// Cache the per-key object so useSyncExternalStore's getSnapshot returns a
// referentially stable value — rebuilding it each call would loop forever.
const snapshots = new Map<string, AvatarFraming>()

function snapshotFor(key: string): AvatarFraming {
  const stored = framings[key]
  const zoom    = clamp(stored?.zoom    ?? DEFAULT_FRAMING.zoom,    ZOOM_MIN,   ZOOM_MAX)
  const offsetY = clamp(stored?.offsetY ?? DEFAULT_FRAMING.offsetY, OFFSET_MIN, OFFSET_MAX)
  const cached = snapshots.get(key)
  if (cached && cached.zoom === zoom && cached.offsetY === offsetY) return cached
  const fresh = { zoom, offsetY }
  snapshots.set(key, fresh)
  return fresh
}

// Coalesce slider drags: dragging emits a change per pixel, and we don't want a
// POST per pixel. localStorage + the on-screen avatar update instantly; the
// server catches up once the user stops moving.
const SAVE_DEBOUNCE_MS = 400
const pendingSaves = new Map<string, number>()

function persistFraming(key: string, framing: AvatarFraming) {
  const existing = pendingSaves.get(key)
  if (existing !== undefined) window.clearTimeout(existing)
  pendingSaves.set(key, window.setTimeout(() => {
    pendingSaves.delete(key)
    fetch('/api/state/avatar-framing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: key, ...framing }),
    }).catch(err => console.warn('[avatar] failed to persist framing:', err))
  }, SAVE_DEBOUNCE_MS))
}

export function setAvatarFraming(key: string, next: Partial<AvatarFraming>) {
  const current = snapshotFor(key)
  const zoom    = clamp(next.zoom    ?? current.zoom,    ZOOM_MIN,   ZOOM_MAX)
  const offsetY = clamp(next.offsetY ?? current.offsetY, OFFSET_MIN, OFFSET_MAX)
  if (zoom === current.zoom && offsetY === current.offsetY) return
  const entry = { zoom, offsetY }
  framings = { ...framings, [key]: entry }
  // localStorage is a boot cache so the avatar isn't briefly mis-framed on load;
  // the server is the source of truth across devices.
  try { localStorage.setItem(LS_FRAMING_KEY, JSON.stringify(framings)) } catch { /* quota */ }
  persistFraming(key, entry)
  framingListeners.forEach(cb => cb())
}

export function resetAvatarFraming(key: string) {
  setAvatarFraming(key, DEFAULT_FRAMING)
}

/**
 * Pull every model's framing from the server once on boot and adopt it — the
 * server wins, so framing dialled in on one device shows up on the kiosk.
 * Mirrors loadAssistantFromServer().
 */
let framingLoaded = false
export function loadAvatarFramingFromServer(): void {
  if (framingLoaded) return
  framingLoaded = true
  fetch('/api/state/avatar-framing')
    .then(r => (r.ok ? (r.json() as Promise<Record<string, Partial<AvatarFraming>>>) : null))
    .then(data => {
      if (!data || typeof data !== 'object') return
      let changed = false
      for (const [key, value] of Object.entries(data)) {
        if (!value || !Number.isFinite(value.zoom) || !Number.isFinite(value.offsetY)) continue
        const cur = framings[key]
        if (cur && cur.zoom === value.zoom && cur.offsetY === value.offsetY) continue
        framings[key] = {
          zoom:    clamp(value.zoom!,    ZOOM_MIN,   ZOOM_MAX),
          offsetY: clamp(value.offsetY!, OFFSET_MIN, OFFSET_MAX),
        }
        changed = true
      }
      if (!changed) return
      try { localStorage.setItem(LS_FRAMING_KEY, JSON.stringify(framings)) } catch { /* quota */ }
      framingListeners.forEach(cb => cb())
    })
    .catch(() => { /* offline — keep the locally cached framing */ })
}

/** Framing for one assistant. Each gets its own — their models differ. */
export function useAvatarFraming(key: string): AvatarFraming {
  return useSyncExternalStore(
    cb => { framingListeners.add(cb); return () => { framingListeners.delete(cb) } },
    () => snapshotFor(key),
    () => snapshotFor(key),
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
