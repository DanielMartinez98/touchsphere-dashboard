import { Router, Request, Response } from 'express'

const router = Router()

// POST /api/system/shutdown
// Exits the Node process with code 0.  The container will NOT restart
// (restart: on-failure ignores clean exits).  The host-side kiosk.sh script
// is watching "docker wait touchsphere" and kills Chromium once it sees the
// container exit — that is the only reliable way to close the kiosk browser
// from inside a Docker container.
router.post('/shutdown', (_req: Request, res: Response) => {
  res.json({ ok: true })
  setTimeout(() => {
    console.log('[system] shutdown requested via API — exiting process')
    process.exit(0)
  }, 300)
})

export default router
