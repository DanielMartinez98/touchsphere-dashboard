import { Router, Request, Response } from 'express'
import ical, { VEvent } from 'node-ical'
import fs from 'fs'
import path from 'path'

const router = Router()

// ── Disk + memory calendar cache ─────────────────────────────────────────────
// Calendar data barely changes — fetching Google iCal on every request wastes
// network and risks Google rate-limiting. Strategy:
//   1. In-memory cache (fast path) — 15 min TTL
//   2. Disk cache (survives container restart) — same files, read on cold miss
//   3. Live fetch — updates both caches
//
// CACHE_DIR defaults to /tmp/touchsphere-cache (set via env for a Docker volume).
const CALENDAR_TTL_MS = 15 * 60 * 1000

interface CacheEntry { events: CalendarEvent[]; ts: number }
const memCache = new Map<string, CacheEntry>()

function cacheDir(): string {
  return process.env['CACHE_DIR'] ?? path.join(process.cwd(), '.cache')
}
function diskPath(key: string): string {
  // Sanitise key so it's safe as a filename
  return path.join(cacheDir(), `calendar-${key.replace(/[^a-z0-9-]/gi, '_')}.json`)
}
function readDisk(key: string): CacheEntry | null {
  try {
    const raw = fs.readFileSync(diskPath(key), 'utf8')
    return JSON.parse(raw) as CacheEntry
  } catch { return null }
}
function writeDisk(key: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(diskPath(key), JSON.stringify(entry), 'utf8')
  } catch (e) { console.warn('[calendar] disk write failed:', e) }
}
// Returns fresh-enough events from memory → disk → null (must fetch)
function getCached(key: string): CalendarEvent[] | null {
  const mem = memCache.get(key)
  if (mem && Date.now() - mem.ts < CALENDAR_TTL_MS) return mem.events
  const disk = readDisk(key)
  if (disk && Date.now() - disk.ts < CALENDAR_TTL_MS) {
    memCache.set(key, disk)   // warm memory cache from disk
    return disk.events
  }
  return null
}
function setCached(key: string, events: CalendarEvent[]): void {
  const entry: CacheEntry = { events, ts: Date.now() }
  memCache.set(key, entry)
  writeDisk(key, entry)
}
// Returns stale disk data to serve while a live fetch fails (offline fallback)
function getStaleFallback(key: string): CalendarEvent[] | null {
  try { return (readDisk(key) ?? memCache.get(key))?.events ?? null } catch { return null }
}

interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
}

// Format a Date as YYYY-MM-DD using its UTC parts.
// iCal date-only values arrive as UTC midnight, so UTC date = the intended calendar date.
function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toEvent(key: string, event: VEvent): CalendarEvent {
  const startTime = event.start instanceof Date ? event.start : new Date(event.start)
  const endTime = event.end instanceof Date ? event.end : new Date(event.end ?? event.start)

  const allDay =
    startTime.getHours() === 0 &&
    startTime.getMinutes() === 0 &&
    startTime.getSeconds() === 0 &&
    startTime.toDateString() !== endTime.toDateString()

  // All-day: store as YYYY-MM-DD so the client never shifts the date across timezones.
  // Timed: store as full ISO so the client can display the correct local time.
  return {
    id: key,
    title: (event.summary as string) ?? '(No title)',
    start: allDay ? utcDateStr(startTime) : startTime.toISOString(),
    end: allDay ? utcDateStr(endTime) : endTime.toISOString(),
    allDay,
  }
}

const ICAL_TIMEOUT_MS = 10_000

function fetchIcal(url: string) {
  return Promise.race([
    ical.async.fromURL(url),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('iCal fetch timed out')), ICAL_TIMEOUT_MS)
    ),
  ])
}

// GET /api/calendar/today
router.get('/today', async (_req: Request, res: Response) => {
  const icalUrl = process.env['CALENDAR_ICAL_URL']
  if (!icalUrl) { res.status(500).json({ error: 'Calendar URL not configured' }); return }

  const key = 'today'
  const cached = getCached(key)
  if (cached) {
    console.log('[calendar] cache hit for today')
    res.json({ events: cached })
    return
  }

  try {
    const data = await fetchIcal(icalUrl)
    const today = new Date()
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)

    const events: CalendarEvent[] = []

    for (const key in data) {
      const component = data[key]
      if (!component || component.type !== 'VEVENT') continue
      const event = component as VEvent

      const startTime = event.start instanceof Date ? event.start : new Date(event.start)
      const endTime = event.end instanceof Date ? event.end : new Date(event.end ?? event.start)

      // Inclusive end boundary: an event starting exactly at midnight (todayEnd) still belongs to today
      if (!(startTime <= todayEnd && endTime > todayStart)) continue

      events.push(toEvent(key, event))
    }

    events.sort((a, b) => a.start.localeCompare(b.start))
    setCached('today', events)
    console.log(`[calendar] fetched fresh today (${events.length} events)`)
    res.json({ events })
  } catch (err) {
    console.error('Calendar /today error:', err)
    const fallback = getStaleFallback('today')
    if (fallback) {
      console.warn('[calendar] serving stale fallback for today')
      res.json({ events: fallback })
    } else {
      res.status(502).json({ error: 'Failed to fetch calendar' })
    }
  }
})

// GET /api/calendar/month?year=2026&month=4 (month is 0-indexed)
router.get('/month', async (req: Request, res: Response) => {
  const icalUrl = process.env['CALENDAR_ICAL_URL']
  if (!icalUrl) { res.status(500).json({ error: 'Calendar URL not configured' }); return }

  const year = parseInt(req.query['year'] as string) || new Date().getFullYear()
  const month = parseInt(req.query['month'] as string)
  const safeMonth = isNaN(month) ? new Date().getMonth() : month

  const cacheKey = `month-${year}-${safeMonth}`
  const cached = getCached(cacheKey)
  if (cached) {
    console.log(`[calendar] cache hit for ${cacheKey}`)
    res.json({ events: cached })
    return
  }

  const monthStart = new Date(year, safeMonth, 1)
  const monthEnd = new Date(year, safeMonth + 1, 1)

  try {
    const data = await fetchIcal(icalUrl)
    const events: CalendarEvent[] = []

    for (const key in data) {
      const component = data[key]
      if (!component || component.type !== 'VEVENT') continue
      const event = component as VEvent

      const startTime = event.start instanceof Date ? event.start : new Date(event.start)
      const endTime = event.end instanceof Date ? event.end : new Date(event.end ?? event.start)

      if (startTime >= monthEnd || endTime <= monthStart) continue

      events.push(toEvent(key, event))
    }

    events.sort((a, b) => a.start.localeCompare(b.start))
    setCached(cacheKey, events)
    console.log(`[calendar] fetched fresh ${cacheKey} (${events.length} events)`)
    res.json({ events })
  } catch (err) {
    console.error('Calendar /month error:', err)
    const fallback = getStaleFallback(cacheKey)
    if (fallback) {
      console.warn(`[calendar] serving stale fallback for ${cacheKey}`)
      res.json({ events: fallback })
    } else {
      res.status(502).json({ error: 'Failed to fetch calendar' })
    }
  }
})

export default router
