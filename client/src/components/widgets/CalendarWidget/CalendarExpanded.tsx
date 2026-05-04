import { useState, useEffect, useMemo, useRef } from 'react'
import { fetchMonthEvents } from '../../../hooks/useCalendar'
import type { CalendarEvent } from '../../../types'

// ── Local-state types ─────────────────────────────────────────────────────────

export type RepeatType = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

interface LocalCalendarEvent extends CalendarEvent {
  repeat?: RepeatType
}

interface EventStatus {
  status: 'accepted' | 'declined' | 'rescheduled'
  newStart?: string
  newEnd?: string
}
type StatusMap = Record<string, EventStatus>

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_STATUSES = 'ts-event-statuses'
const LS_LOCAL    = 'ts-local-events'

function loadStatuses(): StatusMap {
  try { return JSON.parse(localStorage.getItem(LS_STATUSES) ?? '{}') } catch { return {} }
}
function saveStatuses(m: StatusMap) {
  try { localStorage.setItem(LS_STATUSES, JSON.stringify(m)) } catch { /* quota */ }
}
function loadLocalEvents(): LocalCalendarEvent[] {
  try { return JSON.parse(localStorage.getItem(LS_LOCAL) ?? '[]') } catch { return [] }
}
function saveLocalEvents(evs: LocalCalendarEvent[]) {
  try { localStorage.setItem(LS_LOCAL, JSON.stringify(evs)) } catch { /* quota */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}
function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}
function localDateKey(iso: string): string {
  if (iso.length === 10) return iso
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function minuteOfDay(iso: string): number {
  if (iso.length === 10) return 0
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}
function endMinuteOfDay(ev: CalendarEvent): number {
  if (ev.end.length === 10) return 24 * 60
  const m = minuteOfDay(ev.end)
  const startM = minuteOfDay(ev.start)
  return m === 0 || m <= startM ? 24 * 60 : m
}
function fmtTime(iso: string): string {
  if (iso.length === 10) return 'All day'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtFullDate(iso: string): string {
  const d = iso.length === 10 ? new Date(iso + 'T12:00') : new Date(iso)
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
/** Format a date string as a datetime-local value (YYYY-MM-DDTHH:MM) */
function toDatetimeLocal(iso: string): string {
  if (iso.length === 10) return `${iso}T00:00`
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const HOUR_H = 52
const HOURS  = Array.from({ length: 24 }, (_, i) => i)

/** Strip the -occ-YYYY-MM-DD suffix added to recurring event occurrence IDs */
function occBaseId(id: string): string {
  return id.replace(/-occ-\d{4}-\d{2}-\d{2}$/, '')
}

// ── CalendarDatePicker ────────────────────────────────────────────────────────

interface DatePickerProps {
  value:    string   // YYYY-MM-DD
  onChange: (d: string) => void
  label?:   string
}

function CalendarDatePicker({ value, onChange, label }: DatePickerProps) {
  const parsed = value ? new Date(value + 'T12:00') : new Date()
  const [open,      setOpen]      = useState(false)
  const [pickYear,  setPickYear]  = useState(parsed.getFullYear())
  const [pickMonth, setPickMonth] = useState(parsed.getMonth())

  const selYear  = value ? parseInt(value.slice(0, 4))  : -1
  const selMonth = value ? parseInt(value.slice(5, 7)) - 1 : -1
  const selDay   = value ? parseInt(value.slice(8, 10)) : -1

  const days     = getDaysInMonth(pickYear, pickMonth)
  const firstDay = getFirstDayOfWeek(pickYear, pickMonth)
  const mName    = new Date(pickYear, pickMonth).toLocaleString('default', { month: 'long' })
  const todayNow = new Date()
  const displayLabel = value
    ? new Date(value + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
    : 'Select date'

  function pickDay(day: number) {
    onChange(`${pickYear}-${String(pickMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    setOpen(false)
  }
  function prevM() {
    if (pickMonth === 0) { setPickMonth(11); setPickYear(y => y - 1) } else setPickMonth(m => m - 1)
  }
  function nextM() {
    if (pickMonth === 11) { setPickMonth(0); setPickYear(y => y + 1) } else setPickMonth(m => m + 1)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-xs text-white/40">{label}</span>}
      <button onClick={() => setOpen(v => !v)}
        className="w-full bg-white/10 text-white rounded-xl px-4 py-4 text-sm text-left flex items-center justify-between active:bg-white/15">
        <span className={value ? 'text-white' : 'text-white/30'}>{displayLabel}</span>
        <span className="text-white/30 text-xs ml-2">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="bg-white/[0.07] rounded-2xl p-3 mt-0.5">
          {/* Nav */}
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevM}
              className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">
              ‹
            </button>
            <span className="text-sm font-semibold text-white">{mName} {pickYear}</span>
            <button onClick={nextM}
              className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">
              ›
            </button>
          </div>
          {/* Weekday headers */}
          <div className="grid grid-cols-7 text-center mb-1">
            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
              <span key={d} className="text-[10px] text-white/25">{d}</span>
            ))}
          </div>
          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: firstDay }).map((_, i) => <div key={`p-${i}`} />)}
            {Array.from({ length: days }).map((_, i) => {
              const day   = i + 1
              const isSel = day === selDay && pickMonth === selMonth && pickYear === selYear
              const isT   = day === todayNow.getDate() && pickMonth === todayNow.getMonth() && pickYear === todayNow.getFullYear()
              return (
                <button key={day} onClick={() => pickDay(day)}
                  className={`aspect-square rounded-lg text-xs font-medium flex items-center justify-center min-h-[36px]
                    ${isSel ? 'bg-cyan-500 text-black' : isT ? 'bg-white/20 text-white' : 'text-white/70 active:bg-white/20'}`}>
                  {day}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── EventDetailSheet ──────────────────────────────────────────────────────────

interface DetailSheetProps {
  event:          CalendarEvent
  status:         EventStatus | undefined
  isLocal:        boolean
  onClose:        () => void
  onStatusChange: (id: string, s: EventStatus) => void
  onDelete:       (id: string) => void
}

function EventDetailSheet({ event, status, isLocal, onClose, onStatusChange, onDelete }: DetailSheetProps) {
  const [mode, setMode] = useState<'idle' | 'reschedule'>('idle')

  // Split datetime into date (YYYY-MM-DD) + time (HH:MM) for the calendar picker
  const initParts = (iso: string) => {
    const s = toDatetimeLocal(iso)
    return { date: s.slice(0, 10), time: s.slice(11, 16) }
  }
  const [startDate, setStartDate] = useState(() => initParts(event.start).date)
  const [startTime, setStartTime] = useState(() => initParts(event.start).time)
  const [endDate,   setEndDate]   = useState(() => initParts(event.end).date)
  const [endTime,   setEndTime]   = useState(() => initParts(event.end).time)

  function accept()  { onStatusChange(event.id, { status: 'accepted' });  onClose() }
  function decline() { onStatusChange(event.id, { status: 'declined' });  onClose() }
  function saveReschedule() {
    onStatusChange(event.id, {
      status:   'rescheduled',
      newStart: new Date(`${startDate}T${startTime}`).toISOString(),
      newEnd:   new Date(`${endDate}T${endTime}`).toISOString(),
    })
    onClose()
  }

  const cur = status?.status

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Sheet */}
      <div className="relative bg-[#111827] rounded-t-3xl z-20 overflow-y-auto"
           style={{ animation: 'tsSlideUp 0.24s cubic-bezier(0.32,0.72,0,1)', maxHeight: '78vh' }}>
        <div className="px-5 pb-8 pt-3">
          {/* Drag handle */}
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-5" />

          {/* Event info */}
          <div className="mb-6">
            <h2 className="text-lg font-bold text-white leading-snug">{event.title}</h2>
            <p className="text-sm text-white/45 mt-0.5">{fmtFullDate(event.start)}</p>
            {!event.allDay && (
              <p className="text-sm text-cyan-400 mt-0.5">
                {fmtTime(event.start)} – {fmtTime(event.end)}
              </p>
            )}
            {cur && (
              <span className={`inline-flex items-center gap-1 mt-2 px-3 py-1 rounded-full text-xs font-semibold
                ${cur === 'accepted'   ? 'bg-green-500/20 text-green-400'
                : cur === 'declined'   ? 'bg-red-500/20   text-red-400'
                :                        'bg-blue-500/20  text-blue-400'}`}>
                {cur === 'accepted' ? '✓ Accepted' : cur === 'declined' ? '✗ Declined' : '↩ Rescheduled'}
              </span>
            )}
          </div>

          {mode === 'idle' ? (
            <div className="flex flex-col gap-3">
              {/* Accept / Decline */}
              <div className="grid grid-cols-2 gap-3">
                <button onClick={accept}
                  className={`h-14 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-colors
                    ${cur === 'accepted' ? 'bg-green-500 text-white' : 'bg-green-500/15 text-green-400 active:bg-green-500/25'}`}>
                  <span className="text-xl leading-none">✓</span> Accept
                </button>
                <button onClick={decline}
                  className={`h-14 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-colors
                    ${cur === 'declined' ? 'bg-red-500 text-white' : 'bg-red-500/15 text-red-400 active:bg-red-500/25'}`}>
                  <span className="text-xl leading-none">✗</span> Decline
                </button>
              </div>

              {/* Reschedule (timed events only) */}
              {!event.allDay && (
                <button onClick={() => setMode('reschedule')}
                  className={`h-14 w-full rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-colors
                    ${cur === 'rescheduled' ? 'bg-blue-500 text-white' : 'bg-blue-500/15 text-blue-400 active:bg-blue-500/25'}`}>
                  ↩ Change Time
                </button>
              )}

              {/* Delete (local events only) */}
              {isLocal && (
                <button onClick={() => { onDelete(event.id); onClose() }}
                  className="h-14 w-full rounded-2xl text-sm font-bold text-red-400/50 active:bg-red-500/10 transition-colors">
                  Delete Event
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">Change Time</p>

              <CalendarDatePicker label="Start date" value={startDate} onChange={setStartDate} />
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-white/40">Start time</span>
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                  className="bg-white/10 text-white rounded-xl px-4 py-4 text-sm outline-none
                             focus:ring-2 focus:ring-blue-400 w-full" />
              </label>

              <CalendarDatePicker label="End date" value={endDate} onChange={setEndDate} />
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-white/40">End time</span>
                <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                  className="bg-white/10 text-white rounded-xl px-4 py-4 text-sm outline-none
                             focus:ring-2 focus:ring-blue-400 w-full" />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setMode('idle')}
                  className="h-14 rounded-2xl bg-white/10 text-white/60 text-sm font-bold active:bg-white/15">
                  Back
                </button>
                <button onClick={saveReschedule}
                  className="h-14 rounded-2xl bg-blue-500 text-white text-sm font-bold active:bg-blue-600">
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── NewEventSheet ─────────────────────────────────────────────────────────────

interface NewEventSheetProps {
  defaultDate: string   // YYYY-MM-DD
  onClose:     () => void
  onSave:      (ev: LocalCalendarEvent) => void
}

const REPEAT_LABELS: { value: RepeatType; label: string }[] = [
  { value: 'none',    label: 'Never'   },
  { value: 'daily',   label: 'Daily'   },
  { value: 'weekly',  label: 'Weekly'  },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly',  label: 'Yearly'  },
]

function NewEventSheet({ defaultDate, onClose, onSave }: NewEventSheetProps) {
  const [title,  setTitle]  = useState('')
  const [date,   setDate]   = useState(defaultDate)
  const [allDay, setAllDay] = useState(false)
  const [startT, setStartT] = useState('09:00')
  const [endT,   setEndT]   = useState('10:00')
  const [repeat, setRepeat] = useState<RepeatType>('none')
  const titleRef = useRef<HTMLInputElement>(null)

  function save() {
    const trimmed = title.trim()
    if (!trimmed) return
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    let start: string, end: string
    if (allDay) {
      start = date
      end   = date
    } else {
      start = new Date(`${date}T${startT}`).toISOString()
      end   = new Date(`${date}T${endT}`).toISOString()
    }
    onSave({ id, title: trimmed, start, end, allDay, repeat: repeat === 'none' ? undefined : repeat })
    onClose()
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative bg-[#111827] rounded-t-3xl z-20 overflow-y-auto"
           style={{ animation: 'tsSlideUp 0.24s cubic-bezier(0.32,0.72,0,1)', maxHeight: '90vh' }}>
        <div className="px-5 pb-8 pt-3">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-5" />
          <h2 className="text-base font-bold text-white mb-5">New Event</h2>

          <div className="flex flex-col gap-4">
            {/* Title — triggers keyboard on touchscreen */}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/40">Title</span>
              <input
                ref={titleRef}
                type="text"
                inputMode="text"
                autoFocus
                autoComplete="off"
                placeholder="Event name…"
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()}
                className="bg-white/10 text-white placeholder-white/20 rounded-xl px-4 py-4
                           text-sm outline-none focus:ring-2 focus:ring-cyan-400 w-full" />
            </label>

            {/* Date — uses in-app calendar picker */}
            <CalendarDatePicker label="Date" value={date} onChange={setDate} />

            {/* All-day toggle */}
            <button
              onClick={() => setAllDay(v => !v)}
              className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-4 w-full">
              <span className="text-sm text-white/70">All day</span>
              <span className={`w-12 h-7 rounded-full transition-colors relative flex-shrink-0
                ${allDay ? 'bg-cyan-500' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-sm transition-transform
                  ${allDay ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </span>
            </button>

            {/* Repeat */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-white/40">Repeat</span>
              <div className="flex gap-2 overflow-x-auto pb-0.5 -mx-1 px-1">
                {REPEAT_LABELS.map(({ value: r, label }) => (
                  <button key={r} onClick={() => setRepeat(r)}
                    className={`flex-shrink-0 px-4 py-3 rounded-xl text-sm font-medium transition-colors
                      ${repeat === r ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white/60 active:bg-white/15'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Time pickers */}
            {!allDay && (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-white/40">Start</span>
                  <input type="time" value={startT} onChange={e => setStartT(e.target.value)}
                    className="bg-white/10 text-white rounded-xl px-4 py-4 text-sm outline-none
                               focus:ring-2 focus:ring-cyan-400 w-full" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-white/40">End</span>
                  <input type="time" value={endT} onChange={e => setEndT(e.target.value)}
                    className="bg-white/10 text-white rounded-xl px-4 py-4 text-sm outline-none
                               focus:ring-2 focus:ring-cyan-400 w-full" />
                </label>
              </div>
            )}

            <button onClick={save} disabled={!title.trim()}
              className="h-14 w-full rounded-2xl bg-cyan-500 text-black font-bold text-sm
                         disabled:opacity-30 active:bg-cyan-400 transition-colors mt-1">
              Create Event
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── CalendarExpanded ──────────────────────────────────────────────────────────

export default function CalendarExpanded() {
  const now = new Date()
  const [viewYear,    setViewYear]    = useState(now.getFullYear())
  const [viewMonth,   setViewMonth]   = useState(now.getMonth())
  const [selectedDay, setSelectedDay] = useState(now.getDate())

  const [fetchedEvents, setFetchedEvents] = useState<CalendarEvent[]>([])
  const [localEvents,   setLocalEvents]   = useState<LocalCalendarEvent[]>(loadLocalEvents)
  const [statuses,      setStatuses]      = useState<StatusMap>(loadStatuses)
  const [loadingMonth,  setLoadingMonth]  = useState(false)

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [showNewEvent,  setShowNewEvent]  = useState(false)

  const timelineRef = useRef<HTMLDivElement>(null)

  // ── Fetch month events ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoadingMonth(true)
    fetchMonthEvents(viewYear, viewMonth)
      .then(data  => { if (!cancelled) setFetchedEvents(data) })
      .catch(()   => { if (!cancelled) setFetchedEvents([]) })
      .finally(() => { if (!cancelled) setLoadingMonth(false) })
    return () => { cancelled = true }
  }, [viewYear, viewMonth])

  // ── Merge fetched + local, expand repeating events, apply reschedules ─────
  const allEvents = useMemo(() => {
    const result: CalendarEvent[] = []
    const monthStart = new Date(viewYear, viewMonth, 1)
    const monthEnd   = new Date(viewYear, viewMonth + 1, 0, 23, 59, 59, 999)

    for (const ev of [...fetchedEvents, ...localEvents]) {
      const s   = statuses[ev.id]
      let base: CalendarEvent = ev
      if (s?.status === 'rescheduled' && s.newStart && s.newEnd) {
        base = { ...ev, start: s.newStart, end: s.newEnd }
      }

      const repeat = (ev as LocalCalendarEvent).repeat
      if (!repeat || repeat === 'none') { result.push(base); continue }

      const originDate = base.start.length === 10
        ? new Date(base.start + 'T12:00') : new Date(base.start)
      if (originDate > monthEnd) continue

      // Fast-forward to just before monthStart to avoid O(n) iteration from origin
      let cur = new Date(originDate)
      if (cur < monthStart) {
        if (repeat === 'daily') {
          const skip = Math.max(0, Math.floor((monthStart.getTime() - cur.getTime()) / 86_400_000) - 1)
          cur = new Date(cur.getTime() + skip * 86_400_000)
        } else if (repeat === 'weekly') {
          const skip = Math.max(0, Math.floor((monthStart.getTime() - cur.getTime()) / (7 * 86_400_000)) - 1)
          cur = new Date(cur.getTime() + skip * 7 * 86_400_000)
        } else if (repeat === 'monthly') {
          const mDiff = (monthStart.getFullYear() - cur.getFullYear()) * 12 + (monthStart.getMonth() - cur.getMonth())
          if (mDiff > 1) cur = new Date(cur.getFullYear(), cur.getMonth() + mDiff - 1, cur.getDate(), cur.getHours(), cur.getMinutes())
        } else if (repeat === 'yearly') {
          const yDiff = monthStart.getFullYear() - cur.getFullYear()
          if (yDiff > 1) cur = new Date(cur.getFullYear() + yDiff - 1, cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes())
        }
      }

      let guard = 0
      while (cur <= monthEnd && guard++ < 62) {
        if (cur >= monthStart) {
          const diffMs = cur.getTime() - originDate.getTime()
          const occKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
          let occStart: string, occEnd: string
          if (base.start.length === 10) {
            occStart = occKey; occEnd = occKey
          } else {
            occStart = new Date(new Date(base.start).getTime() + diffMs).toISOString()
            occEnd   = new Date(new Date(base.end).getTime()   + diffMs).toISOString()
          }
          result.push({ ...base, id: `${base.id}-occ-${occKey}`, start: occStart, end: occEnd })
        }
        if      (repeat === 'daily')   cur = new Date(cur.getTime() + 86_400_000)
        else if (repeat === 'weekly')  cur = new Date(cur.getTime() + 7 * 86_400_000)
        else if (repeat === 'monthly') cur = new Date(cur.getFullYear(), cur.getMonth() + 1, cur.getDate(), cur.getHours(), cur.getMinutes())
        else                           cur = new Date(cur.getFullYear() + 1, cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes())
      }
    }
    return result
  }, [fetchedEvents, localEvents, statuses, viewYear, viewMonth])

  // ── Derived values ────────────────────────────────────────────────────────
  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay    = getFirstDayOfWeek(viewYear, viewMonth)
  const monthName   = new Date(viewYear, viewMonth).toLocaleString('default', { month: 'long' })
  const selectedKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`
  const selectedIsToday = selectedDay === now.getDate() && viewMonth === now.getMonth() && viewYear === now.getFullYear()

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of allEvents) {
      const key = localDateKey(e.start)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    return map
  }, [allEvents])

  const dayEvents = useMemo(() => eventsByDay.get(selectedKey) ?? [], [eventsByDay, selectedKey])
  const allDayEvs = dayEvents.filter(e => e.allDay)
  const timedEvs  = useMemo(() =>
    dayEvents.filter(e => !e.allDay).sort((a, b) => minuteOfDay(a.start) - minuteOfDay(b.start)),
  [dayEvents])

  const localIds = useMemo(() => new Set(localEvents.map(e => e.id)), [localEvents])

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!timelineRef.current) return
    let targetHour = 8
    if (selectedIsToday) targetHour = Math.max(0, now.getHours() - 1)
    else if (timedEvs.length > 0) targetHour = Math.max(0, Math.floor(minuteOfDay(timedEvs[0].start) / 60) - 1)
    timelineRef.current.scrollTop = targetHour * HOUR_H
  }, [selectedKey])

  // ── Navigation ────────────────────────────────────────────────────────────
  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleStatusChange(id: string, s: EventStatus) {
    const next = { ...statuses, [id]: s }
    setStatuses(next)
    saveStatuses(next)
  }
  function handleDeleteLocal(id: string) {
    const next = localEvents.filter(e => e.id !== id)
    setLocalEvents(next)
    saveLocalEvents(next)
  }
  function handleNewEvent(ev: LocalCalendarEvent) {
    const next = [...localEvents, ev]
    setLocalEvents(next)
    saveLocalEvents(next)
  }

  const nowMinute = now.getHours() * 60 + now.getMinutes()

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`@keyframes tsSlideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>

      <div className="flex flex-col h-full pt-16 relative">

        {/* ══ Month strip ════════════════════════════════════════════════════ */}
        <div className="flex-shrink-0 px-3 pb-2">

          {/* Nav row */}
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} aria-label="Previous month"
              className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">
              ‹
            </button>
            <span className="text-base font-bold text-white tracking-wide">{monthName} {viewYear}</span>
            <button onClick={nextMonth} aria-label="Next month"
              className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">
              ›
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 text-center mb-1">
            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
              <span key={d} className="text-[10px] text-white/25 select-none">{d}</span>
            ))}
          </div>

          {/* Grid */}
          {loadingMonth ? (
            <div className="flex items-center justify-center h-28">
              <span className="w-5 h-5 rounded-full border-2 border-white/20 border-t-cyan-400 animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-0.5">
              {Array.from({ length: firstDay }).map((_, i) => <div key={`pad-${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day   = i + 1
                const isT   = day === now.getDate() && viewMonth === now.getMonth() && viewYear === now.getFullYear()
                const isSel = day === selectedDay
                const dKey  = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                const evs   = eventsByDay.get(dKey) ?? []
                const dots  = evs.slice(0, 3)
                const extra = evs.length - 3
                return (
                  <button key={day} onClick={() => setSelectedDay(day)}
                    className={`flex flex-col items-center justify-start pt-1 pb-0.5 rounded-lg min-h-[46px] transition-colors
                      ${isSel ? 'bg-cyan-500 text-black' : isT ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 active:bg-white/20'}`}>
                    <span className="text-xs font-semibold leading-none">{day}</span>
                    {evs.length > 0 && (
                      <div className="flex gap-[2px] mt-1 items-center justify-center flex-wrap px-0.5">
                        {dots.map((dotEv, idx) => (
                          <span key={idx} className={`w-[5px] h-[5px] rounded-full flex-shrink-0
                            ${dotEv.allDay
                              ? (isSel ? 'bg-black/50' : 'bg-purple-400')
                              : (isSel ? 'bg-black/50' : 'bg-cyan-400')}`} />
                        ))}
                        {extra > 0 && (
                          <span className={`text-[8px] leading-none ${isSel ? 'text-black/60' : 'text-white/35'}`}>
                            +{extra}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* ══ Divider ════════════════════════════════════════════════════════ */}
        <div className="flex-shrink-0 border-t border-white/10 mx-3" />

        {/* ══ Day detail ═════════════════════════════════════════════════════ */}
        <div className="flex-1 min-h-0 flex flex-col">

          {/* Heading */}
          <div className="flex-shrink-0 px-4 pt-2 pb-1 flex items-baseline gap-2">
            <span className="text-sm font-bold text-white">
              {new Date(viewYear, viewMonth, selectedDay).toLocaleDateString([], {
                weekday: 'long', month: 'long', day: 'numeric',
              })}
            </span>
            {dayEvents.length > 0 && (
              <span className="text-xs text-cyan-400">
                {dayEvents.length} event{dayEvents.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* All-day events — tappable */}
          {allDayEvs.length > 0 && (
            <div className="flex-shrink-0 px-4 pb-1.5 flex flex-col gap-1">
              {allDayEvs.map(ev => {
                const s = statuses[ev.id]
                return (
                  <button key={ev.id} onClick={() => setSelectedEvent(ev)}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 w-full text-left transition-colors active:scale-[0.98]
                      ${s?.status === 'accepted' ? 'bg-green-500/15 border border-green-400/30'
                      : s?.status === 'declined' ? 'bg-white/5 border border-white/10 opacity-50'
                      : 'bg-purple-500/15 border border-purple-400/30'}`}>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0
                      ${s?.status === 'accepted' ? 'bg-green-400'
                      : s?.status === 'declined' ? 'bg-white/30' : 'bg-purple-400'}`} />
                    <span className={`text-xs font-medium flex-1 truncate
                      ${s?.status === 'declined' ? 'line-through text-white/40'
                      : s?.status === 'accepted' ? 'text-green-200' : 'text-purple-200'}`}>
                      {ev.title}
                    </span>
                    <span className={`text-[10px] flex-shrink-0
                      ${s?.status === 'accepted' ? 'text-green-400'
                      : s?.status === 'declined' ? 'text-white/20' : 'text-purple-400/50'}`}>
                      {s?.status === 'accepted' ? '✓' : s?.status === 'declined' ? '✗' : 'All day'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Hour-by-hour timeline */}
          <div ref={timelineRef} className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
            <div className="relative" style={{ height: 24 * HOUR_H }}>

              {/* Hour rows */}
              {HOURS.map(h => (
                <div key={h} className="absolute left-0 right-0 border-t border-white/[0.06]"
                  style={{ top: h * HOUR_H, height: HOUR_H }}>
                  <span className="absolute left-0 top-0.5 text-[10px] text-white/20 select-none w-9 text-right pr-1.5 leading-none">
                    {String(h).padStart(2, '0')}
                  </span>
                </div>
              ))}

              {/* Current-time needle */}
              {selectedIsToday && (
                <div className="absolute left-0 right-0 z-20 flex items-center pointer-events-none"
                  style={{ top: (nowMinute / 60) * HOUR_H - 1 }}>
                  <span className="w-9 text-right pr-1 text-[9px] text-red-400 leading-none select-none flex-shrink-0">
                    {String(now.getHours()).padStart(2,'0')}:{String(now.getMinutes()).padStart(2,'0')}
                  </span>
                  <div className="w-2 h-2 rounded-full bg-red-400 -mx-1 flex-shrink-0" />
                  <div className="flex-1 h-px bg-red-400/60" />
                </div>
              )}

              {/* Timed event blocks — tappable */}
              {timedEvs.map(ev => {
                const s        = statuses[ev.id]
                const startM   = minuteOfDay(ev.start)
                const endM     = endMinuteOfDay(ev)
                const top      = (startM / 60) * HOUR_H
                const height   = Math.max(((Math.max(endM - startM, 30)) / 60) * HOUR_H, 28)
                const declined = s?.status === 'declined'
                const accepted = s?.status === 'accepted'
                return (
                  <button key={ev.id} onClick={() => setSelectedEvent(ev)}
                    className={`absolute left-10 right-0 rounded-r-xl px-2.5 py-1 overflow-hidden text-left
                                transition-colors active:brightness-125
                      ${declined ? 'bg-white/5 border-l-[3px] border-white/20 opacity-50'
                      : accepted ? 'bg-green-500/15 border-l-[3px] border-green-400'
                      :            'bg-cyan-500/15 border-l-[3px] border-cyan-400'}`}
                    style={{ top, height }}>
                    <p className={`text-xs font-semibold leading-tight truncate
                      ${declined ? 'line-through text-white/40'
                      : accepted ? 'text-green-100' : 'text-cyan-100'}`}>
                      {ev.title}
                    </p>
                    {height > 30 && (
                      <p className={`text-[10px] leading-tight mt-0.5
                        ${declined ? 'text-white/20' : accepted ? 'text-green-400/70' : 'text-cyan-400/70'}`}>
                        {fmtTime(ev.start)}{ev.end.length !== 10 ? ` – ${fmtTime(ev.end)}` : ''}
                        {accepted && ' ✓'}{s?.status === 'rescheduled' && ' ↩'}
                      </p>
                    )}
                  </button>
                )
              })}

              {timedEvs.length === 0 && allDayEvs.length === 0 && (
                <p className="absolute left-10 text-white/20 text-xs" style={{ top: 8 * HOUR_H + 4 }}>
                  No events
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ══ Add event button ═══════════════════════════════════════════════ */}
        <button onClick={() => setShowNewEvent(true)} aria-label="Add event"
          className="absolute bottom-5 right-5 w-14 h-14 rounded-full bg-cyan-500 text-black
                     flex items-center justify-center text-3xl font-light shadow-lg shadow-cyan-500/30
                     active:scale-90 transition-transform z-[5]">
          +
        </button>

        {/* ══ Sheets ════════════════════════════════════════════════════════ */}
        {selectedEvent && (() => {
          // Recurring occurrences have IDs like "base-occ-YYYY-MM-DD" — strip the suffix
          // so status lookups and delete/accept/decline target the original event
          const baseId = occBaseId(selectedEvent.id)
          return (
            <EventDetailSheet
              event={selectedEvent}
              status={statuses[baseId]}
              isLocal={localIds.has(baseId)}
              onClose={() => setSelectedEvent(null)}
              onStatusChange={(_, s) => handleStatusChange(baseId, s)}
              onDelete={() => handleDeleteLocal(baseId)}
            />
          )
        })()}
        {showNewEvent && (
          <NewEventSheet
            defaultDate={selectedKey}
            onClose={() => setShowNewEvent(false)}
            onSave={handleNewEvent}
          />
        )}
      </div>
    </>
  )
}
