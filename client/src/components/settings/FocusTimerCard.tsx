import { Minus, Plus } from 'lucide-react'
import { FOCUS_DEFAULTS, saveFocusSettings, useFocusSettings, type FocusSettings } from '../../hooks/useFocusTimer'

// Settings → Schedule → the work/rest timer under the sphere. Steppers, not
// sliders (a fingertip cannot land one minute on a 7" screen), plus the
// well-known splits as one-tap presets.

const PRESETS: { label: string; what: string; v: Partial<FocusSettings> }[] = [
  { label: '25 / 5',  what: 'Pomodoro',       v: { workMin: 25, restMin: 5,  longRestMin: 15, roundsBeforeLong: 4 } },
  { label: '50 / 10', what: 'Longer focus',   v: { workMin: 50, restMin: 10, longRestMin: 30, roundsBeforeLong: 3 } },
  { label: '52 / 17', what: 'DeskTime study', v: { workMin: 52, restMin: 17, roundsBeforeLong: 0 } },
  { label: '90 / 20', what: 'Ultradian',      v: { workMin: 90, restMin: 20, roundsBeforeLong: 0 } },
]

function Row({ label, hint, value, unit, step, lo, hi, onChange }: {
  label: string; hint: string; value: number; unit: string; step: number; lo: number; hi: number
  onChange: (v: number) => void
}) {
  const btn = 'w-12 h-12 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white/80 active:scale-90 transition disabled:opacity-30'
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-white/80 text-[15px] font-medium">{label}</p>
        <p className="text-white/40 text-[13px] leading-snug">{hint}</p>
      </div>
      <button type="button" className={btn} disabled={value <= lo} aria-label={`Less ${label}`}
        onClick={() => onChange(Math.max(lo, value - step))}><Minus size={18} /></button>
      <span className="w-20 text-center text-white text-[17px] font-semibold tabular-nums">{value === 0 && unit === 'rounds' ? 'Off' : `${value} ${unit}`}</span>
      <button type="button" className={btn} disabled={value >= hi} aria-label={`More ${label}`}
        onClick={() => onChange(Math.min(hi, value + step))}><Plus size={18} /></button>
    </div>
  )
}

export function FocusTimerCard() {
  const s = useFocusSettings()
  const save = (patch: Partial<FocusSettings>) => { void saveFocusSettings(patch).catch(() => {}) }
  const isDefault = (Object.keys(FOCUS_DEFAULTS) as (keyof FocusSettings)[]).every(k => s[k] === FOCUS_DEFAULTS[k])

  return (
    <div className="set-card p-5 space-y-3">
      <div>
        <p className="text-white/70 text-sm font-medium">Work / rest timer</p>
        <p className="text-white/30 text-xs mt-0.5">
          The timer under the sphere in work mode. When work ends the alarm rings and the screen turns green; the rest starts when you tap it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map(p => {
          const on = (Object.keys(p.v) as (keyof FocusSettings)[]).every(k => s[k] === p.v[k])
          return (
            <button key={p.label} type="button" onClick={() => save(p.v)}
              className={`px-3 py-2 rounded-xl border text-left active:scale-95 transition ${on ? 'bg-cyan-500/25 border-cyan-300/60 text-cyan-50' : 'bg-white/5 border-white/15 text-white/70'}`}>
              <span className="block text-[15px] font-semibold">{p.label}</span>
              <span className="block text-[12px] opacity-60">{p.what}</span>
            </button>
          )
        })}
      </div>

      <div className="divide-y divide-white/5">
        <Row label="Work" hint="How long each work round lasts." value={s.workMin} unit="min" step={5} lo={5} hi={240}
          onChange={v => save({ workMin: v })} />
        <Row label="Rest" hint="The break after each round." value={s.restMin} unit="min" step={1} lo={1} hi={120}
          onChange={v => save({ restMin: v })} />
        <Row label="Long rest" hint="The longer break after several rounds." value={s.longRestMin} unit="min" step={5} lo={5} hi={180}
          onChange={v => save({ longRestMin: v })} />
        <Row label="Long rest every" hint="Work rounds before a long rest. Off: always the short one." value={s.roundsBeforeLong} unit="rounds" step={1} lo={0} hi={12}
          onChange={v => save({ roundsBeforeLong: v })} />
      </div>

      <p className="text-white/30 text-xs leading-snug">
        Defaults are the Pomodoro technique: 25 minutes of work, 5 of rest, and 15 after every fourth round.
        {!isDefault && <> <button type="button" className="underline text-white/50" onClick={() => save(FOCUS_DEFAULTS)}>Back to the defaults</button></>}
      </p>
    </div>
  )
}
