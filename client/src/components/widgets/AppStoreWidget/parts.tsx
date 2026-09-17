// The pieces the App Store corner and the Settings → Apps tab share on
// screen: the stat tile and the two small charts.
//
// One series, one mark, no legend: every chart here is a single measure of
// one app over thirty days, so the title names it and the value is read off
// the tiles above it, not the axis. The mark is thin, the last day carries
// the accent, and the ink stays the text colour.

import { compact } from './format'

/**
 * A stat tile: label, the value, the change against the stretch before.
 * Up is good for everything shown in one, so the delta's colour is its
 * direction. The number wears the text colour, never a series colour.
 */
export function Tile({ label, value, sub, delta, size = 'md' }: {
  label: string
  value: string
  sub?: string
  delta?: { now: number; before: number } | null
  size?: 'md' | 'lg'
}) {
  let change: { text: string; cls: string } | null = null
  if (delta && (delta.now !== 0 || delta.before !== 0)) {
    const diff = delta.now - delta.before
    if (diff === 0) change = { text: 'same as before', cls: 'text-white/40' }
    else {
      const pct = delta.before > 0 ? Math.round((diff / delta.before) * 100) : null
      const sign = diff > 0 ? '+' : '−'
      change = {
        text: pct !== null && Math.abs(pct) < 1000 ? `${sign}${Math.abs(pct)}%` : `${sign}${compact(Math.abs(diff))}`,
        cls: diff > 0 ? 'text-emerald-300' : 'text-red-300',
      }
    }
  }
  return (
    <div className="rounded-xl bg-white/5 border border-white/8 px-3 py-2.5 min-w-0">
      <div className={`text-white/45 leading-tight ${size === 'lg' ? 'text-[12px]' : 'text-[11px]'}`}>{label}</div>
      <div className={`font-semibold text-white leading-tight mt-0.5 truncate ${size === 'lg' ? 'text-[28px]' : 'text-[22px]'}`} title={sub}>{value}</div>
      <div className="text-[11px] leading-tight mt-0.5 flex items-baseline gap-1.5 min-w-0">
        {change ? <span className={change.cls}>{change.text}</span> : <span className="text-white/25">&nbsp;</span>}
        {sub && <span className="text-white/35 truncate">{sub}</span>}
      </div>
    </div>
  )
}

/**
 * A sparkline: a 2px line in a de-emphasised ink with the last day marked in
 * the accent. Its scale is its own — the point is the shape of the month, and
 * the numbers are in the tiles above it.
 */
export function Sparkline({ points, accent, height = 44 }: { points: number[]; accent: string; height?: number }) {
  const w = 300, h = height, pad = 3
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0
  const xy = points.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)] as const)
  const d = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="3.5" fill={accent} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

/**
 * One thin bar per day, anchored to the baseline with a 2px gap between
 * bars, the last day in the accent. For counts — a day with three downloads
 * and a day with none read as three marks and a gap, which a line smooths
 * into a slope that never happened.
 */
export function DayBars({ points, accent, height = 56 }: { points: number[]; accent: string; height?: number }) {
  const max = Math.max(1, ...points)
  return (
    <div className="w-full flex items-end gap-[2px]" style={{ height }} aria-hidden="true">
      {points.map((v, i) => (
        <div key={i} className="flex-1 min-w-0 rounded-t-[2px]" style={{
          height: `${Math.max(v > 0 ? 3 : 1, (v / max) * height)}px`,
          background: i === points.length - 1 ? accent : v > 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)',
        }} />
      ))}
    </div>
  )
}
