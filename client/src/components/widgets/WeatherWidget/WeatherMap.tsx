import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useWeather } from '../../../hooks/useWeather'
import { useAirQuality } from '../../../hooks/useAirQuality'
import { useTimeline, nearestTimelineSlot, wmoDescription } from '../../../hooks/useTimeline'
import { useRainviewer, nearestRvFrame } from '../../../hooks/useRainviewer'

declare const L: any

// Scrub window: 2 days back → 5 days ahead. Both halves are real data, served as
// one continuous hourly series by /api/weather/timeline (Open-Meteo). OpenWeather
// can't do the past at all — history sits behind a paid One Call subscription.
const MIN_OFFSET = -2880   // -48 h
const MAX_OFFSET = 7200    // +120 h

// Map imagery is a different story from map *data*. Nothing gives us free cloud
// or radar imagery across a whole week: RainViewer covers roughly the last 2 h
// plus a 30-min nowcast, and the OWM cloud tile is always a live snapshot (Maps
// 1.0 has no date parameter). Outside that window we show no overlay and say so,
// rather than painting current clouds over a timestamp they don't belong to.
const IMAGERY_NOW_TOLERANCE_MIN = 30

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
  // The window spans days now, so hours alone stop being readable past a day.
  if (Math.abs(h) >= 24) {
    const d = Math.round(h / 24)
    return d > 0 ? `+${d}d` : `${d}d`
  }
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

// ── Simple vs detailed ───────────────────────────────────────────────────────
// At arm's length on a kiosk, the full strip (9 stats + cloud bands + 6
// pollutants) plus the timeline is a wall of numbers. Simple mode keeps only
// what you'd actually glance at — how warm it is, how warm it feels, and
// whether it'll rain — and hides the rest behind one tap. The choice sticks.
const SIMPLE_STATS = ['Temp', 'Feels Like', 'Rain Chance'] as const
const SIMPLE_KEY = 'ts_weather_simple'

function loadSimple(): boolean {
  try {
    const raw = localStorage.getItem(SIMPLE_KEY)
    return raw === null ? true : raw === '1'   // default: simple
  } catch { return true }
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
  const { timeline } = useTimeline()
  const { frames: rvFrames, nowcast: rvNowcast } = useRainviewer()
  // Combine past + nowcast frames for frame lookup
  const allRvFrames = useMemo(() => [...rvFrames, ...rvNowcast], [rvFrames, rvNowcast])
  // rawOffset: instant — drives slider + stats bar + timeline
  // committedOffset: debounced — drives tile layer switching (avoids mid-scrub loads)
  const [rawOffset, setRawOffset] = useState(0)
  const [committedOffset, setCommittedOffset] = useState(0)
  const [mapReady, setMapReady] = useState(false)
  const [simple, setSimple] = useState(loadSimple)

  function toggleSimple() {
    setSimple(prev => {
      const next = !prev
      try { localStorage.setItem(SIMPLE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      // Leaving detail mode with the scrubber parked in the past would strand the
      // strip on a time the user can no longer see or change — snap back to now.
      if (next && rawOffset !== 0) handleScrub(0)
      return next
    })
  }

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
  //  • A RainViewer frame exists for this time (≈ last 2h, or the 30-min nowcast)
  //      → real radar imagery for that exact timestamp
  //  • Offset is essentially "now"  → OWM live cloud tile (a true current snapshot)
  //  • Anything else                → NO overlay. The old code fell back to the OWM
  //    tile here, which paints *current* clouds while the UI claims to be showing
  //    yesterday or Thursday. Showing nothing is the honest answer.
  // RainViewer frames are cached by path (immutable hashes); OWM is always fresh.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || typeof L === 'undefined') return

    const nowSec    = Math.floor(Date.now() / 1000)
    const targetSec = nowSec + committedOffset * 60

    const rvFrame = nearestRvFrame(allRvFrames, targetSec)
    const isNow   = Math.abs(committedOffset) <= IMAGERY_NOW_TOLERANCE_MIN
    const targetKey = rvFrame ? rvFrame.path : (isNow ? 'owm' : 'none')

    if (targetKey === activeKeyRef.current) return
    activeKeyRef.current = targetKey

    const prev = cloudLayerRef.current

    const fadeOutPrev = () => {
      if (!prev) return
      prev.setOpacity(0)
      setTimeout(() => {
        if (cloudLayerRef.current !== prev && map.hasLayer(prev)) map.removeLayer(prev)
      }, 600)
    }

    // No imagery for this time — drop the overlay entirely, leaving the satellite base.
    if (targetKey === 'none') {
      fadeOutPrev()
      cloudLayerRef.current = null
      return
    }

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
      if (prev && prev !== next) fadeOutPrev()
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


  // Every value in the strip comes from the one timeline series — including at
  // "now". Mixing OWM's current reading with Open-Meteo's series put a visible
  // seam at offset 0 (the two providers disagree, sometimes wildly: OWM has been
  // seen reporting 1% humidity against Open-Meteo's 95%). One source, one story.
  const slot = nearestTimelineSlot(timeline, rawOffset)
  const era: 'past' | 'now' | 'future' =
    rawOffset < -IMAGERY_NOW_TOLERANCE_MIN ? 'past' :
    rawOffset >  IMAGERY_NOW_TOLERANCE_MIN ? 'future' : 'now'

  const cloudSlot = slot   // the timeline carries the low/mid/high breakdown too

  // Fallback while the timeline is still loading (or if Open-Meteo is down): show
  // OWM's current reading rather than an empty strip. Only valid at "now" — there
  // is no OWM data for a scrubbed time, so the strip stays empty there and the
  // badge already says the map has nothing to show.
  const owmStats: { label: string; value: string }[] = weather
    ? [
        { label: 'Temp', value: `${Math.round(weather.temp)}°C` },
        { label: 'Feels Like', value: `${Math.round(weather.feels_like)}°C` },
        { label: 'Rain Chance', value: `${Math.round(weather.rain_chance * 100)}%` },
        { label: 'Rain (1h)', value: weather.rain_1h > 0 ? `${weather.rain_1h} mm` : 'None' },
        { label: 'Humidity', value: `${weather.humidity}%` },
        { label: 'Wind', value: `${Math.round(weather.wind_speed * 3.6)} km/h ${windDir(weather.wind_deg)}` },
        { label: 'Pressure', value: `${weather.pressure} hPa` },
        { label: 'Cloud', value: `${weather.clouds}%` },
        { label: 'Sky', value: weather.description },
      ]
    : []

  const allStats: { label: string; value: string }[] = slot
    ? [
        { label: 'Temp', value: `${Math.round(slot.temp)}°C` },
        { label: 'Feels Like', value: `${Math.round(slot.feels_like)}°C` },
        { label: era === 'past' ? 'Rain Chance (fc)' : 'Rain Chance', value: `${Math.round(slot.rain_chance * 100)}%` },
        { label: 'Rain (1h)', value: slot.precip > 0 ? `${slot.precip.toFixed(1)} mm` : 'None' },
        { label: 'Humidity', value: `${slot.humidity}%` },
        { label: 'Wind', value: `${Math.round(slot.wind_speed * 3.6)} km/h ${windDir(slot.wind_deg)}` },
        { label: 'Pressure', value: `${slot.pressure} hPa` },
        { label: 'Cloud', value: `${slot.clouds}%` },
        { label: 'Sky', value: wmoDescription(slot.weather_code) },
      ]
    : era === 'now' ? owmStats : []

  // In simple mode the rain-chance label keeps its plain name — the "(fc)"
  // qualifier is a detail-mode nicety, not something to explain on a glance card.
  const stats = simple
    ? SIMPLE_STATS.flatMap(name => {
        const s = allStats.find(x => x.label.startsWith(name))
        return s ? [{ label: name, value: s.value }] : []
      })
    : allStats

  const hasData = stats.length > 0

  return (
    <div className="flex flex-col h-full pt-16">
      {/* Map */}
      <div className="relative flex-1 min-h-0">
        {/* touch-none passes pinch gestures to Leaflet */}
        <div ref={mapRef} className="absolute inset-0 bg-[#111] touch-none" />
        {/* Simple ⇄ Details. Sits on the map (the strip below scrolls
            horizontally, so a control in it would scroll out of reach). */}
        <button
          type="button"
          onClick={toggleSimple}
          aria-pressed={!simple}
          className="absolute bottom-3 right-2 z-[1000] h-11 px-4 rounded-full bg-black/70 backdrop-blur-sm border border-white/20 text-white/80 text-xs font-semibold active:scale-95 flex items-center gap-1.5"
        >
          {simple ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {simple ? 'Details' : 'Simple'}
        </button>

        {/* Imagery badge. States the truth about what's painted on the map:
            real radar for that timestamp, a live cloud snapshot at "now", or
            nothing at all — because no free source has cloud imagery for last
            Tuesday or next Friday. The stats below still have real data. */}
        {(() => {
          const nowSec = Math.floor(Date.now() / 1000)
          const rvF    = nearestRvFrame(allRvFrames, nowSec + rawOffset * 60)
          const isNow  = Math.abs(rawOffset) <= IMAGERY_NOW_TOLERANCE_MIN

          const { label, dot } = rvF
            ? {
                label: `RADAR · ${new Date(rvF.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`,
                dot:   'bg-amber-400',
              }
            : isNow
              ? { label: 'LIVE CLOUDS', dot: 'bg-green-400 animate-pulse' }
              : { label: 'NO IMAGERY · DATA ONLY', dot: 'bg-white/30' }

          return (
            <div className="absolute top-2 right-2 z-[1000] flex items-center gap-1 bg-black/60 backdrop-blur-sm border border-white/15 rounded-full px-2 py-0.5 pointer-events-none">
              <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
              <span className="text-[10px] text-white/70 font-medium tracking-wide">{label}</span>
            </div>
          )
        })()}
      </div>

      {/* Scrollable info strip — weather + air quality */}
      <div className="flex-shrink-0 bg-black/80 border-t border-white/10 px-2 py-2 overflow-x-auto">
        <div className="flex gap-2 w-max">
          {/* Source badge — whether these values are observed past, now, or forecast */}
          {hasData && (
            <div className={`flex flex-col items-center justify-center border rounded-xl px-3 py-2 min-w-[64px] ${
              era === 'future' ? 'text-sky-400 border-sky-500/40 bg-sky-500/10'   :
              era === 'past'   ? 'text-amber-400 border-amber-500/40 bg-amber-500/10' :
                                 'text-green-400 border-green-500/40 bg-green-500/10'
            }`}>
              <span className="font-bold text-[11px] leading-tight">
                {era === 'future' ? 'FORECAST' : era === 'past' ? 'PAST' : 'CURRENT'}
              </span>
              <span className="text-[9px] opacity-70 leading-tight mt-0.5">{offsetLabel(rawOffset)}</span>
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
          {!simple && cloudSlot && (
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
          {!simple && aqi && (
            <div className="w-px self-stretch bg-white/15 mx-1" />
          )}

          {/* AQI index card */}
          {!simple && aqi && (
            <div className={`flex flex-col items-center border rounded-xl px-4 py-2 min-w-[88px] ${AQI_COLORS[aqi.aqi] ?? 'text-white/60 border-white/10 bg-white/5'}`}>
              <span className="text-[11px] leading-tight opacity-75">Air Quality</span>
              <span className="font-bold text-sm mt-0.5">{aqi.aqi_label}</span>
              <span className="text-[10px] opacity-60 mt-0.5">AQI {aqi.aqi}/5</span>
            </div>
          )}

          {/* Individual pollutant cards */}
          {!simple && aqi && ([
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

      {/* Time scrubber — 2 days back → 5 days ahead, all of it real data.
          Detail mode only: in simple mode the widget is a glance, not a tool. */}
      <div className={`flex-shrink-0 bg-black/80 border-t border-white/10 px-3 pt-2 pb-3 ${simple ? 'hidden' : ''}`}>

        {/* Temperature trace + rain-chance shading across the window. The "now"
            line splits observed past (left) from forecast (right). */}
        {timeline.length > 0 && (() => {
          const visible = timeline.filter(s => s.offset_min >= MIN_OFFSET && s.offset_min <= MAX_OFFSET)
          if (visible.length < 2) return null

          const range = MAX_OFFSET - MIN_OFFSET
          const temps = visible.map(s => s.temp)
          const min   = Math.min(...temps)
          const max   = Math.max(...temps)
          const span  = Math.max(1, max - min)

          const x = (s: typeof visible[0]) => ((s.offset_min - MIN_OFFSET) / range) * 100
          const y = (s: typeof visible[0]) => 100 - ((s.temp - min) / span) * 100
          const line = visible.map(s => `${x(s).toFixed(2)},${y(s).toFixed(2)}`).join(' ')
          const nowPct = ((-MIN_OFFSET) / range) * 100

          return (
            <div className="relative h-14 mb-1.5">
              {/* Rain probability as vertical shading behind the temp trace */}
              <div className="absolute inset-0 flex">
                {visible.map((s, i) => {
                  const next  = visible[i + 1]?.offset_min ?? MAX_OFFSET
                  const width = ((next - s.offset_min) / range) * 100
                  return (
                    <div
                      key={s.dt}
                      className="h-full bg-sky-400"
                      style={{
                        position: 'absolute',
                        left: `${x(s).toFixed(2)}%`,
                        width: `${width.toFixed(2)}%`,
                        opacity: s.rain_chance * 0.5,
                      }}
                    />
                  )
                })}
              </div>

              <svg className="absolute inset-0 w-full h-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline
                  points={line}
                  fill="none"
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>

              {/* Past is dimmed so the eye reads "this already happened" */}
              <div
                className="absolute inset-y-0 left-0 bg-black/35 pointer-events-none"
                style={{ width: `${nowPct.toFixed(2)}%` }}
              />
              {/* NOW divider */}
              <div className="absolute inset-y-0 w-px bg-green-400/80" style={{ left: `${nowPct.toFixed(2)}%` }} />
              {/* Scrub position */}
              <div
                className="absolute inset-y-0 w-px bg-white"
                style={{ left: `${(((rawOffset - MIN_OFFSET) / range) * 100).toFixed(2)}%` }}
              />

              <span className="absolute left-0 top-0 text-[9px] text-white/40 leading-none">{Math.round(max)}°</span>
              <span className="absolute left-0 bottom-0 text-[9px] text-white/40 leading-none">{Math.round(min)}°</span>
            </div>
          )
        })()}

        <div className="flex items-center justify-between mb-1.5">
          <span className="text-white/35 text-[11px]">−2d</span>
          <div className="flex items-baseline gap-2">
            <span className={`font-semibold text-sm ${
              era === 'now' ? 'text-green-400' : era === 'past' ? 'text-amber-400' : 'text-sky-400'
            }`}>
              {offsetLabel(rawOffset)}
            </span>
            <span className="text-white/45 text-[11px]">{absTime(rawOffset)}</span>
          </div>
          <span className="text-white/35 text-[11px]">+5d</span>
        </div>

        <input
          ref={sliderRef}
          type="range"
          min={MIN_OFFSET}
          max={MAX_OFFSET}
          step={60}
          value={rawOffset}
          onChange={e => handleScrub(Number(e.target.value))}
          aria-label="Weather time scrubber — past to forecast"
          className="time-scrubber w-full"
        />

        <div className="flex justify-center mt-1">
          <button
            type="button"
            onClick={() => handleScrub(0)}
            disabled={rawOffset === 0}
            className="text-[11px] px-4 py-1.5 rounded-full bg-white/8 text-white/70 active:bg-white/15 disabled:opacity-30"
          >
            Back to now
          </button>
        </div>
      </div>
    </div>
  )
}
