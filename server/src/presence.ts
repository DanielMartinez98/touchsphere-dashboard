// Desk presence — is someone in front of the kiosk?
//
// The sensor is an HC-SR04 on the Raspberry Pi's GPIO, read by
// scripts/presence/presence.py, which POSTs here on every change and as a
// heartbeat. This module is the server's memory of that: the current answer,
// when it last changed, the distance, and whether the reader has gone quiet.
// Every dashboard hears about a change over the `presence` SSE event, and
// the assistant's system prompt carries the answer as one line.
//
// What is done with it is deliberately small: the screen dims after a while
// away (a setting), and the assistant knows. Nothing here locks, logs a
// timeline, or decides who it is — a distance under a threshold is all the
// sensor can say.

import fs from 'fs'
import path from 'path'
import { broadcast } from './routes/system'

/** A reader that hasn't reported for this long is treated as gone. */
const STALE_MS = 120_000

export interface PresenceState {
  /** true = at the desk, false = away, null = never reported. */
  present: boolean | null
  distanceCm: number | null
  thresholdCm: number | null
  /** When `present` last flipped. */
  since: string | null
  updatedAt: string | null
}

export interface PresenceSettings {
  /** Minutes away before the kiosk dims. 0 = never. */
  dimAfterMin: number
}

const state: PresenceState = { present: null, distanceCm: null, thresholdCm: null, since: null, updatedAt: null }

export function presenceState(): PresenceState & { stale: boolean; sensor: boolean } {
  const stale = !state.updatedAt || Date.now() - new Date(state.updatedAt).getTime() > STALE_MS
  return { ...state, stale, sensor: state.updatedAt !== null }
}

export function reportPresence(present: boolean, distanceCm?: number, thresholdCm?: number): void {
  const now = new Date().toISOString()
  const flipped = state.present !== present
  state.present = present
  state.distanceCm = typeof distanceCm === 'number' && Number.isFinite(distanceCm) ? distanceCm : state.distanceCm
  state.thresholdCm = typeof thresholdCm === 'number' && Number.isFinite(thresholdCm) ? thresholdCm : state.thresholdCm
  if (flipped || !state.since) state.since = now
  state.updatedAt = now
  if (flipped) console.log(`[presence] ${present ? 'at the desk' : 'away'}${state.distanceCm !== null ? ` (${state.distanceCm} cm)` : ''}`)
  broadcast('presence', presenceState())
}

/** One line for the system prompt, or nothing when there is no sensor. */
export function presenceForPrompt(): string {
  const p = presenceState()
  if (!p.sensor || p.stale || p.present === null) return ''
  const mins = p.since ? Math.round((Date.now() - new Date(p.since).getTime()) / 60_000) : 0
  return p.present
    ? ` DESK: the user is at the desk (presence sensor, for ${mins} min).`
    : ` DESK: the user is away from the desk (presence sensor, for ${mins} min) — they may be speaking from across the room.`
}

// ── settings ────────────────────────────────────────────────────────────────

function settingsPath(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  return path.join(dir, 'presence.json')
}

export function readPresenceSettings(): PresenceSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<PresenceSettings>
    const n = Number(raw.dimAfterMin)
    return { dimAfterMin: Number.isFinite(n) && n >= 0 ? Math.min(240, Math.round(n)) : 5 }
  } catch {
    return { dimAfterMin: 5 }
  }
}

export function writePresenceSettings(patch: Partial<PresenceSettings>): PresenceSettings {
  const next = { ...readPresenceSettings() }
  if (typeof patch.dimAfterMin === 'number' && Number.isFinite(patch.dimAfterMin)) {
    next.dimAfterMin = Math.max(0, Math.min(240, Math.round(patch.dimAfterMin)))
  }
  const p = settingsPath()
  const tmp = `${p}.tmp-${process.pid}`
  try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, p) }
  catch (err) { try { fs.unlinkSync(tmp) } catch { /* nothing */ } console.error('[presence] settings write failed:', err) }
  broadcast('presence-settings', next)
  return next
}
