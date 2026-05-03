import { useEffect, useRef, useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'
import { useAirQuality } from '../../../hooks/useAirQuality'
import { useForecast, nearestSlot } from '../../../hooks/useForecast'
import { useCloudLayers, nearestCloudSlot } from '../../../hooks/useCloudLayers'

declare const L: any

// 42-hour window: -6h (past) → +36h (future)
const MIN_OFFSET = -360
const MAX_OFFSET = 2160

// Apple Weather aesthetic: satellite base + white clouds with soft glow.
// The OWM clouds_new tile is RGBA — cloud pixels are white/grey, clear sky is transparent.
// On a dark satellite base the white stands out naturally.
// contrast(1.6): sharpens faint cloud edges without over-saturating.
// brightness(1.3): lifts thin cirrus into visible range.
// drop-shadow: gives clouds a soft luminous halo (Apple-style inner glow).
const CLOUD_FILTER = 'contrast(1.6) brightness(1.3) drop-shadow(0 0 6px rgba(255,255,255,0.5))'

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


// OWM Maps 1.0 (free tier) has no date param — it always returns current clouds.
// We load a single cloud layer once and refresh it hourly. The scrubber only
// drives the stats bar below the map (which uses the forecast API), not the tiles.
const CLOUD_OPACITY = 0.85

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
  const { weather } = useWeather()
  const { aqi } = useAirQuality()
  const { forecasts } = useForecast()
  const { cloudLayers } = useCloudLayers()
  // rawOffset drives the slider visuals and stats bar; the tile layer is always "now"
  const [rawOffset, setRawOffset] = useState(0)
  const [mapReady, setMapReady] = useState(false)

  // Initialize map once — tiles go through server proxy, no OWM key needed client-side
  useEffect(() => {
    if (!mapRef.current || typeof L === 'undefined') return
    if (mapInstanceRef.current) return

    const map = L.map(mapRef.current, {
      center: [20, 0],
      zoom: 3,
      minZoom: 3,
      zoomControl: true,
      scrollWheelZoom: true,
      // Touch gestures — pinch-to-zoom and drag-to-pan on touchscreens
      touchZoom: true,
      dragging: true,
      tap: false,   // tap:true causes ghost clicks on some touch devices
    })
    console.log('[WeatherMap] Leaflet map initialised')
    mapInstanceRef.current = map

    // ESRI World Imagery — free satellite tiles, no key required
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    }).addTo(map)

    // Inject cloud CSS filter + crossfade transition once
    if (!document.getElementById('owm-cloud-style')) {
      const s = document.createElement('style')
      s.id = 'owm-cloud-style'
      s.textContent = [
        `.owm-clouds img { filter: ${CLOUD_FILTER} !important; }`,
        `.owm-clouds { transition: opacity 0.5s ease-in-out; }`,
      ].join('\n')
      document.head.appendChild(s)
    }

    // Load the cloud layer once — Maps 1.0 free tier has no date param so one
    // layer covers all time positions. Refresh every 60 min.
    function loadCloudLayer() {
      const prev = cloudLayerRef.current
      const layer = L.tileLayer('/api/tiles/clouds/{z}/{x}/{y}?offset=0', {
        opacity: 0,
        className: 'owm-clouds',
        attribution: '© OpenWeatherMap',
        updateWhenZooming: false,
        keepBuffer: 4,
      }).addTo(map)
      layer.once('load', () => {
        layer.setOpacity(CLOUD_OPACITY)
        cloudLayerRef.current = layer
        if (prev) {
          prev.setOpacity(0)
          setTimeout(() => { if (map.hasLayer(prev)) map.removeLayer(prev) }, 600)
        }
      })
      // Fallback: activate even if some tiles 404
      setTimeout(() => {
        if (layer.options.opacity === 0) {
          layer.setOpacity(CLOUD_OPACITY)
          cloudLayerRef.current = layer
          if (prev && map.hasLayer(prev)) map.removeLayer(prev)
        }
      }, 5000)
    }
    loadCloudLayer()
    const cloudRefreshId = setInterval(loadCloudLayer, 60 * 60 * 1000)
    // Signal that the map exists — triggers the cloud layer effect to run properly
    setMapReady(true)
    console.log('[WeatherMap] mapReady = true')

    return () => {
      clearInterval(cloudRefreshId)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      cloudLayerRef.current = null
      setMapReady(false)
    }
  }, [])

  // (cloud layer is managed inside the map init effect above — no extra effects needed)

  // Keep slider green-fill in sync via CSS custom property (avoids inline style)
  useEffect(() => {
    if (!sliderRef.current) return
    const pct = ((rawOffset - MIN_OFFSET) / (MAX_OFFSET - MIN_OFFSET)) * 100
    sliderRef.current.style.setProperty('--scrub-val', `${pct.toFixed(1)}%`)
  }, [rawOffset])

  function handleScrub(val: number) {
    setRawOffset(val) // drives stats bar; tile layer is always "now" (Maps 1.0 limitation)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setRawOffset(val), 120)
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


  // Pick the data source for the stats bar. The cloud tile on the map is always
  // "now" (OWM Maps 1.0 free tier has no date parameter). The stats bar and the
  // cloud-layer timeline DO update with the scrubber via the forecast API.
  const fcastSlot = rawOffset > 0 ? nearestSlot(forecasts, rawOffset) : null
  const isForecast = fcastSlot !== null

  // Cloud-layer breakdown (Open-Meteo): always pick the slot nearest to rawOffset
  const cloudSlot = nearestCloudSlot(cloudLayers, rawOffset)

  const stats: { label: string; value: string }[] = isForecast
    ? [
        { label: 'Temp', value: `${Math.round(fcastSlot!.temp)}°C` },
        { label: 'Feels Like', value: `${Math.round(fcastSlot!.feels_like)}°C` },
        { label: 'Rain Chance', value: `${Math.round(fcastSlot!.rain_chance * 100)}%` },
        { label: 'Rain (3h)', value: fcastSlot!.rain_3h > 0 ? `${fcastSlot!.rain_3h.toFixed(1)} mm` : 'None' },
        { label: 'Humidity', value: `${fcastSlot!.humidity}%` },
        { label: 'Wind', value: `${Math.round(fcastSlot!.wind_speed * 3.6)} km/h ${windDir(fcastSlot!.wind_deg)}` },
        { label: 'Pressure', value: `${fcastSlot!.pressure} hPa` },
        ...(fcastSlot!.visibility !== null
          ? [{ label: 'Visibility', value: `${(fcastSlot!.visibility / 1000).toFixed(1)} km` }]
          : []),
        { label: 'Sky', value: fcastSlot!.description },
      ]
    : weather
    ? [
        { label: 'Temp', value: `${Math.round(weather.temp)}°C` },
        { label: 'Feels Like', value: `${Math.round(weather.feels_like)}°C` },
        { label: 'Rain Chance', value: `${Math.round(weather.rain_chance * 100)}%` },
        { label: 'Rain (1h)', value: weather.rain_1h > 0 ? `${weather.rain_1h} mm` : 'None' },
        { label: 'Humidity', value: `${weather.humidity}%` },
        { label: 'Wind', value: `${Math.round(weather.wind_speed * 3.6)} km/h ${windDir(weather.wind_deg)}` },
        { label: 'Pressure', value: `${weather.pressure} hPa` },
        { label: 'Visibility', value: `${(weather.visibility / 1000).toFixed(1)} km` },
        { label: 'Sky', value: weather.description },
      ]
    : []

  return (
    <div className="flex flex-col h-full pt-16">
      {/* Map */}
      <div className="relative flex-1 min-h-0">
        {/* touch-none passes pinch gestures to Leaflet */}
        <div ref={mapRef} className="absolute inset-0 bg-[#111] touch-none" />
        {/* LIVE badge — reminds user the cloud overlay is always current (Maps 1.0 limitation) */}
        <div className="absolute top-2 right-2 z-[1000] flex items-center gap-1 bg-black/60 backdrop-blur-sm border border-white/15 rounded-full px-2 py-0.5 pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[10px] text-white/70 font-medium tracking-wide">LIVE CLOUDS</span>
        </div>
      </div>

      {/* Scrollable info strip — weather + air quality */}
      <div className="flex-shrink-0 bg-black/80 border-t border-white/10 px-2 py-2 overflow-x-auto">
        <div className="flex gap-2 w-max">
          {/* Source badge — shows whether values are current or forecast */}
          {(isForecast || weather) && (
            <div className={`flex flex-col items-center justify-center border rounded-xl px-3 py-2 min-w-[64px] ${
              isForecast
                ? 'text-sky-400 border-sky-500/40 bg-sky-500/10'
                : 'text-green-400 border-green-500/40 bg-green-500/10'
            }`}>
              <span className="font-bold text-[11px] leading-tight">{isForecast ? 'FORECAST' : 'CURRENT'}</span>
            </div>
          )}

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

          {/* Cloud altitude breakdown — uses Open-Meteo data */}
          {cloudSlot && (
            <>
              <div className="w-px self-stretch bg-white/15 mx-1" />
              {/* Three stacked bars in one compact card */}
              <div className="flex flex-col justify-center bg-white/5 border border-white/10 rounded-xl px-3 py-2 min-w-[100px] gap-1">
                <span className="text-white/40 text-[10px] leading-none mb-0.5">Cloud Layers</span>
                {[
                  { label: 'High', value: cloudSlot.cloud_high, color: 'bg-sky-300' },
                  { label: 'Mid',  value: cloudSlot.cloud_mid,  color: 'bg-blue-400' },
                  { label: 'Low',  value: cloudSlot.cloud_low,  color: 'bg-slate-300' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <span className="text-white/40 text-[9px] w-6 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${color} transition-all duration-300`}
                        style={{ width: `${value}%` }}
                      />
                    </div>
                    <span className="text-white/60 text-[9px] w-6 text-right shrink-0">{value}%</span>
                  </div>
                ))}
              </div>
            </>
          )}

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

        {/* Cloud layer timeline — 3 altitude bands plotted across the 42 h window */}
        {cloudLayers.length > 0 && (() => {
          // Only render slots that fall inside the scrubber's [-6h, +36h] window
          const visible = cloudLayers.filter(
            s => s.offset_min >= MIN_OFFSET && s.offset_min <= MAX_OFFSET
          )
          const range = MAX_OFFSET - MIN_OFFSET
          return (
            <div className="mb-2 flex flex-col gap-px">
              {[
                { key: 'high', label: 'High', color: '#7dd3fc', getter: (s: typeof visible[0]) => s.cloud_high },
                { key: 'mid',  label: 'Mid',  color: '#60a5fa', getter: (s: typeof visible[0]) => s.cloud_mid  },
                { key: 'low',  label: 'Low',  color: '#cbd5e1', getter: (s: typeof visible[0]) => s.cloud_low  },
              ].map(band => (
                <div key={band.key} className="flex items-center gap-1.5 h-4">
                  <span className="text-[9px] text-white/30 w-6 shrink-0 text-right">{band.label}</span>
                  <div className="relative flex-1 h-3 rounded-sm overflow-hidden bg-white/5">
                    {visible.map((s, i) => {
                      const pct = ((s.offset_min - MIN_OFFSET) / range) * 100
                      const nextOffset = visible[i + 1]?.offset_min ?? MAX_OFFSET
                      const width = ((nextOffset - s.offset_min) / range) * 100
                      const opacity = band.getter(s) / 100
                      return (
                        <div
                          key={s.dt}
                          className="absolute top-0 h-full"
                          style={{
                            left: `${pct.toFixed(2)}%`,
                            width: `${width.toFixed(2)}%`,
                            backgroundColor: band.color,
                            opacity: Math.max(0.05, opacity),
                          }}
                        />
                      )
                    })}
                    {/* "Now" tick */}
                    <div
                      className="absolute top-0 h-full w-px bg-white/50"
                      style={{ left: `${((-MIN_OFFSET) / range * 100).toFixed(2)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
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
