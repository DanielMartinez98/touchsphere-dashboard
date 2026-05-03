import { Router, Request, Response } from 'express'

const router = Router()

// All active SSE clients waiting for server events.
const sseClients = new Set<Response>()

// GET /api/system/events  — SSE stream for real-time server → client signals.
router.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Heartbeat every 25 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

  sseClients.add(res)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
  })
})

// POST /api/system/shutdown  — broadcast shutdown event then exit.
router.post('/shutdown', (_req: Request, res: Response) => {
  res.json({ ok: true })

  // Give the response 100 ms to flush, then broadcast to all SSE clients
  // and exit after another 500 ms (enough for the browser to receive it).
  setTimeout(() => {
    for (const client of sseClients) {
      client.write('event: shutdown\ndata: {}\n\n')
    }
    setTimeout(() => {
      console.log('[system] shutdown requested via API — exiting process')
      process.exit(0)
    }, 500)
  }, 100)
})

export default router
