// Countdown timers & alarms.
//
// A timer is a relative countdown ("10 minutes"); an alarm is an absolute
// wall-clock time ("7:30 am"). Both collapse to the same persisted record — an
// epoch-millisecond `fireAt` — so the client only has to compare against the
// clock. The browser owns the actual ringing/visual countdown; the server is
// just durable storage so a timer set by voice survives a page reload and
// re-appears on every connected surface.
//
// Voice creates these through the dashboard tools (which write the same JSON
// file directly, mirroring how the media list works); the touchscreen creates
// and cancels them through this REST router. Stale records (fired well in the
// past, e.g. while the kiosk was powered off) are pruned on read so they don't
// ring hours later.

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
}

// How long after fireAt a record is still considered "ringing" and returned to
// clients. Beyond this it's pruned so a timer that elapsed while the device was
// off doesn't suddenly blast hours later.
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

function readRaw(): Timer[] {
  try {
    const p = path.join(stateDir(), FILE)
    if (!fs.existsSync(p)) return []
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as Timer[]) : []
  } catch (err) {
    console.error('[timers] failed to read:', err)
    return []
  }
}

function write(timers: Timer[]): void {
  fs.writeFileSync(path.join(stateDir(), FILE), JSON.stringify(timers, null, 2), 'utf8')
}

// Drop records that fired more than RING_GRACE_MS ago, persisting the trimmed
// list so the file doesn't accumulate dead timers. Always sorted soonest-first.
export function readActiveTimers(): Timer[] {
  const now = Date.now()
  const all = readRaw()
  const alive = all
    .filter(t => typeof t.fireAt === 'number' && t.fireAt >= now - RING_GRACE_MS)
    .sort((a, b) => a.fireAt - b.fireAt)
  if (alive.length !== all.length) {
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
//   alarm: { kind: 'alarm', fireAt,     label? }
router.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    kind?: string; durationMs?: number; fireAt?: number; label?: string
  }
  const kind: TimerKind = body.kind === 'alarm' ? 'alarm' : 'timer'
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, MAX_LABEL_LEN) : ''
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
    if (fireAt <= now) { res.status(400).json({ error: 'fireAt must be in the future' }); return }
    if (fireAt > now + MAX_AHEAD_MS) { res.status(400).json({ error: 'fireAt is too far in the future' }); return }
  }

  const timers = readActiveTimers()
  if (timers.length >= MAX_TIMERS) {
    res.status(409).json({ error: 'Too many active timers' })
    return
  }
  const timer: Timer = { id: crypto.randomUUID(), label, kind, fireAt, createdAt: now, durationMs }
  timers.push(timer)
  timers.sort((a, b) => a.fireAt - b.fireAt)
  try {
    write(timers)
    console.log(`[timers] + ${kind} "${label || '(no label)'}" fireAt=${new Date(fireAt).toISOString()}`)
    res.status(201).json(timer)
  } catch {
    res.status(500).json({ error: 'Failed to persist timer' })
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
