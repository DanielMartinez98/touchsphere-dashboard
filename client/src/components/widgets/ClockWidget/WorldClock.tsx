import { useClock } from '../../../hooks/useClock'
import { formatRemaining, formatClock, type TimersApi } from '../../../hooks/useTimers'

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

// Quick-add presets so a timer can be started by touch when voice isn't handy.
const PRESETS: { label: string; ms: number }[] = [
  { label: '1m',  ms: 1 * 60_000 },
  { label: '3m',  ms: 3 * 60_000 },
  { label: '5m',  ms: 5 * 60_000 },
  { label: '10m', ms: 10 * 60_000 },
  { label: '15m', ms: 15 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
]

export default function WorldClock({ timers }: { timers?: TimersApi }) {
  const now = useClock()

  return (
    <div className="flex flex-col h-full p-6 pt-16 gap-4 overflow-y-auto">
      <h2 className="text-2xl font-bold text-white/80 mb-1">World Clock</h2>
      <div className="grid grid-cols-2 gap-3">
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

      {/* ── Timers & alarms ── */}
      {timers && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-bold text-white/80">Timers</h3>
            <span className="text-white/30 text-xs">Tap to start · say “set a timer”</span>
          </div>

          <div className="grid grid-cols-6 gap-2 mb-3">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => void timers.addTimer(p.ms)}
                className="py-3 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 active:scale-95 text-purple-200 text-sm font-semibold border border-purple-400/25 transition-all"
              >
                {p.label}
              </button>
            ))}
          </div>

          {timers.timers.length === 0 ? (
            <p className="text-white/30 text-sm py-2">No active timers or alarms.</p>
          ) : (
            <div className="space-y-2">
              {timers.timers.map(t => {
                const isAlarm = t.kind === 'alarm'
                const remaining = t.fireAt - now.getTime()
                return (
                  <div key={t.id} className="flex items-center gap-3 bg-white/5 rounded-2xl px-4 py-3 border border-white/8">
                    <span className="text-purple-300 text-xs uppercase tracking-wider w-12 flex-shrink-0">
                      {isAlarm ? 'Alarm' : 'Timer'}
                    </span>
                    <span className="text-white font-mono text-xl font-semibold tabular-nums flex-1">
                      {isAlarm ? formatClock(t.fireAt) : formatRemaining(remaining)}
                    </span>
                    {t.label && <span className="text-white/40 text-xs truncate max-w-[30%]">{t.label}</span>}
                    <button
                      onClick={() => timers.cancel(t.id)}
                      aria-label="Cancel"
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white/40 hover:text-white/90 hover:bg-white/10 active:scale-90 transition-all flex-shrink-0"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
