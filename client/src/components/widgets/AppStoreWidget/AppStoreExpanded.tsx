// The Apps panel: how each app is doing on the App Store, in detail.
//
// The corner is where the numbers live (Settings → Apps keeps only the key).
// With several apps it opens on a card per app — the four numbers and the
// month's downloads — and a tap on one goes to that app's page: the tiles
// with their change against the stretch before, the month as bars and lines,
// where the downloads came from, the smaller counts (updates, redownloads,
// in-app purchases, sessions, crashes), and a day-by-day table. Nothing here
// is live: the header says which day Apple has published up to, and the
// analytics note says when the impressions stop.

import { useState } from 'react'
import { ArrowLeft, RotateCw } from 'lucide-react'
import type { AppStoreApp, AppStoreView, PeriodTotals } from '../../../hooks/useAppStore'
import { Tile, Sparkline, DayBars } from './parts'
import {
  PERIODS, before, compact, headlineMoney, money, ago, inMinutes, prettyDay, shortDay, type Period,
} from './format'

const ACCENT = '#818cf8'

interface Props {
  view:   AppStoreView | null
  error:  string | null
  busy:   boolean
  onSync: () => void
}

function pct(part: number, whole: number | null): string {
  if (!whole || whole <= 0) return '—'
  return `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%`
}

/** The four numbers for a period, shared by the summary card and the detail page. */
function Tiles({ app, period, currency, size }: { app: AppStoreApp; period: Period; currency: string | null; size: 'md' | 'lg' }) {
  const t: PeriodTotals = app.periods[period]
  const prev = before(app, period)
  const earned = headlineMoney(t.proceeds, currency)
  const mainCur = currency ?? Object.keys(t.proceeds)[0] ?? null
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Tile size={size} label="Downloads" value={compact(t.downloads)} delta={prev ? { now: t.downloads, before: prev.downloads } : null} />
      <Tile size={size} label="Earned" value={earned.text} sub={earned.others.length ? `+ ${earned.others.join(', ')}` : undefined}
        delta={prev && mainCur ? { now: t.proceeds[mainCur] ?? 0, before: prev.proceeds[mainCur] ?? 0 } : null} />
      <Tile size={size} label="Impressions" value={t.impressions === null ? '—' : compact(t.impressions)}
        delta={prev && t.impressions !== null && prev.impressions !== null ? { now: t.impressions, before: prev.impressions } : null} />
      <Tile size={size} label="Page views" value={t.pageViews === null ? '—' : compact(t.pageViews)}
        delta={prev && t.pageViews !== null && prev.pageViews !== null ? { now: t.pageViews, before: prev.pageViews } : null} />
    </div>
  )
}

function analyticsNote(app: AppStoreApp, to: string): string | null {
  if (app.latestAnalyticsDay === null) return 'Impressions and page views start arriving a day or two after the key is set up.'
  if (app.latestAnalyticsDay < to) return `Impressions and page views are up to ${prettyDay(app.latestAnalyticsDay)}; Apple fills the last days in over about three days.`
  return null
}

function SummaryCard({ app, period, currency, onOpen }: { app: AppStoreApp; period: Period; currency: string | null; onOpen: () => void }) {
  const bars = app.series.map(p => p.downloads)
  return (
    <button type="button" onClick={onOpen}
      className="w-full text-left rounded-2xl bg-white/5 border border-hairline p-4 space-y-3 active:bg-white/[0.08] transition-colors">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-white text-[16px] font-semibold truncate">{app.name}</div>
          <div className="text-white/35 text-[11px] truncate">{app.bundleId || app.sku}</div>
        </div>
        <span className="text-indigo-200/80 text-[12px] shrink-0">Details ›</span>
      </div>
      <Tiles app={app} period={period} currency={currency} size="md" />
      <div>
        <div className="flex items-baseline justify-between text-[11px] text-white/40 mb-1">
          <span>Downloads, last 30 days</span>
          <span>{compact(bars.reduce((a, b) => a + b, 0))} in all</span>
        </div>
        <DayBars points={bars} accent={ACCENT} height={40} />
      </div>
    </button>
  )
}

function Detail({ app, period, currency, asOf }: { app: AppStoreApp; period: Period; currency: string | null; asOf: string }) {
  const [rows, setRows] = useState<14 | 30>(14)
  const t = app.periods[period]
  const month = app.periods.month
  const monthEarned = headlineMoney(month.proceeds, currency)
  const downloads = app.series.map(p => p.downloads)
  const proceeds = app.series.map(p => Math.max(0, p.proceeds))
  const impressions = app.series.map(p => p.impressions ?? 0)
  const pageViews = app.series.map(p => p.pageViews ?? 0)
  const hasAnalytics = app.series.some(p => p.impressions !== null)
  const peak = Math.max(0, ...downloads)
  const peakDay = app.series[downloads.indexOf(peak)]?.date
  const daysWithSales = app.series.filter(p => p.downloads > 0).length
  const note = analyticsNote(app, t.to)
  const also: { label: string; value: number | null }[] = [
    { label: 'Updates', value: t.updates },
    { label: 'Redownloads', value: t.redownloads },
    { label: 'In-app purchases', value: t.iap },
    { label: 'Refunded', value: t.refunds },
    { label: 'Taps', value: t.taps },
    { label: 'Sessions', value: t.sessions },
    { label: 'Crashes', value: t.crashes },
  ]
  const table = [...app.series].reverse().slice(0, rows)
  const totalCountry = app.countries.reduce((n, c) => n + c.downloads, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-white text-[20px] font-bold font-display truncate">{app.name}</div>
          <div className="text-white/35 text-[12px] truncate">{app.bundleId || app.sku}</div>
        </div>
        <div className="text-white/40 text-[11px] shrink-0 text-right">
          {app.latestSalesDay ? `sales to ${prettyDay(app.latestSalesDay)}` : 'no sales file yet'}
        </div>
      </div>

      <Tiles app={app} period={period} currency={currency} size="lg" />
      {period !== 'yesterday' && (
        <p className="text-white/30 text-[11px] -mt-2">Changes are against {PERIODS.find(p => p.id === period)!.prev}.</p>
      )}
      {note && <p className="text-[12px] text-white/40 leading-snug -mt-1">{note}</p>}

      {/* The month as it happened. */}
      <section className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-3">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-white/70 font-semibold">Downloads, last 30 days</span>
          <span className="text-white/40">{compact(month.downloads)} in all · {daysWithSales} of 30 days</span>
        </div>
        <DayBars points={downloads} accent={ACCENT} height={64} />
        <div className="flex justify-between text-[11px] text-white/35">
          <span>{shortDay(app.series[0]?.date ?? asOf)}</span>
          {peak > 0 && peakDay && <span>peak {compact(peak)} on {shortDay(peakDay)}</span>}
          <span>{shortDay(asOf)}</span>
        </div>
        <div className="pt-2 border-t border-white/8 flex items-baseline justify-between text-[12px]">
          <span className="text-white/70 font-semibold">Earned, last 30 days</span>
          <span className="text-white/40">{monthEarned.text}{monthEarned.others.length ? ` + ${monthEarned.others.join(', ')}` : ''}</span>
        </div>
        <Sparkline points={proceeds} accent={ACCENT} height={40} />
      </section>

      {/* How it was found. */}
      <section className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-3">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-white/70 font-semibold">Seen on the App Store</span>
          <span className="text-white/40">{PERIODS.find(p => p.id === period)!.label.toLowerCase()}</span>
        </div>
        {hasAnalytics ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] text-white/40 mb-1">Impressions · {t.impressions === null ? '—' : compact(t.impressions)}</div>
                <Sparkline points={impressions} accent={ACCENT} height={36} />
              </div>
              <div>
                <div className="text-[11px] text-white/40 mb-1">Product page views · {t.pageViews === null ? '—' : compact(t.pageViews)}</div>
                <Sparkline points={pageViews} accent={ACCENT} height={36} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-white/[0.04] px-2 py-2">
                <div className="text-[16px] font-semibold text-white tabular-nums">{pct(t.pageViews ?? 0, t.impressions)}</div>
                <div className="text-[10px] text-white/40 leading-tight">of impressions opened the page</div>
              </div>
              <div className="rounded-xl bg-white/[0.04] px-2 py-2">
                <div className="text-[16px] font-semibold text-white tabular-nums">{pct(t.downloads, t.pageViews)}</div>
                <div className="text-[10px] text-white/40 leading-tight">of page views downloaded</div>
              </div>
              <div className="rounded-xl bg-white/[0.04] px-2 py-2">
                <div className="text-[16px] font-semibold text-white tabular-nums">{pct(t.downloads, t.impressions)}</div>
                <div className="text-[10px] text-white/40 leading-tight">of impressions downloaded</div>
              </div>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-white/40 leading-snug">Nothing from App Analytics yet. Apple starts writing the daily files a day or two after the key is set up.</p>
        )}
      </section>

      {/* Where, and the rest. */}
      <div className="grid sm:grid-cols-2 gap-3">
        <section className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-2">
          <div className="text-[12px] text-white/70 font-semibold">Where, this month</div>
          {app.countries.length === 0 ? (
            <p className="text-[12px] text-white/40">No downloads in the last 30 days.</p>
          ) : app.countries.map(c => (
            <div key={c.code} className="flex items-center gap-2 text-[12px]">
              <span className="w-8 text-white/70 font-semibold tabular-nums">{c.code}</span>
              <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${totalCountry ? (c.downloads / totalCountry) * 100 : 0}%`, background: ACCENT }} />
              </div>
              <span className="w-12 text-right text-white/60 tabular-nums">{compact(c.downloads)}</span>
            </div>
          ))}
        </section>
        <section className="rounded-2xl bg-white/5 border border-hairline p-4">
          <div className="text-[12px] text-white/70 font-semibold mb-2">Also, {PERIODS.find(p => p.id === period)!.label.toLowerCase()}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {also.map(a => (
              <div key={a.label} className="flex items-baseline justify-between text-[12px] min-w-0">
                <span className="text-white/45 truncate">{a.label}</span>
                <span className="text-white/80 tabular-nums">{a.value === null ? '—' : compact(a.value)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Day by day. */}
      <section className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-white/70 font-semibold">Day by day</span>
          <button type="button" onClick={() => setRows(rows === 14 ? 30 : 14)}
            className="h-8 px-3 rounded-lg bg-white/10 text-white/60 text-[11px] font-semibold active:scale-95">
            {rows === 14 ? 'Show 30 days' : 'Show 14 days'}
          </button>
        </div>
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-white/35 text-[10px] uppercase tracking-wider">
              <th className="text-left font-medium py-1">Day</th>
              <th className="text-right font-medium py-1">Downloads</th>
              <th className="text-right font-medium py-1">Updates</th>
              <th className="text-right font-medium py-1">Earned</th>
              <th className="text-right font-medium py-1">Impr.</th>
              <th className="text-right font-medium py-1">Views</th>
            </tr>
          </thead>
          <tbody>
            {table.map(d => (
              <tr key={d.date} className="border-t border-white/[0.05]">
                <td className="py-1.5 text-white/70">{shortDay(d.date)}</td>
                <td className="py-1.5 text-right text-white">{d.downloads}</td>
                <td className="py-1.5 text-right text-white/60">{d.updates}</td>
                <td className="py-1.5 text-right text-white/80">{currency ? money(d.proceeds, currency) : d.proceeds.toFixed(2)}</td>
                <td className="py-1.5 text-right text-white/60">{d.impressions === null ? '—' : compact(d.impressions)}</td>
                <td className="py-1.5 text-right text-white/60">{d.pageViews === null ? '—' : compact(d.pageViews)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

export default function AppStoreExpanded({ view, error, busy, onSync }: Props) {
  const [period, setPeriod] = useState<Period>('week')
  const [appId, setAppId] = useState<string | null>(null)

  if (!view) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-8 text-center pt-16">
        <p className="text-white/40 text-sm">{error ? `Could not ask the server: ${error}` : 'Loading…'}</p>
      </div>
    )
  }
  if (!view.configured) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-8 text-center pt-16">
        <p className="text-white text-lg font-semibold">App Store Connect is not set up</p>
        <p className="text-white/50 text-sm leading-relaxed max-w-sm">
          Settings → Apps takes the API key from App Store Connect. Once it is in, this corner shows each app&apos;s
          downloads, earnings and impressions, and the assistant answers “how are my apps doing”.
        </p>
      </div>
    )
  }

  const apps = view.apps
  const selected = apps.length === 1 ? apps[0]! : appId ? apps.find(a => a.id === appId) ?? null : null
  const status = view.syncing
    ? 'Reading from Apple…'
    : view.lastRun
      ? (view.lastRun.ok ? `Read ${ago(view.lastRun.at)}` : `Failed ${ago(view.lastRun.at)}: ${view.lastRun.detail}`)
      : 'Not read yet'

  return (
    <div className="relative flex flex-col h-full p-4 pt-16 gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold font-display text-white/85 flex items-center gap-2">
            {selected && apps.length > 1 && (
              <button type="button" onClick={() => setAppId(null)} aria-label="All apps"
                className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center active:scale-95">
                <ArrowLeft size={16} />
              </button>
            )}
            App Store
          </h2>
          <p className={`text-[11px] ${view.lastRun && !view.lastRun.ok ? 'text-red-300' : 'text-white/40'}`}>
            up to {prettyDay(view.asOf)} · {status}{!view.syncing && view.nextRunAt ? ` · next in ${inMinutes(view.nextRunAt)}` : ''}
          </p>
        </div>
        <button type="button" disabled={busy || view.syncing} onClick={onSync}
          className="h-10 px-3 rounded-xl bg-white/10 text-white/70 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-50 shrink-0">
          <RotateCw size={13} className={busy || view.syncing ? 'animate-spin' : ''} />
          Read now
        </button>
      </div>

      {error && <p className="text-[12px] text-red-300 rounded-xl bg-red-500/10 border border-red-400/30 px-3 py-2">{error}</p>}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        {apps.length > 1 ? (
          <div className="flex gap-1.5 flex-wrap">
            <button type="button" onClick={() => setAppId(null)}
              className={`h-9 px-3.5 rounded-full text-[12px] font-semibold ${!selected ? 'bg-indigo-500/25 text-indigo-100' : 'bg-white/5 text-white/50'}`}>
              All
            </button>
            {apps.map(a => (
              <button key={a.id} type="button" onClick={() => setAppId(a.id)}
                className={`h-9 px-3.5 rounded-full text-[12px] font-semibold max-w-[11rem] truncate ${selected?.id === a.id ? 'bg-indigo-500/25 text-indigo-100' : 'bg-white/5 text-white/50'}`}>
                {a.name}
              </button>
            ))}
          </div>
        ) : <span />}
        <div className="flex rounded-xl bg-white/5 border border-hairline p-0.5 shrink-0">
          {PERIODS.map(p => (
            <button key={p.id} type="button" onClick={() => setPeriod(p.id)}
              className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold transition ${period === p.id ? 'bg-white/15 text-white' : 'text-white/50'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-fade-y pb-6 space-y-3">
        {apps.length === 0 ? (
          <p className="text-white/40 text-sm rounded-2xl bg-white/5 border border-hairline p-4">
            {view.syncing || !view.lastRun
              ? 'Reading the first three months from Apple — a minute or two.'
              : view.lastRun.ok ? 'Apple lists no apps for this key yet.' : `Could not read from Apple: ${view.lastRun.detail}`}
          </p>
        ) : selected ? (
          <Detail app={selected} period={period} currency={view.currency} asOf={view.asOf} />
        ) : apps.map(app => (
          <SummaryCard key={app.id} app={app} period={period} currency={view.currency} onOpen={() => setAppId(app.id)} />
        ))}
      </div>
    </div>
  )
}
