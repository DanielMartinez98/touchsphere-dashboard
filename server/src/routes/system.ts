import { Router, Request, Response } from 'express'

const router = Router()

// POST /api/system/shutdown
// Gracefully stops the Node process. The Docker container will restart
// automatically unless it was stopped via `docker stop` first.
// Used by the client's Settings → Close App button.
router.post('/shutdown', (_req: Request, res: Response) => {
  res.json({ ok: true })
  setTimeout(() => {
    console.log('[system] shutdown requested via API — exiting process')
    process.exit(0)
  }, 300)
})

export default router
