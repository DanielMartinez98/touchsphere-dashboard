import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

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
    res.status(500).json({ error: 'Weather API key not configured' })
    return
  }

  try {
    const [currentRes, forecastRes] = await Promise.all([
      axios.get('https://api.openweathermap.org/data/2.5/weather', {
        params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
        timeout: 8000,
      }),
      axios.get('https://api.openweathermap.org/data/2.5/forecast', {
        params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric', cnt: 1 },
        timeout: 8000,
      }),
    ])

    const d = currentRes.data
    const pop = forecastRes.data.list?.[0]?.pop ?? 0

    res.json({
      temp: d.main.temp,
      feels_like: d.main.feels_like,
      description: d.weather[0].description,
      icon: d.weather[0].icon,
      city: d.name,
      country: d.sys.country,
      humidity: d.main.humidity,
      wind_speed: d.wind.speed,
      wind_deg: d.wind.deg ?? 0,
      pressure: d.main.pressure,
      visibility: d.visibility ?? 10000,
      clouds: d.clouds.all,
      rain_1h: d.rain?.['1h'] ?? 0,
      rain_chance: pop,
    })
  } catch (err) {
    console.error('Weather API error:', err)
    res.status(502).json({ error: 'Failed to fetch weather data' })
  }
})

// GET /api/weather/forecast — returns 3-hourly forecast slots (up to 40 steps, ~5 days)
// Each slot contains only fields that OWM's forecast API actually provides;
// visibility is included when present (not guaranteed in every response entry).
router.get('/forecast', async (req: Request, res: Response) => {
  const { lat, lon } = req.query
  const latNum = parseFloat(lat as string)
  const lonNum = parseFloat(lon as string)

  if (!lat || !lon || isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    res.status(400).json({ error: 'Valid lat (-90–90) and lon (-180–180) are required' })
    return
  }

  const apiKey = process.env['OPENWEATHER_API_KEY']
  if (!apiKey) {
    res.status(500).json({ error: 'Weather API key not configured' })
    return
  }

  try {
    const forecastRes = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
      timeout: 8000,
    })

    const now = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slots = forecastRes.data.list.map((item: any) => ({
      dt: item.dt,
      // Pre-compute offset so the client doesn't need to handle clocks
      offset_min: Math.round((item.dt * 1000 - now) / 60_000),
      temp: item.main.temp,
      feels_like: item.main.feels_like,
      description: item.weather[0]?.description ?? '',
      humidity: item.main.humidity,
      wind_speed: item.wind.speed,
      wind_deg: item.wind.deg ?? 0,
      pressure: item.main.pressure,
      clouds: item.clouds.all,
      // forecast gives 3-hour accumulation, not 1-hour
      rain_3h: item.rain?.['3h'] ?? 0,
      rain_chance: item.pop ?? 0,
      // visibility is optional in forecast entries
      visibility: typeof item.visibility === 'number' ? item.visibility : null,
    }))

    res.json(slots)
  } catch (err) {
    console.error('Forecast API error:', err)
    res.status(502).json({ error: 'Failed to fetch forecast data' })
  }
})

export default router
