import { useState, useEffect, useRef, useCallback } from 'react'
import { startAlarmSound, stopAlarmSound } from '../utils/sound'

// One countdown timer or alarm. Shape mirrors the server (routes/timers.ts).
export interface Timer {
  id:         string
  label:      string
  kind:       'timer' | 'alarm'
  fireAt:     number      // epoch ms
  createdAt:  number
  durationMs: number      // 0 for alarms
  repeatDays: number[]    // weekdays an alarm repeats on (0=Sun..6=Sat); [] = one-shot
}

const API = '/api/timers'

/** "9:59", "1:05:00", or "0:08" — mm:ss, rolling to h:mm:ss past an hour. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "7:30 AM" for an alarm's fire time. */
export function formatClock(epoch: number): string {
  return new Date(epoch).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". '' for one-shot. */
export function formatRepeatDays(days: number[]): string {
  if (!days || days.length === 0) return ''
  const set = [...days].sort((a, b) => a - b)
  if (set.length === 7) return 'Every day'
  if (set.length === 5 && [1, 2, 3, 4, 5].every(d => set.includes(d))) return 'Weekdays'
  if (set.length === 2 && set.includes(0) && set.includes(6)) return 'Weekends'
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return set.map(d => DOW[d]).join(', ')
}

/**
 * Owns the active timers/alarms shown on the dashboard. The server is durable
 * storage; this hook fetches the list, ticks the countdowns locally, moves a
 * timer into the "ringing" state the moment it elapses (firing the alarm
 * chime), and lets the user dismiss / snooze / cancel.
 *
 * Refetches whenever a voice tool reports the `timers` slice changed.
 */
export function useTimers() {
  const [timers,  setTimers]  = useState<Timer[]>([])  // pending (not yet fired)
  const [ringing, setRinging] = useState<Timer[]>([])  // fired, awaiting dismiss
  const [now,     setNow]     = useState(() => Date.now())

  // Refs so the tick interval / load() read fresh values without re-subscribing.
  // Synced in effects (never during render) so the value is always current.
  const timersRef    = useRef<Timer[]>([])
  const ringingRef   = useRef<Timer[]>([])
  const dismissedRef = useRef<Set<string>>(new Set())
  useEffect(() => { timersRef.current  = timers  }, [timers])
  useEffect(() => { ringingRef.current = ringing }, [ringing])

  const load = useCallback(() => {
    fetch(API)
      .then(r => (r.ok ? (r.json() as Promise<Timer[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => {
        const ringIds = new Set(ringingRef.current.map(t => t.id))
        // Don't resurrect a timer we're already ringing or that was dismissed.
        setTimers(data.filter(t => !ringIds.has(t.id) && !dismissedRef.current.has(t.id)))
      })
      .catch(err => console.warn('[timers] load failed:', err))
  }, [])

  // Initial load + refetch on voice-driven changes.
  useEffect(() => {
    load()
    const onChange = (e: Event) => {
      const slices = (e as CustomEvent<{ slices?: string[] }>).detail?.slices
      if (!slices || slices.includes('timers')) load()
    }
    window.addEventListener('ts:state-changed', onChange)
    return () => window.removeEventListener('ts:state-changed', onChange)
  }, [load])

  // Tick: drive countdown re-renders and promote elapsed timers to "ringing".
  useEffect(() => {
    if (timers.length === 0 && ringing.length === 0) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      const fired = timersRef.current.filter(x => t >= x.fireAt)
      if (fired.length > 0) {
        setTimers(prev => prev.filter(x => t < x.fireAt))
        setRinging(prev => {
          const have = new Set(prev.map(x => x.id))
          const add = fired.filter(x => !have.has(x.id))
          return add.length ? [...prev, ...add] : prev
        })
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [timers.length, ringing.length])

  // Ring the chime while anything is firing; silence it once all are dismissed.
  useEffect(() => {
    if (ringing.length > 0) startAlarmSound()
    else stopAlarmSound()
  }, [ringing.length])

  // Safety: stop the chime if the component unmounts mid-ring.
  useEffect(() => () => stopAlarmSound(), [])

  const cancel = useCallback((id: string) => {
    dismissedRef.current.add(id)
    setTimers(prev => prev.filter(t => t.id !== id))
    setRinging(prev => prev.filter(t => t.id !== id))
    fetch(`${API}/${id}`, { method: 'DELETE' }).catch(() => { /* best effort */ })
  }, [])

  const addTimer = useCallback((durationMs: number, label = ''): Promise<Timer | null> => {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'timer', durationMs, label }),
    })
      .then(r => (r.ok ? (r.json() as Promise<Timer>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(t => { setTimers(prev => [...prev, t].sort((a, b) => a.fireAt - b.fireAt)); return t })
      .catch(err => { console.warn('[timers] addTimer failed:', err); return null })
  }, [])

  const addAlarm = useCallback((fireAt: number, label = '', repeatDays: number[] = []): Promise<Timer | null> => {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'alarm', fireAt, label, repeatDays }),
    })
      .then(r => (r.ok ? (r.json() as Promise<Timer>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(t => { setTimers(prev => [...prev, t].sort((a, b) => a.fireAt - b.fireAt)); return t })
      .catch(err => { console.warn('[timers] addAlarm failed:', err); return null })
  }, [])

  // Roll a recurring alarm forward to its next occurrence (server computes it),
  // re-inserting the advanced record as pending so tomorrow's ring stays set.
  const advance = useCallback((t: Timer) => {
    setRinging(prev => prev.filter(x => x.id !== t.id))
    fetch(`${API}/${t.id}/advance`, { method: 'POST' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((updated: Timer | { removed?: boolean }) => {
        if (updated && 'id' in updated) {
          setTimers(prev => [...prev.filter(x => x.id !== updated.id), updated].sort((a, b) => a.fireAt - b.fireAt))
        }
      })
      .catch(err => console.warn('[timers] advance failed:', err))
  }, [])

  // Dismiss a ringing item: a recurring alarm rolls to its next day; a one-shot
  // timer/alarm is removed for good.
  const dismiss = useCallback((t: Timer) => {
    if (t.repeatDays?.length) advance(t)
    else cancel(t.id)
  }, [advance, cancel])

  // Dismiss the ringing item (keeping any recurrence) and start a one-off
  // snooze countdown.
  const snooze = useCallback((t: Timer, extraMs: number) => {
    dismiss(t)
    void addTimer(extraMs, t.label)
  }, [dismiss, addTimer])

  return { timers, ringing, now, addTimer, addAlarm, cancel, dismiss, snooze }
}

export type TimersApi = ReturnType<typeof useTimers>
