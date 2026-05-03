import { useState, useEffect } from 'react'
import type { WeatherData } from '../types'

export function useWeather() {
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchWeather() {
      try {
        // Step 1: get location from IP (no key required)
        const geoRes = await fetch('http://ip-api.com/json/?fields=lat,lon,city,country')
        const geo = await geoRes.json()

        // Step 2: fetch weather via our backend proxy
        const weatherRes = await fetch(
          `/api/weather?lat=${geo.lat}&lon=${geo.lon}`
        )
        if (!weatherRes.ok) throw new Error('Weather fetch failed')
        const data: WeatherData = await weatherRes.json()
        setWeather({ ...data, city: geo.city, country: geo.country, lat: geo.lat, lon: geo.lon })
      } catch (e) {
        setError('Unable to load weather')
      }
    }
    fetchWeather()
    const id = setInterval(fetchWeather, 10 * 60 * 1000) // refresh every 10 min
    return () => clearInterval(id)
  }, [])

  return { weather, error }
}
