import { Router, Request, Response } from 'express'
import { exec } from 'child_process'

const router = Router()

// POST /api/system/shutdown
// Kills the Chromium kiosk browser then exits the Node process with code 0.
// With restart: on-failure in docker-compose, exit(0) does NOT trigger a
// container restart, so both the browser and the server stay stopped.
router.post('/shutdown', (_req: Request, res: Response) => {
  res.json({ ok: true })
  setTimeout(() => {
    console.log('[system] shutdown requested via API — killing kiosk browser and exiting')
    // Kill Chromium kiosk (works on Raspberry Pi OS / Debian)
    exec('pkill -f chromium', () => {
      process.exit(0)
    })
  }, 300)
})

export default router
