// The pieces the Apps corner is drawn from: the stat tile, the chart, the
// small marks that go in table rows, the chip and the bottom sheet.
//
// The chart is lines, one per app on one axis, so several apps are compared
// in one picture; there is no hover on a touchscreen, so reading it is a TAP or
// a drag, and the legend under it doubles as the readout.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { SALES_COLOR, change } from './format'

/**
 * A stat tile: what it is, the figure and the change against the stretch
 * before. A tile is also the chart's picker — tapping one draws that measure
 * below — so the chosen one is ringed. What the figure counts is written once,
 * under the chart's title, for the chosen one: six explanations at once made
 * the tiles a page of prose.
 */
export function Tile({ label, value, now, before, selected, onSelect, downIsGood }: {
  label:     string
  value:     string
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
      className={`text-left rounded-2xl px-3.5 py-2.5 min-w-[136px] shrink-0 sm:min-w-0 sm:shrink border transition-colors ${
        selected ? 'bg-white/[0.12] border-white/40' : 'bg-white/5 border-white/8 active:bg-white/10'
      }`}>
      <div className="text-[13px] text-white/55 leading-tight truncate">{label}</div>
      <div className="font-semibold font-display text-white leading-tight mt-0.5 truncate tabular-nums text-[22px] lg:text-[24px]">{value}</div>
      <div className="text-[12px] leading-tight mt-0.5 min-h-[15px] truncate">
        {c
          ? <span className={c.flat ? 'text-white/40' : good ? 'text-emerald-300' : 'text-red-300'}>{c.flat ? c.text : `${c.up ? '▲' : '▼'} ${c.text.replace(/^[+−]/, '')}`}</span>
          : <span className="text-white/25">no earlier figure</span>}
      </div>
    </button>
  )
}

export interface ChartPoint {
  key:   string
  /** Under the axis (first, middle, last only). */
  label: string
  /** In the readout: the whole day, week or month. */
  long:  string
}

export interface ChartLine {
  key:    string
  label:  string
  color:  string
  /** One value per point. null = no figure for it, drawn as a gap. */
  values: (number | null)[]
}

/** Round a maximum up to a number an axis can be labelled with: 1, 2, 2.5, 5 × a power of ten. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

/**
 * The chart: one line per series on one axis, so several apps are compared in
 * one picture. Reading it is a tap or a drag (a touchscreen has no hover; a
 * mouse simply moves): a rule marks the day, a dot sits on each line, and the
 * legend underneath IS the readout — each name beside its colour and its
 * figure for that day — so which line is which and what it says are one look.
 * Tapping a name lifts that line and dims the rest. Names and figures stay in
 * ink; only the marks carry colour.
 */
export function LineChart({ points, lines, format, total, unit }: {
  points: ChartPoint[]
  lines:  ChartLine[]
  format: (v: number) => string
  /** day, week or month: what one point is. */
  unit:   string
  /** The figure for the whole of a point, when the lines are parts of it. */
  total?: (i: number) => number | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [lifted, setLifted] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = points.length
  const height = width >= 520 ? 260 : 210
  const padL = 6, padR = 10, padT = 12, padB = 6
  const plotW = Math.max(1, width - padL - padR)
  const plotH = height - padT - padB
  const max = niceCeil(Math.max(0, ...lines.flatMap(l => l.values.map(v => v ?? 0))))
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => padT + plotH - (v / max) * plotH
  const empty = lines.length === 0 || lines.every(l => l.values.every(v => v === null))
  const at = Math.max(0, picked ? points.findIndex(p => p.key === picked) : n - 1)
  const here = points[at]
  const live = lifted && lines.some(l => l.key === lifted) ? lifted : null
  const ticks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]

  const path = (values: (number | null)[]): string => {
    let d = '', pen = false
    values.forEach((v, i) => {
      if (v === null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
      pen = true
    })
    return d
  }
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.type === 'pointermove' && e.buttons === 0 && n > 120) return
    const rect = e.currentTarget.getBoundingClientRect()
    const i = n <= 1 ? 0 : Math.round(((e.clientX - rect.left - padL) / plotW) * (n - 1))
    const p = points[Math.min(n - 1, Math.max(0, i))]
    if (p) setPicked(p.key)
  }
  const whole = total && here ? total(at) : null

  return (
    <div ref={box}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-[13px] text-white/60">
          <span className="text-white/90 font-semibold">{here?.long ?? ''}</span>
          {!picked && n > 1 ? ' · the latest' : ''}
          {whole !== null && <span className="tabular-nums"> · {format(whole)} in all</span>}
        </div>
        {n > 1 && <span className="text-[12px] text-white/35">Tap or drag the chart to read another {unit}</span>}
      </div>

      {empty ? (
        <div className="flex items-center justify-center text-[14px] text-white/35 rounded-xl bg-white/[0.03] mt-2" style={{ height }}>
          Nothing recorded in this range
        </div>
      ) : width > 0 && n > 1 && (
        <svg width={width} height={height} className="block mt-2 select-none" style={{ touchAction: 'pan-y' }}
          onPointerDown={pick} onPointerMove={pick} role="img"
          aria-label={`${lines.map(l => l.label).join(', ')} over ${n} points`}>
          {[0, 0.5, 1].map(f => (
            <g key={f}>
              <line x1={padL} x2={width - padR} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.09)" strokeWidth={1} />
            </g>
          ))}
          {here && <line x1={x(at)} x2={x(at)} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.28)" strokeWidth={1} />}
          {lines.length === 1 && n > 1 && (
            <path d={`${path(lines[0]!.values.map(v => v ?? 0))}L${x(n - 1).toFixed(1)} ${y(0)}L${x(0).toFixed(1)} ${y(0)}Z`} fill={lines[0]!.color} opacity={0.1} />
          )}
          {lines.map(l => (
            <path key={l.key} d={path(l.values)} fill="none" stroke={l.color} strokeWidth={live === l.key ? 3 : 2}
              strokeLinejoin="round" strokeLinecap="round" opacity={live && live !== l.key ? 0.22 : 1} />
          ))}
          {[0.5, 1].map(f => (
            <text key={f} x={padL} y={y(max * f) - 4} fontSize={11} fill="rgba(255,255,255,0.55)" stroke="#121314" strokeWidth={4}
              style={{ paintOrder: 'stroke' }}>{format(max * f)}</text>
          ))}
          {lines.map(l => {
            const v = l.values[at]
            if (v === null || v === undefined) return null
            return <circle key={l.key} cx={x(at)} cy={y(v)} r={live === l.key ? 5.5 : 4.5} fill={l.color} stroke="#17181a" strokeWidth={2}
              opacity={live && live !== l.key ? 0.3 : 1} />
          })}
        </svg>
      )}
      {/* One day is not a line: the figures below say it all. */}
      <div className={`relative h-5 mt-1 text-[11px] text-white/40 ${n > 1 && !empty ? '' : 'hidden'}`}>
        {ticks.map((i, k) => points[i] && (
          <span key={i} className="absolute top-0 whitespace-nowrap" style={
            k === 0 ? { left: 0 } : k === ticks.length - 1 ? { right: 0 } : { left: '50%', transform: 'translateX(-50%)' }
          }>{points[i]!.label}</span>
        ))}
      </div>

      {lines.length > 0 && (
        <div className="grid gap-1.5 mt-2" style={{ gridTemplateColumns: width < 440 ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {lines.map(l => {
            const v = l.values[at]
            const body = (
              <>
                <span className="w-4 h-[3px] rounded-full shrink-0" style={{ background: l.color }} />
                <span className="flex-1 min-w-0 truncate text-[13px] text-white/75">{l.label}</span>
                <span className="text-[14px] font-semibold text-white tabular-nums shrink-0">{v === null || v === undefined ? '—' : format(v)}</span>
              </>
            )
            return lines.length > 1 ? (
              <button key={l.key} type="button" aria-pressed={live === l.key} onClick={() => setLifted(live === l.key ? null : l.key)}
                className={`h-10 px-3 rounded-xl border flex items-center gap-2 text-left ${
                  live === l.key ? 'bg-white/[0.12] border-white/35' : 'bg-white/[0.04] border-white/8 active:bg-white/10'
                } ${live && live !== l.key ? 'opacity-55' : ''}`}>{body}</button>
            ) : (
              <div key={l.key} className="h-10 px-3 rounded-xl border bg-white/[0.04] border-white/8 flex items-center gap-2">{body}</div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A row's own small trend: a thin line, no axis. The row's figures say how much; this says when. */
export function Spark({ points, color, height = 28 }: { points: number[]; color: string; height?: number }) {
  const max = Math.max(1, ...points)
  const n = points.length
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${n <= 1 ? 50 : ((i / (n - 1)) * 100).toFixed(2)} ${(height - 2 - (v / max) * (height - 4)).toFixed(2)}`).join('')
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
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
