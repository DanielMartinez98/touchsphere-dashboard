// Formatting, date arithmetic and the table of measures the Apps corner and
// Settings → App Store share. Kept apart from the components in parts.tsx so
// that file exports components only (React's fast refresh wants it that way).

import type { Group, Measures } from '../../../hooks/useAppStore'

/** The two ways an app earns, in the two colours they keep everywhere on the screen. */
export const SALES_COLOR = '#818cf8'
export const ADS_COLOR = '#34d399'

export const compact = (n: number): string =>
  n >= 10_000
    ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)

export function money(amount: number, currency: string, approx = false): string {
  let text: string
  try {
    text = new Intl.NumberFormat(undefined, {
      style: 'currency', currency,
      maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
      minimumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
    }).format(amount)
  } catch {
    text = `${amount.toFixed(2)} ${currency}`
  }
  return approx ? `≈ ${text}` : text
}

export function percent(part: number, whole: number | null): string {
  if (!whole || whole <= 0) return '—'
  const p = (part / whole) * 100
  return `${p.toFixed(p < 10 ? 1 : 0)}%`
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

// ── Dates (all YYYY-MM-DD, no time zone: a report day is a label, not an instant) ──

const at = (date: string) => new Date(`${date}T12:00:00`)

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export function prettyDay(date: string): string {
  const d = at(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function shortDay(date: string): string {
  const d = at(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "3 – 9 Nov 2026", "28 Oct – 3 Nov 2026", "9 Nov 2026". */
export function rangeText(from: string, to: string): string {
  const a = at(from), b = at(to)
  const year = b.getFullYear()
  if (from === to) return b.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === year
  const left = sameMonth ? String(a.getDate()) : a.toLocaleDateString(undefined, a.getFullYear() === year ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `${left} – ${b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** The label under a bar or in the first column of the table, for a day, a week or a month. */
export function bucketLabel(b: { key: string; from: string; to: string }, group: Group, long = false): string {
  if (group === 'month') return at(b.key).toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short' })
  if (group === 'week') return long ? `${shortDay(b.from)} – ${shortDay(b.to)}` : shortDay(b.from)
  return long ? prettyDay(b.key) : shortDay(b.key)
}

// ── Ranges ───────────────────────────────────────────────────────────────────

export type PresetId = 'yesterday' | '7d' | '30d' | '90d' | 'month' | 'lastMonth' | '12m' | 'custom'

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d',        label: '7 days' },
  { id: '30d',       label: '30 days' },
  { id: '90d',       label: '90 days' },
  { id: 'month',     label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: '12m',       label: '12 months' },
]

/** A preset as dates, ending on `asOf` — the newest day Apple has published. */
export function presetRange(id: Exclude<PresetId, 'custom'>, asOf: string): { from: string; to: string } {
  switch (id) {
    case 'yesterday': return { from: asOf, to: asOf }
    case '7d':        return { from: addDays(asOf, -6), to: asOf }
    case '30d':       return { from: addDays(asOf, -29), to: asOf }
    case '90d':       return { from: addDays(asOf, -89), to: asOf }
    case '12m':       return { from: addDays(asOf, -364), to: asOf }
    case 'month':     return { from: `${asOf.slice(0, 7)}-01`, to: asOf }
    case 'lastMonth': {
      const end = addDays(`${asOf.slice(0, 7)}-01`, -1)
      return { from: `${end.slice(0, 7)}-01`, to: end }
    }
  }
}

/** The grouping a range reads best at: bars a finger can still tap. */
export function naturalGroup(days: number): Group {
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month'
}

// ── Measures ─────────────────────────────────────────────────────────────────

export type MetricId =
  | 'revenue' | 'downloads' | 'adRevenue' | 'proceeds' | 'impressions' | 'pageViews'
  | 'adImpressions' | 'ecpm' | 'updates' | 'iap'

export interface Metric {
  id:     MetricId
  label:  string
  /** One line saying what the number counts, in plain words. */
  about:  string
  money?: boolean
  value:  (m: Measures) => number | null
}

export const revenueOf = (m: Measures) => m.proceeds + m.adRevenue
export const ecpmOf = (revenue: number, impressions: number) => (impressions > 0 ? (revenue / impressions) * 1000 : null)

export const METRICS: Record<MetricId, Metric> = {
  revenue:       { id: 'revenue',       label: 'Earned in all',    money: true, about: 'Sales plus ads, added together.',                                   value: revenueOf },
  downloads:     { id: 'downloads',     label: 'Downloads',        about: 'People who got the app for the first time. Updates and re-installs are not counted.', value: m => m.downloads },
  adRevenue:     { id: 'adRevenue',     label: 'From ads',         money: true, about: 'What AdMob and Unity Ads say the ads earned. An estimate until they pay.', value: m => m.adRevenue },
  proceeds:      { id: 'proceeds',      label: 'From sales',       money: true, about: 'Paid downloads and in-app purchases, after Apple’s cut.',              value: m => m.proceeds },
  impressions:   { id: 'impressions',   label: 'Seen on the store', about: 'Times the app showed up in search results, charts or a list on the App Store.',   value: m => m.impressions },
  pageViews:     { id: 'pageViews',     label: 'Page visits',      about: 'Times someone opened the app’s own App Store page.',                              value: m => m.pageViews },
  adImpressions: { id: 'adImpressions', label: 'Ads shown',        about: 'Times an ad was actually displayed inside an app.',                               value: m => m.adImpressions },
  ecpm:          { id: 'ecpm',          label: 'Per 1,000 ads',    money: true, about: 'What a thousand shown ads earned (eCPM). Higher means each ad is worth more.', value: m => ecpmOf(m.adRevenue, m.adImpressions) },
  updates:       { id: 'updates',       label: 'Updates',          about: 'Existing users who installed a new version.',                                     value: m => m.updates },
  iap:           { id: 'iap',           label: 'In-app purchases', about: 'Purchases made inside the apps, counted in units.',                               value: m => m.iap },
}

export function countryName(code: string): string {
  if (code === '??' || !code) return 'Unknown'
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** "+12%", "−3", "new" — and whether it went up. null when there is nothing to compare. */
export function change(now: number | null, before: number | null): { text: string; up: boolean; flat: boolean } | null {
  if (now === null || before === null) return null
  if (now === 0 && before === 0) return null
  const diff = now - before
  if (Math.abs(diff) < 0.005) return { text: 'no change', up: false, flat: true }
  if (before <= 0) return { text: 'new', up: true, flat: false }
  const pct = Math.round((diff / before) * 100)
  if (pct === 0) return { text: 'about the same', up: false, flat: true }
  return { text: `${diff > 0 ? '+' : '−'}${Math.abs(pct) >= 1000 ? compact(Math.abs(pct)) : Math.abs(pct)}%`, up: diff > 0, flat: false }
}

/** Compact number for a table cell; a dash for "no figure". */
export function cell(v: number | null): string { return v === null ? '—' : compact(v) }
