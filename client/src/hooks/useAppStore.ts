// The Apps corner's data: the user's own apps on the App Store and what their
// ads earned, through the server (server/src/app-store.ts, ads.ts,
// app-report.ts), which owns the keys and the history.
//
// Two hooks, because there are two questions. `useAppStore` is the light one —
// are the keys in, which apps exist (hidden ones too), what did yesterday come
// to — for the pill, Settings and the "Choose apps" sheet. `useAppReport` asks
// the report for one range under one set of filters, and asks again whenever
// either changes or a read finishes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export type Network = 'admob' | 'unity'

export interface UnifiedApp {
  id:        string
  name:      string
  bundleId:  string
  store:     boolean
  networks:  Network[]
  platforms: string[]
  hidden:    boolean
}

interface RunNote { at: string; ok: boolean; detail: string }

export interface AppStoreView {
  configured:    boolean
  source:        'settings' | 'env' | 'none'
  keyId:         string
  issuerId:      string
  vendorNumber:  string
  lastRun:       (RunNote & { ms: number }) | null
  nextRunAt:     string | null
  syncing:       boolean
  currency:      string
  asOf:          string
  salesDaysRead: number
  apps:          UnifiedApp[]
  yesterday:     { downloads: number; proceeds: number; adRevenue: number; impressions: number | null; approx: boolean; apps: number }
  ads: {
    syncing:   boolean
    googleApp: 'ads' | 'mail' | null
    admob: { connected: boolean; publisherId: string; currency: string; lastRun: RunNote | null }
    unity: { connected: boolean; orgId: string; keyTail: string; lastRun: RunNote | null }
  }
  /** Where Google must be told to send the browser back, ready to paste into the Cloud console. */
  admobRedirectUri: string
}

export interface Measures {
  downloads:     number
  redownloads:   number
  updates:       number
  iap:           number
  refunds:       number
  proceeds:      number
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

export interface AdSlice {
  key: string; label: string; sub?: string
  revenue: number; impressions: number; clicks: number; requests: number; matched: number
}

export type Group = 'day' | 'week' | 'month'

export interface Report {
  from: string; to: string; prevFrom: string; prevTo: string; days: number
  group:    Group
  currency: string
  approx:   boolean
  unconverted: string[]
  fxAsOf:   string | null
  coverage: { sales: string | null; analytics: string | null; admob: string | null; unity: string | null }
  apps:     UnifiedApp[]
  totals:   Measures
  prev:     Measures
  series:   ({ key: string; from: string; to: string } & Measures)[]
  byApp:    { id: string; name: string; totals: Measures; prev: Measures; trend: number[]; series: Measures[] }[]
  byCountry: { code: string; downloads: number; proceeds: number; impressions: number | null; pageViews: number | null; adRevenue: number; adImpressions: number }[]
  bySource: { source: string; impressions: number; pageViews: number; taps: number }[] | null
  ads: { byNetwork: AdSlice[]; byUnit: AdSlice[]; byFormat: AdSlice[]; byPlatform: AdSlice[] }
}

export interface ReportQuery {
  from:      string
  to:        string
  group:     Group
  apps:      string[]
  countries: string[]
  networks:  string[]
  units:     string[]
}

async function fetchView(): Promise<AppStoreView> {
  const res = await fetch('/api/app-store', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as AppStoreView
}

type Busy = 'save' | 'forget' | 'sync' | 'hide' | 'ads' | null

/**
 * `active` is whether anything on screen wants the numbers — the work-mode
 * corner, the Settings tab. Off, nothing is fetched: a rest-mode kiosk makes
 * no App Store calls at all, the Mail and Tasks corners' rule.
 */
export function useAppStore(active = true) {
  const [view, setView] = useState<AppStoreView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = () => {
      fetchView()
        .then(v => { if (!cancelled) { setView(v); setError(null) } })
        .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    }
    load()
    const off = onServerEvent('app-store', load)
    const t = setInterval(load, 5 * 60_000)
    return () => { cancelled = true; off(); clearInterval(t) }
  }, [active])

  const send = useCallback(async (method: 'POST' | 'DELETE', path: string, body: unknown, kind: Exclude<Busy, null>): Promise<boolean> => {
    setBusy(kind)
    try {
      const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({})) as AppStoreView & { error?: string }
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setView(j)
      setError(null)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  const save = useCallback((c: { issuerId: string; keyId: string; vendorNumber: string; privateKey: string }) =>
    send('POST', '/api/app-store/config', c, 'save'), [send])
  const forget = useCallback(() => send('DELETE', '/api/app-store/config', undefined, 'forget'), [send])
  const sync = useCallback(() => send('POST', '/api/app-store/sync', {}, 'sync'), [send])
  /** Leave an app out of the list and every total, or put it back. Shown at once; the server's answer settles it. */
  const setHidden = useCallback((id: string, hidden: boolean) => {
    setView(v => v && { ...v, apps: v.apps.map(a => (a.id === id ? { ...a, hidden } : a)) })
    return send('POST', `/api/app-store/apps/${encodeURIComponent(id)}/hidden`, { hidden }, 'hide')
  }, [send])
  const setCurrency = useCallback((currency: string) => send('POST', '/api/app-store/currency', { currency }, 'save'), [send])
  const saveUnity = useCallback((orgId: string, apiKey: string) => send('POST', '/api/app-store/unity', { orgId, apiKey }, 'ads'), [send])
  const forgetUnity = useCallback(() => send('DELETE', '/api/app-store/unity', undefined, 'ads'), [send])
  const saveGoogleApp = useCallback((clientId: string, clientSecret: string) => send('POST', '/api/app-store/admob/app', { clientId, clientSecret }, 'ads'), [send])
  const forgetAdmob = useCallback(() => send('DELETE', '/api/app-store/admob', undefined, 'ads'), [send])

  return { view, error, busy, save, forget, sync, setHidden, setCurrency, saveUnity, forgetUnity, saveGoogleApp, forgetAdmob }
}

export type AppStoreActions = ReturnType<typeof useAppStore>

/**
 * The report for one query. A newer question cancels the older one's answer
 * (tapping through three filters fires three requests, and the slowest must
 * not win), and the last good report stays on screen while the next loads, so
 * a filter tap dims the page rather than blanking it.
 */
export function useAppReport(query: ReportQuery | null) {
  // `answered` is the question the report on screen answers; while it is not
  // the current one, the page is loading — derived, never set from the effect.
  const [state, setState] = useState<{ report: Report | null; answered: string; error: string | null }>({ report: null, answered: '', error: null })
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  const key = query ? JSON.stringify(query) : ''
  const asked = `${key}|${tick}`

  useEffect(() => onServerEvent('app-store', () => setTick(t => t + 1)), [])

  useEffect(() => {
    if (!key) return
    const q = JSON.parse(key) as ReportQuery
    const mine = ++seq.current
    const question = `${key}|${tick}`
    const qs = new URLSearchParams({ from: q.from, to: q.to, group: q.group })
    if (q.apps.length) qs.set('apps', q.apps.join(','))
    if (q.countries.length) qs.set('countries', q.countries.join(','))
    if (q.networks.length) qs.set('networks', q.networks.join(','))
    if (q.units.length) qs.set('units', q.units.join(','))
    fetch(`/api/app-store/report?${qs}`, { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(res.status === 429 ? 'Too many requests at once — wait a moment.' : `HTTP ${res.status}`)
        return await res.json() as Report
      })
      .then(r => { if (mine === seq.current) setState({ report: r, answered: question, error: null }) })
      .catch(err => { if (mine === seq.current) setState(s => ({ ...s, answered: question, error: err instanceof Error ? err.message : String(err) })) })
  }, [key, tick])

  return { report: state.report, loading: !!key && state.answered !== asked, error: state.error }
}
