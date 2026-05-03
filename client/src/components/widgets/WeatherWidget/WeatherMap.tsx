import { useEffect, useRef, useState } from 'react'
import { useWeather } from '../../../hooks/useWeather'
import { useAirQuality } from '../../../hooks/useAirQuality'
import { useForecast, nearestSlot } from '../../../hooks/useForecast'
import type { ForecastSlot } from '../../../hooks/useForecast'

declare const L: any

// 42-hour window: -6h (past) → +36h (future)
const MIN_OFFSET = -360
const MAX_OFFSET = 2160

// contrast(2.5): amplifies faint cloud pixels without destroying gradients
// brightness(1.25): modest lift so thin cirrus registers without blowing out dense clouds
// saturate(2): preserves the blue-gray OWM cloud hue (brightness alone turns them white)
// drop-shadow: adds a subtle cyan halo for legibility against bright map tiles
const CLOUD_FILTER =
  'contrast(2.5) brightness(1.25) saturate(2) drop-shadow(0 0 3px rgba(0,180,220,0.6))'

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
// One slot per hour across the full 42-hour window (-6h → +36h) = 43 entries
const LAYER_CACHE_MAX = 50
// All hourly offsets in the timeline, built once at module level
const HOUR_OFFSETS: readonly number[] = Array.from(
  { length: (MAX_OFFSET - MIN_OFFSET) / 60 + 1 },
  (_, i) => MIN_OFFSET + i * 60
)

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
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  // Client-side layer cache: keeps Leaflet layer objects for visited offsets so
  // scrubbing back is instant (zero network, zero re-render flash)
  const layerCacheRef = useRef<Map<number, any>>(new Map())
  // Tracks the in-flight layer currently loading so we can cancel it if the user
  // scrubs again before it finishes
  const pendingLayerRef = useRef<any>(null)
  const { weather } = useWeather()
  const { aqi } = useAirQuality()
  const { forecasts } = useForecast()
  // rawOffset drives the slider visuals instantly; committedOffset drives tile swaps (debounced)
  const [rawOffset, setRawOffset] = useState(0)
  const [committedOffset, setCommittedOffset] = useState(0)
  // mapReady bridges the gap between the map-init effect (which writes to a ref)
  // and the cloud-layer effect (which needs the map to exist). Setting state here
  // causes a React re-render so the cloud effect re-fires with the map available.
  const [mapReady, setMapReady] = useState(false)
  // prefetchTick increments every hour — triggers a full cache clear + re-prefetch
  const [prefetchTick, setPrefetchTick] = useState(0)
  // Ref mirror of committedOffset so the async prefetch loop sees the latest value
  // without needing to be included in the effect's dependency array
  const committedOffsetRef = useRef(0)

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
    // Signal that the map exists — triggers the cloud layer effect to run properly
    setMapReady(true)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      cloudLayerRef.current = null
      pendingLayerRef.current = null
      layerCacheRef.current.clear()
      setMapReady(false)
    }
  }, [])

  // Sync committedOffsetRef so the prefetch loop can read the current offset
  // without a stale closure
  useEffect(() => {
    committedOffsetRef.current = committedOffset
  }, [committedOffset])

  // Hourly refresh: clear all non-active cached layers from the map and from cache,
  // then increment prefetchTick to trigger a full re-prefetch of all 43 offsets.
  useEffect(() => {
    const id = setInterval(() => {
      const map = mapInstanceRef.current
      if (map) {
        const active = cloudLayerRef.current
        for (const [, layer] of layerCacheRef.current) {
          if (layer !== active && map.hasLayer(layer)) map.removeLayer(layer)
        }
        // Clear entire cache (active layer will crossfade to a fresh one via cloud effect)
        layerCacheRef.current.clear()
      }
      setPrefetchTick(t => t + 1)
    }, 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // Load-gated crossfade with single-layer-on-map guarantee.
  //
  // KEY INVARIANT: only the active cloud layer (cloudLayerRef) is ever on the map.
  // All other cached layers are removed from the map after the crossfade completes
  // so that zoom events only trigger tile requests for one layer, not up to 8.
  // Server-side tile cache means re-adding a cached layer is fast (<100 ms).
  //
  // updateWhenZooming:false keeps existing tiles visible (scaled) during the zoom
  // animation instead of immediately discarding them — eliminates the flash.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || typeof L === 'undefined') return

    const offset = committedOffset
    const cache = layerCacheRef.current

    // Cancel any in-flight layer (user scrubbed again before it finished)
    if (pendingLayerRef.current) {
      map.removeLayer(pendingLayerRef.current)
      pendingLayerRef.current = null
    }
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current)
      loadTimeoutRef.current = null
    }

    const prev = cloudLayerRef.current

    // Shared commit: make `next` the active layer and remove `prev` from the map
    // after the CSS crossfade has finished (0.4 s covers the 0.35 s transition).
    function activateLayer(next: any) {
      if (next === prev) return
      next.setOpacity(CLOUD_OPACITY)
      cloudLayerRef.current = next
      if (prev) {
        prev.setOpacity(0)
        // Remove prev from the map after the fade so it stops requesting tiles
        // on zoom events. cloudLayerRef guard prevents removing a layer that was
        // just re-activated before the timeout fires.
        setTimeout(() => {
          if (cloudLayerRef.current !== prev && map.hasLayer(prev)) {
            map.removeLayer(prev)
          }
        }, 400)
      }
    }

    // Helper: wait for a layer that is already on the map to finish loading
    // (or fall through after a timeout), then activate it.
    function waitAndActivate(next: any, timeoutMs: number) {
      pendingLayerRef.current = next
      function commit() {
        if (pendingLayerRef.current !== next) return
        pendingLayerRef.current = null
        activateLayer(next)
      }
      loadTimeoutRef.current = setTimeout(commit, timeoutMs)
      next.once('load', () => {
        if (loadTimeoutRef.current) {
          clearTimeout(loadTimeoutRef.current)
          loadTimeoutRef.current = null
        }
        commit()
      })
    }

    // Cache hit — re-add layer to map if it was removed, then crossfade.
    // Server-side tile cache means tiles arrive in <100 ms typically.
    if (cache.has(offset)) {
      const next = cache.get(offset)
      if (next === prev) return
      next.setOpacity(0)
      if (!map.hasLayer(next)) map.addLayer(next)
      waitAndActivate(next, 2000)
      return
    }

    // Cache miss — create new layer with zoom-stable options
    const newLayer = L.tileLayer(buildCloudUrl(offset), {
      opacity: 0,
      className: 'owm-clouds',
      attribution: '© OpenWeatherMap',
      // Keep scaled tiles visible during zoom animation — no flash
      updateWhenZooming: false,
      // Pre-load an extra ring of tiles around the viewport
      keepBuffer: 4,
    }).addTo(map)

    // Evict oldest from cache when at limit (also removes it from map if still there)
    if (cache.size >= LAYER_CACHE_MAX) {
      const firstEntry = cache.entries().next().value as [number, any] | undefined
      if (firstEntry) {
        const [oldOffset, oldLayer] = firstEntry
        if (map.hasLayer(oldLayer)) map.removeLayer(oldLayer)
        cache.delete(oldOffset)
      }
    }
    cache.set(offset, newLayer)

    waitAndActivate(newLayer, 3000)
  }, [committedOffset, mapReady, prefetchTick])

  // Background prefetch: load all 43 hourly offsets sequentially so every hour
  // is ready in the browser tile cache before the user scrubs to it.
  // Runs once on map-ready, then again every hour (prefetchTick).
  // Each layer is added at opacity 0, waits for the Leaflet `load` event
  // (which fires once all tiles in the current viewport have loaded into the
  // browser's HTTP cache), then is removed from the map but kept in layerCacheRef
  // so the cloud effect can re-add it instantly.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || typeof L === 'undefined') return

    let cancelled = false

    ;(async () => {
      for (const offset of HOUR_OFFSETS) {
        if (cancelled) break
        // Skip the currently active offset — the cloud effect manages it
        if (offset === committedOffsetRef.current) continue
        // Skip offsets already cached from this prefetch cycle
        if (layerCacheRef.current.has(offset)) continue

        await new Promise<void>(resolve => {
          const layer = L.tileLayer(buildCloudUrl(offset), {
            opacity: 0,
            className: 'owm-clouds',
            attribution: '© OpenWeatherMap',
            updateWhenZooming: false,
            keepBuffer: 2,
          }).addTo(map)

          function done() {
            if (map.hasLayer(layer)) map.removeLayer(layer)
            if (!cancelled) {
              // Only cache if not already set by the cloud effect
              if (!layerCacheRef.current.has(offset)) {
                if (layerCacheRef.current.size >= LAYER_CACHE_MAX) {
                  // Evict oldest non-active entry
                  for (const [k, v] of layerCacheRef.current) {
                    if (v !== cloudLayerRef.current) {
                      if (map.hasLayer(v)) map.removeLayer(v)
                      layerCacheRef.current.delete(k)
                      break
                    }
                  }
                }
                layerCacheRef.current.set(offset, layer)
              }
            }
            resolve()
          }

          const timer = setTimeout(done, 5000)
          layer.once('load', () => { clearTimeout(timer); done() })
        })

        // 150 ms gap between layers — avoids saturating the connection
        if (!cancelled) await new Promise<void>(r => setTimeout(r, 150))
      }
    })()

    return () => { cancelled = true }
  }, [mapReady, prefetchTick])

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


  // Pick the data source for the stats bar:
  //   rawOffset > 0 and we have forecast slots → use nearest forecast slot (real OWM data)
  //   otherwise → use current weather
  const fcastSlot = rawOffset > 0 ? nearestSlot(forecasts, rawOffset) : null
  const isForecast = fcastSlot !== null

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
        { label: 'Cloud Cover', value: `${fcastSlot!.clouds}%` },
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
