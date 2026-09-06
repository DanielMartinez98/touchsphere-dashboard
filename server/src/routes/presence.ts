// /api/presence — the desk sensor's reports, and what the screen does with them.

import { Router, type Request, type Response } from 'express'
import {
  presenceState, reportPresence, readPresenceSettings, writePresenceSettings, requestLive, liveWanted,
  type PresenceStats,
} from '../presence'

const router = Router()

/**
 * Optional shared secret. The reader is on the tailnet and the worst a forged
 * report can do is dim the screen, so it is optional — but set PRESENCE_TOKEN
 * on the server and TOKEN in the Pi's conf and forged reports are refused.
 */
const TOKEN = (process.env['PRESENCE_TOKEN'] ?? '').trim()

// GET /api/presence → the current answer plus the settings.
router.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ ...presenceState(), settings: readPresenceSettings() })
})

// POST /api/presence { present, distanceCm?, thresholdCm? } — from the Pi.
router.post('/', (req: Request, res: Response) => {
  if (TOKEN && req.header('x-presence-token') !== TOKEN) {
    res.status(401).json({ error: 'bad presence token' })
    return
  }
  const body = req.body as Record<string, unknown> | undefined
  if (typeof body?.['present'] !== 'boolean') {
    res.status(400).json({ error: 'present must be a boolean' })
    return
  }
  // What the reader saw since its last report, when it says. Numbers only;
  // anything else on the field is dropped rather than stored.
  const raw = body['stats'] as Record<string, unknown> | undefined
  const num = (k: string) => (typeof raw?.[k] === 'number' && Number.isFinite(raw[k]) ? raw[k] as number : null)
  const stats: PresenceStats | null = raw && typeof raw === 'object'
    ? { readings: num('readings') ?? 0, noEcho: num('noEcho') ?? 0, minCm: num('minCm'), maxCm: num('maxCm') }
    : null
  reportPresence(
    body['present'],
    typeof body['distanceCm'] === 'number' ? body['distanceCm'] : undefined,
    typeof body['thresholdCm'] === 'number' ? body['thresholdCm'] : undefined,
    stats,
    body['live'] === true,
  )
  // The one channel back to the Pi: whether a sensor card is open and wants
  // every reading. The reader flips its own mode on this alone.
  res.json({ ok: true, live: liveWanted() })
})

// POST /api/presence/live — the sensor card is open: ask the reader for every
// reading for the next 30 s. The card calls this every 10 s while open.
router.post('/live', (_req: Request, res: Response) => {
  requestLive()
  res.json({ ok: true, live: true })
})

// POST /api/presence/settings { dimAfterMin }
router.post('/settings', (req: Request, res: Response) => {
  const body = req.body as { dimAfterMin?: unknown } | undefined
  const patch = typeof body?.dimAfterMin === 'number' ? { dimAfterMin: body.dimAfterMin } : {}
  res.json(writePresenceSettings(patch))
})

export default router
