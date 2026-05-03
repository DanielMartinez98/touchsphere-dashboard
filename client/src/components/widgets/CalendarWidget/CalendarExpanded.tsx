import { useState, useEffect } from 'react'
import { fetchMonthEvents } from '../../../hooks/useCalendar'
import type { CalendarEvent } from '../../../types'

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}

export default function CalendarExpanded() {
  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState(today.getDate())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loadingMonth, setLoadingMonth] = useState(false)

  useEffect(() => {
    setLoadingMonth(true)
    fetchMonthEvents(viewYear, viewMonth)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoadingMonth(false))
  }, [viewYear, viewMonth])

  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth)
  const monthName = new Date(viewYear, viewMonth).toLocaleString('default', { month: 'long' })

  const selectedDate = new Date(viewYear, viewMonth, selectedDay)

  // Smart date key: handles both YYYY-MM-DD (all-day) and full ISO strings (timed)
  function toDateKey(s: string): string {
    if (s.length === 10) return s // already YYYY-MM-DD
    const d = new Date(s)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const selectedKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`
  const dayEvents = events.filter(e => toDateKey(e.start) === selectedKey)

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  return (
    <div className="flex flex-col h-full p-4 pt-16 gap-4">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="w-10 h-10 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">‹</button>
        <h2 className="text-xl font-bold text-white">{monthName} {viewYear}</h2>
        <button onClick={nextMonth} className="w-10 h-10 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">›</button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 text-center">
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
          <span key={d} className="text-xs text-white/30 py-1">{d}</span>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1
          const isToday = day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear()
          const isSelected = day === selectedDay
          const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const hasEvent = events.some(e => (e.start.length === 10 ? e.start : e.start.substring(0, 10)) === dateStr)
          return (
            <button
              key={day}
              onClick={() => setSelectedDay(day)}
              className={`
                aspect-square rounded-xl text-sm font-medium flex flex-col items-center justify-center gap-0.5
                ${isSelected ? 'bg-cyan-500 text-black' : isToday ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 active:bg-white/20'}
              `}
            >
              {day}
              {hasEvent && <span className={`w-1 h-1 rounded-full ${isSelected ? 'bg-black' : 'bg-cyan-400'}`} />}
            </button>
          )
        })}
      </div>

      {/* Events for selected day */}
      <div className="flex-1 overflow-auto mt-2">
        <h3 className="text-sm text-white/40 mb-2">
          {selectedDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </h3>
        {dayEvents.length === 0 ? (
          <p className="text-white/30 text-sm">No events</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dayEvents.map((ev: CalendarEvent) => (
              <div key={ev.id} className="bg-white/5 rounded-xl p-3">
                <p className="font-semibold text-white text-sm">{ev.title}</p>
                {!ev.allDay && (
                  <p className="text-xs text-cyan-400 mt-0.5">
                    {new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {' – '}
                    {new Date(ev.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
