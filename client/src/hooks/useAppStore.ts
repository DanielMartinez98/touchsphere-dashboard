// Settings → Apps: the user's own apps on the App Store, from App Store
// Connect through the server (server/src/app-store.ts), which owns the key
// and the history. One GET on mount, the `app-store` SSE frame after each
// sync, and a slow poll while the tab is open so "synced 5 min ago" stays true.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export interface PeriodTotals {
  from:        string
  to:          string
  downloads:   number
  redownloads: number
  updates:     number
  iap:         number
  refunds:     number
  proceeds:    Record<string, number>
  impressions: number | null
  pageViews:   number | null
  taps:        number | null
  sessions:    number | null
  crashes:     number | null
}

export interface AppStoreApp {
  id:       string
  name:     string
  sku:      string
  bundleId: string
  latestSalesDay:     string | null
  latestAnalyticsDay: string | null
  periods: { yesterday: PeriodTotals; week: PeriodTotals; prevWeek: PeriodTotals; month: PeriodTotals; prevMonth: PeriodTotals }
  series: {
    date: string; downloads: number; redownloads: number; updates: number; iap: number; refunds: number
    proceeds: number; impressions: number | null; pageViews: number | null; taps: number | null
    sessions: number | null; crashes: number | null
  }[]
  countries: { code: string; downloads: number }[]
}

export interface AppStoreView {
  configured:    boolean
  source:        'settings' | 'env' | 'none'
  keyId:         string
  issuerId:      string
  vendorNumber:  string
  lastRun:       { at: string; ok: boolean; detail: string; ms: number } | null
  nextRunAt:     string | null
  syncing:       boolean
  currency:      string | null
  asOf:          string
  salesDaysRead: number
  apps:          AppStoreApp[]
}

async function fetchView(): Promise<AppStoreView> {
  const res = await fetch('/api/app-store', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as AppStoreView
}

/**
 * `active` is whether anything on screen wants the numbers — the work-mode
 * corner, the Settings tab. Off, nothing is fetched: a rest-mode kiosk makes
 * no App Store calls at all, the Mail and Tasks corners' rule.
 */
export function useAppStore(active = true) {
  const [view, setView] = useState<AppStoreView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'forget' | 'sync' | null>(null)

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

  const send = useCallback(async (method: 'POST' | 'DELETE', path: string, body: unknown, kind: 'save' | 'forget' | 'sync'): Promise<boolean> => {
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

  return { view, error, busy, save, forget, sync }
}
