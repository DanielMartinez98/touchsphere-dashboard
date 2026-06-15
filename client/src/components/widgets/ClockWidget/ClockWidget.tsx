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
  let badge: { icon: string; text: string } | null = null
  if (stopwatch?.running) {
    badge = { icon: '⏱', text: formatStopwatch(stopwatch.elapsed) }
  } else if (next) {
    badge = next.kind === 'alarm'
      ? { icon: '⏰', text: formatClock(next.fireAt) }
      : { icon: '⏲', text: formatRemaining(next.fireAt - now.getTime()) }
  }

  return (
    <>
      <span className="text-3xl font-bold tracking-tight text-white">{time}</span>
      <span className="text-xs text-white/50">{date}</span>
      {badge && (
        <span className="mt-1 flex items-center gap-1.5 text-purple-300 text-sm font-mono tabular-nums">
          <span aria-hidden>{badge.icon}</span>
          {badge.text}
        </span>
      )}
    </>
  )
}
