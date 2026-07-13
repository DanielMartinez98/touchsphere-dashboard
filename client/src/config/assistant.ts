// ── Assistant identity (client) ──────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the client half of the AI's identity: the name,
// the wake ("call") words, and the UI copy for each selectable assistant.
//
// The user picks a profile in Settings; the selection is persisted server-side
// (POST /api/state/assistant) so the chat personality and TTS voice — which are
// defined in the SERVER table (server/src/config/assistant.ts) — follow it too.
// Keep the ids and names in sync between the two files.

import { useSyncExternalStore } from 'react'

export type AssistantId = 'jarvis' | 'touchsphere' | 'martin' | 'merlin' | 'jess' | 'miku'

// ── The assistant's face ─────────────────────────────────────────────────────
// Each assistant owns its appearance the same way it owns its voice and persona,
// so switching assistant switches the face too. TouchSphere is deliberately the
// odd one out: it *is* the orb — that's its identity, not a missing model.
//
// To give an assistant its own model later, point it at a different file here.
// Nothing else needs to change: the renderer is chosen from `kind`.
export type AvatarSpec =
  | { kind: 'sphere' }
  | { kind: 'live2d'; model: string }
  | { kind: 'vrm';    model: string }

// ── The model catalogue ──────────────────────────────────────────────────────
// Every face the dashboard can wear. Each assistant picks one (see `avatar` on
// its profile below), and the user can override that per assistant in Settings.
//
// TO ADD A MODEL: drop the file in client/public (dev) and in the server's
// avatar mount (prod), then add one entry here. Nothing else needs to change —
// the renderer is chosen from `kind`.
//
// Live2D models live under /live2d/<name>/<name>.model3.json; VRMs are single
// files served from the web root.
export type AvatarModelId = string

export interface AvatarModel {
  id: AvatarModelId
  /** Shown in the Settings picker. */
  label: string
  /** One-liner under the label. */
  note: string
  spec: AvatarSpec
}

export const AVATAR_MODELS: AvatarModel[] = [
  {
    id: 'orb',
    label: 'Orb',
    note: 'The particle sphere — no character',
    spec: { kind: 'sphere' },
  },
  {
    id: 'hiyori',
    label: 'Hiyori',
    note: 'Live2D — official sample, full physics',
    spec: { kind: 'live2d', model: '/live2d/Hiyori/hiyori_pro_t11.model3.json' },
  },
  {
    id: 'miku',
    label: 'Miku',
    note: 'Live2D — official sample, full physics',
    spec: { kind: 'live2d', model: '/live2d/Miku/miku_sample_t04.model3.json' },
  },
  {
    id: 'frieren',
    label: 'Frieren',
    note: 'Live2D — ripped pack, no physics (hair won’t sway)',
    spec: { kind: 'live2d', model: '/live2d/Frieren/Frieren.model3.json' },
  },
  {
    id: 'cortana',
    label: 'Cortana',
    note: 'VRM — true 3D, heavier on the GPU',
    spec: { kind: 'vrm', model: '/avatar.vrm' },
  },
  // NOT here: the Miku .unitypackage. That's a VRChat Unity avatar — an FBX with
  // Unity shaders, no VRM humanoid metadata and no expression presets, so there'd
  // be nothing to drive lip-sync or blinking from. The Miku above is the official
  // Live2D sample model instead, which has all of it.
]

export function getAvatarModel(id: AvatarModelId): AvatarModel | undefined {
  return AVATAR_MODELS.find(m => m.id === id)
}

export interface AssistantProfile {
  id: AssistantId
  /** Display name, e.g. shown as "Hey Martin". */
  name: string
  /** One-line description shown next to the option in Settings. */
  tagline: string
  /**
   * The face this assistant wears by default — a model id from AVATAR_MODELS.
   * The user can override it per assistant in Settings (see useAvatar).
   */
  defaultModelId: AvatarModelId
  /**
   * Phrases that trigger the assistant, matched as case-insensitive substrings.
   * Vosk's small-en model has a fixed vocabulary and frequently mishears names,
   * so each list includes common phonetic look-alikes. If you rename or add an
   * assistant, tune this list for how the name actually gets transcribed.
   */
  wakePatterns: string[]
  /** Canonical spoken prompt shown in the UI, e.g. "Hey Martin". */
  wakePhrase: string
  /** A short in-character line spoken as a preview when the profile is selected. */
  sampleLine: string
}

export const ASSISTANT_PROFILES: Record<AssistantId, AssistantProfile> = {
  martin: {
    id: 'martin',
    name: 'Martin',
    tagline: 'Annoyed, tipsy wizard stuck in the 90s — grumbles, then helps.',
    defaultModelId: 'frieren',
    wakePatterns: ['yo martin', 'yo martini', 'yo martian', 'yo marten'],
    wakePhrase: 'Yo Martin',
    sampleLine: "Ugh, what now? *hic* ...Yeah, I'm Martin. Back in my day we had real magic — and dial-up. What d'you want?",
  },
  jarvis: {
    id: 'jarvis',
    name: 'Jarvis',
    tagline: 'Refined British AI butler — dry wit, ruthless efficiency.',
    defaultModelId: 'frieren',
    wakePatterns: ['jarvis', 'hey jarvis', 'yo jarvis', 'jervis', 'harvest'],
    wakePhrase: 'Hey Jarvis',
    sampleLine: "Good day. Jarvis at your service — efficient, discreet, and only mildly judgmental.",
  },
  touchsphere: {
    id: 'touchsphere',
    name: 'TouchSphere',
    tagline: 'Bright, upbeat futuristic helper.',
    // TouchSphere *is* the orb — that's the whole identity. Never give it a model.
    defaultModelId: 'orb',
    wakePatterns: ['touchsphere', 'touch sphere', 'hey touchsphere', 'hey sphere', 'the sphere', 'sphere'],
    wakePhrase: 'Hey Sphere',
    sampleLine: "Hey there! TouchSphere here, powered up and ready to help you take on the day!",
  },
  merlin: {
    id: 'merlin',
    name: 'Merlin',
    tagline: 'Whimsical wizard of old — theatrical, arcane flair.',
    defaultModelId: 'frieren',
    wakePatterns: ['excuse me merlin', 'excuse me marlin', 'excuse me murlin', 'excuse me berlin'],
    wakePhrase: 'Excuse me Merlin',
    sampleLine: "Ahh, greetings! Merlin — weaver of spells and keeper of ancient wisdom — at thy service.",
  },
  miku: {
    id: 'miku',
    name: 'Miku',
    tagline: 'Cheerful virtual singer — bubbly, warm, always glad to help.',
    // Her face and her voice are both Miku's — the whole point of tying the
    // model to the assistant. The voice is produced locally by kokoro→RVC
    // (see the server profile), so it costs nothing and works offline.
    defaultModelId: 'miku',
    wakePatterns: ['hey miku', 'hey mika', 'hey meeku', 'hey miko', 'a miku'],
    wakePhrase: 'Hey Miku',
    sampleLine: "Hi hi! Miku here! Whatever you need, I'm on it — let's make today a good one!",
  },
  jess: {
    id: 'jess',
    name: 'Jess',
    tagline: 'Sassy and easily annoyed — helps anyway, with an eye-roll.',
    defaultModelId: 'frieren',
    wakePatterns: ['yo jess', 'yo jessie', 'yo jes', 'yo jazz'],
    wakePhrase: 'Yo Jess',
    sampleLine: "Ugh, fine, I'm Jess. What do you want? ...I'll help. I always do. Doesn't mean I have to like it.",
  },
}

/** Display order for the Settings selector. */
export const ASSISTANT_ORDER: AssistantId[] = ['martin', 'jarvis', 'touchsphere', 'miku', 'merlin', 'jess']
export const DEFAULT_ASSISTANT_ID: AssistantId = 'martin'

// ── Reactive selection store ─────────────────────────────────────────────────
// Backed by useSyncExternalStore so both the Settings selector and the wake-word
// listener see changes immediately. Persisted to localStorage for instant boot,
// and mirrored to the server (the source of truth for persona + voice).
const LS_KEY = 'ts_assistant_id'

function readInitial(): AssistantId {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v && v in ASSISTANT_PROFILES) return v as AssistantId
  } catch { /* ignore */ }
  return DEFAULT_ASSISTANT_ID
}

let selectedId: AssistantId = readInitial()
const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
function getSnapshot() { return selectedId }

/** Change the active assistant: update the store, cache locally, persist server-side. */
export function setAssistantId(id: AssistantId) {
  if (!(id in ASSISTANT_PROFILES) || id === selectedId) return
  selectedId = id
  try { localStorage.setItem(LS_KEY, id) } catch { /* ignore */ }
  emit()
  fetch('/api/state/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(err => console.warn('[assistant] failed to persist selection:', err))
}

/** The currently-selected assistant id (re-renders on change). */
export function useAssistantId(): AssistantId {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** The full selected profile (name + wake words + UI copy). */
export function useAssistant(): AssistantProfile {
  return ASSISTANT_PROFILES[useAssistantId()]
}

// Reconcile with the server once on boot (server wins across devices/reloads).
let loaded = false
export function loadAssistantFromServer(): void {
  if (loaded) return
  loaded = true
  fetch('/api/state/assistant')
    .then(r => (r.ok ? (r.json() as Promise<{ id?: string }>) : null))
    .then(data => {
      const id = data?.id
      if (id && id in ASSISTANT_PROFILES && id !== selectedId) {
        selectedId = id as AssistantId
        try { localStorage.setItem(LS_KEY, selectedId) } catch { /* ignore */ }
        emit()
      }
    })
    .catch(() => { /* keep local value */ })
}
