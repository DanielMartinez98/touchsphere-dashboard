import { useEffect, useMemo, useRef, useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'
import { useAirQuality } from '../../../hooks/useAirQuality'
import { useForecast, nearestSlot } from '../../../hooks/useForecast'
import { useCloudLayers, nearestCloudSlot } from '../../../hooks/useCloudLayers'
import { useRainviewer, nearestRvFrame } from '../../../hooks/useRainviewer'

declare const L: any

// 42-hour window: -6h (past) → +36h (future)
const MIN_OFFSET = -360
const MAX_OFFSET = 2160

// Apple Weather aesthetic: satellite base + soft white cloud overlay.
// OWM tiles are RGBA — cloud pixels are white/grey, clear sky is transparent.
// contrast(1.6) sharpens thin cirrus edges; drop-shadow gives the soft halo Apple uses.
const CLOUD_FILTER = 'contrast(1.6) brightness(1.3) drop-shadow(0 0 6px rgba(255,255,255,0.5))'

// RainViewer radar: color scheme 2 (Universal Blue), smooth+snow options
// max native tile zoom for RainViewer is 7; Leaflet scales up for higher map zooms
const RV_COLOR = 2
const RV_OPTIONS = '1_1'
const RV_MAX_NATIVE_ZOOM = 7

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
  const cloudLayerRef = useRef<any>(null)    // currently visible layer on the map
  const rvLayerCacheRef = useRef<Map<string, any>>(new Map())  // cached RainViewer layers keyed by path
  const activeKeyRef = useRef<string>('')       // path of visible layer ('owm' or RainViewer path)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  const { weather } = useWeather()
  const { aqi } = useAirQuality()
  const { forecasts } = useForecast()
  const { cloudLayers } = useCloudLayers()
  const { frames: rvFrames, nowcast: rvNowcast } = useRainviewer()
  // Combine past + nowcast frames for frame lookup
  const allRvFrames = useMemo(() => [...rvFrames, ...rvNowcast], [rvFrames, rvNowcast])
  // rawOffset: instant — drives slider + stats bar + timeline
  // committedOffset: debounced — drives tile layer switching (avoids mid-scrub loads)
  const [rawOffset, setRawOffset] = useState(0)
  const [committedOffset, setCommittedOffset] = useState(0)
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

    // Inject CSS for OWM cloud tiles (filter) and RainViewer tiles (no filter)
    // both share the crossfade transition class
    if (!document.getElementById('owm-cloud-style')) {
      const s = document.createElement('style')
      s.id = 'owm-cloud-style'
      s.textContent = [
        `.owm-clouds img { filter: ${CLOUD_FILTER} !important; }`,
        `.owm-clouds, .rv-radar { transition: opacity 0.5s ease-in-out; }`,
      ].join('\n')
      document.head.appendChild(s)
    }
    setMapReady(true)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      cloudLayerRef.current = null
      rvLayerCacheRef.current.clear()
      activeKeyRef.current = ''
      setMapReady(false)
    }
  }, [])

  // Layer switching: loads the correct tile layer whenever committedOffset changes.
  //  • Past ≤ 0 min, within last 2h  → real RainViewer radar frame for that exact timestamp
  //  • Future or older than 2h       → OWM live cloud tile (always current snapshot)
  // RainViewer frames are cached by path (immutable hashes); OWM is always fresh.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || typeof L === 'undefined') return

    const nowSec   = Math.floor(Date.now() / 1000)
    const targetSec = nowSec + committedOffset * 60

    // Pick a RainViewer frame only for past offsets
    const rvFrame  = committedOffset <= 0 ? nearestRvFrame(allRvFrames, targetSec) : null
    const targetKey = rvFrame ? rvFrame.path : 'owm'

    if (targetKey === activeKeyRef.current) return
    activeKeyRef.current = targetKey

    const prev = cloudLayerRef.current

    // Get or create the target Leaflet layer
    let next: any
    if (rvFrame && rvLayerCacheRef.current.has(rvFrame.path)) {
      next = rvLayerCacheRef.current.get(rvFrame.path)
    } else {
      const url = rvFrame
        ? `${rvFrame.host}${rvFrame.path}/256/{z}/{x}/{y}/${RV_COLOR}/${RV_OPTIONS}.png`
        : '/api/tiles/clouds/{z}/{x}/{y}?offset=0'
      next = L.tileLayer(url, {
        opacity: 0,
        className: rvFrame ? 'rv-radar' : 'owm-clouds',
        attribution: rvFrame ? '© RainViewer' : '© OpenWeatherMap',
        updateWhenZooming: false,
        keepBuffer: 4,
        ...(rvFrame ? { maxNativeZoom: RV_MAX_NATIVE_ZOOM } : {}),
      })
      if (rvFrame) rvLayerCacheRef.current.set(rvFrame.path, next)
    }

    if (!map.hasLayer(next)) next.addTo(map)
    next.setOpacity(0)

    let committed = false
    function activate() {
      if (committed) return
      committed = true
      next.setOpacity(CLOUD_OPACITY)
      cloudLayerRef.current = next
      if (prev && prev !== next) {
        prev.setOpacity(0)
        setTimeout(() => {
          if (cloudLayerRef.current !== prev && map.hasLayer(prev)) map.removeLayer(prev)
        }, 600)
      }
    }
    const fallback = setTimeout(activate, 4000)
    next.once('load', () => { clearTimeout(fallback); activate() })
    return () => clearTimeout(fallback)
  }, [committedOffset, mapReady, allRvFrames])

  // Keep slider green-fill in sync via CSS custom property (avoids inline style)
  useEffect(() => {
    if (!sliderRef.current) return
    const pct = ((rawOffset - MIN_OFFSET) / (MAX_OFFSET - MIN_OFFSET)) * 100
    sliderRef.current.style.setProperty('--scrub-val', `${pct.toFixed(1)}%`)
  }, [rawOffset])

  function handleScrub(val: number) {
    setRawOffset(val)  // instant: slider, stats bar, timeline, badge
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setCommittedOffset(val), 250)  // debounced tile swap
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
        {/* Layer source badge — RADAR (RainViewer, past 2h) or LIVE CLOUDS (OWM) */}
        {(() => {
          const nowSec  = Math.floor(Date.now() / 1000)
          const rvF     = rawOffset <= 0 ? nearestRvFrame(allRvFrames, nowSec + rawOffset * 60) : null
          const label   = rvF
            ? `RADAR · ${new Date(rvF.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : 'LIVE CLOUDS'
          return (
            <div className="absolute top-2 right-2 z-[1000] flex items-center gap-1 bg-black/60 backdrop-blur-sm border border-white/15 rounded-full px-2 py-0.5 pointer-events-none">
              <span className={`w-1.5 h-1.5 rounded-full ${rvF ? 'bg-amber-400' : 'bg-green-400 animate-pulse'}`} />
              <span className="text-[10px] text-white/70 font-medium tracking-wide">{label}</span>
            </div>
          )
        })()}
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

      {/* Time scrubber — hidden for now */}
      <div className="hidden">

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
