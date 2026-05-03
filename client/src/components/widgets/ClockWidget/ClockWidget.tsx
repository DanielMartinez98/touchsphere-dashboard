import { useClock } from '../../../hooks/useClock'

export function ClockCollapsed() {
  const now = useClock()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <>
      <span className="text-3xl font-bold tracking-tight text-white">{time}</span>
      <span className="text-xs text-white/50">{date}</span>
    </>
  )
}
