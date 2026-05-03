import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  const { lat, lon } = req.query

  if (!lat || !lon) {
    res.status(400).json({ error: 'lat and lon are required' })
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
        params: { lat, lon, appid: apiKey, units: 'metric' },
        timeout: 8000,
      }),
      axios.get('https://api.openweathermap.org/data/2.5/forecast', {
        params: { lat, lon, appid: apiKey, units: 'metric', cnt: 1 },
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

export default router
