import { useEffect, useState, useSyncExternalStore } from 'react'
import { startAlarmSound, stopAlarmSound } from '../utils/sound'
import { onServerEvent } from './useServerEvents'

// The work/rest timer under the sphere in work mode. Nothing starts on its
// own: a tap starts the work, the alarm says it is over and the screen turns
// to the rest colour, and the rest starts on the next tap (and work again
// after it). Either can be paused.
//
// A module store, not component state, because two places read it: the timer
// itself and App's backdrop, which changes colour while it is time to rest.
// Kept in localStorage so a reload of the kiosk does not lose a running round.

export interface FocusSettings { workMin: number; restMin: number; longRestMin: number; roundsBeforeLong: number }
export const FOCUS_DEFAULTS: FocusSettings = { workMin: 25, restMin: 5, longRestMin: 15, roundsBeforeLong: 4 }

export type FocusPhase = 'work' | 'rest'
/** idle: nothing started. done: this phase's time is up, waiting for the tap that starts the next. */
export type FocusStatus = 'idle' | 'running' | 'paused' | 'done'

export interface FocusState {
  phase:       FocusPhase
  status:      FocusStatus
  endsAt:      number    // while running
  remainingMs: number    // while paused
  durationMs:  number    // the whole phase, for the progress ring
  round:       number    // work rounds finished since the last reset
  long:        boolean   // the current/next rest is the long one
  ringing:     boolean
}

const KEY = 'focus-timer'
const RING_FOR_MS = 60_000

const IDLE: FocusState = { phase: 'work', status: 'idle', endsAt: 0, remainingMs: 0, durationMs: 0, round: 0, long: false, ringing: false }

function load(): FocusState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return IDLE
    const s = { ...IDLE, ...(JSON.parse(raw) as Partial<FocusState>), ringing: false }
    // Ran out while the page was gone: land on "time's up", without the alarm.
    if (s.status === 'running' && s.endsAt <= Date.now()) s.status = 'done'
    return s
  } catch { return IDLE }
}

let state: FocusState = load()
let settings: FocusSettings = FOCUS_DEFAULTS
const listeners = new Set<() => void>()
let fireTimer: ReturnType<typeof setTimeout> | null = null
let ringTimer: ReturnType<typeof setTimeout> | null = null

function set(next: Partial<FocusState>) {
  state = { ...state, ...next }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private window */ }
  schedule()
  listeners.forEach(l => l())
}

function schedule() {
  if (fireTimer) { clearTimeout(fireTimer); fireTimer = null }
  if (state.status !== 'running') return
  fireTimer = setTimeout(finish, Math.max(0, state.endsAt - Date.now()))
}

function ring(on: boolean) {
  if (ringTimer) { clearTimeout(ringTimer); ringTimer = null }
  if (on) {
    startAlarmSound()
    // A minute is long enough to be heard from across the room; a ring that
    // never stops on an empty desk is a nuisance to whoever is nearby.
    ringTimer = setTimeout(() => silence(), RING_FOR_MS)
  } else {
    stopAlarmSound()
  }
}

function finish() {
  const round = state.phase === 'work' ? state.round + 1 : state.round
  const every = settings.roundsBeforeLong
  set({
    status: 'done', remainingMs: 0, ringing: true, round,
    long: state.phase === 'work' && every > 0 && round % every === 0,
  })
  ring(true)
}

function begin(phase: FocusPhase, long = false) {
  const min = phase === 'work' ? settings.workMin : long ? settings.longRestMin : settings.restMin
  const ms = min * 60_000
  if (state.ringing) ring(false)
  set({ phase, status: 'running', endsAt: Date.now() + ms, remainingMs: 0, durationMs: ms, long, ringing: false })
}

export function silence() {
  if (!state.ringing) return
  ring(false)
  set({ ringing: false })
}

/** The one big button: start, or start whatever comes next. */
export function focusPrimary() {
  if (state.status === 'idle') return begin('work')
  if (state.status === 'done') return state.phase === 'work' ? begin('rest', state.long) : begin('work')
  if (state.status === 'running') return focusPause()
  if (state.status === 'paused') return focusResume()
}

export function focusPause() {
  if (state.status !== 'running') return
  set({ status: 'paused', remainingMs: Math.max(0, state.endsAt - Date.now()) })
}

export function focusResume() {
  if (state.status !== 'paused') return
  set({ status: 'running', endsAt: Date.now() + state.remainingMs })
}

export function focusReset() {
  if (state.ringing) ring(false)
  set(IDLE)
}

/** True from the alarm that ends a work round until the rest after it is over. */
export function isResting(s: FocusState): boolean {
  return (s.phase === 'work' && s.status === 'done') || (s.phase === 'rest' && s.status !== 'done')
}

schedule()

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export function useFocusTimer(): FocusState {
  return useSyncExternalStore(subscribe, () => state)
}

// ── Settings (server-side, so the phone and the kiosk agree) ──────────────────

const settingsListeners = new Set<() => void>()
function setSettings(next: FocusSettings) {
  settings = next
  settingsListeners.forEach(l => l())
}

let loaded = false
function loadSettings() {
  if (loaded) return
  loaded = true
  fetch('/api/state/focus-timer')
    .then(r => r.ok ? r.json() as Promise<{ settings: FocusSettings }> : null)
    .then(r => { if (r) setSettings({ ...FOCUS_DEFAULTS, ...r.settings }) })
    .catch(() => { loaded = false })
  // Subscribed on first use rather than at import: the shared EventSource
  // carries the screen's role, which is not known yet at import time.
  onServerEvent('focus-timer', raw => { setSettings({ ...FOCUS_DEFAULTS, ...(raw as Partial<FocusSettings>) }) })
}

export async function saveFocusSettings(patch: Partial<FocusSettings>): Promise<void> {
  setSettings({ ...settings, ...patch })   // optimistic: the stepper moves at once
  const r = await fetch('/api/state/focus-timer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  if (r.ok) setSettings(((await r.json()) as { settings: FocusSettings }).settings)
}

export function useFocusSettings(): FocusSettings {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force(n => n + 1)
    settingsListeners.add(l)
    loadSettings()
    return () => { settingsListeners.delete(l) }
  }, [])
  return settings
}

/** "24:59", or "1:04:59" past an hour. */
export function formatFocus(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
