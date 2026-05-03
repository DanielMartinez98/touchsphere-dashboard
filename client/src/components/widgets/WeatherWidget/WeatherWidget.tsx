import { useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'

const ICON_URL = (code: string) => `https://openweathermap.org/img/wn/${code}@2x.png`

export function WeatherCollapsed() {
  const { weather, error } = useWeather()
  const [iconError, setIconError] = useState(false)

  if (error) return <span className="text-xs text-red-400">{error}</span>
  if (!weather) return <span className="text-xs text-white/40">Loading...</span>

  return (
    <>
      <div className="flex items-center gap-2">
        {iconError ? (
          <span className="w-10 h-10 flex items-center justify-center text-2xl">🌡️</span>
        ) : (
          <img
            src={ICON_URL(weather.icon)}
            alt={weather.description}
            className="w-10 h-10 -m-1"
            onError={() => setIconError(true)}
          />
        )}
        <span className="text-3xl font-bold text-white">{Math.round(weather.temp)}°</span>
      </div>
      <span className="text-xs text-white/50 capitalize">{weather.description}</span>
      <span className="text-xs text-white/40">{weather.city}, {weather.country}</span>
    </>
  )
}
