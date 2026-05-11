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
type MediaType = 'game' | 'show' | 'movie'
interface MediaItem {
  id: string
  title: string
  type: MediaType
  done: boolean
}

function readMedia(): MediaItem[] {
  return readJSON<MediaItem[]>('media.json', [])
}
function writeMedia(items: MediaItem[]): void {
  writeJSON('media.json', items)
}

function listMedia(): string {
  const items = readMedia()
  if (items.length === 0) return 'The playlist is empty.'
  const fmt = (i: MediaItem) =>
    `- [${i.done ? 'x' : ' '}] ${i.title} (${i.type})`
  const open = items.filter(i => !i.done)
  const done = items.filter(i =>  i.done)
  const parts: string[] = []
  if (open.length) parts.push(`To play/watch (${open.length}):\n` + open.map(fmt).join('\n'))
  if (done.length) parts.push(`\nFinished (${done.length}):\n` + done.map(fmt).join('\n'))
  return parts.join('\n')
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
  hit.done = done
  writeMedia(items)
  console.log(`[chat:tool] mark_media_done → "${hit.title}" done=${done}`)
  return `Marked "${hit.title}" as ${done ? 'finished' : 'not finished'}.`
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
async function getWeather(): Promise<string> {
  // Resolve a lat/lon: prefer DEFAULT_LAT/LON, else geoip.
  let lat = parseFloat(process.env['DEFAULT_LAT'] ?? '')
  let lon = parseFloat(process.env['DEFAULT_LON'] ?? '')
  if (!isFinite(lat) || !isFinite(lon)) {
    const geo = await localGet<{ lat?: number; lon?: number }>('/api/geoip')
    if (geo && typeof geo.lat === 'number' && typeof geo.lon === 'number') {
      lat = geo.lat; lon = geo.lon
    }
  }
  if (!isFinite(lat) || !isFinite(lon)) return 'Weather unavailable: no location.'
  const w = await localGet<{
    temp: number; feels_like: number; description: string; city?: string;
    humidity: number; wind_speed: number; rain_chance?: number; clouds?: number;
  }>(`/api/weather?lat=${lat}&lon=${lon}`)
  if (!w) return 'Weather unavailable.'
  const place = w.city ?? 'your location'
  return `${place}: ${Math.round(w.temp)}°C (feels ${Math.round(w.feels_like)}°C), ${w.description}, ` +
         `humidity ${w.humidity}%, wind ${w.wind_speed} m/s, rain chance ${Math.round((w.rain_chance ?? 0) * 100)}%.`
}

async function getCalendarToday(): Promise<string> {
  const data = await localGet<{ events?: Array<{ title: string; start: string; allDay: boolean }> }>('/api/calendar/today')
  const events = data?.events ?? []
  if (events.length === 0) return 'No events on the calendar today.'
  return `Today's events:\n` + events.map(e => {
    if (e.allDay) return `- ${e.title} (all day)`
    const t = new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    return `- ${t} — ${e.title}`
  }).join('\n')
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
      name: 'get_device_status',
      description: 'CPU temperature, memory, load average, and uptime of the device running TouchSphere.',
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
    case 'get_weather':        return getWeather()
    case 'get_calendar_today': return getCalendarToday()
    case 'get_device_status':  return getDeviceStatus()
    default: return null
  }
}

// Names that, if successfully invoked, mutate persisted state. Used by the
// chat route to tell the client which slices to refetch.
export const MUTATING_TOOLS = new Set([
  'add_media_item',
  'remove_media_item',
  'mark_media_done',
])
