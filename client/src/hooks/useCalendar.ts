import { useState, useEffect } from 'react'
import type { CalendarEvent } from '../types'

export function useCalendar() {
  const [events, setEvents] = useState<CalendarEvent[]>([])
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
          setEvents(data.events ?? [])
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
