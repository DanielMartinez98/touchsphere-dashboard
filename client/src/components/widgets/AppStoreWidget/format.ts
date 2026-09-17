// Formatting and the period table the App Store corner and Settings → Apps
// share. Kept apart from the components in parts.tsx so that file exports
// components only (React's fast refresh wants it that way).

import type { PeriodTotals } from '../../../hooks/useAppStore'

export type Period = 'yesterday' | 'week' | 'month'

export const PERIODS: { id: Period; label: string; prev: string }[] = [
  { id: 'yesterday', label: 'Yesterday', prev: 'the day before' },
  { id: 'week',      label: '7 days',    prev: 'the 7 before' },
  { id: 'month',     label: '30 days',   prev: 'the 30 before' },
]

export const compact = (n: number): string =>
  n >= 10_000
    ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : new Intl.NumberFormat().format(n)

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** The headline money for a period: the main currency's figure, and the other currencies that also earned. */
export function headlineMoney(p: Record<string, number>, currency: string | null): { text: string; others: string[] } {
  const entries = Object.entries(p).filter(([, v]) => v !== 0)
  if (entries.length === 0) return { text: currency ? money(0, currency) : '0', others: [] }
  const main = currency && p[currency] !== undefined ? currency : entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]![0]
  return {
    text: money(p[main] ?? 0, main),
    others: entries.filter(([c]) => c !== main).map(([c, v]) => money(v, c)),
  }
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

export function inMinutes(iso: string): string {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  return m <= 0 ? 'any moment' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`
}

export function prettyDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function shortDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The stretch before a period, for the change on a tile; null for yesterday, which has no "before" worth a percentage. */
export function before(app: { periods: { prevWeek: PeriodTotals; prevMonth: PeriodTotals } }, period: Period): PeriodTotals | null {
  return period === 'week' ? app.periods.prevWeek : period === 'month' ? app.periods.prevMonth : null
}
