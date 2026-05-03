import { Router, Request, Response } from 'express'
import ical, { VEvent } from 'node-ical'

const router = Router()

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

// GET /api/calendar/today
router.get('/today', async (_req: Request, res: Response) => {
  const icalUrl = process.env['CALENDAR_ICAL_URL']
  if (!icalUrl) { res.status(500).json({ error: 'Calendar URL not configured' }); return }

  try {
    const data = await ical.async.fromURL(icalUrl)
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

      if (!(startTime < todayEnd && endTime > todayStart)) continue

      events.push(toEvent(key, event))
    }

    events.sort((a, b) => a.start.localeCompare(b.start))
    res.json({ events })
  } catch (err) {
    console.error('Calendar /today error:', err)
    res.status(502).json({ error: 'Failed to fetch calendar' })
  }
})

// GET /api/calendar/month?year=2026&month=4 (month is 0-indexed)
router.get('/month', async (req: Request, res: Response) => {
  const icalUrl = process.env['CALENDAR_ICAL_URL']
  if (!icalUrl) { res.status(500).json({ error: 'Calendar URL not configured' }); return }

  const year = parseInt(req.query['year'] as string) || new Date().getFullYear()
  const month = parseInt(req.query['month'] as string)
  const safeMonth = isNaN(month) ? new Date().getMonth() : month

  const monthStart = new Date(year, safeMonth, 1)
  const monthEnd = new Date(year, safeMonth + 1, 1)

  try {
    const data = await ical.async.fromURL(icalUrl)
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
    res.json({ events })
  } catch (err) {
    console.error('Calendar /month error:', err)
    res.status(502).json({ error: 'Failed to fetch calendar' })
  }
})

export default router
