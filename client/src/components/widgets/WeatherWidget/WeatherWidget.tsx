import { useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'
import { useCloudLayers, nearestCloudSlot } from '../../../hooks/useCloudLayers'

const ICON_URL = (code: string) => `https://openweathermap.org/img/wn/${code}@2x.png`

export function WeatherCollapsed() {
  const { weather, error } = useWeather()
  const { cloudLayers } = useCloudLayers()
  const [iconError, setIconError] = useState(false)

  if (error) return <span className="text-xs text-red-400">{error}</span>
  if (!weather) return <span className="text-xs text-white/40">Loading...</span>

  // Current cloud layer breakdown (offset 0 = now)
  const cSlot = nearestCloudSlot(cloudLayers, 0)

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

      {/* Cloud altitude mini-bars — only shown when Open-Meteo data is available */}
      {cSlot && (
        <div className="flex flex-col gap-0.5 mt-1 w-full max-w-[120px]">
          {[
            { label: 'H', value: cSlot.cloud_high, color: '#7dd3fc' },
            { label: 'M', value: cSlot.cloud_mid,  color: '#60a5fa' },
            { label: 'L', value: cSlot.cloud_low,  color: '#cbd5e1' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex items-center gap-1">
              <span className="text-[8px] text-white/30 w-3 shrink-0">{label}</span>
              <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${value}%`, backgroundColor: color, opacity: Math.max(0.15, value / 100) }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
