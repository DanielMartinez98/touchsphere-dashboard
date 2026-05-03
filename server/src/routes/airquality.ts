import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

// ── Server-side cache (30 min) ───────────────────────────────────────────────
// Matches the client's 30-min refresh rate; prevents extra OWM calls on page refresh.
const AQI_TTL_MS = 30 * 60 * 1000
interface AqiCache { data: object; ts: number }
const aqiCache = new Map<string, AqiCache>()

function cacheKey(lat: number, lon: number) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

const AQI_LABELS: Record<number, string> = {
  1: 'Good',
  2: 'Fair',
  3: 'Moderate',
  4: 'Poor',
  5: 'Very Poor',
}

router.get('/', async (req: Request, res: Response) => {
  const { lat, lon } = req.query
  const latNum = parseFloat(lat as string)
  const lonNum = parseFloat(lon as string)

  if (!lat || !lon || isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    res.status(400).json({ error: 'Valid lat (-90–90) and lon (-180–180) are required' })
    return
  }

  const apiKey = process.env['OPENWEATHER_API_KEY']
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured' })
    return
  }

  const key = cacheKey(latNum, lonNum)
  const cached = aqiCache.get(key)
  if (cached && Date.now() - cached.ts < AQI_TTL_MS) {
    console.log(`[airquality] cache hit for ${key}`)
    res.json(cached.data)
    return
  }

  try {
    const { data } = await axios.get(
      'https://api.openweathermap.org/data/2.5/air_pollution',
      { params: { lat: latNum, lon: lonNum, appid: apiKey }, timeout: 8000 }
    )

    const item = data.list[0]
    const aqi: number = item.main.aqi
    const c = item.components

    const result = {
      aqi,
      aqi_label: AQI_LABELS[aqi] ?? 'Unknown',
      co: c.co,
      no2: c.no2,
      o3: c.o3,
      so2: c.so2,
      pm2_5: c.pm2_5,
      pm10: c.pm10,
    }
    aqiCache.set(key, { data: result, ts: Date.now() })
    console.log(`[airquality] fetched fresh for ${key}`)
    res.json(result)
  } catch (err) {
    console.error('Air quality API error:', err)
    res.status(502).json({ error: 'Failed to fetch air quality data' })
  }
})

export default router
