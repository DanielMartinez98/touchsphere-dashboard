import { useState, useEffect } from 'react'
import type { WeatherData } from '../types'

// ── Module-level singleton ──────────────────────────────────────────────────
// Fetching starts the moment this module is first imported — before any
// component mounts. All hook instances share the same data with no duplicate
// network requests.

type Listener = () => void

let _weather: WeatherData | null = null
let _error: string | null = null
const _listeners = new Set<Listener>()

function _notify() {
  _listeners.forEach(fn => fn())
}

async function _getLocation(): Promise<{ lat: number; lon: number }> {
  if (navigator.geolocation) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10_000,
          maximumAge: 5 * 60 * 1000,
        })
      )
      return { lat: pos.coords.latitude, lon: pos.coords.longitude }
    } catch {
      // fall through to IP-based lookup
    }
  }
  // Fall back to server-side IP lookup (works over plain HTTP unlike navigator.geolocation)
  const res = await fetch('/api/geoip')
  if (!res.ok) throw new Error('IP geolocation failed')
  const geo = await res.json()
  if (typeof geo.lat !== 'number' || typeof geo.lon !== 'number') {
    throw new Error('Invalid geolocation response')
  }
  return { lat: geo.lat, lon: geo.lon }
}

async function _fetchWeather() {
  try {
    const { lat, lon } = await _getLocation()
    const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`)
    if (!res.ok) throw new Error('Weather fetch failed')
    const data: WeatherData = await res.json()
    _weather = { ...data, lat, lon }
    _error = null
  } catch {
    _error = 'Unable to load weather'
  }
  _notify()
}

// Start immediately on module load, refresh every 10 minutes
_fetchWeather()
setInterval(_fetchWeather, 10 * 60 * 1000)

// ── Hook ───────────────────────────────────────────────────────────────────
export function useWeather() {
  const [, rerender] = useState(0)

  useEffect(() => {
    const listener: Listener = () => rerender(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])

  return { weather: _weather, error: _error }
}

// Expose for other singleton modules that need lat/lon
export function getWeatherSnapshot() {
  return _weather
}
