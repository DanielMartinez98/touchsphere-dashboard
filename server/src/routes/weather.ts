import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

// ── Server-side caches ───────────────────────────────────────────────────────
// Weather (current conditions) refreshes every 10 min — matches client poll rate.
// Forecast changes slowly; 60 min TTL matches the client's 60-min refresh cycle
// and allows the weather route to reuse cached forecast data for `pop`,
// eliminating the redundant `forecast?cnt=1` OWM call that previously fired
// on every weather refresh (was 2 OWM calls → now 1 when forecast cache is warm).
const WEATHER_TTL_MS     = 10 * 60 * 1000   // 10 min
const FORECAST_TTL_MS    = 60 * 60 * 1000   // 60 min
const CLOUD_LAYER_TTL_MS = 60 * 60 * 1000   // 60 min — cloud-layer data is hourly resolution

interface WeatherCache     { data: object;   ts: number }
interface ForecastCache    { data: object[]; ts: number }
interface CloudLayerCache  { data: object[]; ts: number }

const weatherCache    = new Map<string, WeatherCache>()
const forecastCache   = new Map<string, ForecastCache>()
const cloudLayerCache = new Map<string, CloudLayerCache>()

function cacheKey(lat: number, lon: number) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

// ── Shared helper: map one OWM forecast list item → ForecastSlot ─────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSlot(item: any, now: number) {
  return {
    dt: item.dt,
    offset_min: Math.round((item.dt * 1000 - now) / 60_000),
    temp: item.main.temp,
    feels_like: item.main.feels_like,
    description: item.weather[0]?.description ?? '',
    humidity: item.main.humidity,
    wind_speed: item.wind.speed,
    wind_deg: item.wind.deg ?? 0,
    pressure: item.main.pressure,
    clouds: item.clouds.all,
    rain_3h: item.rain?.['3h'] ?? 0,
    rain_chance: item.pop ?? 0,
    visibility: typeof item.visibility === 'number' ? item.visibility : null,
  }
}

// ── GET /api/weather — current conditions ────────────────────────────────────
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

  const key = cacheKey(latNum, lonNum)
  const cachedWeather = weatherCache.get(key)
  if (cachedWeather && Date.now() - cachedWeather.ts < WEATHER_TTL_MS) {
    console.log(`[weather] cache hit for ${key}`)
    res.json(cachedWeather.data)
    return
  }

  try {
    const now = Date.now()
    const cachedForecast = forecastCache.get(key)
    const forecastWarm   = !!cachedForecast && now - cachedForecast.ts < FORECAST_TTL_MS

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentData: any
    let pop = 0

    if (forecastWarm) {
      // Forecast cache is warm — 1 OWM call (current weather only)
      const currentRes = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
        params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
        timeout: 8000,
      })
      currentData = currentRes.data
      pop = (cachedForecast!.data[0] as any)?.rain_chance ?? 0
      console.log(`[weather] fetched fresh (forecast cache reused) for ${key}`)
    } else {
      // Forecast cache cold — 2 OWM calls; populate forecastCache so /forecast gets a hit too
      const [currentRes, forecastRes] = await Promise.all([
        axios.get('https://api.openweathermap.org/data/2.5/weather', {
          params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
          timeout: 8000,
        }),
        axios.get('https://api.openweathermap.org/data/2.5/forecast', {
          params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
          timeout: 8000,
        }),
      ])
      currentData = currentRes.data
      const slots = forecastRes.data.list.map((item: any) => mapSlot(item, now))
      forecastCache.set(key, { data: slots, ts: now })
      pop = slots[0]?.rain_chance ?? 0
      console.log(`[weather] fetched fresh (+ populated forecast cache) for ${key}`)
    }

    const d = currentData
    const result = {
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
    }
    weatherCache.set(key, { data: result, ts: now })
    res.json(result)
  } catch (err) {
    console.error('Weather API error:', (err as any)?.response?.data ?? err)
    res.status(502).json({ error: 'Failed to fetch weather data' })
  }
})

// ── GET /api/weather/forecast — 3-hourly slots (≤40, ~5 days) ───────────────
// The weather route above also populates forecastCache when it runs cold,
// so in steady state this endpoint almost always serves a cache hit.
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

  const key = cacheKey(latNum, lonNum)
  const cached = forecastCache.get(key)
  if (cached && Date.now() - cached.ts < FORECAST_TTL_MS) {
    console.log(`[forecast] cache hit for ${key}`)
    res.json(cached.data)
    return
  }

  try {
    const forecastRes = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat: latNum, lon: lonNum, appid: apiKey, units: 'metric' },
      timeout: 8000,
    })

    const now = Date.now()
    const slots = forecastRes.data.list.map((item: any) => mapSlot(item, now))
    forecastCache.set(key, { data: slots, ts: now })
    console.log(`[forecast] fetched fresh for ${key} (${slots.length} slots)`)
    res.json(slots)
  } catch (err) {
    console.error('Forecast API error:', (err as any)?.response?.data ?? err)
    res.status(502).json({ error: 'Failed to fetch forecast data' })
  }
})

// ── GET /api/weather/cloud-layers — hourly low/mid/high cloud breakdown ──────
// Uses Open-Meteo (free, no API key). Returns 72 hourly slots (3 days).
// Cached 60 min — matches forecast TTL so scrubbing stays cheap.
// Open-Meteo is the only source that provides altitude-separated cloud cover
// without a paid tier: cloud_cover_low (0–3 km), mid (3–8 km), high (> 8 km).
router.get('/cloud-layers', async (req: Request, res: Response) => {
  const { lat, lon } = req.query
  const latNum = parseFloat(lat as string)
  const lonNum = parseFloat(lon as string)

  if (!lat || !lon || isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    res.status(400).json({ error: 'Valid lat (-90–90) and lon (-180–180) are required' })
    return
  }

  const key = cacheKey(latNum, lonNum)
  const cached = cloudLayerCache.get(key)
  if (cached && Date.now() - cached.ts < CLOUD_LAYER_TTL_MS) {
    console.log(`[cloud-layers] cache hit for ${key}`)
    res.json(cached.data)
    return
  }

  try {
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: latNum,
        longitude: lonNum,
        // Only request what we display — keeps payload small (~7 KB for 72 slots)
        hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,weather_code,precipitation_probability',
        forecast_days: 3,
        timezone: 'auto',
      },
      timeout: 8000,
    })

    const now = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = response.data.hourly as Record<string, any[]>
    const slots = h.time.map((t: string, i: number) => {
      const dt = new Date(t).getTime()
      return {
        dt,
        offset_min: Math.round((dt - now) / 60_000),
        cloud_low:  h.cloud_cover_low[i]            ?? 0,
        cloud_mid:  h.cloud_cover_mid[i]            ?? 0,
        cloud_high: h.cloud_cover_high[i]           ?? 0,
        weather_code: h.weather_code[i]             ?? 0,
        precip_prob:  h.precipitation_probability[i] ?? 0,
      }
    })

    cloudLayerCache.set(key, { data: slots, ts: now })
    console.log(`[cloud-layers] fetched fresh for ${key} (${slots.length} slots)`)
    res.json(slots)
  } catch (err) {
    console.error('Cloud-layers API error:', (err as any)?.response?.data ?? err)
    res.status(502).json({ error: 'Failed to fetch cloud layer data' })
  }
})

// ── GET /api/weather/timeline — one contiguous hourly series: past → now → future
// OpenWeather cannot serve the past at all: history lives behind One Call 3.0,
// which our key is not subscribed to (401). Open-Meteo gives past and future in
// a single keyless request, so the whole timeline comes from one source and the
// series is guaranteed continuous across "now" (no seam between two providers).
//
// Units are matched to the OWM shape the client already renders: wind in m/s,
// temps in °C — so slots are interchangeable with the existing forecast slots.
const TIMELINE_TTL_MS   = 30 * 60 * 1000   // 30 min — hourly data, hourly model runs
const TIMELINE_PAST_DAYS     = 2           // Open-Meteo allows up to 92
const TIMELINE_FORECAST_DAYS = 5           // …and up to 16

interface TimelineCache { data: object[]; ts: number }
const timelineCache = new Map<string, TimelineCache>()

router.get('/timeline', async (req: Request, res: Response) => {
  const { lat, lon } = req.query
  const latNum = parseFloat(lat as string)
  const lonNum = parseFloat(lon as string)

  if (!lat || !lon || isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    res.status(400).json({ error: 'Valid lat (-90–90) and lon (-180–180) are required' })
    return
  }

  const key = cacheKey(latNum, lonNum)
  const cached = timelineCache.get(key)
  if (cached && Date.now() - cached.ts < TIMELINE_TTL_MS) {
    console.log(`[timeline] cache hit for ${key}`)
    res.json(cached.data)
    return
  }

  try {
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude:  latNum,
        longitude: lonNum,
        hourly: [
          'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
          'precipitation', 'precipitation_probability', 'weather_code',
          'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
          'wind_speed_10m', 'wind_direction_10m', 'surface_pressure', 'is_day',
        ].join(','),
        // Match the units the client already formats for (OWM shape).
        wind_speed_unit: 'ms',
        past_days:     TIMELINE_PAST_DAYS,
        forecast_days: TIMELINE_FORECAST_DAYS,
        timezone: 'auto',
      },
      timeout: 8000,
    })

    const now = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = response.data.hourly as Record<string, any[]>
    const slots = h.time.map((t: string, i: number) => {
      const dt = new Date(t).getTime()
      return {
        dt,
        offset_min:   Math.round((dt - now) / 60_000),
        temp:         h.temperature_2m[i],
        feels_like:   h.apparent_temperature[i],
        humidity:     h.relative_humidity_2m[i],
        precip:       h.precipitation[i] ?? 0,
        // Open-Meteo reports probability 0–100; OWM's `pop` is 0–1. Normalise to
        // OWM's scale so the client's existing formatters keep working.
        rain_chance:  (h.precipitation_probability[i] ?? 0) / 100,
        weather_code: h.weather_code[i] ?? 0,
        clouds:       h.cloud_cover[i] ?? 0,
        cloud_low:    h.cloud_cover_low[i] ?? 0,
        cloud_mid:    h.cloud_cover_mid[i] ?? 0,
        cloud_high:   h.cloud_cover_high[i] ?? 0,
        wind_speed:   h.wind_speed_10m[i] ?? 0,
        wind_deg:     h.wind_direction_10m[i] ?? 0,
        pressure:     Math.round(h.surface_pressure[i] ?? 0),
        is_day:       (h.is_day[i] ?? 1) === 1,
      }
    })

    timelineCache.set(key, { data: slots, ts: now })
    const first = slots[0], last = slots[slots.length - 1]
    console.log(`[timeline] fetched fresh for ${key} — ${slots.length} slots (${first?.offset_min}min → ${last?.offset_min}min)`)
    res.json(slots)
  } catch (err) {
    console.error('Timeline API error:', (err as any)?.response?.data ?? err)
    res.status(502).json({ error: 'Failed to fetch weather timeline' })
  }
})

export default router
