import { Timer, AlarmClock, Hourglass } from 'lucide-react'
import { useClock } from '../../../hooks/useClock'
import { formatRemaining, formatClock, type TimersApi } from '../../../hooks/useTimers'
import { formatStopwatch, type StopwatchApi } from '../../../hooks/useStopwatch'

export function ClockCollapsed({ timers, stopwatch }: { timers?: TimersApi; stopwatch?: StopwatchApi }) {
  const now = useClock()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  // Surface the most relevant active tool so the pill hints these exist and is
  // glanceable: a running stopwatch, else the soonest pending timer/alarm.
  const next = timers?.timers[0]
  let badge: { icon: React.ReactElement; text: string } | null = null
  if (stopwatch?.running) {
    badge = { icon: <Timer size={16} />, text: formatStopwatch(stopwatch.elapsed) }
  } else if (next) {
    badge = next.kind === 'alarm'
      ? { icon: <AlarmClock size={16} />, text: formatClock(next.fireAt) }
      : { icon: <Hourglass size={16} />, text: formatRemaining(next.fireAt - now.getTime()) }
  }

  return (
    <>
      <span className="text-3xl font-bold font-display tracking-tight tabular-nums text-white">{time}</span>
      <span className="text-sm text-ink-mid">{date}</span>
      {badge && (
        <span className="mt-1 flex items-center gap-1.5 text-purple-300 text-sm font-display tabular-nums">
          <span aria-hidden>{badge.icon}</span>
          {badge.text}
        </span>
      )}
    </>
  )
}
