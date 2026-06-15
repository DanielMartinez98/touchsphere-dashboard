import { formatRemaining, formatClock, formatRepeatDays, type TimersApi, type Timer } from '../hooks/useTimers'
import { formatStopwatch, type StopwatchApi } from '../hooks/useStopwatch'

/**
 * Ambient timer/alarm surface. Two parts:
 *   1. A glanceable column of countdown pills on the left edge (active, pending).
 *   2. A full-width ringing banner for any timer/alarm that has fired, with
 *      Dismiss + Snooze, mirroring the BedtimeBanner styling.
 *
 * Single source of truth lives in `useTimers` (mounted once in App); both this
 * overlay and the Clock widget share that instance.
 */
function TimerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2" />
      <path d="M9 2h6" />
    </svg>
  )
}
function AlarmIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}
function StopwatchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="14" r="7" />
      <path d="M12 14V11" />
      <path d="M9 2h6" />
      <path d="M18 7l1.5-1.5" />
    </svg>
  )
}

export function TimersOverlay({ timers, stopwatch }: { timers: TimersApi; stopwatch?: StopwatchApi }) {
  const { timers: pending, ringing, now, cancel, dismiss, snooze } = timers
  const showStopwatch = !!stopwatch?.running

  return (
    <>
      {/* ── Glanceable countdown pills (left edge, vertically centered) ── */}
      {(pending.length > 0 || showStopwatch) && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2 pointer-events-none">
          {pending.map(t => {
            const isAlarm = t.kind === 'alarm'
            const remaining = t.fireAt - now
            return (
              <div
                key={t.id}
                className="pointer-events-auto flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-2xl bg-black/55 backdrop-blur-md border border-purple-400/30 shadow-lg max-w-[44vw]"
              >
                <span className="text-purple-300 flex-shrink-0">{isAlarm ? <AlarmIcon /> : <TimerIcon />}</span>
                <div className="min-w-0">
                  <div className="text-white font-mono text-lg font-semibold leading-none tabular-nums">
                    {isAlarm ? formatClock(t.fireAt) : formatRemaining(remaining)}
                  </div>
                  {t.label
                    ? <div className="text-white/45 text-[10px] mt-0.5 truncate">{t.label}</div>
                    : isAlarm
                      ? <div className="text-white/45 text-[10px] mt-0.5">{t.repeatDays?.length ? formatRepeatDays(t.repeatDays) : 'alarm'}</div>
                      : null}
                </div>
                <button
                  onClick={() => cancel(t.id)}
                  aria-label="Cancel timer"
                  className="ml-1 w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white/90 hover:bg-white/10 active:scale-90 transition-all flex-shrink-0"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )
          })}

          {/* Running stopwatch — glanceable, no controls (manage it in the Clock widget). */}
          {showStopwatch && stopwatch && (
            <div className="flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-2xl bg-black/55 backdrop-blur-md border border-cyan-400/30 shadow-lg">
              <span className="text-cyan-300 flex-shrink-0"><StopwatchIcon /></span>
              <div className="text-white font-mono text-lg font-semibold leading-none tabular-nums">
                {formatStopwatch(stopwatch.elapsed)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Ringing banners (top center, stacked) ── */}
      {ringing.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[700] flex flex-col gap-2 w-[480px] max-w-[92%]">
          {ringing.map((t: Timer) => {
            const isAlarm = t.kind === 'alarm'
            const recurring = t.repeatDays?.length > 0
            const title = isAlarm ? (t.label || 'Alarm') : (t.label ? `${t.label} — done` : 'Timer done')
            const snoozeMs = isAlarm ? 5 * 60_000 : 60_000
            const snoozeLabel = isAlarm ? 'Snooze 5m' : '+1 min'
            return (
              <div
                key={t.id}
                className="bg-amber-500/25 border border-amber-400/50 backdrop-blur-md rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 animate-pulse"
              >
                <div className="w-10 h-10 rounded-xl bg-amber-400/30 flex items-center justify-center flex-shrink-0 text-amber-100">
                  {isAlarm ? <AlarmIcon /> : <TimerIcon />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-amber-50 text-sm font-semibold truncate">{title}</p>
                  <p className="text-amber-100/80 text-xs mt-0.5">
                    {isAlarm ? 'Alarm ringing' : 'Time’s up'}{recurring ? ' · repeats' : ''}
                  </p>
                </div>
                <button
                  onClick={() => snooze(t, snoozeMs)}
                  className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 text-xs font-medium transition-all flex-shrink-0"
                >
                  {snoozeLabel}
                </button>
                <button
                  onClick={() => dismiss(t)}
                  className="px-4 py-2 rounded-xl bg-white/20 hover:bg-white/30 active:scale-95 text-white text-sm font-semibold transition-all flex-shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
