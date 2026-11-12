// The Apps corner's numbers, as one question with one answer: "from this day
// to that one, for these apps, in these countries — what happened?"
//
// The corner used to be handed three fixed stretches (yesterday, 7 days, 30
// days) pre-summed per app, which is a scoreboard: it says how much and never
// lets you ask where, when or through what. This builds the answer for any
// range from the days app-store.ts and ads.ts keep, sliced by the filters the
// screen sets, with the same stretch immediately before it for comparison:
//
//   totals / prev   every measure over the range and over the range before it
//   series          the same per day, week or month, for the chart and the table
//   byApp           per app, both stretches — the comparison table. It ignores
//                   the app filter on purpose: it IS the app picker
//   byCountry       per country; ignores the country filter for the same reason
//   bySource        where on the App Store the app was seen (search, browse…)
//   ads             by network, ad unit, format and platform
//
// ONE LIST OF APPS. An app is the same app whether Apple, AdMob or Unity is
// describing it, so the three catalogues are joined: an AdMob app linked to
// its store listing joins on the store id, anything else on its name, and an
// ad app with no App Store twin (an Android build) stands as its own entry.
// A hidden app is left out of everything, totals included.
//
// ONE CURRENCY. Every amount is converted to the display currency at today's
// rate (fx.ts), so store proceeds and ad revenue can be added. `approx` says
// a conversion happened; the screen marks those figures "≈".

import {
  addDays, configSource, latestDay, readConfig, readPrefs, readStats, syncState,
  type DayStats, type Stats,
} from './app-store'
import { adsStatus, readAds, type AdRow, type AdStore, type AdsStatus, type Network } from './ads'
import { convert, fxAsOf } from './fx'

// ── The joined app list ──────────────────────────────────────────────────────

export interface UnifiedApp {
  /** The Apple id for an App Store app; `ad:<network>:<id>` for one known only to an ad network. */
  id:        string
  name:      string
  bundleId:  string
  store:     boolean
  networks:  Network[]
  platforms: string[]
  hidden:    boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

function unify(stats: Stats, ads: AdStore, hidden: Set<string>): { apps: UnifiedApp[]; adKeyToApp: Map<string, string> } {
  const apps = new Map<string, UnifiedApp>()
  const byName = new Map<string, string>()
  for (const a of Object.values(stats.apps)) {
    apps.set(a.id, { id: a.id, name: a.name, bundleId: a.bundleId, store: true, networks: [], platforms: ['ios'], hidden: hidden.has(a.id) })
    if (a.name) byName.set(norm(a.name), a.id)
  }
  const adKeyToApp = new Map<string, string>()
  // Store-linked apps first, so a name match never beats a real link.
  const adApps = Object.entries(ads.apps).sort((a, b) => Number(!!b[1].storeId) - Number(!!a[1].storeId))
  for (const [key, a] of adApps) {
    let id = a.storeId && apps.has(a.storeId) ? a.storeId : byName.get(norm(a.name))
    if (!id) {
      id = `ad:${key}`
      apps.set(id, { id, name: a.name, bundleId: '', store: false, networks: [], platforms: [], hidden: hidden.has(id) })
      if (a.name) byName.set(norm(a.name), id)
    }
    const app = apps.get(id)!
    if (!app.networks.includes(a.network)) app.networks.push(a.network)
    if (a.platform && !app.platforms.includes(a.platform)) app.platforms.push(a.platform)
    adKeyToApp.set(key, id)
  }
  return { apps: [...apps.values()], adKeyToApp }
}

// ── Measures ─────────────────────────────────────────────────────────────────

export interface Measures {
  downloads:     number
  redownloads:   number
  updates:       number
  iap:           number
  refunds:       number
  /** What the App Store sales earned, in the display currency. */
  proceeds:      number
  /** null while no day in the stretch has that report (or it cannot be narrowed to the filter). */
  impressions:   number | null
  pageViews:     number | null
  taps:          number | null
  sessions:      number | null
  crashes:       number | null
  adRevenue:     number
  adImpressions: number
  adClicks:      number
  adRequests:    number
  adMatched:     number
}

function zero(): Measures {
  return {
    downloads: 0, redownloads: 0, updates: 0, iap: 0, refunds: 0, proceeds: 0,
    impressions: null, pageViews: null, taps: null, sessions: null, crashes: null,
    adRevenue: 0, adImpressions: 0, adClicks: 0, adRequests: 0, adMatched: 0,
  }
}

const NULLABLE = ['impressions', 'pageViews', 'taps', 'sessions', 'crashes'] as const
const PLAIN = ['downloads', 'redownloads', 'updates', 'iap', 'refunds', 'proceeds', 'adRevenue', 'adImpressions', 'adClicks', 'adRequests', 'adMatched'] as const

function add(into: Measures, m: Partial<Measures>): void {
  for (const k of PLAIN) if (m[k]) into[k] += m[k]!
  for (const k of NULLABLE) { const v = m[k]; if (typeof v === 'number') into[k] = (into[k] ?? 0) + v }
}

function tidy(m: Measures): Measures {
  m.proceeds = Math.round(m.proceeds * 100) / 100
  m.adRevenue = Math.round(m.adRevenue * 100) / 100
  return m
}

// ── The question ─────────────────────────────────────────────────────────────

export type Group = 'day' | 'week' | 'month'

export interface ReportQuery {
  from:       string
  to:         string
  group?:     Group
  apps?:      string[]
  countries?: string[]
  networks?:  string[]
  /** `<network>:<unit id>`, as `ads.byUnit[].key` gives them. */
  units?:     string[]
}

export interface AdSlice {
  key: string; label: string; sub?: string
  revenue: number; impressions: number; clicks: number; requests: number; matched: number
}

export interface Report {
  from: string; to: string; prevFrom: string; prevTo: string; days: number
  group:    Group
  currency: string
  /** True when any amount was converted from another currency (at today's rate). */
  approx:   boolean
  /** Currencies seen with no rate, added at face value. Normally empty. */
  unconverted: string[]
  fxAsOf:   string | null
  /** The newest day each source has: sales, analytics, and each ad network. */
  coverage: { sales: string | null; analytics: string | null; admob: string | null; unity: string | null }
  apps:     UnifiedApp[]
  totals:   Measures
  prev:     Measures
  series:   ({ key: string; from: string; to: string } & Measures)[]
  /** `series` is that app's own figures per bucket, in the order of `series` above: the lines of the chart. */
  byApp:    { id: string; name: string; totals: Measures; prev: Measures; trend: number[]; series: Measures[] }[]
  byCountry: { code: string; downloads: number; proceeds: number; impressions: number | null; pageViews: number | null; adRevenue: number; adImpressions: number }[]
  /** null when a country filter is set: Apple's file does not cross source with territory here. */
  bySource: { source: string; impressions: number; pageViews: number; taps: number }[] | null
  ads: { byNetwork: AdSlice[]; byUnit: AdSlice[]; byFormat: AdSlice[]; byPlatform: AdSlice[] }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 800

function bucketOf(date: string, group: Group): string {
  if (group === 'day') return date
  if (group === 'month') return `${date.slice(0, 7)}-01`
  const d = new Date(`${date}T00:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7          // weeks start on Monday
  return addDays(date, -back)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

const NETWORK_NAME: Record<string, string> = { admob: 'AdMob', unity: 'Unity Ads' }

export function buildReport(q: ReportQuery): Report {
  const stats = readStats()
  const ads = readAds()
  const prefs = readPrefs()
  const currency = prefs.currency
  const hidden = new Set(prefs.hidden)
  const { apps: allApps, adKeyToApp } = unify(stats, ads, hidden)
  const apps = allApps.filter(a => !a.hidden)
  const shown = new Set(apps.map(a => a.id))

  let to = ISO.test(q.to) ? q.to : latestDay()
  let from = ISO.test(q.from) ? q.from : addDays(to, -6)
  if (from > to) [from, to] = [to, from]
  if (daysBetween(from, to) >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1))
  const days = daysBetween(from, to) + 1
  const prevTo = addDays(from, -1)
  const prevFrom = addDays(prevTo, -(days - 1))
  const group: Group = q.group === 'week' || q.group === 'month' ? q.group : 'day'

  const set = (v: string[] | undefined) => (v && v.length ? new Set(v) : null)
  const appFilter = set(q.apps?.filter(id => shown.has(id)))
  const ccFilter = set(q.countries?.map(c => c.toUpperCase()))
  const netFilter = set(q.networks)
  const unitFilter = set(q.units)

  let approx = false
  const unconverted = new Set<string>()
  const money = (amount: number, cur: string): number => {
    if (!amount) return 0
    if (cur === currency) return amount
    const v = convert(amount, cur, currency)
    if (v === null) { unconverted.add(cur); return amount }
    approx = true
    return v
  }
  const moneyOf = (p: Record<string, number>): number => {
    let n = 0
    for (const [cur, amount] of Object.entries(p)) n += money(amount, cur)
    return n
  }

  const totals = zero(), prev = zero()
  const series = new Map<string, { key: string; from: string; to: string } & Measures>()
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const key = bucketOf(d, group)
    const b = series.get(key)
    if (b) b.to = d
    else series.set(key, { key, from: d, to: d, ...zero() })
  }
  const byApp = new Map<string, { totals: Measures; prev: Measures; trend: Map<string, number>; series: Map<string, Measures> }>()
  for (const a of apps) byApp.set(a.id, { totals: zero(), prev: zero(), trend: new Map(), series: new Map() })
  const appBucket = (slot: { series: Map<string, Measures> }, key: string): Measures => {
    let m = slot.series.get(key)
    if (!m) { m = zero(); slot.series.set(key, m) }
    return m
  }
  const byCountry = new Map<string, Report['byCountry'][number]>()
  const country = (code: string) => {
    let c = byCountry.get(code)
    if (!c) { c = { code, downloads: 0, proceeds: 0, impressions: null, pageViews: null, adRevenue: 0, adImpressions: 0 }; byCountry.set(code, c) }
    return c
  }
  const bySource = new Map<string, { source: string; impressions: number; pageViews: number; taps: number }>()
  let latestAnalytics: string | null = null

  /** One app's day under the country filter. */
  const storeDay = (day: DayStats): Partial<Measures> => {
    if (!ccFilter) {
      return {
        downloads: day.downloads, redownloads: day.redownloads, updates: day.updates, iap: day.iap, refunds: day.refunds,
        proceeds: moneyOf(day.proceeds),
        impressions: day.impressions ?? null, pageViews: day.pageViews ?? null, taps: day.taps ?? null,
        sessions: day.sessions ?? null, crashes: day.crashes ?? null,
      }
    }
    const m: Partial<Measures> = { downloads: 0, redownloads: 0, updates: 0, iap: 0, refunds: 0, proceeds: 0 }
    for (const cc of ccFilter) {
      const c = day.byCountry?.[cc]
      if (c) {
        m.downloads! += c.d; m.redownloads! += c.r; m.updates! += c.u; m.iap! += c.i; m.refunds! += c.f
        m.proceeds! += moneyOf(c.p)
      }
      const t = day.territories?.[cc]
      if (day.territories) {
        m.impressions = (m.impressions ?? 0) + (t?.im ?? 0)
        m.pageViews = (m.pageViews ?? 0) + (t?.pv ?? 0)
        m.taps = (m.taps ?? 0) + (t?.tp ?? 0)
      }
    }
    return m
  }

  for (const app of apps) {
    if (!app.store) continue
    const appDays = stats.days[app.id] ?? {}
    const slot = byApp.get(app.id)!
    const picked = !appFilter || appFilter.has(app.id)
    for (let d = prevFrom; d <= to; d = addDays(d, 1)) {
      const day = appDays[d]
      if (!day) continue
      const now = d >= from
      const m = storeDay(day)
      add(now ? slot.totals : slot.prev, m)
      if (now) {
        slot.trend.set(bucketOf(d, group), (slot.trend.get(bucketOf(d, group)) ?? 0) + (m.downloads ?? 0))
        add(appBucket(slot, bucketOf(d, group)), m)
      }
      if (!picked) continue
      add(now ? totals : prev, m)
      if (!now) continue
      add(series.get(bucketOf(d, group))!, m)
      if (typeof day.impressions === 'number' && (!latestAnalytics || d > latestAnalytics)) latestAnalytics = d
      for (const [cc, c] of Object.entries(day.byCountry ?? {})) {
        const row = country(cc)
        row.downloads += c.d
        row.proceeds += moneyOf(c.p)
      }
      for (const [cc, t] of Object.entries(day.territories ?? {})) {
        const row = country(cc)
        row.impressions = (row.impressions ?? 0) + t.im
        row.pageViews = (row.pageViews ?? 0) + t.pv
      }
      if (!ccFilter) {
        for (const [source, t] of Object.entries(day.sources ?? {})) {
          const row = bySource.get(source) ?? { source, impressions: 0, pageViews: 0, taps: 0 }
          row.impressions += t.im; row.pageViews += t.pv; row.taps += t.tp
          bySource.set(source, row)
        }
      }
    }
  }

  const slices = { byNetwork: new Map<string, AdSlice>(), byUnit: new Map<string, AdSlice>(), byFormat: new Map<string, AdSlice>(), byPlatform: new Map<string, AdSlice>() }
  const slice = (into: Map<string, AdSlice>, key: string, label: string, sub: string | undefined, r: AdRow, rev: number) => {
    let s = into.get(key)
    if (!s) { s = { key, label, ...(sub ? { sub } : {}), revenue: 0, impressions: 0, clicks: 0, requests: 0, matched: 0 }; into.set(key, s) }
    s.revenue += rev; s.impressions += r.imp; s.clicks += r.clk; s.requests += r.req; s.matched += r.mat
  }
  const adLatest: Record<string, string> = {}
  const appName = new Map(apps.map(a => [a.id, a.name]))

  for (let d = prevFrom; d <= to; d = addDays(d, 1)) {
    const rows = ads.days[d]
    if (!rows) continue
    const now = d >= from
    for (const r of rows) {
      const appId = adKeyToApp.get(`${r.n}:${r.app}`)
      if (!appId || !shown.has(appId)) continue
      if (!adLatest[r.n] || d > adLatest[r.n]!) adLatest[r.n] = d
      const unitKey = `${r.n}:${r.unit}`
      const okNet = !netFilter || netFilter.has(r.n)
      const okUnit = !unitFilter || unitFilter.has(unitKey)
      const okCc = !ccFilter || ccFilter.has(r.cc)
      const okApp = !appFilter || appFilter.has(appId)
      const rev = money(r.rev, ads.currency[r.n] ?? 'USD')
      const m: Partial<Measures> = { adRevenue: rev, adImpressions: r.imp, adClicks: r.clk, adRequests: r.req, adMatched: r.mat }
      if (okNet && okUnit && okCc) {
        add(now ? byApp.get(appId)!.totals : byApp.get(appId)!.prev, m)
        if (now) add(appBucket(byApp.get(appId)!, bucketOf(d, group)), m)
        if (okApp) {
          add(now ? totals : prev, m)
          if (now) add(series.get(bucketOf(d, group))!, m)
        }
      }
      if (!now || !okApp) continue
      // Each breakdown ignores its own filter, so it stays a picker.
      if (okNet && okUnit) {
        const c = country(r.cc)
        c.adRevenue += rev; c.adImpressions += r.imp
      }
      if (!okCc) continue
      if (okUnit) slice(slices.byNetwork, r.n, NETWORK_NAME[r.n] ?? r.n, undefined, r, rev)
      if (okNet) {
        const unit = ads.units[unitKey]
        const label = unit?.name || (r.unit ? r.unit : 'No ad unit named')
        const sub = [appName.get(appId), NETWORK_NAME[r.n], unit?.format || r.fmt, r.plat === 'ios' ? 'iOS' : r.plat === 'android' ? 'Android' : r.plat].filter(Boolean).join(' · ')
        slice(slices.byUnit, `${unitKey}`, label, sub, r, rev)
      }
      if (okNet && okUnit) {
        slice(slices.byFormat, r.fmt || 'Not stated', r.fmt || 'Not stated', undefined, r, rev)
        slice(slices.byPlatform, r.plat || 'Not stated', r.plat === 'ios' ? 'iOS' : r.plat === 'android' ? 'Android' : (r.plat || 'Not stated'), undefined, r, rev)
      }
    }
  }

  const salesDays = Object.keys(stats.salesDays).filter(d => stats.salesDays[d] === 'ok').sort()
  const sortSlices = (m: Map<string, AdSlice>) =>
    [...m.values()].map(s => ({ ...s, revenue: Math.round(s.revenue * 100) / 100 })).sort((a, b) => b.revenue - a.revenue || b.impressions - a.impressions)
  const seriesKeys = [...series.keys()]

  return {
    from, to, prevFrom, prevTo, days, group, currency,
    approx, unconverted: [...unconverted], fxAsOf: fxAsOf(),
    coverage: {
      sales: salesDays[salesDays.length - 1] ?? null,
      analytics: latestAnalytics,
      admob: adLatest['admob'] ?? null,
      unity: adLatest['unity'] ?? null,
    },
    apps,
    totals: tidy(totals),
    prev: tidy(prev),
    series: [...series.values()].map(tidy) as Report['series'],
    byApp: apps.map(a => {
      const s = byApp.get(a.id)!
      return { id: a.id, name: a.name, totals: tidy(s.totals), prev: tidy(s.prev), trend: seriesKeys.map(k => s.trend.get(k) ?? 0), series: seriesKeys.map(k => tidy(s.series.get(k) ?? zero())) }
    }).sort((a, b) =>
      (b.totals.proceeds + b.totals.adRevenue) - (a.totals.proceeds + a.totals.adRevenue)
      || b.totals.downloads - a.totals.downloads || a.name.localeCompare(b.name)),
    byCountry: [...byCountry.values()]
      .map(c => ({ ...c, proceeds: Math.round(c.proceeds * 100) / 100, adRevenue: Math.round(c.adRevenue * 100) / 100 }))
      .filter(c => c.downloads || c.proceeds || c.impressions || c.adRevenue || c.adImpressions)
      .sort((a, b) => b.downloads - a.downloads || (b.proceeds + b.adRevenue) - (a.proceeds + a.adRevenue) || (b.impressions ?? 0) - (a.impressions ?? 0)),
    bySource: ccFilter ? null : [...bySource.values()].sort((a, b) => b.impressions - a.impressions),
    ads: {
      byNetwork: sortSlices(slices.byNetwork), byUnit: sortSlices(slices.byUnit),
      byFormat: sortSlices(slices.byFormat), byPlatform: sortSlices(slices.byPlatform),
    },
  }
}

// ── The light view: status, the list of apps, and yesterday for the pill ─────

export interface AppStoreView {
  configured:   boolean
  source:       'settings' | 'env' | 'none'
  keyId:        string
  issuerId:     string
  vendorNumber: string
  lastRun:      Stats['lastRun']
  nextRunAt:    string | null
  syncing:      boolean
  /** The currency every amount is shown in. */
  currency:     string
  /** The day the sales window ends on (yesterday, Pacific time). */
  asOf:         string
  salesDaysRead: number
  /** Every app known, hidden ones included — the list Settings and "Choose apps" edit. */
  apps:         UnifiedApp[]
  /** The newest published day across the apps that are shown. */
  yesterday:    { downloads: number; proceeds: number; adRevenue: number; impressions: number | null; approx: boolean; apps: number }
  ads:          AdsStatus
}

export function appStoreView(): AppStoreView {
  const cfg = readConfig()
  const stats = readStats()
  const prefs = readPrefs()
  const asOf = latestDay()
  const r = buildReport({ from: asOf, to: asOf })
  const { apps } = unify(stats, readAds(), new Set(prefs.hidden))
  apps.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name))
  return {
    configured: !!(cfg.issuerId && cfg.keyId && cfg.vendorNumber && cfg.privateKey),
    source: configSource(),
    keyId: cfg.keyId,
    issuerId: cfg.issuerId,
    vendorNumber: cfg.vendorNumber,
    lastRun: stats.lastRun,
    ...syncState(),
    currency: prefs.currency,
    asOf,
    salesDaysRead: Object.keys(stats.salesDays).length,
    apps,
    yesterday: {
      downloads: r.totals.downloads, proceeds: r.totals.proceeds, adRevenue: r.totals.adRevenue,
      impressions: r.totals.impressions, approx: r.approx, apps: r.apps.length,
    },
    ads: adsStatus(),
  }
}
