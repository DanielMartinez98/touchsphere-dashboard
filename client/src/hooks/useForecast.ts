import { useState, useEffect } from 'react'
import { getWeatherSnapshot } from './useWeather'

// ── Types ───────────────────────────────────────────────────────────────────
export interface ForecastSlot {
  dt: number
  offset_min: number
  temp: number
  feels_like: number
  description: string
  humidity: number
  wind_speed: number
  wind_deg: number
  pressure: number
  clouds: number
  rain_3h: number
  rain_chance: number
  visibility: number | null
}

// ── Module-level singleton ──────────────────────────────────────────────────
// Starts fetching as soon as lat/lon is available from the weather singleton.
// Refreshes every 60 minutes (forecast changes slowly).

type Listener = () => void

let _forecasts: ForecastSlot[] = []
const _listeners = new Set<Listener>()
let _lat: number | null = null
let _lon: number | null = null

function _notify() {
  _listeners.forEach(fn => fn())
}

async function _fetchForecast() {
  if (_lat === null || _lon === null) return
  try {
    const res = await fetch(`/api/weather/forecast?lat=${_lat}&lon=${_lon}`)
    if (!res.ok) return
    const slots: ForecastSlot[] = await res.json()
    _forecasts = slots
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
    _fetchForecast()
    setInterval(_fetchForecast, 60 * 60 * 1000)
  } else {
    const poll = setInterval(() => {
      const s = getWeatherSnapshot()
      if (s) {
        clearInterval(poll)
        _lat = s.lat
        _lon = s.lon
        _fetchForecast()
        setInterval(_fetchForecast, 60 * 60 * 1000)
      }
    }, 5_000)
  }
}

_startWhenReady()

// ── Hook ───────────────────────────────────────────────────────────────────
export function useForecast() {
  const [, rerender] = useState(0)

  useEffect(() => {
    const listener: Listener = () => rerender(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])

  return { forecasts: _forecasts }
}

/** Pick the slot whose offset_min is closest to targetMin. */
export function nearestSlot(slots: ForecastSlot[], targetMin: number): ForecastSlot | null {
  if (!slots.length) return null
  return slots.reduce((best, s) =>
    Math.abs(s.offset_min - targetMin) < Math.abs(best.offset_min - targetMin) ? s : best
  )
}
