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

dotenv.config()

// Fail fast if the required API key is missing
if (!process.env['OPENWEATHER_API_KEY']) {
  console.error('FATAL: OPENWEATHER_API_KEY is not set. Exiting.')
  process.exit(1)
}

console.log('[startup] NODE_ENV:', process.env['NODE_ENV'])
console.log('[startup] OPENWEATHER_API_KEY set:', !!process.env['OPENWEATHER_API_KEY'])
console.log('[startup] CALENDAR_ICAL_URL set:', !!process.env['CALENDAR_ICAL_URL'])

const app = express()
const PORT = process.env['PORT'] ?? 3001
const isProd = process.env['NODE_ENV'] === 'production'

// Security headers (CSP disabled — Vite inlines scripts during dev and the SPA
// uses dynamic imports that a strict default-src would block)
app.use(helmet({ contentSecurityPolicy: false }))

// In dev the Vite proxy handles CORS; in prod everything is same-origin
app.use(cors({ origin: isProd ? false : '*' }))
app.use(express.json())

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} — ip: ${req.headers['x-forwarded-for'] ?? req.ip}`)
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
  console.log(`TouchSphere server running on http://localhost:${PORT}`)
})
