import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppMode } from './useAppMode'
import { playSound } from '../utils/sound'

/**
 * User-configurable schedule that automatically flips the app between
 * `work` and `rest` modes and triggers a bedtime alert. All values are
 * "HH:MM" 24-hour strings in the device's local time.
 *
 * Persisted client-side in localStorage (key `ts_auto_schedule`).
 */
export interface AutoSchedule {
  enabled:   boolean
  workStart: string  // e.g. '09:00' — switch to work mode
  restStart: string  // e.g. '17:00' — switch to rest mode
  bedtime:   string  // e.g. '01:00' — fire bedtime alert
}

const STORAGE_KEY = 'ts_auto_schedule'

const DEFAULT_SCHEDULE: AutoSchedule = {
  enabled:   false,
  workStart: '09:00',
  restStart: '17:00',
  bedtime:   '01:00',
}

const BEDTIME_EVENT = 'ts:bedtime-alert'

function loadSchedule(): AutoSchedule {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SCHEDULE
    const parsed = JSON.parse(raw) as Partial<AutoSchedule>
    return {
      enabled:   typeof parsed.enabled   === 'boolean' ? parsed.enabled   : DEFAULT_SCHEDULE.enabled,
      workStart: validHHMM(parsed.workStart) ?? DEFAULT_SCHEDULE.workStart,
      restStart: validHHMM(parsed.restStart) ?? DEFAULT_SCHEDULE.restStart,
      bedtime:   validHHMM(parsed.bedtime)   ?? DEFAULT_SCHEDULE.bedtime,
    }
  } catch {
    return DEFAULT_SCHEDULE
  }
}

function validHHMM(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return /^\d{2}:\d{2}$/.test(v) ? v : null
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10))
  return (h * 60) + m
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Reactive accessor + setter for the auto schedule. Updates from one
 * call site propagate to all subscribers in the same window.
 */
const listeners = new Set<(s: AutoSchedule) => void>()
let cached: AutoSchedule | null = null

function getSchedule(): AutoSchedule {
  if (!cached) cached = loadSchedule()
  return cached
}

function writeSchedule(next: AutoSchedule) {
  cached = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore quota errors */ }
  listeners.forEach(fn => { try { fn(next) } catch { /* ignore listener errors */ } })
}

export function useAutoSchedule() {
  const [schedule, setSchedule] = useState<AutoSchedule>(() => getSchedule())

  useEffect(() => {
    const fn = (s: AutoSchedule) => setSchedule(s)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])

  const update = useCallback((patch: Partial<AutoSchedule>) => {
    writeSchedule({ ...getSchedule(), ...patch })
  }, [])

  return { schedule, updateSchedule: update }
}

/**
 * Mount once near the app root. Watches the clock and:
 *   - Switches `mode` to `work` when crossing `workStart`
 *   - Switches `mode` to `rest` when crossing `restStart`
 *   - Dispatches the `ts:bedtime-alert` window event when crossing `bedtime`
 *
 * Each transition fires at most once per local day. While `mode === 'locked'`
 * we never override the lock; the next transition will pick up after unlock.
 */
export function useAutoMode(mode: AppMode, setMode: (m: AppMode) => void) {
  const { schedule } = useAutoSchedule()
  const lastModeKeyRef    = useRef<string | null>(null)  // 'YYYY-MM-DD:work|rest'
  const lastBedtimeDayRef = useRef<string | null>(null)
  // Capture latest setMode/mode in a ref so the interval closure stays stable.
  const ctxRef = useRef({ mode, setMode })
  ctxRef.current = { mode, setMode }

  useEffect(() => {
    if (!schedule.enabled) return

    function tick() {
      const now = new Date()
      const nowMin   = (now.getHours() * 60) + now.getMinutes()
      const today    = dayKey(now)
      const workMin  = toMinutes(schedule.workStart)
      const restMin  = toMinutes(schedule.restStart)
      const bedMin   = toMinutes(schedule.bedtime)
      const { mode: curMode, setMode: applyMode } = ctxRef.current

      // ── Mode switching ───────────────────────────────────────────────
      // "Expected" mode for the current minute. We treat the day as a
      // ring: between workStart and restStart → work, otherwise → rest.
      // Order-agnostic so the user can put restStart before workStart
      // (e.g. night-shift schedules).
      let expected: 'work' | 'rest'
      if (workMin === restMin) {
        expected = 'work'  // degenerate config — pick something stable
      } else if (workMin < restMin) {
        expected = (nowMin >= workMin && nowMin < restMin) ? 'work' : 'rest'
      } else {
        // restStart < workStart → "work" wraps past midnight
        expected = (nowMin >= workMin || nowMin < restMin) ? 'work' : 'rest'
      }

      const slotKey = `${today}:${expected}`
      if (lastModeKeyRef.current !== slotKey && curMode !== 'locked' && curMode !== expected) {
        console.log(`[AutoMode] auto-switch → ${expected} (now ${now.toLocaleTimeString()})`)
        applyMode(expected)
      }
      // Mark the slot as handled even if no flip was needed, so we don't
      // re-trigger every tick. We still re-evaluate on the next slot.
      lastModeKeyRef.current = slotKey

      // ── Bedtime alert ────────────────────────────────────────────────
      // Fire once per day when the clock has reached or passed bedtime.
      // Within a small forward window so a freshly-opened app at e.g.
      // 14:00 doesn't immediately fire yesterday's bedtime.
      if (lastBedtimeDayRef.current !== today) {
        const diff = nowMin - bedMin
        // Fire if we're within 5 minutes after bedtime — this handles app
        // launches that miss the exact minute.
        if (diff >= 0 && diff <= 5) {
          console.log('[AutoMode] bedtime alert!')
          lastBedtimeDayRef.current = today
          fireBedtimeAlert()
        }
      }
    }

    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [schedule])
}

/**
 * Manually trigger the bedtime alert flow. Useful for the "Test" button
 * in the settings panel. Plays the chime and shows the in-app popup
 * (via the `ts:bedtime-alert` event consumed by `BedtimeBanner`).
 */
export function fireBedtimeAlert() {
  void playSound('/start.mp3', 'sfx').catch(() => { /* ignore audio errors */ })
  window.dispatchEvent(new CustomEvent(BEDTIME_EVENT))
}

export const BEDTIME_ALERT_EVENT = BEDTIME_EVENT
