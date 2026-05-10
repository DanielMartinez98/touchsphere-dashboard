import { useState } from 'react'

// Touch-friendly month picker. `value` is YYYY-MM-DD. Calling `onChange`
// with an empty string is not supported here; clearing is handled by the caller.
export default function MiniCalendar({
  value, onChange,
}: {
  value:    string
  onChange: (d: string) => void
}) {
  const init  = value ? new Date(value + 'T12:00') : new Date()
  const [py, setPy] = useState(init.getFullYear())
  const [pm, setPm] = useState(init.getMonth())
  const days  = new Date(py, pm + 1, 0).getDate()
  const first = new Date(py, pm, 1).getDay()
  const mName = new Date(py, pm).toLocaleString('default', { month: 'long' })
  const sel   = value ? new Date(value + 'T12:00') : null
  const today = new Date()

  function pick(day: number) {
    onChange(`${py}-${String(pm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  function prev() { pm === 0 ? (setPm(11), setPy(y => y - 1)) : setPm(m => m - 1) }
  function next() { pm === 11 ? (setPm(0), setPy(y => y + 1)) : setPm(m => m + 1) }

  return (
    <div className="bg-white/[0.06] rounded-2xl p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prev} className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">‹</button>
        <span className="text-sm font-semibold text-white">{mName} {py}</span>
        <button type="button" onClick={next} className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">›</button>
      </div>
      <div className="grid grid-cols-7 text-center mb-1">
        {['S','M','T','W','T','F','S'].map((d, i) => <span key={i} className="text-[10px] text-white/20">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {Array.from({ length: first }).map((_, i) => <div key={i} />)}
        {Array.from({ length: days }).map((_, i) => {
          const day   = i + 1
          const isSel = sel && day === sel.getDate() && pm === sel.getMonth() && py === sel.getFullYear()
          const isT   = day === today.getDate() && pm === today.getMonth() && py === today.getFullYear()
          return (
            <button type="button" key={day} onClick={() => pick(day)}
              className={`aspect-square rounded-lg text-xs font-medium flex items-center justify-center min-h-[34px]
                ${isSel ? 'bg-green-500 text-black' : isT ? 'bg-white/20 text-white' : 'text-white/60 active:bg-white/20'}`}>
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}
