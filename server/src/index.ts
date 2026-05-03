import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import weatherRouter from './routes/weather'
import calendarRouter from './routes/calendar'
import airQualityRouter from './routes/airquality'
import tilesRouter from './routes/tiles'

dotenv.config()

const app = express()
const PORT = process.env['PORT'] ?? 3001
const isProd = process.env['NODE_ENV'] === 'production'

// In dev the Vite proxy handles CORS; in prod everything is same-origin
app.use(cors({ origin: isProd ? false : '*' }))
app.use(express.json())

app.use('/api/weather', weatherRouter)
app.use('/api/calendar', calendarRouter)
app.use('/api/airquality', airQualityRouter)
app.use('/api/tiles', tilesRouter)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/config', (_req, res) => {
  res.json({ owmKey: process.env['OPENWEATHER_API_KEY'] ?? '' })
})

// Serve the Vite-built React app in production
// The client dist folder is copied into the image at /app/client/dist
if (isProd) {
  const clientDist = path.join(__dirname, '../../client/dist')
  app.use(express.static(clientDist))
  // SPA fallback — any non-API path returns index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`TouchSphere server running on http://localhost:${PORT}`)
})
