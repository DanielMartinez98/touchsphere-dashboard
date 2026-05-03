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

// POST /api/system/restart  — broadcast reload event to all connected clients.
// The server itself keeps running; each browser tab reloads itself.
router.post('/restart', (_req: Request, res: Response) => {
  res.json({ ok: true })
  setTimeout(() => {
    console.log('[system] restart requested via API — broadcasting reload to clients')
    for (const client of sseClients) {
      client.write('event: reload\ndata: {}\n\n')
    }
  }, 100)
})

export default router
