import { useEffect, useState } from 'react'
import { Pause, Play, RotateCcw, BellOff } from 'lucide-react'
import {
  useFocusTimer, useFocusSettings, focusPrimary, focusReset, silence, isResting, formatFocus,
} from '../hooks/useFocusTimer'

/**
 * The work/rest timer: one pill under the sphere, above Settings and the mic.
 * The big button does whatever comes next (start working, pause, resume,
 * start the rest), the small one starts over. While the alarm rings, a tap on
 * the text silences it without starting the next phase.
 */
export function FocusTimer() {
  const s = useFocusTimer()
  const cfg = useFocusSettings()
  // The clock is state, ticked by the interval, so render stays pure. It is
  // read only while running, and the first tick lands within 250 ms.
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (s.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [s.status, s.endsAt])

  const resting = isResting(s)
  const left = s.status === 'running' ? (now ? s.endsAt - now : s.durationMs) : s.remainingMs
  const progress = s.durationMs > 0 && (s.status === 'running' || s.status === 'paused')
    ? Math.min(1, Math.max(0, 1 - left / s.durationMs)) : 0
  const nextRestMin = s.long ? cfg.longRestMin : cfg.restMin

  let title: string
  let sub: string
  let action: string
  let ActionIcon = Play
  if (s.status === 'idle') {
    title = 'Work timer'
    sub = `${cfg.workMin} min work · ${cfg.restMin} min rest`
    action = 'Start working'
  } else if (s.status === 'done') {
    title = s.phase === 'work' ? 'Time to rest' : 'Back to work'
    sub = s.phase === 'work' ? `${s.round} round${s.round === 1 ? '' : 's'} done` : 'Rest is over'
    action = s.phase === 'work' ? `Start ${s.long ? 'long ' : ''}rest · ${nextRestMin} min` : `Start working · ${cfg.workMin} min`
  } else {
    title = formatFocus(left)
    sub = s.status === 'paused'
      ? `Paused · ${s.phase === 'work' ? 'working' : 'resting'}`
      : s.phase === 'work' ? `Working · round ${s.round + 1}` : s.long ? 'Long rest' : 'Resting'
    action = s.status === 'paused' ? 'Resume' : 'Pause'
    ActionIcon = s.status === 'paused' ? Play : Pause
  }

  const tone = resting
    ? 'bg-emerald-500/15 border-emerald-400/45 text-emerald-50'
    : 'bg-cyan-500/10 border-cyan-400/35 text-cyan-50'
  const button = resting
    ? 'bg-emerald-400/25 border-emerald-300/60 text-emerald-50'
    : 'bg-cyan-400/20 border-cyan-300/50 text-cyan-50'
  const bar = resting ? 'bg-emerald-300' : 'bg-cyan-300'

  return (
    <div className={`absolute left-1/2 -translate-x-1/2 bottom-[68px] sm:bottom-[96px] z-20 w-[min(92vw,420px)] rounded-2xl border backdrop-blur-md shadow-lg overflow-hidden ${tone} ${s.ringing ? 'focus-ring' : ''}`}>
      <div className="flex items-center gap-3 pl-4 pr-2 py-2">
        <button
          type="button"
          onClick={silence}
          disabled={!s.ringing}
          aria-label={s.ringing ? 'Silence the alarm' : undefined}
          className="flex-1 min-w-0 text-left flex items-center gap-2"
        >
          {s.ringing && <BellOff size={18} className="shrink-0 opacity-80" />}
          <span className="min-w-0">
            <span className={`block font-semibold leading-tight truncate ${s.status === 'running' || s.status === 'paused' ? 'text-2xl tabular-nums' : 'text-[17px]'}`}>{title}</span>
            <span className="block text-[14px] opacity-70 leading-tight truncate">{s.ringing ? 'Tap here to silence' : sub}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={focusPrimary}
          className={`h-12 px-4 rounded-xl border flex items-center gap-2 text-[16px] font-semibold whitespace-nowrap active:scale-95 transition-transform ${button}`}
        >
          <ActionIcon size={18} />{action}
        </button>
        {s.status !== 'idle' && (
          <button
            type="button"
            onClick={focusReset}
            aria-label="Stop the timer and start over"
            className="w-11 h-12 rounded-xl flex items-center justify-center opacity-70 active:scale-90 active:bg-white/10 transition"
          >
            <RotateCcw size={18} />
          </button>
        )}
      </div>
      {progress > 0 && (
        <div className="h-1 bg-white/10">
          <div className={`h-full ${bar} transition-[width] duration-1000 ease-linear`} style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  )
}
