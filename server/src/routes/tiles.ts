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
  if (tileCache.size < MAX_ENTRIES) return
  const cutoff = Date.now() - CACHE_TTL_MS
  for (const [key, entry] of tileCache) {
    if (entry.cachedAt < cutoff) tileCache.delete(key)
    if (tileCache.size < MAX_ENTRIES * 0.75) break
  }
}

// ── Route: GET /api/tiles/clouds/:z/:x/:y?offset=<minutes> ───────────────────
// offset is rounded to the nearest hour before hitting OWM so identical
// tiles within the same hour share one cache entry.
router.get('/clouds/:z/:x/:y', async (req: Request, res: Response) => {
  const { z, x, y } = req.params
  const offsetMin = parseInt(req.query['offset'] as string) || 0
  const apiKey = process.env['OPENWEATHER_API_KEY']

  if (!apiKey) {
    res.status(500).send('API key not configured')
    return
  }

  // Round to nearest hour (3600 s) for cache key stability
  const roundedUnix = Math.round((Date.now() + offsetMin * 60_000) / 3_600_000) * 3600
  const cacheKey = `${z}/${x}/${y}/${roundedUnix}`

  const cached = tileCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    res.setHeader('Content-Type', cached.contentType)
    res.setHeader('X-Cache', 'HIT')
    res.setHeader('Cache-Control', 'public, max-age=1800')
    res.send(cached.data)
    return
  }

  const tileUrl = offsetMin === 0
    ? `https://tile.openweathermap.org/map/clouds_new/${z}/${x}/${y}.png?appid=${apiKey}`
    : `https://maps.openweathermap.org/maps/2.0/weather/CL/${z}/${x}/${y}?appid=${apiKey}&date=${roundedUnix}&opacity=0.75&fill_bound=true`

  try {
    const { data, headers } = await axios.get<ArrayBuffer>(tileUrl, {
      responseType: 'arraybuffer',
      timeout: 6000,
    })
    const buffer = Buffer.from(data)
    const contentType: string = (headers['content-type'] as string) || 'image/png'

    evict()
    tileCache.set(cacheKey, { data: buffer, contentType, cachedAt: Date.now() })

    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('Cache-Control', 'public, max-age=1800')
    res.send(buffer)
  } catch {
    res.setHeader('Content-Type', 'image/png')
    res.status(200).send(TRANSPARENT_TILE)
  }
})

export default router
