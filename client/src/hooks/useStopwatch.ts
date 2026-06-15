import { useState, useEffect, useCallback } from 'react'

// A count-up stopwatch with lap support. Time is tracked from wall-clock
// timestamps (Date.now), not by accumulating interval ticks, so it stays
// accurate even when the tab is throttled or the interval drifts. The interval
// only drives re-renders while running.
//
// Mounted once in App (like useTimers) and shared, so it keeps running while
// the Clock widget is closed and a glanceable pill can show it elsewhere.
//
// State model: `baseMs` is the time banked from finished segments; `startedAt`
// is the timestamp the current running segment began (null when paused). The
// stopwatch is running exactly when `startedAt != null`.

/** "01:23.4" — mm:ss.t (tenths), rolling to h:mm:ss.t past an hour. */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, ms)
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const tenths = Math.floor((total % 1000) / 100)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0
    ? `${h}:${pad(m)}:${pad(s)}.${tenths}`
    : `${pad(m)}:${pad(s)}.${tenths}`
}

export function useStopwatch() {
  const [baseMs,    setBaseMs]    = useState(0)                 // banked ms from prior segments
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [laps,      setLaps]      = useState<number[]>([])
  const [now,       setNow]       = useState(() => Date.now())  // ticked while running

  const running = startedAt != null

  // Advance `now` ~10×/s while running so the display ticks in tenths. Reading
  // this state (rather than Date.now()) keeps the render pure.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [running])

  // Elapsed right now, including the in-progress segment when running.
  const elapsed = baseMs + (startedAt != null ? Math.max(0, now - startedAt) : 0)

  const start = useCallback(() => {
    if (startedAt != null) return
    const t = Date.now()
    setNow(t)
    setStartedAt(t)
  }, [startedAt])

  const pause = useCallback(() => {
    if (startedAt == null) return
    setBaseMs(b => b + (Date.now() - startedAt))
    setStartedAt(null)
  }, [startedAt])

  const reset = useCallback(() => {
    setBaseMs(0)
    setStartedAt(null)
    setLaps([])
  }, [])

  const lap = useCallback(() => {
    const t = baseMs + (startedAt != null ? Date.now() - startedAt : 0)
    setLaps(ls => [...ls, t])
  }, [baseMs, startedAt])

  return { running, elapsed, laps, start, pause, reset, lap }
}

export type StopwatchApi = ReturnType<typeof useStopwatch>
