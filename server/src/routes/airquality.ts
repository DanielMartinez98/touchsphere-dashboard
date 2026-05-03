import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

const AQI_LABELS: Record<number, string> = {
  1: 'Good',
  2: 'Fair',
  3: 'Moderate',
  4: 'Poor',
  5: 'Very Poor',
}

router.get('/', async (req: Request, res: Response) => {
  const { lat, lon } = req.query
  if (!lat || !lon) {
    res.status(400).json({ error: 'lat and lon are required' })
    return
  }

  const apiKey = process.env['OPENWEATHER_API_KEY']
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured' })
    return
  }

  try {
    const { data } = await axios.get(
      'https://api.openweathermap.org/data/2.5/air_pollution',
      { params: { lat, lon, appid: apiKey }, timeout: 8000 }
    )

    const item = data.list[0]
    const aqi: number = item.main.aqi
    const c = item.components

    res.json({
      aqi,
      aqi_label: AQI_LABELS[aqi] ?? 'Unknown',
      co: c.co,
      no2: c.no2,
      o3: c.o3,
      so2: c.so2,
      pm2_5: c.pm2_5,
      pm10: c.pm10,
    })
  } catch (err) {
    console.error('Air quality API error:', err)
    res.status(502).json({ error: 'Failed to fetch air quality data' })
  }
})

export default router
