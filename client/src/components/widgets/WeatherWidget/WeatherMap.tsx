import { useEffect, useRef, useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'
import { useAirQuality } from '../../../hooks/useAirQuality'

declare const L: any

// 42-hour window: -6h (past) → +36h (future)
const MIN_OFFSET = -360
const MAX_OFFSET = 2160

// Cache at module level — survives widget close/reopen
// (OWM key is now kept server-side; this is kept for the CSS filter guard)
const CLOUD_FILTER =
  'contrast(3) brightness(3) drop-shadow(0 0 3px rgba(0,200,220,0.9)) drop-shadow(0 0 1px rgba(0,80,120,1))'

function windDir(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(deg / 45) % 8]
}

function offsetLabel(min: number): string {
  if (min === 0) return 'Now'
  const h = Math.round(min / 60)
  return h > 0 ? `+${h}h` : `${h}h`
}

function absTime(min: number): string {
  const d = new Date(Date.now() + min * 60 * 1000)
  return (
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) +
    ' · ' +
    d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  )
}

function buildCloudUrl(offsetMin: number): string {
  // All tiles now go through our server proxy which caches responses in memory.
  // The OWM key is kept server-side; the client never needs it.
  return `/api/tiles/clouds/{z}/{x}/{y}?offset=${offsetMin}`
}

// Full opacity after crossfade; CSS filter handles visual punch
const CLOUD_OPACITY = 1
// Max Leaflet layer objects kept in memory (each ~a few MB of tile images)
const LAYER_CACHE_MAX = 8

const AQI_COLORS: Record<number, string> = {
  1: 'text-green-400 border-green-500/40 bg-green-500/10',
  2: 'text-lime-400 border-lime-500/40 bg-lime-500/10',
  3: 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10',
  4: 'text-orange-400 border-orange-500/40 bg-orange-500/10',
  5: 'text-red-400 border-red-500/40 bg-red-500/10',
}

export default function WeatherMap() {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const cloudLayerRef = useRef<any>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  // Client-side layer cache: keeps Leaflet layer objects for visited offsets so
  // scrubbing back is instant (zero network, zero re-render flash)
  const layerCacheRef = useRef<Map<number, any>>(new Map())
  // Tracks the in-flight layer currently loading so we can cancel it if the user
  // scrubs again before it finishes
  const pendingLayerRef = useRef<any>(null)
  const { weather } = useWeather()
  const { aqi } = useAirQuality(weather?.lat ?? null, weather?.lon ?? null)
  // rawOffset drives the slider visuals instantly; committedOffset drives tile swaps (debounced)
  const [rawOffset, setRawOffset] = useState(0)
  const [committedOffset, setCommittedOffset] = useState(0)

  // Initialize map once — tiles go through server proxy, no OWM key needed client-side
  useEffect(() => {
    if (!mapRef.current || typeof L === 'undefined') return
    if (mapInstanceRef.current) return

    const map = L.map(mapRef.current, { center: [20, 0], zoom: 2, zoomControl: true })
    mapInstanceRef.current = map

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(map)

    // Inject cloud CSS filter + crossfade transition once
    if (!document.getElementById('owm-cloud-style')) {
      const s = document.createElement('style')
      s.id = 'owm-cloud-style'
      s.textContent = [
        `.owm-clouds img { filter: ${CLOUD_FILTER} !important; }`,
        `.owm-clouds { transition: opacity 0.35s ease-in-out; }`,
      ].join('\n')
      document.head.appendChild(s)
    }
    // Cloud layer is now managed entirely by the committedOffset effect below

    return () => {
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      cloudLayerRef.current = null
      pendingLayerRef.current = null
      layerCacheRef.current.clear()
    }
  }, [])

  // Load-gated crossfade: old layer stays fully visible until new tiles are ready,
  // then CSS transition animates the swap. Client cache makes revisited offsets instant.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || typeof L === 'undefined') return

    const offset = committedOffset
    const cache = layerCacheRef.current

    // Cancel any layer that is still loading (user scrubbed again before it finished)
    if (pendingLayerRef.current) {
      map.removeLayer(pendingLayerRef.current)
      pendingLayerRef.current = null
    }

    // Cache hit — crossfade to the already-loaded layer instantly
    if (cache.has(offset)) {
      const next = cache.get(offset)
      const prev = cloudLayerRef.current
      if (next !== prev) {
        next.setOpacity(CLOUD_OPACITY)
        if (prev) prev.setOpacity(0)
        cloudLayerRef.current = next
      }
      return
    }

    // Cache miss — add new layer at opacity 0 (invisible), old layer stays visible
    const prev = cloudLayerRef.current
    const newLayer = L.tileLayer(buildCloudUrl(offset), {
      opacity: 0,
      className: 'owm-clouds',
      attribution: '© OpenWeatherMap',
    }).addTo(map)
    pendingLayerRef.current = newLayer

    newLayer.once('load', () => {
      // Ignore if a newer request has already superseded this one
      if (pendingLayerRef.current !== newLayer) return
      pendingLayerRef.current = null

      // Crossfade: new layer fades in, old layer fades out (CSS transition handles animation)
      newLayer.setOpacity(CLOUD_OPACITY)
      if (prev) prev.setOpacity(0)
      cloudLayerRef.current = newLayer

      // Evict the oldest cached layer when we hit the limit
      if (cache.size >= LAYER_CACHE_MAX) {
        const firstEntry = cache.entries().next().value as [number, any] | undefined
        if (firstEntry) {
          const [oldOffset, oldLayer] = firstEntry
          if (oldLayer !== cloudLayerRef.current) map.removeLayer(oldLayer)
          cache.delete(oldOffset)
        }
      }
      cache.set(offset, newLayer)
    })
  }, [committedOffset])

  // Keep slider green-fill in sync via CSS custom property (avoids inline style)
  useEffect(() => {
    if (!sliderRef.current) return
    const pct = ((rawOffset - MIN_OFFSET) / (MAX_OFFSET - MIN_OFFSET)) * 100
    sliderRef.current.style.setProperty('--scrub-val', `${pct.toFixed(1)}%`)
  }, [rawOffset])

  function handleScrub(val: number) {
    setRawOffset(val) // instant visual feedback
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setCommittedOffset(val), 120)
  }

  // Fly to real location
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !weather) return
    const latlng: [number, number] = [weather.lat, weather.lon]
    map.invalidateSize()
    map.setView(latlng, 8)  // instant — no fly animation
    if (markerRef.current) markerRef.current.remove()
    markerRef.current = L.marker(latlng)
      .addTo(map)
      .bindPopup(
        `<b>${weather.city}, ${weather.country}</b><br>${Math.round(weather.temp)}°C — ${weather.description}`
      )
      .openPopup()
  }, [weather])


  const stats = weather
    ? [
        { label: 'Temp', value: `${Math.round(weather.temp)}°C` },
        { label: 'Feels Like', value: `${Math.round(weather.feels_like)}°C` },
        { label: 'Rain Chance', value: `${Math.round(weather.rain_chance * 100)}%` },
        { label: 'Rain (1h)', value: weather.rain_1h > 0 ? `${weather.rain_1h} mm` : 'None' },
        { label: 'Humidity', value: `${weather.humidity}%` },
        { label: 'Wind', value: `${Math.round(weather.wind_speed * 3.6)} km/h ${windDir(weather.wind_deg)}` },
        { label: 'Pressure', value: `${weather.pressure} hPa` },
        { label: 'Visibility', value: `${(weather.visibility / 1000).toFixed(1)} km` },
        { label: 'Cloud Cover', value: `${weather.clouds}%` },
        { label: 'Sky', value: weather.description },
      ]
    : []

  return (
    <div className="flex flex-col h-full pt-16">
      {/* Map */}
      <div ref={mapRef} className="flex-1 min-h-0 bg-[#111]" />

      {/* Scrollable info strip — weather + air quality */}
      <div className="flex-shrink-0 bg-black/80 border-t border-white/10 px-2 py-2 overflow-x-auto">
        <div className="flex gap-2 w-max">
          {/* Weather stats */}
          {stats.map(s => (
            <div
              key={s.label}
              className="flex flex-col items-center bg-white/5 border border-white/10 rounded-xl px-4 py-2 min-w-[88px]"
            >
              <span className="text-white/50 text-[11px] leading-tight">{s.label}</span>
              <span className="text-white font-semibold text-sm mt-0.5 text-center">{s.value}</span>
            </div>
          ))}

          {/* Divider */}
          {aqi && (
            <div className="w-px self-stretch bg-white/15 mx-1" />
          )}

          {/* AQI index card */}
          {aqi && (
            <div className={`flex flex-col items-center border rounded-xl px-4 py-2 min-w-[88px] ${AQI_COLORS[aqi.aqi] ?? 'text-white/60 border-white/10 bg-white/5'}`}>
              <span className="text-[11px] leading-tight opacity-75">Air Quality</span>
              <span className="font-bold text-sm mt-0.5">{aqi.aqi_label}</span>
              <span className="text-[10px] opacity-60 mt-0.5">AQI {aqi.aqi}/5</span>
            </div>
          )}

          {/* Individual pollutant cards */}
          {aqi && ([
            { label: 'PM2.5', value: `${aqi.pm2_5.toFixed(1)} µg` },
            { label: 'PM10',  value: `${aqi.pm10.toFixed(1)} µg` },
            { label: 'O₃',    value: `${aqi.o3.toFixed(1)} µg` },
            { label: 'NO₂',   value: `${aqi.no2.toFixed(1)} µg` },
            { label: 'SO₂',   value: `${aqi.so2.toFixed(1)} µg` },
            { label: 'CO',    value: `${aqi.co.toFixed(0)} µg` },
          ].map(s => (
            <div
              key={s.label}
              className="flex flex-col items-center bg-white/5 border border-white/10 rounded-xl px-4 py-2 min-w-[80px]"
            >
              <span className="text-white/50 text-[11px] leading-tight">{s.label}</span>
              <span className="text-white font-semibold text-sm mt-0.5">{s.value}</span>
            </div>
          )))}
        </div>
      </div>

      {/* Time scrubber */}
      <div className="flex-shrink-0 bg-black/90 border-t border-white/10 px-4 py-3 select-none">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/35 text-[11px]">−6h</span>
          <div className="flex items-baseline gap-2">
            <span className={`font-semibold text-sm ${rawOffset === 0 ? 'text-green-400' : rawOffset < 0 ? 'text-amber-400' : 'text-sky-400'}`}>
              {offsetLabel(rawOffset)}
            </span>
            <span className="text-white/45 text-[11px]">{absTime(rawOffset)}</span>
          </div>
          <span className="text-white/35 text-[11px]">+36h</span>
        </div>

        <input
          ref={sliderRef}
          type="range"
          min={MIN_OFFSET}
          max={MAX_OFFSET}
          step={60}
          value={rawOffset}
          onChange={e => handleScrub(Number(e.target.value))}
          aria-label="Cloud cover time scrubber"
          className="time-scrubber w-full"
        />

        {/* Now tick indicator — fixed at 14.286% (360/2520 of the 42h range) */}
        <div className="relative mt-1 h-3">
          <div className="absolute left-[14.286%] -translate-x-1/2 flex flex-col items-center">
            <div className="w-px h-2 bg-white/30" />
            <span className="text-white/30 text-[9px] leading-none">NOW</span>
          </div>
        </div>
      </div>
    </div>
  )
}
