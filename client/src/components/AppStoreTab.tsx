// Settings → Apps: how the user's own apps are doing on the App Store.
//
// Two halves. The first is a chore written out step by step — an API key from
// App Store Connect, the vendor number from the payments page, the .p8 file —
// done once and folded away behind a "Connected" line afterwards. The key file
// can be picked from the phone's Files (a paste of a .p8 on a kiosk keyboard
// is not a thing anyone should do) or pasted whole.
//
// The second is a card per app: a KPI row of four stat tiles for the chosen
// stretch (yesterday, 7 days, 30 days) with the change against the stretch
// before, and a 30-day sparkline of downloads under it. Nothing here is live —
// Apple publishes a day the next morning and impressions run up to three days
// behind — so the card says which day it is up to rather than pretending.

import { useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useAppStore, type AppStoreApp, type PeriodTotals } from '../hooks/useAppStore'
import { TouchInput } from './TouchInput'

type Period = 'yesterday' | 'week' | 'month'

const PERIODS: { id: Period; label: string; prev: string }[] = [
  { id: 'yesterday', label: 'Yesterday', prev: 'the day before' },
  { id: 'week',      label: '7 days',    prev: 'the 7 before' },
  { id: 'month',     label: '30 days',   prev: 'the 30 before' },
]

const compact = (n: number): string =>
  n >= 10_000
    ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : new Intl.NumberFormat().format(n)

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** The headline money for a period: the main currency's figure, and how many other currencies also earned. */
function headlineMoney(p: Record<string, number>, currency: string | null): { text: string; others: string[] } {
  const entries = Object.entries(p).filter(([, v]) => v !== 0)
  if (entries.length === 0) return { text: currency ? money(0, currency) : '0', others: [] }
  const main = currency && p[currency] !== undefined ? currency : entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]![0]
  return {
    text: money(p[main] ?? 0, main),
    others: entries.filter(([c]) => c !== main).map(([c, v]) => money(v, c)),
  }
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

function inMinutes(iso: string): string {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  return m <= 0 ? 'any moment' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`
}

function prettyDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * A stat tile: label, the value, the change against the stretch before.
 * Up is good for all four of these, so the delta's colour is its direction.
 * The number wears the text colour, never a series colour, the tile is the
 * only mark and there is no legend — one value needs none.
 */
function Tile({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: { now: number; before: number } | null }) {
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
      <div className="text-[11px] text-white/45 leading-tight">{label}</div>
      <div className="text-[22px] font-semibold text-white leading-tight mt-0.5 truncate" title={sub}>{value}</div>
      <div className="text-[11px] leading-tight mt-0.5 flex items-baseline gap-1.5 min-w-0">
        {change ? <span className={change.cls}>{change.text}</span> : <span className="text-white/25">&nbsp;</span>}
        {sub && <span className="text-white/35 truncate">{sub}</span>}
      </div>
    </div>
  )
}

/**
 * A 30-day sparkline: a 2px line in a de-emphasised ink with the last day
 * marked in the accent. Its scale is its own — the point is the shape of the
 * month, and the numbers are in the tiles above it.
 */
function Sparkline({ points, accent }: { points: number[]; accent: string }) {
  const w = 300, h = 44, pad = 3
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0
  const xy = points.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)] as const)
  const d = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="3.5" fill={accent} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

function AppCard({ app, period, currency }: { app: AppStoreApp; period: Period; currency: string | null }) {
  const t: PeriodTotals = app.periods[period]
  const before: PeriodTotals | null = period === 'week' ? app.periods.prevWeek : period === 'month' ? app.periods.prevMonth : null
  const earned = headlineMoney(t.proceeds, currency)
  const earnedBefore = before ? headlineMoney(before.proceeds, currency) : null
  const mainCur = currency ?? Object.keys(t.proceeds)[0] ?? null
  const moneyDelta = before && mainCur
    ? { now: t.proceeds[mainCur] ?? 0, before: before.proceeds[mainCur] ?? 0 }
    : null
  const series = app.series.map(p => p.downloads)
  const seriesTotal = series.reduce((a, b) => a + b, 0)
  const extras: string[] = []
  if (t.updates) extras.push(`${compact(t.updates)} updates`)
  if (t.redownloads) extras.push(`${compact(t.redownloads)} redownloads`)
  if (t.iap) extras.push(`${compact(t.iap)} in-app purchases`)
  if (t.refunds) extras.push(`${compact(t.refunds)} refunded`)
  if (t.sessions !== null) extras.push(`${compact(t.sessions)} sessions`)
  if (t.crashes !== null && t.crashes > 0) extras.push(`${compact(t.crashes)} crashes`)
  const analyticsNote = app.latestAnalyticsDay === null
    ? 'Impressions and page views arrive a day or two after the key is set up.'
    : app.latestAnalyticsDay < t.to
      ? `Impressions and page views are up to ${prettyDay(app.latestAnalyticsDay)}; Apple fills the last days in over three days.`
      : null

  return (
    <div className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-white text-[15px] font-semibold truncate">{app.name}</div>
          <div className="text-white/35 text-[11px] truncate">{app.bundleId || app.sku}</div>
        </div>
        <div className="text-white/40 text-[11px] shrink-0">
          {app.latestSalesDay ? `sales to ${prettyDay(app.latestSalesDay)}` : 'no sales file yet'}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Downloads" value={compact(t.downloads)} delta={before ? { now: t.downloads, before: before.downloads } : null} />
        <Tile
          label="Earned"
          value={earned.text}
          sub={earned.others.length ? `+ ${earned.others.join(', ')}` : undefined}
          delta={moneyDelta}
        />
        <Tile
          label="Impressions"
          value={t.impressions === null ? '—' : compact(t.impressions)}
          delta={before && t.impressions !== null && before.impressions !== null ? { now: t.impressions, before: before.impressions } : null}
        />
        <Tile
          label="Page views"
          value={t.pageViews === null ? '—' : compact(t.pageViews)}
          delta={before && t.pageViews !== null && before.pageViews !== null ? { now: t.pageViews, before: before.pageViews } : null}
        />
      </div>
      {earnedBefore && earnedBefore.others.length > 0 && (
        <p className="text-white/30 text-[11px] -mt-1">Earned before: {earnedBefore.text}{earnedBefore.others.length ? ` + ${earnedBefore.others.join(', ')}` : ''}</p>
      )}

      <div>
        <div className="flex items-baseline justify-between text-[11px] text-white/40 mb-1">
          <span>Downloads, last 30 days</span>
          <span>{compact(seriesTotal)} in all · peak {compact(Math.max(0, ...series))}</span>
        </div>
        <Sparkline points={series} accent="#67e8f9" />
      </div>

      {(extras.length > 0 || app.countries.length > 0) && (
        <div className="text-[12px] text-white/50 leading-relaxed">
          {extras.length > 0 && <div>{extras.join(' · ')}</div>}
          {app.countries.length > 0 && (
            <div>Where, this month: {app.countries.map(c => `${c.code} ${compact(c.downloads)}`).join(' · ')}</div>
          )}
        </div>
      )}
      {analyticsNote && <p className="text-[11px] text-white/35 leading-snug">{analyticsNote}</p>}
    </div>
  )
}

export function AppStoreTab() {
  const { view, error, busy, save, forget, sync } = useAppStore()
  const [period, setPeriod] = useState<Period>('week')
  const [editing, setEditing] = useState(false)
  const [issuerId, setIssuerId] = useState({ v: '', seeded: false })
  const [keyId, setKeyId] = useState({ v: '', seeded: false })
  const [vendor, setVendor] = useState({ v: '', seeded: false })
  const [pem, setPem] = useState('')
  const [pemName, setPemName] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (view && !issuerId.seeded && view.issuerId) setIssuerId({ v: view.issuerId, seeded: true })
  if (view && !keyId.seeded && view.keyId) setKeyId({ v: view.keyId, seeded: true })
  if (view && !vendor.seeded && view.vendorNumber) setVendor({ v: view.vendorNumber, seeded: true })

  const pickFile = (file: File | undefined) => {
    if (!file) return
    file.text().then(text => { setPem(text); setPemName(file.name) }).catch(() => {})
  }

  const canSave = !!issuerId.v.trim() && !!keyId.v.trim() && !!vendor.v.trim() && (!!pem.trim() || !!view?.configured)

  const onSave = () => {
    void save({ issuerId: issuerId.v, keyId: keyId.v, vendorNumber: vendor.v, privateKey: pem })
      .then(ok => { if (ok) { setPem(''); setPemName(null); setEditing(false) } })
  }

  if (!view) {
    return (
      <div className="max-w-lg mx-auto py-8 text-center text-white/40 text-sm">
        {error ? `Could not ask the server: ${error}` : 'Loading…'}
      </div>
    )
  }

  const showForm = !view.configured || editing

  return (
    <div className="space-y-5 max-w-lg mx-auto pb-4">
      <div>
        <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
          Your apps on the App Store
        </span>
        <p className="text-[12px] text-white/45 leading-relaxed">
          Downloads, what each app earned, and how often it was seen — read from App Store Connect
          with a key you make once. Apple publishes each day the next morning and fills impressions in
          over about three days, so this is a daily scoreboard; the dashboard keeps every day it reads,
          since Apple deletes the daily files after a year. Ask the assistant “how are my apps doing”.
        </p>
      </div>

      {error && (
        <p className="text-[12px] text-red-300 leading-snug rounded-xl bg-red-500/10
                      border border-red-400/30 px-3 py-2">{error}</p>
      )}

      {view.configured && !editing && (
        <div className="rounded-2xl bg-white/5 border border-hairline p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold">
                Connected <span className="text-emerald-300 font-normal">· key {view.keyId}</span>
              </div>
              <div className="text-white/40 text-[11px] truncate">
                vendor {view.vendorNumber}{view.source === 'env' ? ' · from .env' : ''}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button type="button" onClick={() => setEditing(true)}
                className="h-10 px-3 rounded-xl bg-white/10 border border-hairline text-white/70 text-[12px] font-semibold active:scale-95">
                Change
              </button>
              {view.source === 'settings' && (confirmForget ? (
                <>
                  <button type="button" onClick={() => setConfirmForget(false)}
                    className="h-10 px-3 rounded-xl bg-white/10 text-white/60 text-[12px] font-medium">Keep</button>
                  <button type="button" disabled={busy === 'forget'}
                    onClick={() => { setConfirmForget(false); void forget() }}
                    className="h-10 px-3 rounded-xl bg-red-500 text-white text-[12px] font-bold">Forget key</button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmForget(true)}
                  className="h-10 px-3 rounded-xl bg-red-500/15 border border-red-400/30 text-red-300 text-[12px] font-semibold active:scale-95">
                  Forget
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className={view.lastRun && !view.lastRun.ok ? 'text-red-300' : 'text-white/40'}>
              {view.syncing
                ? 'Reading from Apple…'
                : view.lastRun
                  ? (view.lastRun.ok ? `Read ${ago(view.lastRun.at)}` : `Failed ${ago(view.lastRun.at)}: ${view.lastRun.detail}`)
                  : 'Not read yet'}
              {!view.syncing && view.nextRunAt ? ` · next in ${inMinutes(view.nextRunAt)}` : ''}
            </span>
            <button type="button" disabled={busy === 'sync' || view.syncing} onClick={() => { void sync() }}
              className="h-9 px-3 rounded-xl bg-white/10 text-white/70 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-50 shrink-0">
              <RotateCw size={13} className={busy === 'sync' || view.syncing ? 'animate-spin' : ''} />
              Read now
            </button>
          </div>
          {view.lastRun?.ok && <p className="text-white/30 text-[11px] leading-snug">{view.lastRun.detail}</p>}
        </div>
      )}

      {showForm && (
        <div>
          <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">
            {view.configured ? 'Change the key' : '1 · An App Store Connect key'}
          </span>
          {!view.configured && (
            <ol className="text-[12px] text-white/45 leading-relaxed space-y-1 mb-3 list-decimal pl-4">
              <li>Open <span className="text-white/70">appstoreconnect.apple.com</span> → Users and Access → <span className="text-white/70">Integrations</span> → App Store Connect API.</li>
              <li>Generate a <span className="text-white/70">team key</span> with the Admin role (the analytics reports need it). Download the .p8 file — Apple lets you download it once.</li>
              <li>Copy the <span className="text-white/70">Issuer ID</span> from the top of that page and the key’s <span className="text-white/70">Key ID</span>.</li>
              <li>The <span className="text-white/70">vendor number</span> is at the top of Payments and Financial Reports.</li>
            </ol>
          )}
          <div className="space-y-2">
            <TouchInput
              value={issuerId.v}
              onChange={v => setIssuerId({ v, seeded: true })}
              placeholder="Issuer ID — 8-4-4-4-12 characters"
              plain
              ariaLabel="App Store Connect issuer id"
              className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
            />
            <div className="grid grid-cols-2 gap-2">
              <TouchInput
                value={keyId.v}
                onChange={v => setKeyId({ v, seeded: true })}
                placeholder="Key ID — 10 characters"
                plain
                ariaLabel="App Store Connect key id"
                className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
              />
              <TouchInput
                value={vendor.v}
                onChange={v => setVendor({ v, seeded: true })}
                numeric
                placeholder="Vendor number"
                plain
                ariaLabel="Vendor number"
                className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[13px] placeholder:text-white/30 border border-hairline"
              />
            </div>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".p8,.pem,text/plain" className="hidden"
                onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
              <button type="button" onClick={() => fileRef.current?.click()}
                className="h-11 px-4 rounded-xl bg-white/10 border border-hairline text-white/80 text-[13px] font-semibold active:scale-95 shrink-0">
                Choose the .p8 file
              </button>
              <span className="text-[12px] text-white/45 truncate min-w-0">
                {pemName ? pemName : view.configured ? 'Saved key kept unless you pick or paste another' : 'AuthKey_XXXXXXXXXX.p8, or paste it below'}
              </span>
            </div>
            <TouchInput
              value={pem}
              onChange={setPem}
              multiline
              rows={3}
              placeholder="…or paste the key file here, BEGIN line to END line"
              plain
              ariaLabel="Private key"
              className="w-full bg-white/10 text-white rounded-xl px-4 py-3 text-[12px] font-mono placeholder:text-white/30 border border-hairline"
            />
            <p className="text-[11px] text-white/35 leading-snug">
              The key is checked against Apple before it is saved, and it stays on this server’s volume — the browser only ever sees its id.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy === 'save' || !canSave}
                onClick={onSave}
                className="h-11 px-5 rounded-xl bg-cyan-500/20 border border-cyan-400/30 text-cyan-100 text-[13px] font-semibold flex items-center gap-2 active:scale-95 disabled:opacity-40"
              >
                {busy === 'save' && <RotateCw size={14} className="animate-spin" />}
                {busy === 'save' ? 'Checking with Apple…' : view.configured ? 'Save changes' : 'Connect'}
              </button>
              {view.configured && (
                <button type="button" onClick={() => { setEditing(false); setPem(''); setPemName(null) }}
                  className="h-11 px-4 rounded-xl bg-white/10 text-white/60 text-[13px] font-medium">Cancel</button>
              )}
            </div>
          </div>
        </div>
      )}

      {view.configured && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">
              Apps <span className="normal-case tracking-normal text-white/30">· up to {prettyDay(view.asOf)}</span>
            </span>
            <div className="flex rounded-xl bg-white/5 border border-hairline p-0.5 shrink-0">
              {PERIODS.map(p => (
                <button key={p.id} type="button" onClick={() => setPeriod(p.id)}
                  className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold transition ${period === p.id ? 'bg-white/15 text-white' : 'text-white/50'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {period !== 'yesterday' && (
            <p className="text-white/30 text-[11px] -mt-1">Changes are against {PERIODS.find(p => p.id === period)!.prev}.</p>
          )}
          {view.apps.length === 0 ? (
            <p className="text-white/40 text-sm rounded-2xl bg-white/5 border border-hairline p-4">
              {view.syncing || !view.lastRun
                ? 'Reading the first three months from Apple — a minute or two.'
                : view.lastRun.ok ? 'Apple lists no apps for this key yet.' : `Could not read from Apple: ${view.lastRun.detail}`}
            </p>
          ) : view.apps.map(app => <AppCard key={app.id} app={app} period={period} currency={view.currency} />)}
        </div>
      )}
    </div>
  )
}
