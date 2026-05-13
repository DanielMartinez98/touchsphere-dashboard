// Dashboard tools exposed to the chat LLM.
//
// These let the model read and (in some cases) write the app's own state —
// media playlist, calendar, weather, device metrics, world time — so the
// assistant can answer questions like "what time is it in Tokyo?" and
// perform actions like "add Hades to my game list".
//
// Each tool is a thin wrapper around either the on-disk state files or the
// existing /api/* routes (called over loopback) so logic stays in one place
// and we don't drift away from what the widgets already display.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { addMemory, loadMemories, removeMemories } from '../memory'

// ── State file helpers (mirror state.ts) ─────────────────────────────────────
function stateDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}
function statePath(file: string): string {
  return path.join(stateDir(), file)
}
function readJSON<T>(file: string, fallback: T): T {
  try {
    const p = statePath(file)
    if (!fs.existsSync(p)) return fallback
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}
function writeJSON(file: string, data: unknown): void {
  fs.writeFileSync(statePath(file), JSON.stringify(data, null, 2), 'utf8')
}

// ── Loopback helper ──────────────────────────────────────────────────────────
const PORT = process.env['PORT'] ?? '3001'
const LOOPBACK = `http://127.0.0.1:${PORT}`

async function localGet<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${LOOPBACK}${url}`, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Media playlist ───────────────────────────────────────────────────────────
type MediaType   = 'game' | 'show' | 'movie'
type MediaStatus = 'not_started' | 'in_progress' | 'done' | 'dropped'

const STATUSES: readonly MediaStatus[] = ['not_started', 'in_progress', 'done', 'dropped']
const MOVIE_STATUSES: readonly MediaStatus[] = ['not_started', 'done']
const STATUS_LABEL: Record<MediaStatus, string> = {
  not_started: 'not started',
  in_progress: 'in progress',
  done:        'done',
  dropped:     'dropped',
}

interface MediaItem {
  id: string
  title: string
  type: MediaType
  done: boolean
  status: MediaStatus
  starred?: boolean
}

// Mirror the server's normalizer so legacy items (no `status`) read sanely
// even before they're rewritten.
function normalize(raw: Partial<MediaItem> & { type: MediaType }): MediaItem {
  const done = raw.done === true
  let status = raw.status
  if (!status || !STATUSES.includes(status)) status = done ? 'done' : 'not_started'
  return {
    id:    raw.id    ?? crypto.randomUUID(),
    title: raw.title ?? '',
    type:  raw.type,
    done:  status === 'done',
    status,
    ...(raw.starred ? { starred: true } : {}),
  }
}

function readMedia(): MediaItem[] {
  const raw = readJSON<Array<Partial<MediaItem> & { type: MediaType }>>('media.json', [])
  return raw.map(normalize)
}
function writeMedia(items: MediaItem[]): void {
  writeJSON('media.json', items)
}

function statusGlyph(s: MediaStatus): string {
  return s === 'done' ? 'x' : s === 'in_progress' ? '~' : s === 'dropped' ? '-' : ' '
}

function listMedia(): string {
  const items = readMedia()
  if (items.length === 0) return 'The playlist is empty.'
  const fmt = (i: MediaItem) =>
    `- [${statusGlyph(i.status)}] ${i.title} (${i.type}, ${STATUS_LABEL[i.status]})${i.starred ? ' ★' : ''}`
  const groups: Record<MediaStatus, MediaItem[]> = {
    in_progress: [], not_started: [], done: [], dropped: [],
  }
  for (const i of items) groups[i.status].push(i)
  const parts: string[] = []
  if (groups.in_progress.length) parts.push(`In progress (${groups.in_progress.length}):\n` + groups.in_progress.map(fmt).join('\n'))
  if (groups.not_started.length) parts.push(`To play/watch (${groups.not_started.length}):\n` + groups.not_started.map(fmt).join('\n'))
  if (groups.done.length)        parts.push(`Finished (${groups.done.length}):\n`           + groups.done.map(fmt).join('\n'))
  if (groups.dropped.length)     parts.push(`Dropped (${groups.dropped.length}):\n`         + groups.dropped.map(fmt).join('\n'))
  return parts.join('\n\n')
}

function addMedia(title: string, type: string): string {
  const t = title.trim()
  if (!t) return 'Error: title is required.'
  if (type !== 'game' && type !== 'show' && type !== 'movie') {
    return `Error: type must be "game", "show", or "movie" (got "${type}").`
  }
  const items = readMedia()
  // Avoid duplicates (case-insensitive title match within same type).
  const dupe = items.find(i =>
    i.type === type && i.title.toLowerCase() === t.toLowerCase(),
  )
  if (dupe) return `Already on the list: "${dupe.title}" (${dupe.type}).`
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title: t,
    type: type as MediaType,
    done: false,
    status: 'not_started',
  }
  items.push(item)
  writeMedia(items)
  console.log(`[chat:tool] add_media_item → "${item.title}" (${item.type})`)
  return `Added "${item.title}" to the ${item.type} list.`
}

function findByTitle(items: MediaItem[], title: string): MediaItem | undefined {
  const q = title.trim().toLowerCase()
  if (!q) return undefined
  // Exact match first, then substring.
  return items.find(i => i.title.toLowerCase() === q)
      ?? items.find(i => i.title.toLowerCase().includes(q))
}

function removeMedia(title: string): string {
  const items = readMedia()
  const hit = findByTitle(items, title)
  if (!hit) return `No playlist item matching "${title}".`
  const filtered = items.filter(i => i.id !== hit.id)
  writeMedia(filtered)
  console.log(`[chat:tool] remove_media_item → "${hit.title}"`)
  return `Removed "${hit.title}" from the ${hit.type} list.`
}

function markMediaDone(title: string, done = true): string {
  const items = readMedia()
  const hit = findByTitle(items, title)
  if (!hit) return `No playlist item matching "${title}".`
  // Toggle between done and not_started so the legacy boolean view stays
  // coherent. For finer control (in_progress, dropped) the model should call
  // set_media_status instead.
  hit.status = done ? 'done' : 'not_started'
  hit.done   = done
  writeMedia(items)
  console.log(`[chat:tool] mark_media_done → "${hit.title}" status=${hit.status}`)
  return `Marked "${hit.title}" as ${done ? 'finished' : 'not finished'}.`
}

function setMediaStatus(title: string, status: string): string {
  if (!STATUSES.includes(status as MediaStatus)) {
    return `Error: status must be one of ${STATUSES.join(', ')} (got "${status}").`
  }
  const items = readMedia()
  const hit = findByTitle(items, title)
  if (!hit) return `No playlist item matching "${title}".`
  if (hit.type === 'movie' && !MOVIE_STATUSES.includes(status as MediaStatus)) {
    return `Error: movies only support "not_started" or "done" (got "${status}"). Use those instead for "${hit.title}".`
  }
  hit.status = status as MediaStatus
  hit.done   = hit.status === 'done'
  writeMedia(items)
  console.log(`[chat:tool] set_media_status → "${hit.title}" status=${hit.status}`)
  return `Set "${hit.title}" to ${STATUS_LABEL[hit.status]}.`
}

function starMedia(title: string, starred: boolean): string {
  const items = readMedia()
  const hit = findByTitle(items, title) as (MediaItem & { starred?: boolean }) | undefined
  if (!hit) return `No playlist item matching "${title}".`
  hit.starred = starred
  writeMedia(items)
  console.log(`[chat:tool] star_media_item → "${hit.title}" starred=${starred}`)
  return starred
    ? `Pinned "${hit.title}" to the top of the ${hit.type} list.`
    : `Unpinned "${hit.title}".`
}

function recommendMedia(type: string): string {
  const items = readMedia()
  const wanted = (type === 'game' || type === 'show' || type === 'movie') ? type : null
  // Both "done" and "dropped" are out of the pool — neither is a valid recommendation.
  const pool = items.filter(i =>
    i.status !== 'done' && i.status !== 'dropped' && (wanted === null || i.type === wanted),
  )
  if (pool.length === 0) {
    return wanted
      ? `Nothing left to recommend in your ${wanted} list.`
      : 'Your playlist is empty (or everything is marked done).'
  }
  const pick = pool[Math.floor(Math.random() * pool.length)]!
  console.log(`[chat:tool] recommend_media_item → "${pick.title}" (${pick.type})`)
  return `Recommended: "${pick.title}" (${pick.type}).`
}

// ── Time at a place ──────────────────────────────────────────────────────────
// A small lookup of common cities → IANA timezone. The tool also accepts a
// raw IANA tz string ("Europe/Paris"), so unrecognised cities are not fatal —
// the model can pass the tz directly when it knows it.
const CITY_TZ: Record<string, string> = {
  'new york':     'America/New_York',
  'nyc':          'America/New_York',
  'los angeles':  'America/Los_Angeles',
  'la':           'America/Los_Angeles',
  'san francisco':'America/Los_Angeles',
  'chicago':      'America/Chicago',
  'denver':       'America/Denver',
  'toronto':      'America/Toronto',
  'mexico city':  'America/Mexico_City',
  'london':       'Europe/London',
  'paris':        'Europe/Paris',
  'berlin':       'Europe/Berlin',
  'madrid':       'Europe/Madrid',
  'rome':         'Europe/Rome',
  'amsterdam':    'Europe/Amsterdam',
  'moscow':       'Europe/Moscow',
  'istanbul':     'Europe/Istanbul',
  'dubai':        'Asia/Dubai',
  'tehran':       'Asia/Tehran',
  'mumbai':       'Asia/Kolkata',
  'delhi':        'Asia/Kolkata',
  'bangkok':      'Asia/Bangkok',
  'singapore':    'Asia/Singapore',
  'hong kong':    'Asia/Hong_Kong',
  'beijing':      'Asia/Shanghai',
  'shanghai':     'Asia/Shanghai',
  'tokyo':        'Asia/Tokyo',
  'seoul':        'Asia/Seoul',
  'sydney':       'Australia/Sydney',
  'melbourne':    'Australia/Melbourne',
  'auckland':     'Pacific/Auckland',
  'honolulu':     'Pacific/Honolulu',
  'sao paulo':    'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',
  'cairo':        'Africa/Cairo',
  'johannesburg': 'Africa/Johannesburg',
  'lagos':        'Africa/Lagos',
}

function resolveTimezone(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // 1. Try as-is (IANA names contain '/').
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date())
    return raw
  } catch { /* fall through */ }
  // 2. City lookup.
  const key = raw.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (CITY_TZ[key]) return CITY_TZ[key]
  return null
}

function getTime(location: string): string {
  const tz = resolveTimezone(location)
  if (!tz) {
    return `I don't know the timezone for "${location}". Try an IANA name like "Europe/Paris" or a major city name.`
  }
  const now = new Date()
  const time = now.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const date = now.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  return `In ${location} (${tz}) it's ${time} on ${date}.`
}

// ── Weather / calendar / device (loopback) ───────────────────────────────────
// Resolve a lat/lon: prefer DEFAULT_LAT/LON, else geoip. Returns null if both
// fail so callers can short-circuit with a clean error message.
async function resolveLatLon(): Promise<{ lat: number; lon: number } | null> {
  let lat = parseFloat(process.env['DEFAULT_LAT'] ?? '')
  let lon = parseFloat(process.env['DEFAULT_LON'] ?? '')
  if (!isFinite(lat) || !isFinite(lon)) {
    const geo = await localGet<{ lat?: number; lon?: number }>('/api/geoip')
    if (geo && typeof geo.lat === 'number' && typeof geo.lon === 'number') {
      lat = geo.lat; lon = geo.lon
    }
  }
  if (!isFinite(lat) || !isFinite(lon)) return null
  return { lat, lon }
}

async function getWeather(): Promise<string> {
  const loc = await resolveLatLon()
  if (!loc) return 'Weather unavailable: no location.'
  const w = await localGet<{
    temp: number; feels_like: number; description: string; city?: string;
    humidity: number; wind_speed: number; rain_chance?: number; clouds?: number;
  }>(`/api/weather?lat=${loc.lat}&lon=${loc.lon}`)
  if (!w) return 'Weather unavailable.'
  const place = w.city ?? 'your location'
  return `${place}: ${Math.round(w.temp)}°C (feels ${Math.round(w.feels_like)}°C), ${w.description}, ` +
         `humidity ${w.humidity}%, wind ${w.wind_speed} m/s, rain chance ${Math.round((w.rain_chance ?? 0) * 100)}%.`
}

interface ForecastSlot {
  dt: number
  offset_min: number
  temp: number
  description: string
  rain_chance?: number
}

async function getWeatherForecast(hoursStr: string): Promise<string> {
  const loc = await resolveLatLon()
  if (!loc) return 'Forecast unavailable: no location.'
  // OpenWeatherMap returns 3-hour slots; default to next 24h (~8 slots), cap 5 days.
  const hours = Math.max(3, Math.min(120, parseInt(hoursStr, 10) || 24))
  const slots = await localGet<ForecastSlot[]>(`/api/weather/forecast?lat=${loc.lat}&lon=${loc.lon}`)
  if (!slots || slots.length === 0) return 'Forecast unavailable.'
  const cutoffMin = hours * 60
  const window = slots.filter(s => s.offset_min >= 0 && s.offset_min <= cutoffMin)
  if (window.length === 0) return 'Forecast has no slots in the requested window.'
  // Aggregate so the model gets a compact summary instead of 40 lines.
  const temps = window.map(s => s.temp)
  const minT = Math.round(Math.min(...temps))
  const maxT = Math.round(Math.max(...temps))
  const maxRain = Math.round(Math.max(...window.map(s => s.rain_chance ?? 0)) * 100)
  // Sample one slot every ~6h so the model can quote specific windows if asked.
  const sampled = window.filter((_, i) => i % 2 === 0).slice(0, 6).map(s => {
    const hrs = Math.round(s.offset_min / 60)
    return `+${hrs}h: ${Math.round(s.temp)}°C ${s.description}${s.rain_chance ? ` (rain ${Math.round(s.rain_chance * 100)}%)` : ''}`
  })
  return `Next ${hours}h forecast — range ${minT}-${maxT}°C, peak rain chance ${maxRain}%. ` +
         `Slots: ${sampled.join(' | ')}.`
}

const AQI_LABELS: Record<number, string> = {
  1: 'Good', 2: 'Fair', 3: 'Moderate', 4: 'Poor', 5: 'Very Poor',
}

async function getAirQuality(): Promise<string> {
  const loc = await resolveLatLon()
  if (!loc) return 'Air quality unavailable: no location.'
  const a = await localGet<{
    aqi: number; aqi_label?: string;
    pm2_5?: number; pm10?: number; o3?: number; no2?: number;
  }>(`/api/airquality?lat=${loc.lat}&lon=${loc.lon}`)
  if (!a) return 'Air quality unavailable.'
  const label = a.aqi_label ?? AQI_LABELS[a.aqi] ?? 'Unknown'
  const parts = [`AQI ${a.aqi}/5 (${label})`]
  if (typeof a.pm2_5 === 'number') parts.push(`PM2.5 ${a.pm2_5} µg/m³`)
  if (typeof a.pm10  === 'number') parts.push(`PM10 ${a.pm10} µg/m³`)
  if (typeof a.o3    === 'number') parts.push(`O₃ ${a.o3} µg/m³`)
  if (typeof a.no2   === 'number') parts.push(`NO₂ ${a.no2} µg/m³`)
  return parts.join(', ') + '.'
}

// ── App mode ─────────────────────────────────────────────────────────────────
// The mode file backs the work/rest/locked toggle in the StatusBar. We let the
// AI flip between "work" and "rest" by voice; "locked" is intentionally NOT
// available as a tool — locking the dashboard requires the user's credential
// flow on the touchscreen, not a voice command.
async function setAppMode(mode: string): Promise<string> {
  const m = mode.trim().toLowerCase()
  if (m !== 'work' && m !== 'rest') {
    return `Error: mode must be "work" or "rest" (got "${mode}"). Locked mode can only be set on the touchscreen.`
  }
  try {
    const res = await fetch(`${LOOPBACK}/api/state/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: m }),
    })
    if (!res.ok) return `Error: failed to set mode (${res.status}).`
    console.log(`[chat:tool] set_app_mode → ${m}`)
    return `Switched the dashboard to ${m} mode.`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Error setting mode: ${msg}`
  }
}

interface CalEvent { id?: string; title: string; start: string; end: string; allDay: boolean }

// Parse a date the model may pass us. Accepts:
//   YYYY-MM-DD                           → that day
//   "today" / "tomorrow" / "yesterday"
//   "+3" / "-2"                          → relative day offset
//   weekday names ("monday", "next friday", "this saturday")
// Returns a Date pinned to local-midnight, or null.
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
function parseDateInput(input: string): Date | null {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)

  if (raw === 'today')     return today
  if (raw === 'tomorrow')  return new Date(today.getTime() + 86_400_000)
  if (raw === 'yesterday') return new Date(today.getTime() - 86_400_000)

  // YYYY-MM-DD
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (ymd) {
    const d = new Date(parseInt(ymd[1]!), parseInt(ymd[2]!) - 1, parseInt(ymd[3]!))
    return isNaN(d.getTime()) ? null : d
  }

  // Relative offset like "+3" or "-2"
  const rel = /^([+-]?\d{1,3})$/.exec(raw)
  if (rel) return new Date(today.getTime() + parseInt(rel[1]!) * 86_400_000)

  // Weekday names: "monday", "next monday", "this monday"
  const wd = /^(?:(this|next|last)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(raw)
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]!)
    const cur = today.getDay()
    let delta = (target - cur + 7) % 7
    if (wd[1] === 'next' && delta === 0) delta = 7
    if (wd[1] === 'last') delta = delta === 0 ? -7 : delta - 7
    if (!wd[1] && delta === 0) {} // "monday" today → today
    return new Date(today.getTime() + delta * 86_400_000)
  }

  // Last-resort native parse (e.g. "Jan 5 2026")
  const fallback = new Date(raw)
  if (!isNaN(fallback.getTime())) {
    fallback.setHours(0, 0, 0, 0)
    return fallback
  }
  return null
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Fetch events for whichever month(s) the [start, end] range touches and merge.
// `/api/calendar/month` is cached server-side so this stays cheap.
async function fetchEventsInRange(start: Date, end: Date): Promise<CalEvent[]> {
  const months = new Set<string>()
  const cur = new Date(start.getFullYear(), start.getMonth(), 1)
  const stopAt = new Date(end.getFullYear(), end.getMonth(), 1)
  while (cur <= stopAt) {
    months.add(`${cur.getFullYear()}-${cur.getMonth()}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  const all: CalEvent[] = []
  const seen = new Set<string>()
  for (const m of months) {
    const [y, mo] = m.split('-')
    const data = await localGet<{ events?: CalEvent[] }>(`/api/calendar/month?year=${y}&month=${mo}`)
    for (const ev of data?.events ?? []) {
      const id = ev.id ?? `${ev.title}|${ev.start}`
      if (seen.has(id)) continue
      seen.add(id)
      all.push(ev)
    }
  }
  // Filter to events that overlap [start, end). All-day events use a YYYY-MM-DD
  // string, so compare via Date constructor at local midnight.
  const startMs = start.getTime()
  const endMs   = end.getTime()
  return all.filter(ev => {
    const sMs = (ev.start.length === 10 ? new Date(ev.start + 'T00:00') : new Date(ev.start)).getTime()
    const eMs = (ev.end.length   === 10 ? new Date(ev.end   + 'T23:59') : new Date(ev.end)).getTime()
    return sMs < endMs && eMs > startMs
  }).sort((a, b) => a.start.localeCompare(b.start))
}

function formatEvent(ev: CalEvent, includeDate = false): string {
  const d = ev.start.length === 10 ? new Date(ev.start + 'T12:00') : new Date(ev.start)
  const datePart = includeDate
    ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' '
    : ''
  if (ev.allDay) return `- ${datePart}${ev.title} (all day)`
  const t = new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `- ${datePart}${t} \u2014 ${ev.title}`
}

async function getCalendarToday(): Promise<string> {
  // Loopback to /today keeps caching tight for the most-common query.
  const data = await localGet<{ events?: CalEvent[] }>('/api/calendar/today')
  const events = data?.events ?? []
  if (events.length === 0) return 'No events on the calendar today.'
  return `Today's events:\n` + events.map(e => formatEvent(e)).join('\n')
}

async function getCalendarDay(input: string): Promise<string> {
  const day = parseDateInput(input || 'today')
  if (!day) return `I couldn't understand the date "${input}". Try YYYY-MM-DD, "tomorrow", or a weekday name.`
  const next = new Date(day.getTime() + 86_400_000)
  const events = await fetchEventsInRange(day, next)
  const label  = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (events.length === 0) return `No events on ${label}.`
  return `Events on ${label}:\n` + events.map(e => formatEvent(e)).join('\n')
}

async function getCalendarRange(startInput: string, endInput: string): Promise<string> {
  const start = parseDateInput(startInput || 'today')
  if (!start) return `I couldn't understand the start date "${startInput}".`
  const end = endInput ? parseDateInput(endInput) : new Date(start.getTime() + 7 * 86_400_000)
  if (!end) return `I couldn't understand the end date "${endInput}".`
  // Range is inclusive on both ends — bump end to end-of-day.
  const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
  if (endExclusive <= start) return `End date must be on or after start date.`
  // Cap at 60 days to avoid runaway tool output.
  const maxEnd = new Date(start.getTime() + 60 * 86_400_000)
  const cappedEnd = endExclusive > maxEnd ? maxEnd : endExclusive
  const events = await fetchEventsInRange(start, cappedEnd)
  const startLbl = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const endLbl   = new Date(cappedEnd.getTime() - 1).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (events.length === 0) return `No events between ${startLbl} and ${endLbl}.`
  // Group by day for readability.
  const byDay = new Map<string, CalEvent[]>()
  for (const ev of events) {
    const key = ev.start.length === 10 ? ev.start : ymdKey(new Date(ev.start))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(ev)
  }
  const lines: string[] = [`Events from ${startLbl} to ${endLbl}:`]
  for (const [key, evs] of [...byDay.entries()].sort()) {
    const d = new Date(key + 'T12:00')
    lines.push(`\n${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}:`)
    for (const ev of evs) lines.push(formatEvent(ev))
  }
  return lines.join('\n')
}

async function getCalendarWeek(startInput: string): Promise<string> {
  const start = parseDateInput(startInput || 'today')
  if (!start) return `I couldn't understand the start date "${startInput}".`
  const end = new Date(start.getTime() + 6 * 86_400_000) // 7-day window
  return getCalendarRange(ymdKey(start), ymdKey(end))
}

async function getDeviceStatus(): Promise<string> {
  const d = await localGet<{
    cpuTempC: number | null; memUsedPct: number; memAvailableMB: number; memTotalMB: number;
    loadAvg1: number; cpuCount: number; uptimeSeconds: number;
  }>('/api/device')
  if (!d) return 'Device status unavailable.'
  const upH = Math.floor(d.uptimeSeconds / 3600)
  const upM = Math.floor((d.uptimeSeconds % 3600) / 60)
  return `CPU ${d.cpuTempC ?? '?'}°C, load ${d.loadAvg1}/${d.cpuCount}, ` +
         `mem ${d.memUsedPct}% used (${d.memAvailableMB}/${d.memTotalMB} MB free), ` +
         `uptime ${upH}h ${upM}m.`
}

// ── Memory ────────────────────────────────────────────────────────────────────
function rememberFact(content: string, scope: string): string {
  const c = content.trim()
  if (!c) return 'Error: content is required.'
  const s: 'short' | 'long' = scope === 'long' ? 'long' : 'short'
  const mem = addMemory(c, s, 'assistant')
  return `Saved to ${s}-term memory: "${mem.content}"`
}

function forgetFact(query: string): string {
  const q = query.trim()
  if (!q) return 'Error: query is required.'
  const removed = removeMemories(q)
  if (removed === 0) return `No memories matched "${q}".`
  return `Forgot ${removed} ${removed === 1 ? 'memory' : 'memories'} matching "${q}".`
}

function listMemoriesTool(): string {
  const store = loadMemories()
  if (store.longTerm.length === 0 && store.shortTerm.length === 0) {
    return 'Memory is empty.'
  }
  const parts: string[] = []
  if (store.longTerm.length > 0) {
    parts.push('Long-term:')
    for (const m of store.longTerm) parts.push(`- ${m.content}`)
  }
  if (store.shortTerm.length > 0) {
    parts.push('Short-term (last 24h):')
    const recent = store.shortTerm.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const m of recent) parts.push(`- ${m.content}`)
  }
  return parts.join('\n')
}

// ── Tool dispatch ────────────────────────────────────────────────────────────
export const DASHBOARD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description:
        'Return the current local time at a place. Accepts a major city name ' +
        '(e.g. "Tokyo", "New York", "Paris") or an IANA timezone ("Asia/Tokyo"). ' +
        'Use this whenever the user asks what time it is somewhere — do NOT guess.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name or IANA timezone.' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_media_items',
      description:
        "Read the user's media playlist (games, shows, and movies they want to play or watch). " +
        'Call this before adding to avoid duplicates, or when the user asks what is on the list.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_media_item',
      description:
        "Add a game, show, or movie to the user's playlist. Use this whenever the user " +
        'asks to add, remember, queue, save, or jot down something to play or watch. ' +
        'Pick the type that best fits (game / show / movie).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the game / show / movie.' },
          type:  { type: 'string', enum: ['game', 'show', 'movie'], description: 'Kind of media.' },
        },
        required: ['title', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_media_item',
      description: 'Remove a playlist item by title (case-insensitive substring match).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title to remove.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_media_done',
      description: 'Mark a playlist item as finished (or unfinished if done=false).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title to mark.' },
          done:  { type: 'boolean', description: 'true = finished, false = unfinished. Defaults to true.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: "Current weather at the user's configured location. Use for local weather questions.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_today',
      description: "Today's events from the user's calendar.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_day',
      description:
        "Events on a specific day. Accepts YYYY-MM-DD, 'today', 'tomorrow', " +
        "'yesterday', a relative offset like '+3' or '-2', or a weekday like " +
        "'monday' / 'next friday' / 'last sunday'. Use this for any single-day question " +
        "other than today.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Day to look up (see description for accepted formats).' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_week',
      description:
        "Events for a 7-day window starting on `start` (default: today). Use this when " +
        "the user asks 'this week', 'next week', 'the week of ...', etc.",
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: "First day of the week to show. Same formats as get_calendar_day. Defaults to 'today'." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_range',
      description:
        'Events between two dates (inclusive on both ends). Capped at 60 days. Use this for ' +
        "questions like 'what's on between Monday and Wednesday' or 'events from May 5 to May 10'.",
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Start date (same formats as get_calendar_day).' },
          end:   { type: 'string', description: 'End date, inclusive (same formats as get_calendar_day).' },
        },
        required: ['start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_device_status',
      description: 'CPU temperature, memory, load average, and uptime of the device running TouchSphere.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_media_status',
      description:
        'Set a playlist item\'s status. Games and shows support four states: "not_started", "in_progress", ' +
        '"done", "dropped". Movies only support "not_started" and "done" (use one of those for movies). ' +
        'Use this whenever the user reports progress: "I started Hades" → in_progress, "I finished Hades" → done, ' +
        '"I gave up on Hades" → dropped. For a simple finished/unfinished toggle, mark_media_done still works.',
      parameters: {
        type: 'object',
        properties: {
          title:  { type: 'string', description: 'Title of the item (case-insensitive partial match allowed).' },
          status: { type: 'string', enum: ['not_started', 'in_progress', 'done', 'dropped'], description: 'Target status.' },
        },
        required: ['title', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'star_media_item',
      description:
        'Pin (or unpin) a playlist item to the top of the list. Starred items always sort above un-starred ' +
        'items in the same active group, and surface in the "Up Next" tile. Use when the user wants something ' +
        'to be their next priority ("pin Hades", "make Hades my top pick", "unstar Hades").',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string',  description: 'Title of the item (case-insensitive partial match allowed).' },
          starred: { type: 'boolean', description: 'true to pin, false to unpin. Defaults to true.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_media_item',
      description:
        'Pick a random un-finished item from the user\'s playlist. Use when the user asks what they should ' +
        'play/watch/do next ("what should I play tonight?", "recommend me a movie"). Always pulls from the ' +
        'user\'s actual list — do not invent titles.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['game', 'show', 'movie'], description: 'Optional filter; omit to pick from any type.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_app_mode',
      description:
        'Switch the dashboard between "work" mode (full widget access) and "rest" mode (reduced UI). ' +
        'Use when the user says things like "switch to rest mode", "I\'m done working", "back to work mode". ' +
        'Cannot set "locked" mode — that requires the touchscreen credential flow.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['work', 'rest'], description: 'Target mode.' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather_forecast',
      description:
        'Get the upcoming weather forecast for the dashboard\'s location. Returns a temperature range, peak ' +
        'rain chance, and 3-hour-spaced sample slots so you can answer "will it rain tomorrow?", ' +
        '"what\'s the high tonight?", etc. Use this for any future-tense weather question — get_weather only ' +
        'covers right now.',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'How many hours to look ahead (default 24, max 120).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_air_quality',
      description:
        'Current air-quality index (1=Good, 5=Very Poor) and the main pollutant levels (PM2.5, PM10, O₃, NO₂) ' +
        'for the dashboard\'s location. Use for questions about air quality, pollution, allergies, or whether it\'s safe to exercise outside.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a fact to persistent memory so you remember it in future conversations. ' +
        'Use this for stable facts (the user\'s name, preferences, recurring routines, important dates) — ' +
        'scope "long" — or for context you only need for the rest of the day (current project, mood, what they\'re working on) — scope "short". ' +
        'Long-term memories never expire; short-term memories are auto-deleted after 24 hours. ' +
        'Phrase the content as a complete factual statement (e.g. "The user\'s name is Daniel", not "Daniel"). ' +
        'Don\'t use this for trivia the user can easily restate; reserve it for things they\'d be annoyed to repeat.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact or note to remember, as a complete sentence.' },
          scope:   { type: 'string', enum: ['short', 'long'], description: '"long" = forever, "short" = 24h.' },
        },
        required: ['content', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description:
        'Remove memories that match a query. Matches by case-insensitive substring against the stored content, ' +
        'so "name" would remove every memory mentioning a name. Use this when the user contradicts a saved fact, ' +
        'asks you to forget something, or when stored info becomes stale.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against memory contents.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description:
        'List everything currently in your persistent memory. The contents are also auto-injected into your ' +
        'system prompt at the start of every conversation, so you usually do not need to call this — only use it ' +
        'when the user explicitly asks what you remember about them.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const

export async function runDashboardTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'get_time':           return getTime(str('location'))
    case 'list_media_items':   return listMedia()
    case 'add_media_item':     return addMedia(str('title'), str('type'))
    case 'remove_media_item':  return removeMedia(str('title'))
    case 'mark_media_done': {
      const done = typeof args['done'] === 'boolean' ? (args['done'] as boolean) : true
      return markMediaDone(str('title'), done)
    }
    case 'set_media_status': return setMediaStatus(str('title'), str('status'))
    case 'star_media_item': {
      const starred = typeof args['starred'] === 'boolean' ? (args['starred'] as boolean) : true
      return starMedia(str('title'), starred)
    }
    case 'recommend_media_item': return recommendMedia(str('type'))
    case 'set_app_mode':         return setAppMode(str('mode'))
    case 'get_weather':        return getWeather()
    case 'get_weather_forecast': {
      const h = typeof args['hours'] === 'number' ? String(args['hours']) : str('hours')
      return getWeatherForecast(h)
    }
    case 'get_air_quality':    return getAirQuality()
    case 'get_calendar_today': return getCalendarToday()
    case 'get_calendar_day':   return getCalendarDay(str('date'))
    case 'get_calendar_week':  return getCalendarWeek(str('start'))
    case 'get_calendar_range': return getCalendarRange(str('start'), str('end'))
    case 'get_device_status':  return getDeviceStatus()
    case 'remember':           return rememberFact(str('content'), str('scope'))
    case 'forget':             return forgetFact(str('query'))
    case 'list_memories':      return listMemoriesTool()
    default: return null
  }
}

// Names that, if successfully invoked, mutate persisted state. Used by the
// chat route to tell the client which slices to refetch.
export const MUTATING_TOOLS = new Set([
  'add_media_item',
  'remove_media_item',
  'mark_media_done',
  'set_media_status',
  'star_media_item',
  'set_app_mode',
  'remember',
  'forget',
])
