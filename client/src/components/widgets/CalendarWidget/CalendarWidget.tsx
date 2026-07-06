import { CalendarDays } from 'lucide-react'
import { useCalendar } from '../../../hooks/useCalendar'

export function CalendarCollapsed() {
  const { events, loading, error } = useCalendar()

  if (loading) return <span className="text-sm text-ink-dim">Loading...</span>
  if (error) return (
    <>
      <CalendarDays size={22} className="text-yellow-300/80" />
      <span className="text-sm text-red-400">Calendar unavailable</span>
    </>
  )

  const now = new Date()
  const upcoming = events.filter(e => new Date(e.end) > now)
  const next = upcoming[0]

  return (
    <>
      <CalendarDays size={22} className="text-yellow-300/80" />
      {next ? (
        <>
          <span className="text-sm font-semibold text-cyan-300 leading-tight truncate w-full">
            {next.title}
          </span>
          <span className="text-[13px] text-ink-dim tabular-nums">
            {new Date(next.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </>
      ) : (
        <span className="text-sm text-ink-dim">No more events today</span>
      )}
    </>
  )
}
