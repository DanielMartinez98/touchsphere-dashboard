import { useState, useEffect } from 'react'
import type { AirQualityData } from '../types'

export function useAirQuality(lat: number | null, lon: number | null) {
  const [aqi, setAqi] = useState<AirQualityData | null>(null)

  useEffect(() => {
    if (lat === null || lon === null) return

    async function load() {
      try {
        const res = await fetch(`/api/airquality?lat=${lat}&lon=${lon}`)
        if (!res.ok) return
        const data: AirQualityData = await res.json()
        setAqi(data)
      } catch {
        // silently ignore
      }
    }

    load()
    const id = setInterval(load, 30 * 60 * 1000) // refresh every 30 min
    return () => clearInterval(id)
  }, [lat, lon])

  return { aqi }
}
