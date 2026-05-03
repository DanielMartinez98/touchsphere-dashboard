import { useState, useEffect } from 'react'
import type { AirQualityData } from '../types'
import { getWeatherSnapshot } from './useWeather'

// ── Module-level singleton ──────────────────────────────────────────────────
// Starts fetching as soon as a lat/lon is available from the weather singleton.
// Retries every 5 s until location is known, then refreshes every 30 minutes.

type Listener = () => void

// ── localStorage cache ──────────────────────────────────────────────────────
const LS_KEY = 'ts_aqi'
function _loadCache(): AirQualityData | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as AirQualityData) : null
  } catch { return null }
}
function _saveCache(data: AirQualityData) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)) } catch {}
}

let _aqi: AirQualityData | null = _loadCache()
const _listeners = new Set<Listener>()
let _lat: number | null = null
let _lon: number | null = null

function _notify() {
  _listeners.forEach(fn => fn())
}

async function _fetchAqi() {
  if (_lat === null || _lon === null) return
  try {
    const res = await fetch(`/api/airquality?lat=${_lat}&lon=${_lon}`)
    if (!res.ok) return
    const data: AirQualityData = await res.json()
    _aqi = data
    _saveCache(data)
    _notify()
  } catch {
    // silently ignore
  }
}

function _startWhenReady() {
  const snap = getWeatherSnapshot()
  if (snap) {
    _lat = snap.lat
    _lon = snap.lon
    _fetchAqi()
    setInterval(_fetchAqi, 30 * 60 * 1000)
  } else {
    // Weather not ready yet — poll every 5 s until it is
    const poll = setInterval(() => {
      const s = getWeatherSnapshot()
      if (s) {
        clearInterval(poll)
        _lat = s.lat
        _lon = s.lon
        _fetchAqi()
        setInterval(_fetchAqi, 30 * 60 * 1000)
      }
    }, 5_000)
  }
}

_startWhenReady()

// ── Hook ───────────────────────────────────────────────────────────────────
// lat/lon params kept for API compatibility but are no longer used —
// the singleton derives them from the weather store.
export function useAirQuality(_lat2?: number | null, _lon2?: number | null) {
  const [, rerender] = useState(0)

  useEffect(() => {
    const listener: Listener = () => rerender(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])

  return { aqi: _aqi }
}
