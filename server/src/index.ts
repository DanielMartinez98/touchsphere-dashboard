import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
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
import chatRouter from './routes/chat'
import browseRouter from './routes/browse'
import notionRouter from './routes/notion'
import timersRouter from './routes/timers'
import memoryRouter from './routes/memory'
import artworkRouter from './routes/artwork'
import guidesRouter from './routes/guides'
import imageRouter from './routes/image'
import plexRouter from './routes/plex'
import { elevenLabsKeyState } from './config/keys'
import { sweepInterrupted } from './guides'
import { SEARCH_PROVIDER } from './research'

dotenv.config()

// ── Startup diagnostics ───────────────────────────────────────────────────────
// ElevenLabs keys are `sk_…`. Presence alone is not a useful check: a
// wrong-format key still reads as "set", and the failure it causes is silent in
// both directions — TTS quietly degrades to espeak-ng, while STT (which has no
// fallback at all) 502s on every utterance. The dashboard looks perfectly alive
// and just stops responding to speech, so the format is worth asserting here
// rather than leaving it to be discovered from ElevenLabs' 400.
const ELEVEN_KEY = process.env['ELEVENLABS_API_KEY'] ?? ''
const ELEVEN_KEY_MALFORMED = elevenLabsKeyState() === 'malformed'

console.log('[startup] ============================================')
console.log('[startup] TouchSphere server starting')
console.log('[startup] NODE_ENV              :', process.env['NODE_ENV'] ?? 'not set')
console.log('[startup] PORT                  :', process.env['PORT'] ?? '3001 (default)')
console.log('[startup] CACHE_DIR             :', process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache (default)')
console.log('[startup] LOG_LEVEL             :', process.env['LOG_LEVEL'] ?? 'info (default)')
console.log('[startup] OPENWEATHER_API_KEY   :', process.env['OPENWEATHER_API_KEY'] ? '✓ set' : '✗ MISSING')
console.log('[startup] CALENDAR_ICAL_URL     :', process.env['CALENDAR_ICAL_URL']   ? '✓ set' : '— not set (calendar disabled)')
console.log('[startup] ELEVENLABS_API_KEY    :',
  !ELEVEN_KEY            ? '— not set (TTS will use espeak-ng, STT disabled)'
  : ELEVEN_KEY_MALFORMED ? `✗ MALFORMED (starts with "${ELEVEN_KEY.slice(0, 3)}…", expected "sk_")`
  : '✓ set')
console.log('[startup] OLLAMA_URL            :', process.env['OLLAMA_URL']           ?? 'http://host.docker.internal:11434 (default)')
console.log('[startup] OLLAMA_MODEL          :', process.env['OLLAMA_MODEL']         ?? 'gemma3 (default)')
console.log('[startup] OLLAMA_API_KEY        :', process.env['OLLAMA_API_KEY']       ? '✓ set' : '— not set (no auth header)')
console.log('[startup] YOUTUBE_API_KEY       :', process.env['YOUTUBE_API_KEY']      ? '✓ set' : '— not set (video search falls back to scraping)')
console.log('[startup] NOTION_API_KEY        :', process.env['NOTION_API_KEY']       ? '✓ set' : '— not set (Notion widget disabled)')
console.log('[startup] NOTION_DATABASE_ID    :', process.env['NOTION_DATABASE_ID']   ? '✓ set' : '— not set (Notion widget disabled)')
console.log('[startup] DEFAULT_LAT/LON       :',
  (process.env['DEFAULT_LAT'] && process.env['DEFAULT_LON'])
    ? `${process.env['DEFAULT_LAT']}, ${process.env['DEFAULT_LON']}`
    : '— not set (will use ip-api.com)')
// Which provider game-guide research will use. DuckDuckGo needs no key but
// returns no snippets, so a guide built on it leans entirely on page reads.
console.log('[startup] guide research        :', SEARCH_PROVIDER === 'ollama'
  ? 'ollama hosted web_search'
  : 'duckduckgo html (no OLLAMA_API_KEY)')
console.log('[startup] ============================================')

// Guide generation lives in memory and is fire-and-forget, so a restart in the
// middle of one leaves a guide stuck on "generating" — a spinner with nothing
// behind it. Fail those now so the view can offer Retry.
sweepInterrupted()

// Fail fast if the required API key is missing
if (!process.env['OPENWEATHER_API_KEY']) {
  console.error('[startup] FATAL: OPENWEATHER_API_KEY is not set. Exiting.')
  process.exit(1)
}

// Loud but not fatal: the dashboard is perfectly usable without voice, so a bad
// key shouldn't stop the widgets from coming up — it just has to be impossible
// to miss in the boot log.
if (ELEVEN_KEY_MALFORMED) {
  console.error('[startup] WARNING: ELEVENLABS_API_KEY does not look like an ElevenLabs key.')
  console.error('[startup]          Keys begin with "sk_" — elevenlabs.io → Profile → API Keys.')
  console.error('[startup]          Until it is fixed: /api/stt fails on every utterance (voice')
  console.error('[startup]          input will not work at all) and /api/tts falls back to espeak-ng.')
}

const app = express()
// Exactly one proxy sits in front of this process — Caddy, in the same compose
// network (`reverse_proxy app:3001`) — and it sets X-Forwarded-For. With
// `trust proxy` off, express-rate-limit keys every request on Caddy's own
// address and logs a ValidationError on each; `1` trusts that single hop and
// no further, so a client-supplied X-Forwarded-For still can't spoof its way
// past the limiter.
app.set('trust proxy', 1)
const PORT = process.env['PORT'] ?? 3001
const isProd = process.env['NODE_ENV'] === 'production'

// Security headers (CSP disabled — Vite inlines scripts during dev and the SPA
// uses dynamic imports that a strict default-src would block)
//
// referrerPolicy is overridden because Helmet defaults to `no-referrer`, and
// since late 2025 the YouTube embed player REQUIRES a Referer header to
// identify its host — without one it refuses to play and shows "Video player
// configuration error (153)". `strict-origin-when-cross-origin` is the browser
// default and what YouTube expects: it sends only the origin cross-site (so no
// path or query leaks outward) while still identifying us.
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))

// LAN kiosks live on a different origin (the Pi) and POST audio here, so allow it.
// Tighten by setting AUDIO_ALLOWED_ORIGIN=http://192.168.1.42 if you want to lock down.
const allowed = process.env['AUDIO_ALLOWED_ORIGIN']
// exposedHeaders: without it the browser hides X-TTS-Provider from JS on a
// cross-origin kiosk, and the Debug tab silently loses the one field that says
// which engine actually spoke.
app.use(cors({ origin: allowed ?? '*', exposedHeaders: ['X-TTS-Provider'] }))
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
// TTS gets its own budget because a spoken reply is no longer one request: the
// client splits it into sentences and fetches them separately so the first one
// can start playing while the rest are still being synthesised. On the strict
// data budget — which the widgets' polling also draws from — a long reply during
// a busy minute could 429 mid-sentence and simply stop talking. The requests are
// still bounded (MAX_TEXT_LEN per chunk, and a human can only hold so many
// conversations a minute), so a higher ceiling costs nothing.
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
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
app.use('/api/tts', ttsLimiter, ttsRouter)
app.use('/api/stt', dataLimiter, sttRouter)
app.use('/api/chat', dataLimiter, chatRouter)
app.use('/api/browse', dataLimiter, browseRouter)
app.use('/api/notion', dataLimiter, notionRouter)
app.use('/api/timers', dataLimiter, timersRouter)
app.use('/api/memory', dataLimiter, memoryRouter)
app.use('/api/guides', dataLimiter, guidesRouter)
// Generated images: the gallery pulls a file per thumbnail, so this sits behind
// the generous tile limiter rather than the 60/min data one, same as artwork.
app.use('/api/image', tileLimiter, imageRouter)
// The media stack. Posters and the HLS video stream are fetched by the dozen
// (a segment every few seconds for the length of a film) so they ride the tile
// budget; the rest calls Plex/Seerr/qBittorrent upstream and stays strict.
app.use('/api/plex', (req, res, next) =>
  /^\/(hls|img|poster)\//.test(req.path) ? tileLimiter(req, res, next) : dataLimiter(req, res, next), plexRouter)
// Artwork is split across both limiters. Cached covers are served off local
// disk and a full list fetches one per item, so they need the tile budget —
// but /search calls TMDB/IGDB upstream, so it stays on the strict data budget
// and can't be used to burn our API quota.
app.use('/api/artwork/search', dataLimiter)
app.use('/api/artwork', tileLimiter, artworkRouter)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// /api/config removed — never expose API keys to the client

// ── Avatar assets (Live2D model + Cubism Core runtime) ───────────────────────
// Licensed art and a proprietary Live2D runtime. Deliberately NOT committed (see
// .gitignore) and therefore NOT baked into the image — they're bind-mounted from
// the host instead, which also means the model can be swapped without a rebuild.
//
// Serves the same paths the client already asks for in dev (where Vite serves
// them out of client/public):
//   /live2dcubismcore.min.js
//   /live2d/<model>/<model>.model3.json  (+ .moc3, textures)
//   /avatar.vrm
//
// Registered before the SPA catch-all, or index.html would swallow these and the
// client would try to parse HTML as a .moc3. If the directory isn't mounted we
// simply don't serve it: the client's load fails, and the UI falls back to the
// particle sphere — the correct behaviour on a host with no model installed.
const AVATAR_DIR = process.env['AVATAR_DIR'] ?? '/data/avatar'
if (fs.existsSync(AVATAR_DIR)) {
  // maxAge 0 + ETag: the browser revalidates each load and gets a cheap 304 when
  // nothing changed, but picks up a swapped model immediately. A long max-age
  // here pins a stale texture in the kiosk's disk cache, where no amount of
  // reloading dislodges it — which is exactly what happened while debugging.
  app.use(express.static(AVATAR_DIR, { maxAge: 0, etag: true }))
  console.log(`[startup] avatar assets      : serving from ${AVATAR_DIR}`)
} else {
  console.log(`[startup] avatar assets      : none at ${AVATAR_DIR} — dashboard will use the sphere`)
}

// Serve the Vite-built React app in production
// The client dist folder is copied into the image at /app/client/dist
if (isProd) {
  const clientDist = path.join(__dirname, '../../client/dist')
  app.use(express.static(clientDist))
  // SPA fallback — any non-API path returns index.html so client-side routing
  // works. But a request that plainly names a *file* (it has an extension) and
  // wasn't matched by either static handler is a genuinely missing asset, and
  // must 404. Serving index.html for it "succeeds" with a 200 full of HTML,
  // which then blows up somewhere far away as a parse error — e.g. a missing
  // /avatar.vrm surfacing as "Unexpected token '<'" inside the model loader.
  app.get('/{*path}', (req, res) => {
    if (/\.[a-z0-9]+$/i.test(req.path)) {
      return res.status(404).json({ error: 'not found', path: req.path })
    }
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[startup] server listening on http://localhost:${PORT}`)
  console.log('[startup] routes: /api/weather /api/calendar /api/airquality /api/tiles /api/geoip /api/system /api/state /api/device /api/health')
})
