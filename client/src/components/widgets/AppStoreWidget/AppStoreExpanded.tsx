// The Apps panel: what the apps earned and how they were found, for any
// stretch of days, narrowed however the question needs.
//
// It reads top to bottom as one answer. WHEN (a preset or any two days, with
// ‹ › to step back a stretch at a time) and FOR WHAT (apps, countries) come
// first; then one sentence that says the result in words; then six figures,
// each with its change against the stretch before and a line saying what it
// counts — and each a button, because tapping one draws it in the chart below,
// by day, week or month. Under the chart the same figures are cut five ways:
// day by day, by app, by country, by ad (network, unit, format, platform) and
// by how the app was found on the App Store.
//
// Every row that names something is a filter: tap an app, a country or an ad
// unit and the whole page narrows to it; the "Showing" line says what is in
// effect and clears it. A breakdown never narrows itself, so the table you
// tapped stays whole and the next tap is one away.
//
// Apps are left out of the list (one not released yet, a test build) from
// "Choose apps" or the eye on an app's row; a hidden app leaves every total.
//
// Nothing here is live — Apple publishes a day the next morning and fills in
// impressions over about three — so the header says how far each source reads.

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, EyeOff, RotateCw, SlidersHorizontal, CalendarRange, Globe2, Download } from 'lucide-react'
import {
  useAppReport, type AppStoreActions, type AdSlice, type Group, type Measures, type Report, type ReportQuery,
} from '../../../hooks/useAppStore'
import { keyboardMode } from '../../../hooks/useKeyboardMode'
import { Switch } from '../../settings/ui'
import { BarChart, Chip, MiniBars, SectionCard, ShareBar, Sheet, Tile, type Bar } from './parts'
import { RangePicker } from './RangePicker'
import {
  ADS_COLOR, METRICS, PRESETS, SALES_COLOR, addDays, ago, bucketLabel, cell, change, compact, countryName, daysBetween,
  ecpmOf, inMinutes, money, naturalGroup, percent, presetRange, prettyDay, rangeText, revenueOf, shortDay,
  type MetricId, type PresetId,
} from './format'

type Tab = 'days' | 'apps' | 'countries' | 'ads' | 'found'
const TABS: { id: Tab; label: string }[] = [
  { id: 'days', label: 'Day by day' },
  { id: 'apps', label: 'By app' },
  { id: 'countries', label: 'By country' },
  { id: 'ads', label: 'Ads' },
  { id: 'found', label: 'How it was found' },
]
const TILES: MetricId[] = ['revenue', 'downloads', 'adRevenue', 'proceeds', 'impressions', 'adImpressions']
const NETWORK_NAME: Record<string, string> = { admob: 'AdMob', unity: 'Unity Ads' }

function remembered(): { preset: PresetId; from?: string; to?: string } {
  try {
    const raw = JSON.parse(localStorage.getItem('apps.range') ?? '{}') as { preset?: PresetId; from?: string; to?: string }
    if (raw.preset === 'custom' && raw.from && raw.to) return { preset: 'custom', from: raw.from, to: raw.to }
    if (raw.preset && PRESETS.some(p => p.id === raw.preset)) return { preset: raw.preset }
  } catch { /* first visit */ }
  return { preset: '7d' }
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])

// ── The sentence ─────────────────────────────────────────────────────────────

function Headline({ r }: { r: Report }) {
  const t = r.totals
  const total = revenueOf(t)
  const c = change(total, revenueOf(r.prev))
  const span = r.days === 1 ? prettyDay(r.to) : `these ${r.days} days`
  const top = r.byCountry[0]
  const best = [...r.series].sort((a, b) => b.downloads - a.downloads)[0]
  const parts: string[] = []
  if (t.adRevenue > 0) parts.push(`${money(t.adRevenue, r.currency)} from ads`)
  if (t.proceeds !== 0) parts.push(`${money(t.proceeds, r.currency)} from sales`)
  return (
    <div className="rounded-2xl bg-gradient-to-br from-indigo-500/20 to-emerald-500/10 border border-white/10 px-4 py-3.5">
      <p className="text-[17px] leading-snug text-white">
        <span className="font-semibold">{money(total, r.currency, r.approx)}</span> earned {r.days === 1 ? `on ${span}` : `in ${span}`}
        {parts.length > 1 ? <span className="text-white/65"> — {parts.join(' and ')}</span> : null}.
        {c && !c.flat && (
          <span className={c.up ? ' text-emerald-300' : ' text-red-300'}> {c.up ? 'Up' : 'Down'} {c.text.replace(/^[+−]/, '')} on the {r.days === 1 ? 'day' : `${r.days} days`} before.</span>
        )}
      </p>
      <p className="text-[14px] leading-snug text-white/60 mt-1.5">
        {compact(t.downloads)} new download{t.downloads === 1 ? '' : 's'}
        {top && top.downloads > 0 && t.downloads > 0 ? `, most from ${countryName(top.code)} (${percent(top.downloads, t.downloads)})` : ''}.
        {best && best.downloads > 0 && r.series.length > 1 ? ` Best ${r.group}: ${bucketLabel(best, r.group, true)} with ${compact(best.downloads)}.` : ''}
      </p>
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function DaysTable({ r }: { r: Report }) {
  const [all, setAll] = useState(false)
  const rows = [...r.series].reverse()
  const shown = all ? rows : rows.slice(0, 14)
  const cash = (v: number) => money(v, r.currency)
  const head = ['Downloads', 'Earned', 'Sales', 'Ads', 'Seen', 'Page visits', 'Ads shown', 'Per 1,000 ads']
  const exportCsv = () => {
    const lines = [['From', 'To', 'Downloads', 'Updates', 'In-app purchases', `Sales (${r.currency})`, `Ads (${r.currency})`, 'Store impressions', 'Page views', 'Ads shown', 'Ad clicks', 'Ad requests'].join(',')]
    for (const s of r.series) lines.push([s.from, s.to, s.downloads, s.updates, s.iap, s.proceeds, s.adRevenue, s.impressions ?? '', s.pageViews ?? '', s.adImpressions, s.adClicks, s.adRequests].join(','))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    a.download = `apps-${r.from}-to-${r.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <SectionCard title={r.group === 'day' ? 'Day by day' : r.group === 'week' ? 'Week by week' : 'Month by month'}
      note="Newest first. Slide the table sideways for more columns."
      action={keyboardMode() === 'native' ? (
        <button type="button" onClick={exportCsv}
          className="h-10 px-3 rounded-xl bg-white/10 text-white/70 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 shrink-0">
          <Download size={14} /> CSV
        </button>
      ) : undefined}>
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full min-w-[640px] text-[14px] tabular-nums">
          <thead>
            <tr className="text-white/40 text-[11px] uppercase tracking-wider">
              <th className="text-left font-medium py-1.5 sticky left-0 bg-[#151617]">{r.group === 'day' ? 'Day' : r.group === 'week' ? 'Week of' : 'Month'}</th>
              {head.map(h => <th key={h} className="text-right font-medium py-1.5 pl-3 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map(s => {
              const e = ecpmOf(s.adRevenue, s.adImpressions)
              return (
                <tr key={s.key} className="border-t border-white/[0.06]">
                  <td className="py-2 text-white/80 whitespace-nowrap sticky left-0 bg-[#151617]">{bucketLabel(s, r.group, true)}</td>
                  <td className="py-2 pl-3 text-right text-white">{compact(s.downloads)}</td>
                  <td className="py-2 pl-3 text-right text-white font-semibold">{cash(revenueOf(s))}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{cash(s.proceeds)}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{cash(s.adRevenue)}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{cell(s.impressions)}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{cell(s.pageViews)}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{compact(s.adImpressions)}</td>
                  <td className="py-2 pl-3 text-right text-white/65">{e === null ? '—' : cash(e)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 14 && (
        <button type="button" onClick={() => setAll(!all)}
          className="w-full h-11 rounded-xl bg-white/[0.07] text-white/70 text-[13px] font-semibold active:scale-[0.99]">
          {all ? 'Show the newest 14' : `Show all ${rows.length}`}
        </button>
      )}
    </SectionCard>
  )
}

function AppsTable({ r, picked, onPick, onHide }: { r: Report; picked: string[]; onPick: (id: string) => void; onHide: (id: string, name: string) => void }) {
  const max = Math.max(...r.byApp.map(a => revenueOf(a.totals)), 0)
  const maxDl = Math.max(...r.byApp.map(a => a.totals.downloads), 0)
  return (
    <SectionCard title="By app" note="Tap an app to see only its numbers everywhere on this page. The eye leaves it out of the list.">
      {r.byApp.length === 0 && <p className="text-[14px] text-white/45">Every app is hidden. “Choose apps” brings them back.</p>}
      <div className="space-y-2">
        {r.byApp.map(a => {
          const on = picked.includes(a.id)
          const total = revenueOf(a.totals)
          const c = change(total, revenueOf(a.prev)) ?? change(a.totals.downloads, a.prev.downloads)
          const info = r.apps.find(x => x.id === a.id)
          return (
            <div key={a.id} className={`rounded-xl border flex items-stretch ${on ? 'bg-indigo-500/15 border-indigo-400/50' : 'bg-white/[0.04] border-white/8'}`}>
              <button type="button" onClick={() => onPick(a.id)} className="flex-1 min-w-0 text-left px-3.5 py-3 active:bg-white/5 rounded-l-xl">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px] font-semibold text-white truncate">{a.name}</span>
                  <span className="text-[16px] font-semibold text-white tabular-nums shrink-0">{money(total, r.currency)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-[12px] mt-0.5">
                  <span className="text-white/45 truncate">
                    {[info?.store ? 'App Store' : null, ...(info?.networks ?? []).map(n => NETWORK_NAME[n])].filter(Boolean).join(' · ') || 'no data yet'}
                  </span>
                  {c && <span className={`shrink-0 ${c.flat ? 'text-white/40' : c.up ? 'text-emerald-300' : 'text-red-300'}`}>{c.flat ? c.text : `${c.up ? '▲' : '▼'} ${c.text.replace(/^[+−]/, '')}`}</span>}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center mt-2 text-[12px] text-white/60 tabular-nums">
                  <ShareBar value={total} max={max} color={ADS_COLOR} />
                  <span>{money(a.totals.adRevenue, r.currency)} ads · {money(a.totals.proceeds, r.currency)} sales</span>
                  <ShareBar value={a.totals.downloads} max={maxDl} />
                  <span>{compact(a.totals.downloads)} downloads{a.totals.impressions !== null ? ` · seen ${compact(a.totals.impressions)}` : ''}</span>
                </div>
                {a.trend.length > 1 && a.trend.some(v => v > 0) && <div className="mt-2"><MiniBars points={a.trend} /></div>}
              </button>
              <button type="button" onClick={() => onHide(a.id, a.name)} aria-label={`Hide ${a.name} from the list`}
                className="w-12 shrink-0 flex items-center justify-center text-white/35 border-l border-white/8 active:bg-white/10 rounded-r-xl">
                <EyeOff size={17} />
              </button>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

function CountriesTable({ r, picked, onPick }: { r: Report; picked: string[]; onPick: (code: string) => void }) {
  const [all, setAll] = useState(false)
  const rows = all ? r.byCountry : r.byCountry.slice(0, 12)
  const maxDl = Math.max(...r.byCountry.map(c => c.downloads), 0)
  const totalDl = r.byCountry.reduce((n, c) => n + c.downloads, 0)
  return (
    <SectionCard title="By country" note="Tap a country to see only its numbers on this page. Tap again to let it go.">
      {r.byCountry.length === 0 && <p className="text-[14px] text-white/45">Nothing from any country in this range.</p>}
      <div className="space-y-1.5">
        {rows.map(c => {
          const on = picked.includes(c.code)
          return (
            <button key={c.code} type="button" onClick={() => onPick(c.code)}
              className={`w-full text-left rounded-xl border px-3.5 py-2.5 active:bg-white/10 ${on ? 'bg-indigo-500/15 border-indigo-400/50' : 'bg-white/[0.04] border-white/8'}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[15px] text-white truncate"><span className="font-semibold">{countryName(c.code)}</span> <span className="text-white/35 text-[12px]">{c.code}</span></span>
                <span className="text-[15px] text-white tabular-nums shrink-0">{compact(c.downloads)} <span className="text-white/40 text-[12px]">{percent(c.downloads, totalDl)}</span></span>
              </div>
              <div className="mt-1.5"><ShareBar value={c.downloads} max={maxDl} /></div>
              <div className="flex justify-between gap-3 text-[12px] text-white/50 tabular-nums mt-1.5">
                <span>{money(c.proceeds + c.adRevenue, r.currency)} earned{c.adRevenue > 0 ? ` (${money(c.adRevenue, r.currency)} ads)` : ''}</span>
                <span>{c.impressions !== null ? `seen ${compact(c.impressions)}` : ''}{c.adImpressions ? ` · ${compact(c.adImpressions)} ads shown` : ''}</span>
              </div>
            </button>
          )
        })}
      </div>
      {r.byCountry.length > 12 && (
        <button type="button" onClick={() => setAll(!all)}
          className="w-full h-11 rounded-xl bg-white/[0.07] text-white/70 text-[13px] font-semibold">
          {all ? 'Show the top 12' : `Show all ${r.byCountry.length} countries`}
        </button>
      )}
    </SectionCard>
  )
}

function SliceRows({ rows, currency, picked, onPick }: { rows: AdSlice[]; currency: string; picked?: string[]; onPick?: (key: string) => void }) {
  const max = Math.max(...rows.map(s => s.revenue), 0)
  return (
    <div className="space-y-1.5">
      {rows.map(s => {
        const on = picked?.includes(s.key)
        const e = ecpmOf(s.revenue, s.impressions)
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] font-semibold text-white truncate">{s.label}</span>
              <span className="text-[15px] font-semibold text-white tabular-nums shrink-0">{money(s.revenue, currency)}</span>
            </div>
            {s.sub && <div className="text-[12px] text-white/40 truncate">{s.sub}</div>}
            <div className="mt-1.5"><ShareBar value={s.revenue} max={max} color={ADS_COLOR} /></div>
            <div className="grid grid-cols-4 gap-2 text-[12px] text-white/55 tabular-nums mt-1.5">
              <span><span className="text-white/80">{compact(s.impressions)}</span> shown</span>
              <span><span className="text-white/80">{e === null ? '—' : money(e, currency)}</span> / 1,000</span>
              <span><span className="text-white/80">{percent(s.matched, s.requests)}</span> filled</span>
              <span>{s.clicks ? <><span className="text-white/80">{percent(s.clicks, s.impressions)}</span> tapped</> : ''}</span>
            </div>
          </>
        )
        const cls = `w-full text-left rounded-xl border px-3.5 py-2.5 ${on ? 'bg-emerald-500/15 border-emerald-400/50' : 'bg-white/[0.04] border-white/8'}`
        return onPick
          ? <button key={s.key} type="button" onClick={() => onPick(s.key)} className={`${cls} active:bg-white/10`}>{body}</button>
          : <div key={s.key} className={cls}>{body}</div>
      })}
    </div>
  )
}

function AdsTab({ r, connected, networks, units, onNetwork, onUnit }: {
  r: Report; connected: boolean
  networks: string[]; units: string[]
  onNetwork: (key: string) => void; onUnit: (key: string) => void
}) {
  const t = r.totals
  const none = r.ads.byNetwork.length === 0
  if (none && !connected) {
    return (
      <SectionCard title="Ads">
        <p className="text-[14px] text-white/55 leading-relaxed">
          No ad network is connected yet. Settings → App Store connects <span className="text-white/85">Google AdMob</span> (a Google sign-in)
          and <span className="text-white/85">Unity Ads</span> (an organization ID and a key), and what the ads earned then appears here and in
          every total on this page.
        </p>
      </SectionCard>
    )
  }
  const e = ecpmOf(t.adRevenue, t.adImpressions)
  return (
    <>
      <SectionCard title="What the ads did" note="Shown = an ad was displayed. Filled = the share of times an app asked for an ad and got one. Per 1,000 = what a thousand shown ads earned.">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { k: 'Earned', v: money(t.adRevenue, r.currency, r.approx) },
            { k: 'Ads shown', v: compact(t.adImpressions) },
            { k: 'Per 1,000 ads', v: e === null ? '—' : money(e, r.currency) },
            { k: 'Filled', v: percent(t.adMatched, t.adRequests) },
          ].map(x => (
            <div key={x.k} className="rounded-xl bg-white/[0.05] px-3 py-2.5">
              <div className="text-[12px] text-white/45">{x.k}</div>
              <div className="text-[20px] font-semibold text-white tabular-nums">{x.v}</div>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="By network" note="Tap one to count only that network’s ads on this page.">
        {none ? <p className="text-[14px] text-white/45">No ads were shown in this range.</p>
          : <SliceRows rows={r.ads.byNetwork} currency={r.currency} picked={networks} onPick={onNetwork} />}
      </SectionCard>
      {r.ads.byUnit.length > 0 && (
        <SectionCard title="By ad unit" note="Each place an ad appears in an app (Unity calls it a placement). Tap one to follow it alone.">
          <SliceRows rows={r.ads.byUnit} currency={r.currency} picked={units} onPick={onUnit} />
        </SectionCard>
      )}
      {r.ads.byFormat.filter(f => f.key !== 'Not stated').length > 0 && (
        <SectionCard title="By kind of ad" note="Unity Ads does not say the kind, so its ads are under “Not stated”.">
          <SliceRows rows={r.ads.byFormat} currency={r.currency} />
        </SectionCard>
      )}
      {r.ads.byPlatform.length > 1 && (
        <SectionCard title="By platform">
          <SliceRows rows={r.ads.byPlatform} currency={r.currency} />
        </SectionCard>
      )}
    </>
  )
}

function FoundTab({ r }: { r: Report }) {
  const t = r.totals
  const steps = [
    { label: 'Saw the app on the App Store', sub: 'in search, a chart or a list', value: t.impressions },
    { label: 'Opened its page', sub: t.impressions ? `${percent(t.pageViews ?? 0, t.impressions)} of those who saw it` : '', value: t.pageViews },
    { label: 'Downloaded it', sub: t.pageViews ? `${percent(t.downloads, t.pageViews)} of those who opened the page` : '', value: t.downloads },
  ]
  const top = Math.max(...steps.map(s => s.value ?? 0), 1)
  const also: { label: string; about: string; value: number | null }[] = [
    { label: 'Updates', about: 'existing users installing a new version', value: t.updates },
    { label: 'Re-downloads', about: 'people getting it again', value: t.redownloads },
    { label: 'In-app purchases', about: 'units bought inside the apps', value: t.iap },
    { label: 'Refunded', about: 'units Apple gave money back for', value: t.refunds },
    { label: 'Taps on the listing', about: 'on its icon or Get button in a list', value: t.taps },
    { label: 'Sessions', about: 'times an app was opened (from users who share analytics)', value: t.sessions },
    { label: 'Crashes', about: 'from users who share analytics', value: t.crashes },
  ]
  return (
    <>
      <SectionCard title="From seeing it to downloading it"
        note={t.impressions === null
          ? 'Apple has not sent these figures for this range yet. They start a day or two after the key is set up and run about three days behind.'
          : `Out of every 1,000 times the app was seen, about ${Math.round((t.downloads / Math.max(1, t.impressions)) * 1000)} became a download.`}>
        <div className="space-y-2.5">
          {steps.map((s, i) => (
            <div key={s.label}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[14px] text-white/85">{i + 1}. {s.label}</span>
                <span className="text-[18px] font-semibold text-white tabular-nums">{cell(s.value)}</span>
              </div>
              <div className="h-3 rounded-md bg-white/[0.06] overflow-hidden mt-1">
                <div className="h-full rounded-md" style={{ width: `${Math.max((s.value ?? 0) > 0 ? 1.5 : 0, ((s.value ?? 0) / top) * 100)}%`, background: SALES_COLOR, opacity: 1 - i * 0.2 }} />
              </div>
              {s.sub && <div className="text-[12px] text-white/45 mt-0.5">{s.sub}</div>}
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="Where on the App Store" note={r.bySource === null ? 'Apple does not split this by country — clear the country filter to see it.' : 'What people were doing when the app appeared in front of them.'}>
        {r.bySource && r.bySource.length === 0 && <p className="text-[14px] text-white/45">No figures for this range yet.</p>}
        {r.bySource && r.bySource.length > 0 && (
          <div className="space-y-2">
            {r.bySource.map(s => (
              <div key={s.source}>
                <div className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="text-white/85 truncate">{s.source}</span>
                  <span className="text-white tabular-nums shrink-0">{compact(s.impressions)} <span className="text-white/40 text-[12px]">seen · {compact(s.pageViews)} page visits</span></span>
                </div>
                <div className="mt-1"><ShareBar value={s.impressions} max={r.bySource![0]!.impressions} /></div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Also in this range">
        <div className="divide-y divide-white/[0.06]">
          {also.map(a => (
            <div key={a.label} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0 truncate"><span className="text-[14px] text-white/85">{a.label}</span> <span className="text-[12px] text-white/40">{a.about}</span></span>
              <span className="text-[15px] text-white tabular-nums shrink-0">{cell(a.value)}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </>
  )
}

// ── The panel ────────────────────────────────────────────────────────────────

export default function AppStoreExpanded({ store }: { store: AppStoreActions }) {
  const { view, error } = store
  const [range, setRange] = useState(remembered)
  const [groupPick, setGroupPick] = useState<Group | null>(null)
  const [apps, setApps] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  const [networks, setNetworks] = useState<string[]>([])
  const [units, setUnits] = useState<string[]>([])
  const [metric, setMetric] = useState<MetricId>('revenue')
  const [tab, setTab] = useState<Tab>('days')
  const [sheet, setSheet] = useState<'apps' | 'countries' | 'range' | null>(null)
  const [justHid, setJustHid] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => { try { localStorage.setItem('apps.range', JSON.stringify(range)) } catch { /* private mode */ } }, [range])

  const asOf = view?.asOf ?? ''
  const { from, to } = useMemo(() => {
    if (!asOf) return { from: '', to: '' }
    if (range.preset === 'custom' && range.from && range.to) return { from: range.from, to: range.to }
    return presetRange(range.preset === 'custom' ? '7d' : range.preset, asOf)
  }, [range, asOf])
  const days = from ? daysBetween(from, to) + 1 : 0
  const group = groupPick ?? naturalGroup(days)
  const ready = !!view && (view.configured || view.ads.admob.connected || view.ads.unity.connected || view.apps.length > 0)
  const query: ReportQuery | null = ready && from ? { from, to, group, apps, countries, networks, units } : null
  const { report: r, loading, error: reportError } = useAppReport(query)

  if (!view) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-8 text-center pt-16">
        <p className="text-white/45 text-[15px]">{error ? `Could not ask the server: ${error}` : 'Loading…'}</p>
      </div>
    )
  }
  if (!ready) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-8 text-center pt-16">
        <p className="text-white text-xl font-semibold">Nothing is connected yet</p>
        <p className="text-white/55 text-[15px] leading-relaxed max-w-sm">
          Settings → App Store takes the App Store Connect key, a Google sign-in for AdMob and a key for Unity Ads. Once one is in,
          this corner shows downloads, earnings and ads for every app, and the assistant answers “how are my apps doing”.
        </p>
      </div>
    )
  }

  const step = (dir: -1 | 1) => setRange({ preset: 'custom', from: addDays(from, dir * days), to: addDays(to, dir * days) })
  const canForward = to < asOf
  const filtered = apps.length + countries.length + networks.length + units.length > 0
  const clear = () => { setApps([]); setCountries([]); setNetworks([]); setUnits([]) }
  const busy = view.syncing || view.ads.syncing || store.busy === 'sync'
  const failed = [view.lastRun, view.ads.admob.lastRun, view.ads.unity.lastRun].find(x => x && !x.ok)
  const status = busy ? 'Reading…' : failed ? `A read failed ${ago(failed.at)}: ${failed.detail}` : view.lastRun ? `Read ${ago(view.lastRun.at)}` : 'Not read yet'
  const hiddenCount = view.apps.filter(a => a.hidden).length
  const appName = (id: string) => view.apps.find(a => a.id === id)?.name ?? id
  const unitName = (key: string) => r?.ads.byUnit.find(u => u.key === key)?.label ?? key

  const hide = (id: string, name: string) => {
    setApps(list => list.filter(x => x !== id))
    setJustHid({ id, name })
    void store.setHidden(id, true)
  }

  const m = METRICS[metric]
  const cash = (v: number) => money(v, r?.currency ?? view.currency)
  const fmt = (v: number) => (m.money ? cash(v) : compact(v))
  const bars: Bar[] = (r?.series ?? []).map(s => ({
    key: s.key, label: bucketLabel(s, r!.group), long: bucketLabel(s, r!.group, true),
    parts: metric === 'revenue' ? [s.proceeds, s.adRevenue] : [m.value(s)],
  }))
  const tileValue = (id: MetricId, t: Measures) => {
    const v = METRICS[id].value(t)
    return v === null ? '—' : METRICS[id].money ? money(v, r?.currency ?? view.currency, id !== 'ecpm' && !!r?.approx) : compact(v)
  }
  const coverage = r ? [
    r.coverage.sales ? `sales to ${shortDay(r.coverage.sales)}` : null,
    r.coverage.analytics ? `store views to ${shortDay(r.coverage.analytics)}` : null,
    r.coverage.admob ? `AdMob to ${shortDay(r.coverage.admob)}` : null,
    r.coverage.unity ? `Unity to ${shortDay(r.coverage.unity)}` : null,
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="relative flex flex-col h-full p-4 pt-16 gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold font-display text-white/90">Apps</h2>
          <p className={`text-[12px] leading-snug ${failed && !busy ? 'text-red-300' : 'text-white/45'}`}>
            {status}{!busy && !failed && view.nextRunAt ? ` · next in ${inMinutes(view.nextRunAt)}` : ''}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={() => setSheet('apps')}
            className="h-11 px-3.5 rounded-xl bg-white/10 text-white/80 text-[13px] font-semibold flex items-center gap-1.5 active:scale-95">
            <SlidersHorizontal size={15} /> Choose apps{hiddenCount ? ` · ${hiddenCount} hidden` : ''}
          </button>
          <button type="button" disabled={busy} onClick={() => { void store.sync() }} aria-label="Read now"
            className="h-11 w-11 rounded-xl bg-white/10 text-white/80 flex items-center justify-center active:scale-95 disabled:opacity-50">
            <RotateCw size={16} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {(error || reportError) && <p className="text-[13px] text-red-300 rounded-xl bg-red-500/10 border border-red-400/30 px-3 py-2">{error || reportError}</p>}

      <div className={`flex-1 min-h-0 overflow-y-auto scroll-fade-y pb-8 space-y-3 transition-opacity ${loading && r ? 'opacity-60' : ''}`}>
        {/* When. */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4" style={{ scrollbarWidth: 'none' }}>
          {PRESETS.map(p => (
            <Chip key={p.id} tone="plain" on={range.preset === p.id} onClick={() => { setRange({ preset: p.id }); setGroupPick(null) }}>{p.label}</Chip>
          ))}
          <Chip tone="plain" on={range.preset === 'custom'} onClick={() => setSheet('range')}>
            <span className="flex items-center gap-1.5"><CalendarRange size={14} /> Other days…</span>
          </Chip>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => step(-1)} aria-label="The stretch before"
            className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-white/80 active:scale-95 shrink-0"><ChevronLeft size={20} /></button>
          <button type="button" onClick={() => setSheet('range')} className="flex-1 min-w-0 h-11 rounded-xl bg-white/5 border border-white/8 px-3 text-center active:bg-white/10">
            <div className="text-[15px] font-semibold text-white truncate leading-tight">{from ? rangeText(from, to) : ''}</div>
            <div className="text-[11px] text-white/40 truncate leading-tight">
              {r ? `compared with ${rangeText(r.prevFrom, r.prevTo)}` : ''}
            </div>
          </button>
          <button type="button" onClick={() => step(1)} disabled={!canForward} aria-label="The stretch after"
            className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-white/80 active:scale-95 disabled:opacity-25 shrink-0"><ChevronRight size={20} /></button>
        </div>

        {/* For what. */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4" style={{ scrollbarWidth: 'none' }}>
          <Chip on={countries.length > 0} onClick={() => setSheet('countries')}>
            <span className="flex items-center gap-1.5"><Globe2 size={14} /> {countries.length === 0 ? 'All countries' : countries.length === 1 ? countryName(countries[0]!) : `${countries.length} countries`}</span>
          </Chip>
          <Chip on={apps.length === 0} onClick={() => setApps([])}>All apps</Chip>
          {(r?.apps ?? view.apps.filter(a => !a.hidden)).map(a => (
            <Chip key={a.id} on={apps.includes(a.id)} onClick={() => setApps(toggle(apps, a.id))}>{a.name}</Chip>
          ))}
        </div>
        {filtered && (
          <div className="flex items-center gap-2 rounded-xl bg-indigo-500/10 border border-indigo-400/25 pl-3.5 pr-1.5 py-1.5">
            <span className="flex-1 min-w-0 text-[13px] text-indigo-100/90 leading-snug">
              Showing only {[
                ...apps.map(appName), ...countries.map(countryName),
                ...networks.map(n => `${NETWORK_NAME[n] ?? n} ads`), ...units.map(u => `the “${unitName(u)}” ad unit`),
              ].join(' · ')}
            </span>
            <button type="button" onClick={clear} className="h-9 px-3 rounded-lg bg-white/10 text-white/80 text-[12px] font-semibold shrink-0 active:scale-95">Show everything</button>
          </div>
        )}
        {justHid && (
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.07] border border-white/10 pl-3.5 pr-1.5 py-1.5">
            <span className="flex-1 min-w-0 text-[13px] text-white/75 truncate">{justHid.name} is hidden and no longer counted.</span>
            <button type="button" onClick={() => { void store.setHidden(justHid.id, false); setJustHid(null) }}
              className="h-9 px-3 rounded-lg bg-white/10 text-white/85 text-[12px] font-semibold shrink-0 active:scale-95">Undo</button>
          </div>
        )}

        {!r ? (
          <p className="text-white/45 text-[15px] rounded-2xl bg-white/5 border border-white/8 p-4">
            {reportError ? 'The numbers could not be loaded.' : 'Adding it up…'}
          </p>
        ) : (
          <>
            <Headline r={r} />

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TILES.map(id => (
                <Tile key={id} label={METRICS[id].label} about={METRICS[id].about}
                  value={tileValue(id, r.totals)} now={METRICS[id].value(r.totals)} before={METRICS[id].value(r.prev)}
                  selected={metric === id} onSelect={() => setMetric(id)} />
              ))}
            </div>
            {r.approx && (
              <p className="text-[12px] text-white/40 leading-snug px-1">
                ≈ Money earned in other currencies is converted to {r.currency} at today’s rate, so totals are close but not what Apple or Google will pay to the cent.
                {r.unconverted.length ? ` No rate for ${r.unconverted.join(', ')}: counted at face value.` : ''}
              </p>
            )}

            <SectionCard title={`${m.label}, ${r.group === 'day' ? 'each day' : r.group === 'week' ? 'each week' : 'each month'}`}
              note="Tap a figure above to chart it. Tap a bar to read it."
              action={
                <div className="flex rounded-xl bg-white/5 border border-white/8 p-0.5 shrink-0">
                  {(['day', 'week', 'month'] as Group[]).map(g => (
                    <button key={g} type="button" onClick={() => setGroupPick(g)} disabled={g === 'day' && days > 120}
                      className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold capitalize disabled:opacity-25 ${group === g ? 'bg-white/15 text-white' : 'text-white/50'}`}>
                      {g}
                    </button>
                  ))}
                </div>
              }>
              <BarChart bars={bars} format={fmt}
                series={metric === 'revenue' ? ['Sales', 'Ads'] : [m.label]}
                colors={metric === 'revenue' ? [SALES_COLOR, ADS_COLOR] : [metric === 'adRevenue' || metric === 'adImpressions' ? ADS_COLOR : SALES_COLOR]} />
            </SectionCard>

            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 pt-1" style={{ scrollbarWidth: 'none' }}>
              {TABS.map(t => <Chip key={t.id} tone="plain" on={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>)}
            </div>
            {tab === 'days' && <DaysTable r={r} />}
            {tab === 'apps' && <AppsTable r={r} picked={apps} onPick={id => setApps(toggle(apps, id))} onHide={hide} />}
            {tab === 'countries' && <CountriesTable r={r} picked={countries} onPick={c => setCountries(toggle(countries, c))} />}
            {tab === 'ads' && (
              <AdsTab r={r} connected={view.ads.admob.connected || view.ads.unity.connected} networks={networks} units={units}
                onNetwork={k => setNetworks(toggle(networks, k))} onUnit={k => setUnits(toggle(units, k))} />
            )}
            {tab === 'found' && <FoundTab r={r} />}

            {coverage && <p className="text-[12px] text-white/35 leading-snug px-1">Figures read so far: {coverage}. Apple publishes each day the next morning (Pacific time) and fills in store views over about three days.</p>}
          </>
        )}
      </div>

      {sheet === 'range' && from && (
        <RangePicker from={from} to={to} max={asOf} onClose={() => setSheet(null)}
          onPick={(a, b) => { setRange({ preset: 'custom', from: a, to: b }); setGroupPick(null) }} />
      )}
      {sheet === 'countries' && (
        <Sheet title="Countries" onClose={() => setSheet(null)} footer={
          <div className="flex gap-2">
            <button type="button" onClick={() => setCountries([])} className="flex-1 h-11 rounded-xl bg-white/10 text-white/80 text-[14px] font-semibold">All countries</button>
            <button type="button" onClick={() => setSheet(null)} className="flex-1 h-11 rounded-xl bg-indigo-500 text-white text-[14px] font-semibold">Done</button>
          </div>
        }>
          <p className="text-[13px] text-white/50 mb-3">Tap the countries to count. With none picked, every country is counted.</p>
          <div className="space-y-1.5">
            {(r?.byCountry ?? []).map(c => {
              const on = countries.includes(c.code)
              return (
                <button key={c.code} type="button" onClick={() => setCountries(toggle(countries, c.code))}
                  className={`w-full h-12 px-3.5 rounded-xl border flex items-center justify-between gap-3 text-[15px] ${on ? 'bg-indigo-500/20 border-indigo-400/50 text-white' : 'bg-white/[0.04] border-white/8 text-white/80'}`}>
                  <span className="truncate">{countryName(c.code)}</span>
                  <span className="text-[13px] text-white/50 tabular-nums shrink-0">{compact(c.downloads)} downloads</span>
                </button>
              )
            })}
            {r && r.byCountry.length === 0 && <p className="text-[14px] text-white/45">No country has figures in this range.</p>}
          </div>
        </Sheet>
      )}
      {sheet === 'apps' && (
        <Sheet title="Choose apps" onClose={() => setSheet(null)}>
          <p className="text-[13px] text-white/50 leading-relaxed mb-3">
            Switch off an app you do not want here — one that is not released yet, a test build. It leaves the list, every total on this
            page, the corner and the assistant’s answers. Its figures keep being kept, so switching it back on loses nothing.
          </p>
          <div className="space-y-1.5">
            {view.apps.map(a => (
              <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] border border-white/8 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className={`text-[15px] font-semibold truncate ${a.hidden ? 'text-white/40' : 'text-white'}`}>{a.name}</div>
                  <div className="text-[12px] text-white/40 truncate">
                    {[a.store ? 'App Store' : null, ...a.networks.map(n => NETWORK_NAME[n]), a.bundleId].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Switch on={!a.hidden} onChange={on => { if (!on) setApps(list => list.filter(x => x !== a.id)); void store.setHidden(a.id, !on) }} label={`Show ${a.name}`} />
              </div>
            ))}
            {view.apps.length === 0 && <p className="text-[14px] text-white/45">No apps have been read yet.</p>}
          </div>
        </Sheet>
      )}
    </div>
  )
}
