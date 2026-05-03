import { useState, useEffect } from 'react'
import { getWeatherSnapshot } from './useWeather'

// ── Types ───────────────────────────────────────────────────────────────────
export interface CloudLayerSlot {
  dt: number
  offset_min: number
  cloud_low: number    // 0–100 % — low clouds/fog (0–3 km altitude)
  cloud_mid: number    // 0–100 % — mid clouds (3–8 km)
  cloud_high: number   // 0–100 % — high cirrus (> 8 km)
  weather_code: number // WMO code (from Open-Meteo)
  precip_prob: number  // 0–100 %
}

// ── Module-level singleton ──────────────────────────────────────────────────
// Same pattern as useForecast: fetches once, shared across all hook instances,
// re-fetches every 60 min. Cloud-layer data has 1-hour resolution so refreshing
// more often would be pointless and wasteful.

type Listener = () => void

// ── localStorage cache ──────────────────────────────────────────────────────
const LS_KEY = 'ts_cloud_layers'
function _loadCache(): CloudLayerSlot[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as CloudLayerSlot[]) : []
  } catch { return [] }
}
function _saveCache(slots: CloudLayerSlot[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(slots)) } catch {}
}

let _slots: CloudLayerSlot[] = _loadCache()
const _listeners = new Set<Listener>()
let _lat: number | null = null
let _lon: number | null = null

function _notify() {
  _listeners.forEach(fn => fn())
}

async function _fetchCloudLayers() {
  if (_lat === null || _lon === null) return
  try {
    const res = await fetch(`/api/weather/cloud-layers?lat=${_lat}&lon=${_lon}`)
    if (!res.ok) return
    const slots: CloudLayerSlot[] = await res.json()
    _slots = slots
    _saveCache(slots)
    _notify()
  } catch {
    // silently ignore — stale cache stays active
  }
}

function _startWhenReady() {
  const snap = getWeatherSnapshot()
  if (snap) {
    _lat = snap.lat
    _lon = snap.lon
    _fetchCloudLayers()
    setInterval(_fetchCloudLayers, 60 * 60 * 1000)
  } else {
    const poll = setInterval(() => {
      const s = getWeatherSnapshot()
      if (s) {
        clearInterval(poll)
        _lat = s.lat
        _lon = s.lon
        _fetchCloudLayers()
        setInterval(_fetchCloudLayers, 60 * 60 * 1000)
      }
    }, 5_000)
  }
}

_startWhenReady()

// ── Hook ───────────────────────────────────────────────────────────────────
export function useCloudLayers() {
  const [, rerender] = useState(0)

  useEffect(() => {
    const listener: Listener = () => rerender(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])

  return { cloudLayers: _slots }
}

/** Pick the cloud-layer slot closest to targetMin offset. */
export function nearestCloudSlot(slots: CloudLayerSlot[], targetMin: number): CloudLayerSlot | null {
  if (!slots.length) return null
  return slots.reduce((best, s) =>
    Math.abs(s.offset_min - targetMin) < Math.abs(best.offset_min - targetMin) ? s : best
  )
}
