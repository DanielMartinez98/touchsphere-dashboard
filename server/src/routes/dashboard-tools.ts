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
import { addMemory, loadMemories, removeMemories, isTopic } from '../memory'
import { nextRecurringFireAt, sanitizeRepeatDays } from './timers'
import { findCover, artworkConfigured } from './artwork'
import { guideProgress, listGuides, loadGuide, setStepDone } from '../guides'
import { startGuide } from '../guide-generator'
import { normalizeSiteHost } from '../research'
import { pushGuide } from '../guide-events'

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

export interface MediaItem {
  id: string
  title: string
  type: MediaType
  done: boolean
  status: MediaStatus
  starred?: boolean
  cover?: string
  /** The Plex ratingKey this row follows (plex-watch.ts), so a retitled row still lines up. */
  plexKey?: string
}

// Mirror the server's normalizer so legacy items (no `status`) read sanely
// even before they're rewritten. Every field an item can carry MUST be copied
// through: this normalizer runs on read and the result is written straight back
// on the next mutation, so anything omitted here is silently destroyed for the
// whole list (that's how `cover` got wiped by any AI edit).
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
    ...(raw.cover ? { cover: raw.cover } : {}),
    ...(raw.plexKey ? { plexKey: raw.plexKey } : {}),
  }
}

// Exported for guide-view-tools, which resolves the game the user named the same
// way every other voice tool does.
export function readMedia(): MediaItem[] {
  const raw = readJSON<Array<Partial<MediaItem> & { type: MediaType }>>('media.json', [])
  return raw.map(normalize)
}
export function writeMedia(items: MediaItem[]): void {
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

// Render a candidate list for the model to read back to the user.
function suggestionList(suggestions: { title: string; year: number | null }[]): string {
  return suggestions
    .map(s => `"${s.title}"${s.year ? ` (${s.year})` : ''}`)
    .join(', ')
}

async function addMedia(title: string, type: string): Promise<string> {
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

  // Look the cover up before saving so the item lands complete. The result also
  // tells us whether the title was good enough to trust — a spoken title is
  // often misheard or misspelled, and a wrong poster is worse than none.
  const { cover, match, exact, suggestions } = await findCover(type as MediaType, t)

  const item: MediaItem = {
    id: crypto.randomUUID(),
    title: t,
    type: type as MediaType,
    done: false,
    status: 'not_started',
    ...(cover ? { cover } : {}),
  }
  items.push(item)
  writeMedia(items)
  console.log(`[chat:tool] add_media_item → "${item.title}" (${item.type}) cover=${cover ?? 'none'} exact=${exact}`)

  if (cover && exact) {
    return `Added "${item.title}" to the ${item.type} list, with cover art.`
  }

  if (cover && match) {
    // We attached art for a title that isn't quite what was asked for.
    return `Added "${item.title}" to the ${item.type} list, but the closest artwork match was ` +
           `"${match.title}"${match.year ? ` (${match.year})` : ''}, not an exact title match. ` +
           `Ask the user whether they meant "${match.title}" — if they say yes, call rename_media_item ` +
           `to correct the title. Other candidates: ${suggestionList(suggestions.slice(1))}.`
  }

  // Distinguish "the server has no key for this provider" from "that title doesn't
  // exist". Blaming the user's spelling for a server misconfiguration wastes their
  // time and they can't fix it by re-spelling anything.
  if (!artworkConfigured(item.type)) {
    const provider = item.type === 'game' ? 'IGDB' : 'TMDB'
    return `Added "${item.title}" to the ${item.type} list. Cover art was skipped because the ${provider} ` +
           `artwork provider is not configured on this server — this is a server setup issue, NOT a problem ` +
           `with the title. Do not ask the user to re-spell it. Just confirm the item was added.`
  }

  if (suggestions.length > 0) {
    return `Added "${item.title}" to the ${item.type} list, but no artwork matches that exact title — ` +
           `it is probably misspelled. The closest titles are: ${suggestionList(suggestions)}. ` +
           `Ask the user which one they meant, then call rename_media_item with it. ` +
           `If none are right, leave the item as-is.`
  }

  return `Added "${item.title}" to the ${item.type} list, but no cover art was found and no similar ` +
         `titles either. Ask the user to spell the title, then call rename_media_item to fix it ` +
         `(renaming re-runs the artwork lookup).`
}

// Rename an item and re-run the artwork lookup. This is the fix-up path for a
// title that was misheard or misspelled badly enough that no cover was found.
async function renameMedia(title: string, newTitle: string): Promise<string> {
  const t = newTitle.trim()
  if (!t) return 'Error: new_title is required.'
  const items = readMedia()
  const hit = findByTitle(items, title)
  if (!hit) return `Not on the list: "${title}".`

  const old = hit.title
  hit.title = t

  const { cover, match, exact } = await findCover(hit.type, t)
  if (cover) hit.cover = cover

  writeMedia(items)
  console.log(`[chat:tool] rename_media_item → "${old}" → "${t}" cover=${cover ?? 'unchanged'}`)

  if (cover && exact)  return `Renamed "${old}" to "${t}" and updated the cover art.`
  if (cover && match)  return `Renamed "${old}" to "${t}" and attached artwork for "${match.title}". ` +
                              `Confirm with the user that this is the right one.`
  return `Renamed "${old}" to "${t}", but still no cover art was found for that title.`
}

export function findByTitle(items: MediaItem[], title: string): MediaItem | undefined {
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

// ── Notion tasks ───────────────────────────────────────────────────────────────
// Create a task in the user's Notion task database via the existing loopback
// route (the same one the widget POSTs to), so a voice-created task is identical
// to a touch-created one. `due` accepts the same natural-language dates as the
// calendar tools ("today", "tomorrow", "next friday", "+3", or YYYY-MM-DD) and is
// normalized to YYYY-MM-DD before it's sent. Server picks the default task DB.
async function addNotionTask(title: string, due: string): Promise<string> {
  const t = title.trim()
  if (!t) return 'Error: a task title is required.'
  let dueDate: Date | null = null
  if (due.trim()) {
    dueDate = parseDateInput(due)
    if (!dueDate) return `Error: I couldn't understand the due date "${due}". Try "today", "tomorrow", a weekday, or YYYY-MM-DD.`
  }
  try {
    const res = await fetch(`${LOOPBACK}/api/notion/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: t, ...(dueDate ? { due: ymdKey(dueDate) } : {}) }),
    })
    if (res.status === 503) return "Error: Notion tasks aren't configured on this device."
    if (!res.ok) return `Error: failed to add the task (${res.status}).`
    console.log(`[chat:tool] add_notion_task → "${t}"${dueDate ? ` due ${ymdKey(dueDate)}` : ''}`)
    if (dueDate) {
      const label = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      return `Added "${t}" to your tasks, due ${label}.`
    }
    return `Added "${t}" to your tasks.`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Error adding task: ${msg}`
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
function rememberFact(content: string, scope: string, topic = ''): string {
  const c = content.trim()
  if (!c) return 'Error: content is required.'
  const s: 'short' | 'long' = scope === 'long' ? 'long' : 'short'
  const mem = addMemory(c, s, 'assistant', 'fact', isTopic(topic) ? topic : undefined)
  return `Saved to ${s}-term memory: "${mem.content}"`
}

function rememberPreference(content: string): string {
  const c = content.trim()
  if (!c) return 'Error: content is required.'
  const mem = addMemory(c, 'long', 'assistant', 'preference')
  return `Saved a preference: "${mem.content}"`
}

function forgetFact(query: string): string {
  const q = query.trim()
  if (!q) return 'Error: query is required.'
  // A refusal is not a failure — it comes back with the matches listed so the
  // model can pick a distinctive phrase instead of widening the net further.
  const { removed, refused } = removeMemories(q)
  if (refused) return `Did not forget anything: ${refused}`
  if (removed.length === 0) return `No memories matched "${q}".`
  return `Forgot ${removed.length} ${removed.length === 1 ? 'memory' : 'memories'}: ` +
         removed.map(m => `"${m.content}"`).join('; ')
}

function listMemoriesTool(): string {
  const store = loadMemories()
  if (store.longTerm.length === 0 && store.shortTerm.length === 0) {
    return 'Memory is empty.'
  }
  const parts: string[] = []
  const prefs = store.longTerm.filter(m => m.kind === 'preference')
  const facts = store.longTerm.filter(m => m.kind !== 'preference')
  if (facts.length > 0) {
    parts.push('Long-term facts:')
    for (const m of facts) parts.push(`- ${m.content}`)
  }
  if (prefs.length > 0) {
    parts.push('Learned preferences:')
    for (const m of prefs) parts.push(`- ${m.content}`)
  }
  if (store.shortTerm.length > 0) {
    parts.push('Short-term (last 24h):')
    const recent = store.shortTerm.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const m of recent) parts.push(`- ${m.content}`)
  }
  return parts.join('\n')
}

// ── Timers & alarms ────────────────────────────────────────────────────────────
// Mirrors the shape persisted by routes/timers.ts. We write the same JSON file
// directly (like the media list) so a voice-created timer is identical to a
// touch-created one. The client owns the countdown + ring; this is just storage.
type TimerKind = 'timer' | 'alarm'
interface TimerRecord {
  id: string
  label: string
  kind: TimerKind
  fireAt: number
  createdAt: number
  durationMs: number
  repeatDays: number[]   // weekdays an alarm repeats on (0=Sun..6=Sat); [] = one-shot
}

const TIMER_RING_GRACE_MS = 5 * 60 * 1000
const TIMER_MAX_DURATION_MS = 24 * 60 * 60 * 1000

// Same prune-and-advance contract as routes/timers.ts (recurring alarms roll
// forward instead of being pruned), so the voice path sees the same list.
function readTimers(): TimerRecord[] {
  const now = Date.now()
  const all = readJSON<TimerRecord[]>('timers.json', [])
  let mutated = false
  const alive: TimerRecord[] = []
  for (const t of all) {
    if (!Array.isArray(t.repeatDays)) t.repeatDays = []
    if (typeof t.fireAt !== 'number') { mutated = true; continue }
    if (t.repeatDays.length > 0) {
      if (t.fireAt < now - TIMER_RING_GRACE_MS) {
        const next = nextRecurringFireAt(t, now)
        if (next !== t.fireAt) { t.fireAt = next; mutated = true }
      }
      alive.push(t)
    } else if (t.fireAt >= now - TIMER_RING_GRACE_MS) {
      alive.push(t)
    } else {
      mutated = true
    }
  }
  alive.sort((a, b) => a.fireAt - b.fireAt)
  if (mutated) writeJSON('timers.json', alive)
  return alive
}
function writeTimers(timers: TimerRecord[]): void {
  writeJSON('timers.json', timers)
}

// "daily"/"every day", "weekdays", "weekends", or day names ("mon, wed, fri").
// Returns a weekday set (0=Sun..6=Sat); [] when nothing recognised / one-shot.
function parseRepeat(input: string): number[] {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw || /\b(once|one[- ]?time|no repeat|don'?t repeat)\b/.test(raw)) return []
  if (/\b(daily|every ?day|each day)\b/.test(raw)) return [0, 1, 2, 3, 4, 5, 6]
  if (/\bweekdays?\b|every weekday|work ?days?/.test(raw)) return [1, 2, 3, 4, 5]
  if (/\bweekends?\b/.test(raw)) return [0, 6]
  const names: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  }
  const days = new Set<number>()
  for (const m of raw.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/g)) {
    days.add(names[m[1]!]!)
  }
  return sanitizeRepeatDays([...days])
}

// "every day", "weekdays", "Mon, Wed, Fri" — human summary of a repeat set.
function formatRepeat(days: number[]): string {
  if (days.length === 0) return ''
  if (days.length === 7) return 'every day'
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekends'
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return days.map(d => NAMES[d]).join(', ')
}

// "10 minutes", "1h30m", "90 seconds", "1.5 hours", "20" (→ minutes). Returns ms.
function parseDurationToMs(input: string): number {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return 0
  // Bare number → assume minutes (most common spoken case: "set a timer for 20").
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(parseFloat(raw) * 60_000)
  let ms = 0
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const value = parseFloat(match[1]!)
    const unit = match[2]!
    if (unit.startsWith('h')) ms += value * 3_600_000
    else if (unit.startsWith('s')) ms += value * 1_000
    else ms += value * 60_000   // m / min / minute
  }
  return Math.round(ms)
}

function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s && !h) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  return parts.join(' ') || '0 seconds'
}

// Parse a wall-clock time ("7:30am", "19:00", "noon", "midnight", "7 pm") and
// resolve to the next future occurrence in local time. Returns epoch ms or null.
function parseAlarmTime(input: string): number | null {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return null
  let hh: number | null = null
  let mm = 0
  if (raw === 'noon') { hh = 12 }
  else if (raw === 'midnight') { hh = 0 }
  else {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw)
    if (!m) return null
    hh = parseInt(m[1]!, 10)
    mm = m[2] ? parseInt(m[2], 10) : 0
    const mer = m[3]
    if (mer === 'pm' && hh < 12) hh += 12
    if (mer === 'am' && hh === 12) hh = 0
  }
  if (hh === null || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1) // roll to tomorrow
  return target.getTime()
}

function formatClock(epoch: number): string {
  return new Date(epoch).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function setTimer(hours: number, minutes: number, seconds: number, durationStr: string, label: string): string {
  let ms = (hours * 3_600_000) + (minutes * 60_000) + (seconds * 1_000)
  if (ms <= 0 && durationStr) ms = parseDurationToMs(durationStr)
  if (ms <= 0) return 'Error: specify a duration (e.g. 10 minutes).'
  if (ms > TIMER_MAX_DURATION_MS) ms = TIMER_MAX_DURATION_MS
  const now = Date.now()
  const timers = readTimers()
  const timer: TimerRecord = {
    id: crypto.randomUUID(),
    label: label.trim().slice(0, 60),
    kind: 'timer',
    fireAt: now + ms,
    createdAt: now,
    durationMs: ms,
    repeatDays: [],
  }
  timers.push(timer)
  writeTimers(timers)
  console.log(`[chat:tool] set_timer → ${formatDurationMs(ms)} "${timer.label}"`)
  const name = timer.label ? ` for ${timer.label}` : ''
  return `Timer set${name} for ${formatDurationMs(ms)}.`
}

function setAlarm(timeStr: string, label: string, repeatStr: string): string {
  let fireAt = parseAlarmTime(timeStr)
  if (!fireAt) return `Error: I couldn't understand the time "${timeStr}". Try something like "7:30 am".`
  const repeatDays = parseRepeat(repeatStr)
  if (repeatDays.length > 0) fireAt = nextRecurringFireAt({ fireAt, repeatDays })
  const now = Date.now()
  const timers = readTimers()
  const alarm: TimerRecord = {
    id: crypto.randomUUID(),
    label: label.trim().slice(0, 60),
    kind: 'alarm',
    fireAt,
    createdAt: now,
    durationMs: 0,
    repeatDays,
  }
  timers.push(alarm)
  writeTimers(timers)
  console.log(`[chat:tool] set_alarm → ${formatClock(fireAt)} "${alarm.label}"${repeatDays.length ? ` repeat=${formatRepeat(repeatDays)}` : ''}`)
  const name = alarm.label ? ` for ${alarm.label}` : ''
  if (repeatDays.length > 0) {
    return `Alarm set${name} for ${formatClock(fireAt)}, repeating ${formatRepeat(repeatDays)}.`
  }
  const day = fireAt - now > 24 * 3_600_000 || new Date(fireAt).getDate() !== new Date(now).getDate() ? ' tomorrow' : ''
  return `Alarm set${name} for ${formatClock(fireAt)}${day}.`
}

function listTimers(): string {
  const timers = readTimers()
  if (timers.length === 0) return 'No active timers or alarms.'
  const now = Date.now()
  const lines = timers.map(t => {
    const remaining = t.fireAt - now
    if (t.kind === 'alarm') {
      const repeat = t.repeatDays?.length ? ` (repeats ${formatRepeat(t.repeatDays)})` : ''
      return `- Alarm${t.label ? ` (${t.label})` : ''} at ${formatClock(t.fireAt)}${repeat}`
    }
    const left = remaining > 0 ? `${formatDurationMs(remaining)} left` : 'ringing now'
    return `- Timer${t.label ? ` (${t.label})` : ''}: ${left}`
  })
  return `Active timers and alarms:\n${lines.join('\n')}`
}

function cancelTimer(query: string): string {
  const timers = readTimers()
  if (timers.length === 0) return 'There are no active timers or alarms to cancel.'
  const q = query.trim().toLowerCase()
  if (!q || q === 'all') {
    if (!q && timers.length > 1) {
      return `There are ${timers.length} active timers — say which one to cancel, or "cancel all".`
    }
    writeTimers([])
    console.log(`[chat:tool] cancel_timer → cleared ${timers.length}`)
    return timers.length === 1 ? 'Cancelled the timer.' : `Cancelled all ${timers.length} timers and alarms.`
  }
  // Match by label, falling back to kind keyword ("timer" / "alarm").
  const hit = timers.find(t => t.label.toLowerCase().includes(q))
    ?? timers.find(t => t.kind === q)
  if (!hit) return `No timer or alarm matching "${query}".`
  writeTimers(timers.filter(t => t.id !== hit.id))
  console.log(`[chat:tool] cancel_timer → "${hit.label || hit.kind}"`)
  return `Cancelled the ${hit.kind}${hit.label ? ` for ${hit.label}` : ''}.`
}

// ── Game guides ──────────────────────────────────────────────────────────────
// The heavy lifting (research, section generation, video lookups) happens in
// guide-generator.ts and outlives the conversation. These tools only start it,
// report on it, and tick boxes — each one has to return in the second or two the
// user is waiting for a spoken reply.

async function createGameGuide(title: string, order: string, source: string): Promise<string> {
  const t = title.trim()
  if (!t) return 'Error: title is required.'
  const sourceSite = source.trim() ? normalizeSiteHost(source) : null

  const items = readMedia()
  let hit = findByTitle(items, t)

  // Asking for a guide is itself a statement of intent to play it, so a game
  // that isn't on the list gets added rather than refused.
  if (!hit) {
    const added = await addMedia(t, 'game')
    hit = findByTitle(readMedia(), t)
    if (!hit) return `Error: could not add "${t}" to the playlist, so there is nothing to attach a guide to. (${added})`
    console.log(`[chat:tool] create_game_guide → added "${hit.title}" to the playlist first`)
  }

  if (hit.type !== 'game') {
    return `"${hit.title}" is a ${hit.type}, not a game — guides are only for games. Say so briefly.`
  }

  const existing = loadGuide(hit.id)
  if (existing?.status === 'generating') {
    return `A guide for "${hit.title}" is already being put together (${existing.phase ?? 'in progress'}). ` +
           `Tell the user it's still working, and do not start another.`
  }

  const result = startGuide({
    itemId: hit.id,
    title: hit.title,
    ...(order.trim() ? { order: order.trim() } : {}),
    ...(sourceSite ? { sourceSite } : {}),
  })
  if (result === 'busy') {
    return `A guide for "${hit.title}" is already being generated. Tell the user it's on its way.`
  }
  const regenerated = existing ? ' This replaces the previous guide and its ticked-off steps.' : ''
  const sourced = sourceSite
    ? ` It's being built from ${sourceSite} first, falling back to the game's wiki for anything that site doesn't cover.`
    : source.trim()
      ? ` (Couldn't use "${source.trim()}" as a source site — building from the community wiki instead.)`
      : ''
  return `Started researching a guide for "${hit.title}".${regenerated}${sourced} It takes a few minutes and builds up ` +
         `section by section; it appears under the game in the Watch/Play list, and the dashboard shows a ` +
         `notice when it's done. Say one short sentence confirming you're on it — do not pretend it is ready yet.`
}

function getGameGuideProgress(title: string): string {
  const items = readMedia()
  const hit = title.trim() ? findByTitle(items, title) : undefined

  if (!hit) {
    // No title, or no match: report on everything that has a guide, so "how are
    // my guides going?" works too.
    const all = listGuides()
    if (all.length === 0) return 'There are no game guides yet.'
    return all
      .map(g => `${g.title}: ${g.status === 'ready' ? `${g.percent}% (${g.counted.done} of ${g.counted.total} steps)` : g.status === 'generating' ? `still generating — ${g.phase ?? 'working'}` : 'failed to generate'}`)
      .join('\n')
  }

  const guide = loadGuide(hit.id)
  if (!guide) return `There is no guide for "${hit.title}" yet. Offer to make one with create_game_guide.`
  if (guide.status === 'generating') {
    return `The guide for "${hit.title}" is still being built — ${guide.phase ?? 'working on it'}. ` +
           `${guide.sections.length} sections planned so far.`
  }
  if (guide.status === 'failed') {
    return `The guide for "${hit.title}" failed to generate: ${guide.error ?? 'unknown error'}. ` +
           `Offer to try again.`
  }

  const p = guideProgress(guide)
  const perSection = guide.sections
    .filter(s => s.steps.length > 0)
    .map(s => `${s.title} ${s.steps.filter(x => x.done).length}/${s.steps.length}`)
    .join(', ')
  return `"${guide.title}" is ${p.percent}% complete — ${p.counted.done} of ${p.counted.total} steps that count ` +
         `toward 100%${p.all.total !== p.counted.total ? ` (${p.all.total} including reference sections)` : ''}. ` +
         `By section: ${perSection}.`
}

function checkOffGuideStep(title: string, step: string, done: boolean): string {
  const q = step.trim().toLowerCase()
  if (q.length < 4) return 'Error: describe the step in a few words so the right one can be found.'

  const items = readMedia()
  const hit = title.trim() ? findByTitle(items, title) : undefined
  // With no title, fall back to the only game that has a guide in progress —
  // usually exactly what "tick off the bow" means while playing one game.
  const candidates = hit ? [hit] : items.filter(i => i.type === 'game' && loadGuide(i.id)?.status === 'ready')
  if (candidates.length === 0) return `No game guide matching "${title}".`
  if (candidates.length > 1) {
    return `Which game? There are guides for: ${candidates.map(c => c.title).join(', ')}. Ask the user.`
  }

  const target = candidates[0]!
  const guide = loadGuide(target.id)
  if (!guide) return `There is no guide for "${target.title}" yet.`

  // Same guard as `forget`: this is driven by a speech-to-text transcript, and
  // ticking the wrong box silently corrupts the user's own record of what they
  // have actually played.
  const matches = guide.sections.flatMap(sec =>
    sec.steps.filter(s => s.text.toLowerCase().includes(q)).map(s => ({ sec, step: s })),
  )
  if (matches.length === 0) return `No step in the "${guide.title}" guide mentions "${step}".`
  if (matches.length > 3) {
    return `"${step}" matches ${matches.length} steps in the "${guide.title}" guide — too many to be sure. ` +
           `Ask the user to be more specific.`
  }
  if (matches.length > 1) {
    return `"${step}" matches ${matches.length} steps: ${matches.map(m => `"${m.step.text}"`).join(' / ')}. ` +
           `Ask the user which one they mean.`
  }

  const only = matches[0]!
  if (only.step.done === done) {
    return `"${only.step.text}" is already marked ${done ? 'done' : 'not done'} in the guide for ${guide.title}.`
  }
  const updated = setStepDone(target.id, only.sec.id, only.step.id, done)
  if (!updated) return `Error: could not update that step.`
  // Push it so an open guide ticks the box as the words land, rather than waiting
  // for the next time the view is opened.
  pushGuide(updated)
  const p = guideProgress(updated)
  console.log(`[chat:tool] check_off_guide_step → "${only.step.text.slice(0, 50)}" ${done ? 'done' : 'undone'} (${p.percent}%)`)
  return `Marked "${only.step.text}" as ${done ? 'done' : 'not done'} in the guide for ${guide.title} — ` +
         `now ${p.percent}% complete (${p.counted.done} of ${p.counted.total}).`
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
        'Pick the type that best fits (game / show / movie). Cover art is fetched automatically. ' +
        'If the result says the artwork match was not exact, or that no artwork was found, the title ' +
        'is probably misheard or misspelled — ask the user to confirm the correct title and then call ' +
        'rename_media_item. Do not silently accept a wrong title.',
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
      name: 'rename_media_item',
      description:
        'Correct the title of an item already on the playlist, and re-fetch its cover art. ' +
        'Use this after add_media_item reports a loose match or no artwork and the user has ' +
        'confirmed the right title, or whenever the user says an entry is spelled wrong.',
      parameters: {
        type: 'object',
        properties: {
          title:     { type: 'string', description: 'Current title of the item (substring match).' },
          new_title: { type: 'string', description: 'The corrected title.' },
        },
        required: ['title', 'new_title'],
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
      name: 'add_notion_task',
      description:
        "Add a to-do / task to the user's Notion task list. Use this whenever the user wants to capture, " +
        'jot down, remember, or be reminded of something they need to DO (an errand, a work item, a follow-up, ' +
        'a chore) — e.g. "add email the landlord to my tasks", "remind me to book the dentist tomorrow", ' +
        '"put finish the report on my list for Friday". This is for actionable to-dos; for games, shows, or ' +
        'movies to play or watch, use add_media_item instead.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task text — what needs doing.' },
          due:   { type: 'string', description: 'Optional due date: "today", "tomorrow", a weekday like "next friday", a relative offset like "+3", or YYYY-MM-DD. Omit if the user gave no date.' },
        },
        required: ['title'],
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
        'Use this for stable facts (the user\'s name, recurring routines, important dates) — ' +
        'scope "long" — or for context you only need for the rest of the day (current project, mood, what they\'re working on) — scope "short". ' +
        'For how they like ANSWERS shaped (video vs. spoken, short vs. detailed), use remember_preference instead. ' +
        'Long-term memories never expire; short-term memories are auto-deleted after 24 hours. ' +
        'Phrase the content as a complete factual statement (e.g. "The user\'s name is Daniel", not "Daniel"). ' +
        'Don\'t use this for trivia the user can easily restate; reserve it for things they\'d be annoyed to repeat.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact or note to remember, as a complete sentence.' },
          scope:   { type: 'string', enum: ['short', 'long'], description: '"long" = forever, "short" = 24h.' },
          topic:   { type: 'string', enum: ['people', 'food', 'home', 'media', 'games', 'work', 'schedule', 'health', 'other'], description: 'What it is about, so the memory screen can file it.' },
        },
        required: ['content', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_preference',
      description:
        'Save a pattern about HOW this user likes to be answered, so you get the format right unprompted next time. ' +
        'Use it when you notice the shape of what they want, not the content: they asked for a video walkthrough ' +
        'of a game section, they wanted a recipe shown on screen rather than read aloud, they prefer short answers ' +
        'about a recurring subject. Phrase it as when/then: ' +
        '"When the user asks how to get past a part of a game, they usually want a video tutorial on screen." ' +
        'Only save a pattern you have actually observed — one clear request is enough, a guess is not. ' +
        'Preferences are applied as OFFERS, not assumptions, so saving one will never railroad the user.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The preference as one when/then sentence about the user.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description:
        'Remove memories that match a query. Matches by case-insensitive substring against the stored content. ' +
        'Pass a DISTINCTIVE phrase from the specific memory you mean — a broad word like "name" or "game" will be ' +
        'refused if it matches several memories, and the refusal lists them so you can retry with something precise. ' +
        'Use this when the user contradicts a saved fact, asks you to forget something, or when stored info goes stale.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A distinctive substring of the memory to remove (3+ characters).' },
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
  {
    type: 'function',
    function: {
      name: 'set_timer',
      description:
        'Start a countdown timer that rings on the dashboard when it elapses. Use for any relative duration ' +
        '("set a timer for 10 minutes", "remind me in 90 seconds", "20 minute timer for the pasta"). ' +
        'Provide the duration with the hours/minutes/seconds fields. Add a short label only if the user named ' +
        'what the timer is for (e.g. "pasta", "laundry"). For an absolute clock time use set_alarm instead.',
      parameters: {
        type: 'object',
        properties: {
          hours:   { type: 'number', description: 'Whole hours of the countdown.' },
          minutes: { type: 'number', description: 'Whole minutes of the countdown.' },
          seconds: { type: 'number', description: 'Whole seconds of the countdown.' },
          label:   { type: 'string', description: 'Optional short name for what the timer is for.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_alarm',
      description:
        'Set an alarm that rings at a specific wall-clock time ("wake me at 7:30 am", "alarm for 6 pm"). ' +
        'A one-shot alarm resolves to the next future occurrence of that time. Pass repeat to make it recur ' +
        '("every weekday at 7", "daily alarm at 8am", "wake me at 6 on weekends"). For a relative countdown ' +
        'use set_timer instead.',
      parameters: {
        type: 'object',
        properties: {
          time:   { type: 'string', description: 'Clock time, e.g. "7:30 am", "19:00", "noon", "midnight".' },
          label:  { type: 'string', description: 'Optional short name for the alarm.' },
          repeat: { type: 'string', description: 'Optional recurrence: "daily", "weekdays", "weekends", or day names like "mon, wed, fri". Omit for a one-time alarm.' },
        },
        required: ['time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_timers',
      description: 'List the active timers and alarms with their remaining time / ring time.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_timer',
      description:
        'Cancel a timer or alarm. Pass the label (or "timer"/"alarm") to target a specific one, "all" to clear ' +
        'everything, or leave the query empty when there is only one. Use when the user says "cancel the timer", ' +
        '"stop the pasta timer", "turn off my alarm".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Label to match, "all", or empty for the only active timer.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_game_guide',
      description:
        'Research and build a step-by-step GAME GUIDE for one of the user\'s games, attached to it in the ' +
        'Watch/Play list. Use this whenever the user asks for a guide, a walkthrough, a checklist, ' +
        'a 100% completion route, or help getting through a game ("make me a guide for Majora\'s Mask", ' +
        '"I want a checklist for Hollow Knight"). The guide is organized the way that game\'s community ' +
        'organizes it (a section per dungeon or chapter, plus collectibles and side quests), every step is ' +
        'tickable, and each section gets a video. If the game is not on the playlist yet it is added ' +
        'automatically. Generation takes a few minutes and continues after the conversation ends, so ' +
        'confirm that you have started it — never claim it is finished. For a single video or one quick ' +
        'answer use play_video or web_search instead; this is for a whole game.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The game\'s title, as the user said it.' },
          order: {
            type: 'string',
            description:
              'Only when the user asked for a specific organization, e.g. "by boss order", ' +
              '"speedrun route", "just the side quests". Leave empty to use how the community organizes it.',
          },
          source: {
            type: 'string',
            description:
              'Only when the user named a specific website to build the guide from ("use zeldadungeon.net", ' +
              '"base it on ign.com"). Pass the site\'s domain or URL. That site is researched first and the ' +
              'game\'s wiki is the fallback. Leave empty to use the community wiki as the primary source.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_game_guide_progress',
      description:
        'Read how far the user has got in a game guide — the overall completion percentage and the ' +
        'per-section counts. Use for "how far am I in Majora\'s Mask?", "what\'s left?", ' +
        '"is my guide ready yet?". Pass no title to report on every guide.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The game\'s title. Omit for all guides.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_off_guide_step',
      description:
        'Tick (or untick) one step in a game guide, for when the user reports progress out loud while ' +
        'playing ("I got the bow", "beat Odolwa", "done with the Woodfall temple key"). Pass a few ' +
        'distinctive words from the step; if they match more than one step you will be told to ask which. ' +
        'Do not use this to mark a whole game finished — that is set_media_status.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The game\'s title. Omit if only one game has a guide.' },
          step:  { type: 'string', description: 'Distinctive words from the step, e.g. "Odolwa" or "hero\'s bow".' },
          done:  { type: 'boolean', description: 'true to tick it off (default), false to un-tick it.' },
        },
        required: ['step'],
      },
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
    case 'rename_media_item':  return renameMedia(str('title'), str('new_title'))
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
    case 'add_notion_task':      return addNotionTask(str('title'), str('due'))
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
    case 'remember':            return rememberFact(str('content'), str('scope'), str('topic'))
    case 'remember_preference': return rememberPreference(str('content'))
    case 'forget':             return forgetFact(str('query'))
    case 'list_memories':      return listMemoriesTool()
    case 'set_timer': {
      const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : 0)
      return setTimer(num('hours'), num('minutes'), num('seconds'), str('duration'), str('label'))
    }
    case 'set_alarm':          return setAlarm(str('time'), str('label'), str('repeat'))
    case 'list_timers':        return listTimers()
    case 'cancel_timer':       return cancelTimer(str('query'))
    case 'create_game_guide':  return createGameGuide(str('title'), str('order'), str('source'))
    case 'get_game_guide_progress': return getGameGuideProgress(str('title'))
    case 'check_off_guide_step': {
      const done = typeof args['done'] === 'boolean' ? (args['done'] as boolean) : true
      return checkOffGuideStep(str('title'), str('step'), done)
    }
    default: return null
  }
}

// Names that, if successfully invoked, mutate persisted state. Used by the
// chat route to tell the client which slices to refetch.
export const MUTATING_TOOLS = new Set([
  'add_media_item',
  'rename_media_item',
  'remove_media_item',
  'mark_media_done',
  'set_media_status',
  'star_media_item',
  'set_app_mode',
  'add_notion_task',
  'remember',
  'remember_preference',
  'forget',
  'set_timer',
  'set_alarm',
  'cancel_timer',
  'create_game_guide',
  'check_off_guide_step',
])

// Maps a mutating tool to the client-side state slice(s) it touches, so the chat
// route can tell exactly which widgets/hooks should refetch. A tool that writes
// to two stores lists both.
export const TOOL_SLICE: Record<string, string | string[]> = {
  set_app_mode:        'mode',
  add_notion_task:     'notion',
  set_timer:           'timers',
  set_alarm:           'timers',
  cancel_timer:        'timers',
  // Memory tools used to fall through to the 'media' default, so every
  // remembered fact triggered a pointless media-list refetch on the client.
  remember:            'memory',
  remember_preference: 'memory',
  forget:              'memory',
  // Guides live in their own store and their own hook. create_game_guide also
  // adds the game to the playlist when it isn't there yet, so it touches both.
  create_game_guide:   ['guides', 'media'],
  check_off_guide_step: 'guides',
  // everything else defaults to 'media'
}
