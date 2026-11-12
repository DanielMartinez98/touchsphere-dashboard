// Picking any two days: a month grid, tap the first day, tap the last.
//
// Drawn here rather than left to <input type="date"> because the kiosk's
// browser opens the native date popup badly (the reason every picker in this
// app is its own sheet), and because a range is two taps on one grid where two
// date fields are two popups. Days after `max` — the newest day Apple has
// published — cannot be picked: there is nothing there yet.

import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Sheet } from './parts'
import { addDays, rangeText } from './format'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function RangePicker({ from, to, max, onPick, onClose }: {
  from: string; to: string; max: string
  onPick: (from: string, to: string) => void
  onClose: () => void
}) {
  const [start, setStart] = useState<string | null>(from)
  const [end, setEnd] = useState<string | null>(to)
  const [month, setMonth] = useState(`${to.slice(0, 7)}-01`)

  const first = new Date(`${month}T00:00:00Z`)
  const lead = (first.getUTCDay() + 6) % 7
  const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1)
  const count = Math.round((next.getTime() - first.getTime()) / 86_400_000)
  const shift = (n: number) => { const d = new Date(first); d.setUTCMonth(d.getUTCMonth() + n); setMonth(d.toISOString().slice(0, 10)) }
  const canForward = next.toISOString().slice(0, 10) <= max

  const tap = (day: string) => {
    if (!start || end) { setStart(day); setEnd(null) }
    else if (day < start) { setEnd(start); setStart(day) }
    else setEnd(day)
  }

  return (
    <Sheet title="Choose the days" onClose={onClose} footer={
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-white/60 min-w-0 truncate">
          {start && end ? rangeText(start, end) : start ? 'Now tap the last day' : 'Tap the first day'}
        </span>
        <button type="button" disabled={!start || !end} onClick={() => { if (start && end) { onPick(start, end); onClose() } }}
          className="h-11 px-6 rounded-xl bg-indigo-500 text-white text-[14px] font-semibold active:scale-95 disabled:opacity-40 shrink-0">
          Show these days
        </button>
      </div>
    }>
      <div className="flex items-center justify-between mb-3">
        <button type="button" onClick={() => shift(-1)} aria-label="Earlier month"
          className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center text-white/80 active:scale-95"><ChevronLeft size={20} /></button>
        <span className="text-[16px] font-semibold text-white">
          {new Date(`${month}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" onClick={() => shift(1)} disabled={!canForward} aria-label="Later month"
          className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center text-white/80 active:scale-95 disabled:opacity-25"><ChevronRight size={20} /></button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((w, i) => <span key={i} className="text-[12px] text-white/35 pb-1">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`lead-${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const day = addDays(month, i)
          const off = day > max
          const edge = day === start || day === end
          const inside = !!start && !!end && day > start && day < end
          return (
            <button key={day} type="button" disabled={off} onClick={() => tap(day)}
              className={`h-11 text-[15px] tabular-nums ${
                edge ? 'bg-indigo-500 text-white font-semibold rounded-xl'
                : inside ? 'bg-indigo-500/20 text-white'
                : off ? 'text-white/15' : 'text-white/80 rounded-xl active:bg-white/10'
              }`}>
              {i + 1}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}
