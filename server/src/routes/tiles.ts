import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

// ── In-memory tile cache ──────────────────────────────────────────────────────
interface CacheEntry {
  data: Buffer
  contentType: string
  cachedAt: number
}

const tileCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000   // 30 min — cloud tiles don't change faster
const MAX_ENTRIES   = 800              // ~25 MB at ~32 KB/tile

// Transparent 1×1 PNG returned on upstream failure so Leaflet never shows broken tiles
const TRANSPARENT_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

function evict() {
  // First pass: remove all expired entries regardless of cache size
  const cutoff = Date.now() - CACHE_TTL_MS
  for (const [key, entry] of tileCache) {
    if (entry.cachedAt < cutoff) tileCache.delete(key)
  }
  // Second pass: if still over the hard limit, evict oldest entries
  if (tileCache.size >= MAX_ENTRIES) {
    const target = Math.floor(MAX_ENTRIES * 0.75)
    for (const key of tileCache.keys()) {
      if (tileCache.size <= target) break
      tileCache.delete(key)
    }
  }
}

// ── Route: GET /api/tiles/clouds/:z/:x/:y?offset=<minutes> ───────────────────
// offset is rounded to the nearest hour before hitting OWM so identical
// tiles within the same hour share one cache entry.
router.get('/clouds/:z/:x/:y', async (req: Request, res: Response) => {
  const { z, x, y } = req.params
  // Clamp offset to the same 42-hour window the client uses (-6h to +36h)
  const rawOffset = parseInt(req.query['offset'] as string)
  const offsetMin = isNaN(rawOffset) ? 0 : Math.max(-360, Math.min(2160, rawOffset))
  const apiKey = process.env['OPENWEATHER_API_KEY']

  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured' })
    return
  }

  // Cache key: z/x/y + hour bucket (Maps 1.0 tiles update ~hourly)
  const hourBucket = Math.floor(Date.now() / 3_600_000)
  const cacheKey = `${z}/${x}/${y}/${hourBucket}`

  const cached = tileCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    res.setHeader('Content-Type', cached.contentType)
    res.setHeader('X-Cache', 'HIT')
    res.setHeader('Cache-Control', 'public, max-age=1800')
    res.send(cached.data)
    return
  }

  // Maps 1.0 endpoint — available on the free tier.
  // Maps 2.0 (maps.openweathermap.org/maps/2.0/) returns 401 on free-tier keys.
  // Maps 1.0 doesn't accept a date param so all time offsets show current clouds;
  // the scrubber still works visually but the tile itself is always "now".
  const tileUrl = `https://tile.openweathermap.org/map/clouds_new/${z}/${x}/${y}.png?appid=${apiKey}`
  console.log(`[tiles] MISS z=${z} x=${x} y=${y} offset=${offsetMin}min → tile.openweathermap.org/map/clouds_new/${z}/${x}/${y}.png`)

  try {
    const { data, headers } = await axios.get<ArrayBuffer>(tileUrl, {
      responseType: 'arraybuffer',
      timeout: 6000,
    })
    const buffer = Buffer.from(data)
    const contentType: string = (headers['content-type'] as string) || 'image/png'
    console.log(`[tiles] upstream OK z=${z} x=${x} y=${y} bytes=${buffer.length} type=${contentType} status=${headers['x-cache'] ?? 'n/a'}`)

    evict()
    tileCache.set(cacheKey, { data: buffer, contentType, cachedAt: Date.now() })

    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('Cache-Control', 'public, max-age=1800')
    res.send(buffer)
  } catch (err: any) {
    const status = err?.response?.status ?? 'no-response'
    const body   = err?.response?.data ? Buffer.from(err.response.data).toString('utf8').slice(0, 200) : String(err)
    console.error(`[tiles] UPSTREAM ERROR z=${z} x=${x} y=${y} status=${status} body=${body}`)
    res.setHeader('Content-Type', 'image/png')
    res.status(200).send(TRANSPARENT_TILE)
  }
})

export default router
