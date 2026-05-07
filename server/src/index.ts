import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import path from 'path'
import weatherRouter from './routes/weather'
import calendarRouter from './routes/calendar'
import airQualityRouter from './routes/airquality'
import tilesRouter from './routes/tiles'
import geoipRouter from './routes/geoip'
import systemRouter from './routes/system'
import stateRouter from './routes/state'
import deviceRouter from './routes/device'
import audioRouter from './routes/audio'
import ttsRouter from './routes/tts'
import sttRouter from './routes/stt'

dotenv.config()

// ── Startup diagnostics ───────────────────────────────────────────────────────
console.log('[startup] ============================================')
console.log('[startup] TouchSphere server starting')
console.log('[startup] NODE_ENV              :', process.env['NODE_ENV'] ?? 'not set')
console.log('[startup] PORT                  :', process.env['PORT'] ?? '3001 (default)')
console.log('[startup] CACHE_DIR             :', process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache (default)')
console.log('[startup] LOG_LEVEL             :', process.env['LOG_LEVEL'] ?? 'info (default)')
console.log('[startup] OPENWEATHER_API_KEY   :', process.env['OPENWEATHER_API_KEY'] ? '✓ set' : '✗ MISSING')
console.log('[startup] CALENDAR_ICAL_URL     :', process.env['CALENDAR_ICAL_URL']   ? '✓ set' : '— not set (calendar disabled)')
console.log('[startup] ELEVENLABS_API_KEY    :', process.env['ELEVENLABS_API_KEY']  ? '✓ set' : '— not set (TTS will use espeak-ng)')
console.log('[startup] DEFAULT_LAT/LON       :',
  (process.env['DEFAULT_LAT'] && process.env['DEFAULT_LON'])
    ? `${process.env['DEFAULT_LAT']}, ${process.env['DEFAULT_LON']}`
    : '— not set (will use ip-api.com)')
console.log('[startup] ============================================')

// Fail fast if the required API key is missing
if (!process.env['OPENWEATHER_API_KEY']) {
  console.error('[startup] FATAL: OPENWEATHER_API_KEY is not set. Exiting.')
  process.exit(1)
}

const app = express()
const PORT = process.env['PORT'] ?? 3001
const isProd = process.env['NODE_ENV'] === 'production'

// Security headers (CSP disabled — Vite inlines scripts during dev and the SPA
// uses dynamic imports that a strict default-src would block)
app.use(helmet({ contentSecurityPolicy: false }))

// LAN kiosks live on a different origin (the Pi) and POST audio here, so allow it.
// Tighten by setting AUDIO_ALLOWED_ORIGIN=http://192.168.1.42 if you want to lock down.
const allowed = process.env['AUDIO_ALLOWED_ORIGIN']
app.use(cors({ origin: allowed ?? '*' }))
app.use(express.json())

// Request logger — logs method, path, status code, and response time
app.use((req, res, next) => {
  const start = Date.now()
  const ip = req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown'
  res.on('finish', () => {
    const ms = Date.now() - start
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO'
    console.log(`[request][${level}] ${req.method} ${req.url} status=${res.statusCode} time=${ms}ms ip=${ip}`)
  })
  next()
})

// Rate limiting — prevents API-quota exhaustion and simple DoS
// Tile requests get a higher limit because Leaflet can load many tiles at once
const dataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})
const tileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})

app.use('/api/weather', dataLimiter, weatherRouter)
app.use('/api/calendar', dataLimiter, calendarRouter)
app.use('/api/airquality', dataLimiter, airQualityRouter)
app.use('/api/tiles', tileLimiter, tilesRouter)
app.use('/api/geoip', dataLimiter, geoipRouter)
app.use('/api/system', systemRouter)
app.use('/api/state', dataLimiter, stateRouter)
app.use('/api/device', dataLimiter, deviceRouter)
app.use('/api/audio', audioRouter)
app.use('/api/tts', dataLimiter, ttsRouter)
app.use('/api/stt', dataLimiter, sttRouter)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// /api/config removed — never expose API keys to the client

// Serve the Vite-built React app in production
// The client dist folder is copied into the image at /app/client/dist
if (isProd) {
  const clientDist = path.join(__dirname, '../../client/dist')
  app.use(express.static(clientDist))
  // SPA fallback — any non-API path returns index.html
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[startup] server listening on http://localhost:${PORT}`)
  console.log('[startup] routes: /api/weather /api/calendar /api/airquality /api/tiles /api/geoip /api/system /api/state /api/device /api/health')
})
