import { useState } from 'react'
import { Thermometer } from 'lucide-react'
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
          <span className="w-10 h-10 flex items-center justify-center text-sky-300"><Thermometer size={28} /></span>
        ) : (
          <img
            src={ICON_URL(weather.icon)}
            alt={weather.description}
            className="w-10 h-10 -m-1"
            onError={() => setIconError(true)}
          />
        )}
        <span className="text-3xl font-bold font-display tabular-nums text-white">{Math.round(weather.temp)}°</span>
      </div>
      <span className="text-sm text-ink-mid capitalize leading-tight">{weather.description}</span>
      <span className="text-[13px] text-ink-dim">{weather.city}, {weather.country}</span>

      {/* Cloud altitude mini-bars — only when Open-Meteo data is available, and
          only on the kiosk. They are a glanceable detail for a screen read at
          arm's length; on a phone they are three more rows of height on the
          tallest pill of the four, which is what pushed this corner down over
          the middle of the screen. `hidden sm:flex`, so the 720px kiosk and any
          tablet keep them exactly as they are. */}
      {cSlot && (
        <div className="hidden sm:flex flex-col gap-0.5 mt-1 w-full max-w-[120px]">
          {[
            { label: 'H', value: cSlot.cloud_high, color: '#7dd3fc' },
            { label: 'M', value: cSlot.cloud_mid,  color: '#60a5fa' },
            { label: 'L', value: cSlot.cloud_low,  color: '#cbd5e1' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex items-center gap-1">
              <span className="text-[10px] text-white/40 w-3 shrink-0">{label}</span>
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
