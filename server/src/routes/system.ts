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

// GET /api/system/debug — runtime + config summary for the in-app Debug panel.
// Secrets are reported as booleans only; never echo key material.
router.get('/debug', (_req: Request, res: Response) => {
  const env = process.env
  res.json({
    uptimeSec: Math.floor(process.uptime()),
    node:      process.version,
    platform:  `${process.platform}/${process.arch}`,
    nodeEnv:   env['NODE_ENV'] ?? 'development',
    cacheDir:  env['CACHE_DIR'] ?? '(default)',
    config: {
      OPENWEATHER_API_KEY: !!env['OPENWEATHER_API_KEY'],
      CALENDAR_ICAL_URL:   !!env['CALENDAR_ICAL_URL'],
      ELEVENLABS_API_KEY:  !!env['ELEVENLABS_API_KEY'],
      NOTION_API_KEY:      !!env['NOTION_API_KEY'],
      NOTION_DATABASE_ID:  !!env['NOTION_DATABASE_ID'],
      OLLAMA_API_KEY:      !!env['OLLAMA_API_KEY'],
      DEFAULT_LAT_LON:     !!(env['DEFAULT_LAT'] && env['DEFAULT_LON']),
      // Cover art. TMDB drives movies/shows; IGDB (which needs BOTH the Twitch
      // client id and secret) drives games. A missing IGDB secret is invisible
      // otherwise: films still get posters, games silently get none.
      TMDB_API_KEY:        !!env['TMDB_API_KEY'],
      IGDB_CREDENTIALS:    !!(env['IGDB_CLIENT_ID'] && env['IGDB_CLIENT_SECRET']),
    },
    ollama: {
      url:   env['OLLAMA_URL']   ?? 'http://host.docker.internal:11434 (default)',
      model: env['OLLAMA_MODEL'] ?? 'gemma3 (default)',
    },
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
