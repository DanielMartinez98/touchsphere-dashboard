import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

// Cache result for 1 hour so external APIs aren't hammered on every page load
let _cache: { lat: number; lon: number; ts: number } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000

// Returns lat/lon — priority order:
//   1. DEFAULT_LAT / DEFAULT_LON env vars (no external call)
//   2. Cached result
//   3. ip-api.com (free, no key, 45 req/min, auto-detects server's public IP)
router.get('/', async (_req: Request, res: Response) => {
  // 1. Static env-var location (best for a personal kiosk — set once, always works)
  const defLat = parseFloat(process.env['DEFAULT_LAT'] ?? '')
  const defLon = parseFloat(process.env['DEFAULT_LON'] ?? '')
  if (!isNaN(defLat) && !isNaN(defLon)) {
    console.log(`[geoip] using DEFAULT_LAT/LON: ${defLat}, ${defLon}`)
    res.json({ lat: defLat, lon: defLon })
    return
  }

  // 2. Return cache if still fresh
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    console.log(`[geoip] cache hit: ${_cache.lat}, ${_cache.lon}`)
    res.json({ lat: _cache.lat, lon: _cache.lon })
    return
  }

  // 3. Call ip-api.com with no IP → auto-detects the server's public IP
  //    Free tier: 45 req/min, no API key required
  try {
    const { data } = await axios.get('http://ip-api.com/json/?fields=lat,lon,status,message', { timeout: 8000 })
    console.log(`[geoip] ip-api.com → status=${data.status} lat=${data.lat} lon=${data.lon}`)

    if (data.status !== 'success' || typeof data.lat !== 'number' || typeof data.lon !== 'number') {
      console.error('[geoip] bad response from ip-api.com:', JSON.stringify(data))
      res.status(502).json({ error: 'Geolocation lookup failed' })
      return
    }

    _cache = { lat: data.lat, lon: data.lon, ts: Date.now() }
    res.json({ lat: data.lat, lon: data.lon })
  } catch (err) {
    console.error('[geoip] ip-api.com error:', err)
    res.status(502).json({ error: 'Geolocation lookup failed' })
  }
})

export default router
