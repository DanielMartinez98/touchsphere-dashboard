// /api/presence — the desk sensor's reports, and what the screen does with them.

import { Router, type Request, type Response } from 'express'
import { presenceState, reportPresence, readPresenceSettings, writePresenceSettings } from '../presence'

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
  reportPresence(
    body['present'],
    typeof body['distanceCm'] === 'number' ? body['distanceCm'] : undefined,
    typeof body['thresholdCm'] === 'number' ? body['thresholdCm'] : undefined,
  )
  res.json({ ok: true })
})

// POST /api/presence/settings { dimAfterMin }
router.post('/settings', (req: Request, res: Response) => {
  const body = req.body as { dimAfterMin?: unknown } | undefined
  const patch = typeof body?.dimAfterMin === 'number' ? { dimAfterMin: body.dimAfterMin } : {}
  res.json(writePresenceSettings(patch))
})

export default router
