import { useState } from 'react'
import { useClock } from '../../../hooks/useClock'
import { formatRemaining, formatClock, formatRepeatDays, type TimersApi } from '../../../hooks/useTimers'
import { formatStopwatch, type StopwatchApi } from '../../../hooks/useStopwatch'
import { TouchInput } from '../../TouchInput'

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

// Single-letter weekday headers for the alarm repeat chips (index = day-of-week).
const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Quick repeat presets; `match` is the formatRepeatDays() string used to tell
// which preset (if any) the current selection corresponds to.
const REPEAT_PRESETS: { label: string; days: number[]; match: string }[] = [
  { label: 'Once',     days: [],                match: '' },
  { label: 'Daily',    days: [0, 1, 2, 3, 4, 5, 6], match: 'Every day' },
  { label: 'Weekdays', days: [1, 2, 3, 4, 5],    match: 'Weekdays' },
  { label: 'Weekends', days: [0, 6],             match: 'Weekends' },
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

/** Vertical −/value/+ stepper sized for finger taps. Wraps within [min, max]. */
function Stepper({ value, onChange, min = 0, max, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max: number; unit: string
}) {
  const span = max - min + 1
  const wrap = (v: number) => (((v - min) % span) + span) % span + min
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={() => onChange(wrap(value + 1))}
        aria-label={`More ${unit}`}
        className="w-14 h-10 rounded-lg bg-white/10 hover:bg-white/20 active:scale-90 text-white text-2xl leading-none flex items-center justify-center transition-all"
      >+</button>
      <div className="w-16 text-center">
        <span className="text-white font-mono text-3xl font-semibold tabular-nums">{String(value).padStart(2, '0')}</span>
        <div className="text-white/40 text-[10px] uppercase tracking-wider">{unit}</div>
      </div>
      <button
        onClick={() => onChange(wrap(value - 1))}
        aria-label={`Less ${unit}`}
        className="w-14 h-10 rounded-lg bg-white/10 hover:bg-white/20 active:scale-90 text-white text-2xl leading-none flex items-center justify-center transition-all"
      >−</button>
    </div>
  )
}

// `nested` = something above us already cleared the widget's grab handle and
// close button (the combined corner's tab bar does). Without it the panel
// reserves that space itself, which is right when it owns the whole screen.
export default function WorldClock({ timers, stopwatch, nested = false }: { timers?: TimersApi; stopwatch?: StopwatchApi; nested?: boolean }) {
  const now = useClock()

  // Top-level view: the world clock, or the timers/alarms/stopwatch tools.
  const [view, setView] = useState<'clock' | 'timers'>('clock')
  // Custom timer/alarm creator + stopwatch tabs.
  const [tab,    setTab]    = useState<'timer' | 'alarm' | 'stopwatch'>('timer')
  const [label,  setLabel]  = useState('')
  const [h, setH] = useState(0), [m, setM] = useState(5), [s, setS] = useState(0)   // timer
  const [hr, setHr] = useState(7), [min, setMin] = useState(0), [mer, setMer] = useState<'AM' | 'PM'>('AM')  // alarm
  const [repeatDays, setRepeatDays] = useState<number[]>([])  // alarm recurrence (0=Sun..6=Sat)

  const customMs = (h * 3600 + m * 60 + s) * 1000

  const toggleDay = (d: number) =>
    setRepeatDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b))

  const startCustom = () => {
    if (!timers || customMs <= 0) return
    void timers.addTimer(customMs, label.trim())
    setH(0); setM(0); setS(0); setLabel('')
  }

  const startAlarm = () => {
    if (!timers) return
    const h24 = (hr % 12) + (mer === 'PM' ? 12 : 0)
    const d = new Date()
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h24, min, 0, 0)
    if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1)   // roll to tomorrow
    void timers.addAlarm(target.getTime(), label.trim(), repeatDays)
    setLabel(''); setRepeatDays([])
  }

  // Count of pending timers/alarms (badge on the Timers view button).
  const activeCount = (timers?.timers.length ?? 0) + (stopwatch?.running ? 1 : 0)

  return (
    <div className={`flex flex-col h-full p-6 ${nested ? 'pt-2' : 'pt-16'} gap-4 overflow-y-auto`}>
      {/* Top-level view switch — World Clock vs the timer tools. */}
      <div className="flex gap-2 self-start bg-white/5 rounded-2xl p-1">
        <button
          onClick={() => setView('clock')}
          className={`px-5 py-2 rounded-xl text-base font-semibold transition-all ${
            view === 'clock' ? 'bg-cyan-500/25 text-white' : 'text-white/40 hover:text-white/70'
          }`}
        >
          World Clock
        </button>
        <button
          onClick={() => setView('timers')}
          className={`px-5 py-2 rounded-xl text-base font-semibold transition-all flex items-center gap-2 ${
            view === 'timers' ? 'bg-purple-500/25 text-white' : 'text-white/40 hover:text-white/70'
          }`}
        >
          Timers & Stopwatch
          {activeCount > 0 && (
            <span className="min-w-5 h-5 px-1.5 rounded-full bg-purple-500/60 text-white text-xs font-bold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {view === 'clock' && (
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
      )}

      {/* ── Timers, alarms & stopwatch ── */}
      {view === 'timers' && timers && (
        <div className="mt-2">
          {/* Timer / Alarm / Stopwatch tab toggle */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-1 bg-white/5 rounded-xl p-1">
              {(['timer', 'alarm', 'stopwatch'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-semibold capitalize transition-all ${
                    tab === t ? 'bg-purple-500/30 text-white' : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab !== 'stopwatch' && <span className="text-white/30 text-xs">or say “set a {tab}”</span>}
          </div>

          {/* Quick presets (timer only) */}
          {tab === 'timer' && (
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
          )}

          {/* Custom timer/alarm creator */}
          {tab !== 'stopwatch' && (
          <div className="bg-white/5 rounded-2xl p-4 mb-4 flex flex-col gap-4 border border-white/8">
            {tab === 'timer' ? (
              <div className="flex items-center justify-center gap-4">
                <Stepper value={h} onChange={setH} max={23} unit="hrs" />
                <span className="text-white/30 text-2xl font-light pb-4">:</span>
                <Stepper value={m} onChange={setM} max={59} unit="min" />
                <span className="text-white/30 text-2xl font-light pb-4">:</span>
                <Stepper value={s} onChange={setS} max={59} unit="sec" />
              </div>
            ) : (
              <div className="flex items-center justify-center gap-4">
                <Stepper value={hr} onChange={setHr} min={1} max={12} unit="hour" />
                <span className="text-white/30 text-2xl font-light pb-4">:</span>
                <Stepper value={min} onChange={setMin} max={59} unit="min" />
                <div className="flex flex-col gap-1.5 pb-4">
                  {(['AM', 'PM'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setMer(p)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                        mer === p ? 'bg-purple-500/30 text-white' : 'bg-white/5 text-white/40 hover:text-white/70'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Repeat selector (alarm only) */}
            {tab === 'alarm' && (
              <div className="flex flex-col gap-2 -mt-1">
                <div className="flex gap-1.5 justify-center">
                  {DOW_LABELS.map((d, i) => {
                    const on = repeatDays.includes(i)
                    return (
                      <button
                        key={i}
                        onClick={() => toggleDay(i)}
                        aria-label={`Repeat on day ${i}`}
                        className={`w-9 h-9 rounded-full text-sm font-semibold transition-all ${
                          on ? 'bg-purple-500/40 text-white' : 'bg-white/5 text-white/40 hover:text-white/70'
                        }`}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
                <div className="flex gap-2 justify-center">
                  {REPEAT_PRESETS.map(p => (
                    <button
                      key={p.label}
                      onClick={() => setRepeatDays(p.days)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                        formatRepeatDays(repeatDays) === p.match
                          ? 'bg-purple-500/30 text-white' : 'bg-white/5 text-white/40 hover:text-white/70'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <TouchInput
              value={label}
              onChange={setLabel}
              placeholder="Label (optional)"
              ariaLabel={`${tab} label`}
              className="bg-black/30 rounded-xl px-4 py-2.5 text-white text-sm w-full placeholder:text-white/30 border border-white/10 outline-none focus:border-purple-400/40"
            />

            {tab === 'timer' ? (
              <button
                onClick={startCustom}
                disabled={customMs <= 0}
                className="py-3 rounded-xl bg-purple-500/30 hover:bg-purple-500/40 active:scale-95 disabled:opacity-30 disabled:active:scale-100 text-white font-semibold transition-all"
              >
                {customMs > 0 ? `Start ${formatRemaining(customMs)} timer` : 'Set a duration'}
              </button>
            ) : (
              <button
                onClick={startAlarm}
                className="py-3 rounded-xl bg-purple-500/30 hover:bg-purple-500/40 active:scale-95 text-white font-semibold transition-all"
              >
                Set alarm · {String(hr).padStart(2, '0')}:{String(min).padStart(2, '0')} {mer}
                {repeatDays.length > 0 && ` · ${formatRepeatDays(repeatDays)}`}
              </button>
            )}
          </div>
          )}

          {/* Stopwatch */}
          {tab === 'stopwatch' && stopwatch && (
            <div className="bg-white/5 rounded-2xl p-4 mb-4 flex flex-col gap-4 border border-white/8">
              <div className="text-center text-white font-mono text-5xl font-semibold tabular-nums py-2">
                {formatStopwatch(stopwatch.elapsed)}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {!stopwatch.running ? (
                  <button
                    onClick={stopwatch.start}
                    className="py-3 rounded-xl bg-green-500/25 hover:bg-green-500/35 active:scale-95 text-green-100 font-semibold transition-all"
                  >
                    {stopwatch.elapsed > 0 ? 'Resume' : 'Start'}
                  </button>
                ) : (
                  <button
                    onClick={stopwatch.pause}
                    className="py-3 rounded-xl bg-amber-500/25 hover:bg-amber-500/35 active:scale-95 text-amber-100 font-semibold transition-all"
                  >
                    Pause
                  </button>
                )}
                <button
                  onClick={stopwatch.lap}
                  disabled={!stopwatch.running}
                  className="py-3 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 disabled:opacity-30 disabled:active:scale-100 text-white font-semibold transition-all"
                >
                  Lap
                </button>
                <button
                  onClick={stopwatch.reset}
                  disabled={stopwatch.elapsed === 0}
                  className="py-3 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 disabled:opacity-30 disabled:active:scale-100 text-white font-semibold transition-all"
                >
                  Reset
                </button>
              </div>
              {stopwatch.laps.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {stopwatch.laps.map((total, i) => {
                    const split = total - (stopwatch.laps[i - 1] ?? 0)
                    return (
                      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/20 text-sm">
                        <span className="text-white/40">Lap {i + 1}</span>
                        <span className="text-white/60 font-mono tabular-nums">+{formatStopwatch(split)}</span>
                        <span className="text-white font-mono tabular-nums">{formatStopwatch(total)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Active list */}
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
                    {isAlarm && t.repeatDays?.length > 0 && (
                      <span className="text-purple-300/70 text-[10px] uppercase tracking-wide flex-shrink-0">{formatRepeatDays(t.repeatDays)}</span>
                    )}
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
