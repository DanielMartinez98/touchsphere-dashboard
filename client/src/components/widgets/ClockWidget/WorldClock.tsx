import { useClock } from '../../../hooks/useClock'

const ZONES = [
  { label: 'Local',     tz: undefined },
  { label: 'New York',  tz: 'America/New_York' },
  { label: 'London',    tz: 'Europe/London' },
  { label: 'Paris',     tz: 'Europe/Paris' },
  { label: 'Dubai',     tz: 'Asia/Dubai' },
  { label: 'Tokyo',     tz: 'Asia/Tokyo' },
  { label: 'Sydney',    tz: 'Australia/Sydney' },
  { label: 'LA',        tz: 'America/Los_Angeles' },
]

export default function WorldClock() {
  const now = useClock()

  return (
    <div className="flex flex-col h-full p-6 pt-16 gap-4">
      <h2 className="text-2xl font-bold text-white/80 mb-2">World Clock</h2>
      <div className="grid grid-cols-2 gap-3 flex-1">
        {ZONES.map(({ label, tz }) => {
          const time = now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: tz,
          })
          const date = now.toLocaleDateString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            timeZone: tz,
          })
          return (
            <div key={label} className="bg-white/5 rounded-2xl p-4 flex flex-col gap-1">
              <span className="text-xs text-white/40 uppercase tracking-wider">{label}</span>
              <span className="text-2xl font-bold text-cyan-400">{time}</span>
              <span className="text-xs text-white/30">{date}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
