import { useState, useEffect } from 'react'
import { getWeatherSnapshot } from './useWeather'

// One contiguous hourly series spanning past → now → future (Open-Meteo).
// OpenWeather can't serve the past on our key (history is behind One Call 3.0),
// so the entire scrubbable window comes from a single source — which also means
// there's no seam at "now" where two providers disagree.

export interface TimelineSlot {
  dt: number            // epoch ms
  offset_min: number    // minutes from load time; negative = past
  temp: number
  feels_like: number
  humidity: number      // %
  precip: number        // mm in the hour
  rain_chance: number   // 0–1 (normalised to OWM's `pop` scale)
  weather_code: number  // WMO
  clouds: number        // % total
  cloud_low: number
  cloud_mid: number
  cloud_high: number
  wind_speed: number    // m/s (matches OWM)
  wind_deg: number
  pressure: number      // hPa
  is_day: boolean
}

// ── Module-level singleton ──────────────────────────────────────────────────
// Same shape as useCloudLayers/useForecast: fetch once, share across instances,
// refresh hourly (the data itself is hourly, so anything finer is waste).
type Listener = () => void

const LS_KEY = 'ts_timeline'
const REFRESH_MS = 60 * 60 * 1000

function _loadCache(): TimelineSlot[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as TimelineSlot[]) : []
  } catch { return [] }
}
function _saveCache(slots: TimelineSlot[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(slots)) } catch { /* quota — ignore */ }
}

let _slots: TimelineSlot[] = _loadCache()
const _listeners = new Set<Listener>()
let _lat: number | null = null
let _lon: number | null = null

function _notify() { _listeners.forEach(fn => fn()) }

async function _fetch() {
  if (_lat === null || _lon === null) return
  try {
    const res = await fetch(`/api/weather/timeline?lat=${_lat}&lon=${_lon}`)
    if (!res.ok) return
    const slots: TimelineSlot[] = await res.json()
    console.log(`[useTimeline] loaded ${slots.length} hourly slots`)
    _slots = slots
    _saveCache(slots)
    _notify()
  } catch {
    // Keep the stale cache — a scrubbable timeline that's an hour old still beats
    // an empty one on a kiosk that may be briefly offline.
  }
}

function _startWhenReady() {
  const snap = getWeatherSnapshot()
  if (snap) {
    _lat = snap.lat
    _lon = snap.lon
    _fetch()
    setInterval(_fetch, REFRESH_MS)
    return
  }
  const poll = setInterval(() => {
    const s = getWeatherSnapshot()
    if (!s) return
    clearInterval(poll)
    _lat = s.lat
    _lon = s.lon
    _fetch()
    setInterval(_fetch, REFRESH_MS)
  }, 5_000)
}

_startWhenReady()

export function useTimeline() {
  const [, rerender] = useState(0)
  useEffect(() => {
    const listener: Listener = () => rerender(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])
  return { timeline: _slots }
}

/** Slot closest to a given offset (minutes from now). */
export function nearestTimelineSlot(slots: TimelineSlot[], targetMin: number): TimelineSlot | null {
  if (!slots.length) return null
  return slots.reduce((best, s) =>
    Math.abs(s.offset_min - targetMin) < Math.abs(best.offset_min - targetMin) ? s : best
  )
}

// WMO weather codes (Open-Meteo). OWM ids don't apply here.
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  56: 'freezing drizzle', 57: 'dense freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
}

export function wmoDescription(code: number): string {
  return WMO[code] ?? 'unknown'
}
