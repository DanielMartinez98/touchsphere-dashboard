import { useCalendar } from '../../../hooks/useCalendar'

export function CalendarCollapsed() {
  const { events, loading, error } = useCalendar()

  if (loading) return <span className="text-xs text-white/40">Loading...</span>
  if (error) return (
    <>
      <span className="text-lg">📅</span>
      <span className="text-xs text-red-400">Calendar unavailable</span>
    </>
  )

  const now = new Date()
  const upcoming = events.filter(e => new Date(e.end) > now)
  const next = upcoming[0]

  return (
    <>
      <span className="text-lg">📅</span>
      {next ? (
        <>
          <span className="text-xs font-semibold text-cyan-300 leading-tight truncate w-full">
            {next.title}
          </span>
          <span className="text-xs text-white/40">
            {new Date(next.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </>
      ) : (
        <span className="text-xs text-white/50">No more events today</span>
      )}
    </>
  )
}
