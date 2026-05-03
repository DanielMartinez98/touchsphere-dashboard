import { useState, useEffect } from 'react'
import type { CalendarEvent } from '../types'

// ── localStorage cache for today’s events ───────────────────────────────────
const LS_TODAY_KEY = 'ts_calendar_today'
function _loadTodayCache(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(LS_TODAY_KEY)
    return raw ? (JSON.parse(raw) as CalendarEvent[]) : []
  } catch { return [] }
}
function _saveTodayCache(events: CalendarEvent[]) {
  try { localStorage.setItem(LS_TODAY_KEY, JSON.stringify(events)) } catch {}
}

export function useCalendar() {
  // Initialise from localStorage so the widget renders immediately without a
  // loading flash on page reload, then the server fetch updates in the background.
  const [events, setEvents] = useState<CalendarEvent[]>(_loadTodayCache)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetchToday() {
      try {
        const res = await fetch('/api/calendar/today')
        if (!res.ok) throw new Error('Calendar fetch failed')
        const data = await res.json()
        if (!cancelled) {
          const fetched: CalendarEvent[] = data.events ?? []
          setEvents(fetched)
          _saveTodayCache(fetched)
          setError(null)
        }
      } catch {
        if (!cancelled) setError('Could not load calendar')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchToday()
    const id = setInterval(fetchToday, 5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return { events, loading, error }
}

export async function fetchMonthEvents(year: number, month: number): Promise<CalendarEvent[]> {
  const res = await fetch(`/api/calendar/month?year=${year}&month=${month}`)
  if (!res.ok) throw new Error('Month fetch failed')
  const data = await res.json()
  return data.events ?? []
}
