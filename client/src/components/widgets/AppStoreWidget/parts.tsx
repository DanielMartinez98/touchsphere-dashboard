// The pieces the Apps corner is drawn from: the stat tile, the chart, the
// small marks that go in table rows, the chip and the bottom sheet.
//
// The chart is bars, one per day (or week, or month), because these are
// counts: a day with three downloads and a day with none read as three marks
// and a gap, which a line smooths into a slope that never happened. There is
// no hover on a touchscreen, so reading a bar is a TAP: the tapped bar lights
// and its figures are written out above the chart. Money earned two ways
// stacks sales under ads in two colours with a legend; every other measure is
// one series in one colour.

import { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { SALES_COLOR, change } from './format'

/**
 * A stat tile: what it is, the figure, the change against the stretch before
 * and one line saying what the figure counts. A tile is also the chart's
 * picker — tapping one draws that measure below — so the chosen one is ringed.
 */
export function Tile({ label, value, about, now, before, selected, onSelect, downIsGood }: {
  label:     string
  value:     string
  about?:    string
  now?:      number | null
  before?:   number | null
  selected?: boolean
  onSelect?: () => void
  downIsGood?: boolean
}) {
  const c = now === undefined || before === undefined ? null : change(now, before)
  const good = c ? (downIsGood ? !c.up : c.up) : false
  return (
    <button type="button" onClick={onSelect} disabled={!onSelect} aria-pressed={selected}
      className={`text-left rounded-2xl px-3.5 py-3 min-w-0 border transition-colors ${
        selected ? 'bg-indigo-500/15 border-indigo-400/60' : 'bg-white/5 border-white/8 active:bg-white/10'
      }`}>
      <div className="text-[13px] text-white/55 leading-tight truncate">{label}</div>
      <div className="font-semibold font-display text-white leading-tight mt-1 truncate tabular-nums text-[26px]">{value}</div>
      <div className="text-[12px] leading-tight mt-1 min-h-[15px]">
        {c
          ? <span className={c.flat ? 'text-white/40' : good ? 'text-emerald-300' : 'text-red-300'}>{c.flat ? c.text : `${c.up ? '▲' : '▼'} ${c.text.replace(/^[+−]/, '')}`}</span>
          : <span className="text-white/25">no earlier figure</span>}
      </div>
      {about && <div className="text-[11px] text-white/35 leading-snug mt-1.5 line-clamp-2">{about}</div>}
    </button>
  )
}

export interface Bar {
  key:    string
  /** Under the axis (first, middle, last only) and in the readout. */
  label:  string
  long:   string
  /** One or two stacked parts, bottom first. null = no figure for this bar. */
  parts:  (number | null)[]
}

/**
 * The chart. `series` names the parts (one name: one colour and no legend).
 * `format` writes a value the way the tiles do. The readout shows the tapped
 * bar, or the newest one until something is tapped.
 */
export function BarChart({ bars, series, colors, format, height = 150 }: {
  bars:    Bar[]
  series:  string[]
  colors:  string[]
  format:  (v: number) => string
  height?: number
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const total = (b: Bar) => b.parts.reduce<number>((n, p) => n + (p ?? 0), 0)
  const max = Math.max(...bars.map(total), 0)
  const scale = max > 0 ? max : 1
  const chosen = bars.find(b => b.key === picked) ?? bars[bars.length - 1]
  const empty = bars.every(b => b.parts.every(p => p === null))
  const dense = bars.length > 60
  const ticks = bars.length <= 1 ? [0] : [0, Math.floor((bars.length - 1) / 2), bars.length - 1]

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 min-h-[40px]">
        {chosen && (
          <div className="min-w-0">
            <div className="text-[12px] text-white/45 truncate">{chosen.long}{picked ? '' : ' · latest'}</div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-[20px] font-semibold text-white tabular-nums">
                {chosen.parts.every(p => p === null) ? 'no figure yet' : format(total(chosen))}
              </span>
              {series.length > 1 && chosen.parts.map((p, i) => (
                <span key={series[i]} className="text-[12px] text-white/55 tabular-nums flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px]" style={{ background: colors[i] }} />
                  {series[i]} {format(p ?? 0)}
                </span>
              ))}
            </div>
          </div>
        )}
        <span className="text-[11px] text-white/35 tabular-nums shrink-0">top of chart {format(max)}</span>
      </div>

      {empty ? (
        <div className="flex items-center justify-center text-[13px] text-white/35 rounded-xl bg-white/[0.03]" style={{ height }}>
          Nothing recorded in this range
        </div>
      ) : (
        <div className="relative flex items-end border-b border-white/15" style={{ height, gap: dense ? 0 : bars.length > 31 ? 1 : 3 }}>
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-white/10 pointer-events-none" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-white/[0.06] pointer-events-none" />
          {bars.map(b => {
            const on = chosen?.key === b.key
            return (
              <button key={b.key} type="button" onClick={() => setPicked(b.key)} aria-label={`${b.long}: ${format(total(b))}`}
                className="relative flex-1 min-w-0 h-full flex flex-col-reverse items-stretch">
                {on && <span className="absolute inset-0 bg-white/[0.07] rounded-t-[3px]" />}
                {b.parts.map((p, i) => (
                  <span key={i} className={`relative block ${i === b.parts.length - 1 || !(b.parts[i + 1] ?? 0) ? 'rounded-t-[3px]' : ''}`} style={{
                    height: `${((p ?? 0) / scale) * 100}%`,
                    minHeight: (p ?? 0) > 0 ? 2 : 0,
                    background: colors[i],
                    opacity: on || !picked ? 1 : 0.55,
                  }} />
                ))}
              </button>
            )
          })}
        </div>
      )}
      <div className="relative h-5 mt-1 text-[11px] text-white/40">
        {ticks.map((i, n) => bars[i] && (
          <span key={i} className="absolute top-0 whitespace-nowrap" style={
            n === 0 ? { left: 0 } : n === ticks.length - 1 ? { right: 0 } : { left: '50%', transform: 'translateX(-50%)' }
          }>{bars[i]!.label}</span>
        ))}
      </div>
      {series.length > 1 && (
        <div className="flex gap-4 text-[12px] text-white/55">
          {series.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: colors[i] }} />{s}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/** A row's own small trend: thin bars, no axis. The row's figures say how much; this says when. */
export function MiniBars({ points, color = 'rgba(129,140,248,0.55)', height = 26 }: { points: number[]; color?: string; height?: number }) {
  const max = Math.max(1, ...points)
  const shown = points.length > 45 ? points.slice(-45) : points
  return (
    <div className="flex items-end w-full" style={{ height, gap: shown.length > 31 ? 1 : 2 }} aria-hidden="true">
      {shown.map((v, i) => (
        <span key={i} className="flex-1 min-w-0 rounded-t-[1px]" style={{ height: `${Math.max(v > 0 ? 8 : 3, (v / max) * 100)}%`, background: v > 0 ? color : 'rgba(255,255,255,0.10)' }} />
      ))}
    </div>
  )
}

/** A share of the largest row, as a bar behind a table row's label. */
export function ShareBar({ value, max, color = SALES_COLOR }: { value: number; max: number; color?: string }) {
  return (
    <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0}%`, background: color }} />
    </div>
  )
}

export function Chip({ on, onClick, children, tone = 'indigo' }: { on: boolean; onClick: () => void; children: ReactNode; tone?: 'indigo' | 'plain' }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`h-10 px-4 rounded-full text-[13px] font-semibold whitespace-nowrap shrink-0 transition-colors ${
        on ? (tone === 'indigo' ? 'bg-indigo-500/30 text-indigo-50 border border-indigo-400/50' : 'bg-white/20 text-white border border-white/20')
           : 'bg-white/5 text-white/55 border border-white/8 active:bg-white/10'
      }`}>
      {children}
    </button>
  )
}

/**
 * A sheet pinned to the bottom of the screen, over a scrim. `fixed`, the task
 * sheet's reason: an absolute sheet under a long list opens below the fold.
 */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[9050] flex flex-col justify-end" role="dialog" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div className="relative mx-auto w-full max-w-xl max-h-[82dvh] flex flex-col rounded-t-3xl bg-[#14171c] border border-white/10 border-b-0 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-white/8">
          <h3 className="text-[18px] font-semibold text-white">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white/70 active:scale-95"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-white/8">{footer}</div>}
      </div>
    </div>
  )
}

export function SectionCard({ title, note, children, action }: { title: string; note?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/5 border border-white/8 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-white/90">{title}</h3>
          {note && <p className="text-[12px] text-white/45 leading-snug mt-0.5">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
