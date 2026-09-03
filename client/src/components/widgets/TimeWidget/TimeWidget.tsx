// Calendar and clock, merged into the one top-right corner.
//
// They were two separate corners (calendar top-right, clock bottom-right) until
// the bottom-left slot was needed for image generation. Merging them is the
// cheap move because they answer the same question from two directions — "what
// time is it and what's next" — and a glance at the corner now answers both
// without a second tap.
//
// The collapsed pill is ordered by how often it's actually read: the time is the
// thing you look up twenty times a day, so it stays the big number the clock
// pill always was; the weather sits beside the date (it moved in from the
// top-left corner when Plex needed it — one line, temperature and sky, since
// the full map is a tab away); the next event sits under that, and a running
// timer or alarm keeps its purple badge at the bottom.

import { useState } from 'react'
import { CalendarDays, Timer, AlarmClock, Hourglass, Thermometer } from 'lucide-react'
import { useClock } from '../../../hooks/useClock'
import { useCalendar } from '../../../hooks/useCalendar'
import { useWeather } from '../../../hooks/useWeather'

const ICON_URL = (code: string) => `https://openweathermap.org/img/wn/${code}@2x.png`

function WeatherLine() {
  const { weather, error } = useWeather()
  const [iconError, setIconError] = useState(false)
  if (error || !weather) return null
  return (
    <span className="flex items-center gap-1 w-full justify-end -mt-0.5">
      {iconError ? (
        <Thermometer size={16} className="text-sky-300 shrink-0" />
      ) : (
        <img src={ICON_URL(weather.icon)} alt="" className="w-7 h-7 -my-1.5 shrink-0" onError={() => setIconError(true)} />
      )}
      <span className="text-sm font-semibold tabular-nums text-white">{Math.round(weather.temp)}°</span>
      <span className="text-[13px] text-ink-dim capitalize truncate">{weather.description}</span>
    </span>
  )
}
import { formatRemaining, formatClock, type TimersApi } from '../../../hooks/useTimers'
import { formatStopwatch, type StopwatchApi } from '../../../hooks/useStopwatch'

export function TimeCollapsed({ timers, stopwatch }: { timers?: TimersApi; stopwatch?: StopwatchApi }) {
  const now = useClock()
  const { events, error } = useCalendar()

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  const upcoming = events.filter(e => new Date(e.end) > now)
  const next = upcoming[0]

  // Surface the most relevant active tool so the pill hints these exist: a
  // running stopwatch, else the soonest pending timer/alarm.
  const soonest = timers?.timers[0]
  let badge: { icon: React.ReactElement; text: string } | null = null
  if (stopwatch?.running) {
    badge = { icon: <Timer size={16} />, text: formatStopwatch(stopwatch.elapsed) }
  } else if (soonest) {
    badge = soonest.kind === 'alarm'
      ? { icon: <AlarmClock size={16} />, text: formatClock(soonest.fireAt) }
      : { icon: <Hourglass size={16} />, text: formatRemaining(soonest.fireAt - now.getTime()) }
  }

  return (
    <>
      <span className="text-3xl font-bold font-display tracking-tight tabular-nums text-white">{time}</span>
      <span className="text-sm text-ink-mid">{date}</span>
      <WeatherLine />

      {/* The agenda line. Deliberately one line and truncated — the pill is a
          glance, and the full day is one tap away in the Calendar tab. */}
      <span className="mt-1 flex items-center gap-1.5 w-full justify-end">
        <CalendarDays size={15} className="text-yellow-300/80 shrink-0" />
        {error ? (
          <span className="text-[13px] text-red-400">Calendar unavailable</span>
        ) : next ? (
          <span className="text-[13px] text-cyan-300 font-semibold truncate text-right">
            {new Date(next.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' · '}{next.title}
          </span>
        ) : (
          <span className="text-[13px] text-ink-dim">Nothing left today</span>
        )}
      </span>

      {badge && (
        <span className="flex items-center gap-1.5 text-purple-300 text-sm font-display tabular-nums">
          <span aria-hidden>{badge.icon}</span>
          {badge.text}
        </span>
      )}
    </>
  )
}
