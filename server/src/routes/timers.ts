// Countdown timers & alarms.
//
// A timer is a relative countdown ("10 minutes"); an alarm is an absolute
// wall-clock time ("7:30 am"). Both collapse to the same persisted record — an
// epoch-millisecond `fireAt` — so the client only has to compare against the
// clock. The browser owns the actual ringing/visual countdown; the server is
// just durable storage so a timer set by voice survives a page reload and
// re-appears on every connected surface.
//
// An alarm may also repeat on a set of weekdays (`repeatDays`, 0=Sun..6=Sat).
// A recurring alarm is never pruned: instead its `fireAt` is rolled forward to
// the next matching weekday — both lazily on read (so one missed while the
// kiosk was off doesn't ring late) and when the user dismisses it (via the
// /advance endpoint). One-shot records (timers, non-repeating alarms) are
// pruned once they've been in the past longer than the ring grace window.
//
// Voice creates these through the dashboard tools (which write the same JSON
// file directly, mirroring how the media list works); the touchscreen creates,
// advances, and cancels them through this REST router.

import { Router, type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()

export type TimerKind = 'timer' | 'alarm'

export interface Timer {
  id:         string
  label:      string      // optional human label ('' when none)
  kind:       TimerKind
  fireAt:     number       // epoch ms when it should ring
  createdAt:  number       // epoch ms
  durationMs: number       // original countdown length (0 for alarms)
  repeatDays: number[]     // weekdays an alarm repeats on (0=Sun..6=Sat); [] = one-shot
}

// How long after fireAt a one-shot record is still considered "ringing" and
// returned to clients. Beyond this it's pruned so a timer that elapsed while the
// device was off doesn't suddenly blast hours later.
const RING_GRACE_MS = 5 * 60 * 1000        // 5 minutes
const MAX_DURATION_MS = 24 * 60 * 60 * 1000 // 24 h ceiling for a single timer
const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000 // alarms at most a week out
const MAX_LABEL_LEN = 60
const MAX_TIMERS = 20

const FILE = 'timers.json'

function stateDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Back-fill fields that older persisted records may lack.
function normalize(t: Timer): Timer {
  if (!Array.isArray(t.repeatDays)) t.repeatDays = []
  return t
}

function readRaw(): Timer[] {
  try {
    const p = path.join(stateDir(), FILE)
    if (!fs.existsSync(p)) return []
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as Timer[]).map(normalize) : []
  } catch (err) {
    console.error('[timers] failed to read:', err)
    return []
  }
}

function write(timers: Timer[]): void {
  fs.writeFileSync(path.join(stateDir(), FILE), JSON.stringify(timers, null, 2), 'utf8')
}

// Coerce arbitrary input into a clean, de-duped, sorted set of weekday numbers.
export function sanitizeRepeatDays(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const days = v.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
  return [...new Set(days)].sort((a, b) => a - b)
}

// Next future epoch (after `from`) that matches a recurring alarm's weekday set,
// preserving the alarm's intended local hour/minute. Returns fireAt unchanged
// for a non-repeating record.
export function nextRecurringFireAt(timer: Pick<Timer, 'fireAt' | 'repeatDays'>, from = Date.now()): number {
  if (!timer.repeatDays || timer.repeatDays.length === 0) return timer.fireAt
  const base = new Date(timer.fireAt)        // carries the intended hour/minute
  const hh = base.getHours()
  const mm = base.getMinutes()
  const start = new Date(from)
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hh, mm, 0, 0)
    if (cand.getTime() > from && timer.repeatDays.includes(cand.getDay())) return cand.getTime()
  }
  return timer.fireAt
}

// Prune dead one-shot records and roll missed recurring alarms forward, then
// persist if anything changed. Always sorted soonest-first.
export function readActiveTimers(): Timer[] {
  const now = Date.now()
  const all = readRaw()
  let mutated = false
  const alive: Timer[] = []
  for (const t of all) {
    if (typeof t.fireAt !== 'number') { mutated = true; continue }
    if (t.repeatDays.length > 0) {
      // Recurring alarm — keep forever, but if it fired while we weren't
      // watching (beyond the grace window) advance it so it doesn't ring late.
      if (t.fireAt < now - RING_GRACE_MS) {
        const next = nextRecurringFireAt(t, now)
        if (next !== t.fireAt) { t.fireAt = next; mutated = true }
      }
      alive.push(t)
    } else if (t.fireAt >= now - RING_GRACE_MS) {
      alive.push(t)
    } else {
      mutated = true   // pruned
    }
  }
  alive.sort((a, b) => a.fireAt - b.fireAt)
  if (mutated) {
    try { write(alive) } catch { /* best effort */ }
  }
  return alive
}

// GET /api/timers — active timers and alarms, soonest first.
router.get('/', (_req: Request, res: Response) => {
  res.json(readActiveTimers())
})

// POST /api/timers
//   timer: { kind: 'timer', durationMs, label? }
//   alarm: { kind: 'alarm', fireAt, label?, repeatDays? }
router.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    kind?: string; durationMs?: number; fireAt?: number; label?: string; repeatDays?: unknown
  }
  const kind: TimerKind = body.kind === 'alarm' ? 'alarm' : 'timer'
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, MAX_LABEL_LEN) : ''
  // Only alarms repeat; a countdown timer is always one-shot.
  const repeatDays = kind === 'alarm' ? sanitizeRepeatDays(body.repeatDays) : []
  const now = Date.now()

  let fireAt: number
  let durationMs = 0
  if (kind === 'timer') {
    durationMs = Math.round(Number(body.durationMs))
    if (!isFinite(durationMs) || durationMs <= 0) {
      res.status(400).json({ error: 'durationMs must be a positive number' })
      return
    }
    if (durationMs > MAX_DURATION_MS) durationMs = MAX_DURATION_MS
    fireAt = now + durationMs
  } else {
    fireAt = Math.round(Number(body.fireAt))
    if (!isFinite(fireAt)) {
      res.status(400).json({ error: 'fireAt (epoch ms) is required for an alarm' })
      return
    }
    // Snap a recurring alarm to its next matching weekday (the caller may pass
    // any same-time-of-day fireAt; repeatDays decides the actual day).
    if (repeatDays.length > 0) fireAt = nextRecurringFireAt({ fireAt, repeatDays }, now)
    if (fireAt <= now) { res.status(400).json({ error: 'fireAt must be in the future' }); return }
    if (fireAt > now + MAX_AHEAD_MS) { res.status(400).json({ error: 'fireAt is too far in the future' }); return }
  }

  const timers = readActiveTimers()
  if (timers.length >= MAX_TIMERS) {
    res.status(409).json({ error: 'Too many active timers' })
    return
  }
  const timer: Timer = { id: crypto.randomUUID(), label, kind, fireAt, createdAt: now, durationMs, repeatDays }
  timers.push(timer)
  timers.sort((a, b) => a.fireAt - b.fireAt)
  try {
    write(timers)
    console.log(`[timers] + ${kind} "${label || '(no label)'}" fireAt=${new Date(fireAt).toISOString()}${repeatDays.length ? ` repeat=[${repeatDays}]` : ''}`)
    res.status(201).json(timer)
  } catch {
    res.status(500).json({ error: 'Failed to persist timer' })
  }
})

// POST /api/timers/:id/advance — roll a recurring alarm to its next occurrence
// (used when the user dismisses a ringing recurring alarm so tomorrow's stays
// set). A one-shot record is simply removed.
router.post('/:id/advance', (req: Request, res: Response) => {
  const { id } = req.params
  const timers = readActiveTimers()
  const idx = timers.findIndex(t => t.id === id)
  if (idx === -1) { res.status(404).json({ error: 'Timer not found' }); return }
  const timer = timers[idx]!
  if (timer.repeatDays.length === 0) {
    timers.splice(idx, 1)
    try { write(timers); res.json({ removed: true }) }
    catch { res.status(500).json({ error: 'Failed to persist timers' }) }
    return
  }
  timer.fireAt = nextRecurringFireAt(timer, Date.now() + 1000) // strictly future
  timers.sort((a, b) => a.fireAt - b.fireAt)
  try {
    write(timers)
    console.log(`[timers] ↻ ${id} → ${new Date(timer.fireAt).toISOString()}`)
    res.json(timer)
  } catch {
    res.status(500).json({ error: 'Failed to persist timers' })
  }
})

// DELETE /api/timers/:id
router.delete('/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const timers = readActiveTimers()
  const filtered = timers.filter(t => t.id !== id)
  if (filtered.length === timers.length) {
    res.status(404).json({ error: 'Timer not found' })
    return
  }
  try {
    write(filtered)
    console.log(`[timers] - ${id}`)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to persist timers' })
  }
})

export default router
