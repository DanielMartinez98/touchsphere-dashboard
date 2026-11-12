// Proves the Apps corner's numbers — with no Apple, Google or Unity account.
//
//   npm run test:apps                  (from server/)
//   npm run test:apps -- --serve       …and keep it all running on :3001 to look at
//
// The REAL server is booted (src/index.ts, as `npm run dev` runs it) against
// one small HTTP server in this process that plays App Store Connect, Google's
// token endpoint, the AdMob API, Unity's Monetization Stats API and the
// exchange-rate feed. Its figures are made from the date by arithmetic, so the
// test knows what every total must come to.
//
// What it asks, in the order a person would: paste the App Store key, connect
// Unity Ads, sign in to AdMob, read; then ask the report for a range, narrow it
// to an app, a country, a network and an ad unit, group it by week, and hide an
// app — the totals must follow every time. One app (not released yet) refuses
// its analytics, which must cost the others nothing.

import http from 'http'
import net from 'net'
import os from 'os'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { spawn, type ChildProcess } from 'child_process'

const SERVER_DIR = path.resolve(__dirname, '..')
const SERVE = process.argv.includes('--serve')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else    { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps

// ── The made-up business ─────────────────────────────────────────────────────

const APPS = [
  { id: '1000000001', name: 'Sudoku Zen',   sku: 'SUDOKU', bundleId: 'com.example.sudoku', scale: 9 },
  { id: '1000000002', name: 'Word Garden',  sku: 'WORDS',  bundleId: 'com.example.words',  scale: 4 },
  { id: '1000000003', name: 'Pixel Runner', sku: 'RUNNER', bundleId: 'com.example.runner', scale: 2 },
  // Not released: no sales, and Apple refuses to start analytics for it.
  { id: '1000000004', name: 'Focus Flow',   sku: 'FOCUS',  bundleId: 'com.example.focus',  scale: 0 },
]
const COUNTRIES = [
  { cc: 'US', cur: 'USD', price: 1.4,  share: 5 },
  { cc: 'MX', cur: 'MXN', price: 24,   share: 3 },
  { cc: 'DE', cur: 'EUR', price: 1.3,  share: 2 },
  { cc: 'JP', cur: 'JPY', price: 210,  share: 1 },
]
/** Units of each currency per US dollar, as the fake feed states them. */
const RATES: Record<string, number> = { USD: 1, MXN: 20, EUR: 0.8, JPY: 150 }
const HISTORY_DAYS = 100

function dayIndex(date: string): number { return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000) }
/** A small whole number that depends on the day and a salt, the same every run. */
function wobble(date: string, salt: number, mod: number): number {
  const x = (dayIndex(date) * 2654435761 + salt * 40503) >>> 0
  return (x >>> 7) % mod
}
function isoDaysAgo(n: number): string { return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10) }
function ptDaysAgo(n: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() - n * 86_400_000))
}
const inHistory = (date: string) => dayIndex(date) > dayIndex(isoDaysAgo(HISTORY_DAYS))

/** First downloads and paid in-app units for an app in a country on a day. */
function sales(app: typeof APPS[number], c: typeof COUNTRIES[number], date: string) {
  if (!app.scale || !inHistory(date)) return { downloads: 0, iap: 0 }
  const downloads = app.scale * c.share + wobble(date, Number(app.id) + c.share, 6)
  const iap = wobble(date, Number(app.id) * 3 + c.share, 3)
  return { downloads, iap }
}
function seen(app: typeof APPS[number], c: typeof COUNTRIES[number], date: string) {
  const { downloads } = sales(app, c, date)
  return { impressions: downloads * 40, pageViews: downloads * 6 }
}

const AD_APPS = [
  { network: 'admob', id: 'ca-app-pub-1~11', name: 'Sudoku Zen', platform: 'IOS', storeId: '1000000001', units: [
    { id: 'ca-app-pub-1/111', name: 'Sudoku banner', format: 'BANNER', ecpm: 0.6 },
    { id: 'ca-app-pub-1/112', name: 'Sudoku rewarded hint', format: 'REWARDED', ecpm: 9 },
  ] },
  { network: 'admob', id: 'ca-app-pub-1~22', name: 'Word Garden', platform: 'IOS', storeId: '1000000002', units: [
    { id: 'ca-app-pub-1/221', name: 'Words interstitial', format: 'INTERSTITIAL', ecpm: 4 },
  ] },
  // An Android build AdMob knows and the App Store does not: it must stand as its own app.
  { network: 'admob', id: 'ca-app-pub-1~33', name: 'Sudoku Zen Android', platform: 'ANDROID', storeId: '', units: [
    { id: 'ca-app-pub-1/331', name: 'Android banner', format: 'BANNER', ecpm: 0.4 },
  ] },
] as const
const UNITY_GAMES = [
  { id: '5550001', name: 'Sudoku Zen', platform: 'ios', placements: [{ id: 'Rewarded_iOS', ecpm: 11 }, { id: 'Interstitial_iOS', ecpm: 5 }] },
  { id: '5550003', name: 'Pixel Runner', platform: 'ios', placements: [{ id: 'Rewarded_iOS', ecpm: 8 }] },
]
function adDay(salt: number, share: number, ecpm: number, date: string) {
  if (!inHistory(date)) return null
  const impressions = 200 * share + wobble(date, salt, 90)
  return { impressions, requests: Math.round(impressions * 1.4), matched: Math.round(impressions * 1.2), clicks: Math.round(impressions / 50), revenue: Math.round(impressions * ecpm) / 1000 }
}

// ── The fake: Apple, Google, AdMob, Unity and the rate feed on one port ──────

async function listen(handler: http.RequestListener): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
  })
}

const SALES_HEADER = ['Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version', 'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date', 'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier', 'Customer Price', 'Promo Code', 'Parent Identifier', 'Subscription', 'Period', 'Category', 'CMB', 'Device', 'Supported Platforms', 'Proceeds Reason', 'Preserved Pricing', 'Client', 'Order Type']

function salesFile(date: string): Buffer | null {
  const [y, m, d] = date.split('-')
  const us = `${m}/${d}/${y}`
  const lines: string[] = []
  const row = (o: Record<string, string | number>) => lines.push(SALES_HEADER.map(h => String(o[h] ?? '')).join('\t'))
  for (const app of APPS) for (const c of COUNTRIES) {
    const s = sales(app, c, date)
    if (s.downloads) row({ SKU: app.sku, Title: app.name, 'Product Type Identifier': '1F', Units: s.downloads, 'Developer Proceeds': 0, 'Begin Date': us, 'End Date': us, 'Country Code': c.cc, 'Currency of Proceeds': c.cur, 'Apple Identifier': app.id })
    if (s.iap) row({ SKU: `${app.sku}.coins`, Title: 'Coins', 'Product Type Identifier': 'IA1', Units: s.iap, 'Developer Proceeds': c.price, 'Begin Date': us, 'End Date': us, 'Country Code': c.cc, 'Currency of Proceeds': c.cur, 'Apple Identifier': `9${app.id}`, 'Parent Identifier': app.sku })
  }
  if (lines.length === 0) return null
  return zlib.gzipSync([SALES_HEADER.join('\t'), ...lines].join('\n'))
}

/** The days an app's standing analytics request has files for. */
const ANALYTICS_DAYS = 40

async function fake(self: () => string) {
  return listen(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const p = u.pathname
    const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
    const text = await readBody(req)

    // ── exchange rates ──
    if (p === '/fx') { json(200, { result: 'success', rates: RATES }); return }

    // ── App Store Connect ──
    if (p === '/v1/apps') {
      json(200, { data: APPS.map(a => ({ type: 'apps', id: a.id, attributes: { name: a.name, sku: a.sku, bundleId: a.bundleId } })) })
      return
    }
    if (p === '/v1/salesReports') {
      const file = salesFile(u.searchParams.get('filter[reportDate]') ?? '')
      if (!file) { json(404, { errors: [{ status: '404', detail: 'There were no sales for the date specified.' }] }); return }
      res.setHeader('content-type', 'application/a-gzip'); res.end(file); return
    }
    let m = /^\/v1\/apps\/(\d+)\/analyticsReportRequests$/.exec(p)
    if (m) { json(200, { data: [] }); return }
    if (p === '/v1/analyticsReportRequests' && req.method === 'POST') {
      const b = JSON.parse(text) as { data: { attributes: { accessType: string }; relationships: { app: { data: { id: string } } } } }
      const appId = b.data.relationships.app.data.id
      if (appId === '1000000004') { json(409, { errors: [{ status: '409', detail: 'This app has no released version to report on.' }] }); return }
      json(201, { data: { type: 'analyticsReportRequests', id: `${b.data.attributes.accessType === 'ONGOING' ? 'on' : 'snap'}-${appId}`, attributes: { accessType: b.data.attributes.accessType } } })
      return
    }
    m = /^\/v1\/analyticsReportRequests\/(on|snap)-(\d+)\/reports$/.exec(p)
    if (m) {
      json(200, { data: m[1] === 'on' ? [{ type: 'analyticsReports', id: `rep-${m[2]}`, attributes: { name: 'App Store Discovery and Engagement Standard' } }] : [] })
      return
    }
    m = /^\/v1\/analyticsReports\/rep-(\d+)\/instances$/.exec(p)
    if (m) {
      const data = []
      for (let n = 2; n < 2 + ANALYTICS_DAYS; n++) data.push({ type: 'analyticsReportInstances', id: `inst-${m[1]}-${isoDaysAgo(n)}`, attributes: { granularity: 'DAILY', processingDate: isoDaysAgo(n) } })
      json(200, { data }); return
    }
    m = /^\/v1\/analyticsReportInstances\/inst-(\d+)-(\d{4}-\d{2}-\d{2})\/segments$/.exec(p)
    if (m) { json(200, { data: [{ type: 'analyticsReportSegments', id: 's', attributes: { url: `${self()}/segment/${m[1]}/${m[2]}` } }] }); return }
    m = /^\/segment\/(\d+)\/(\d{4}-\d{2}-\d{2})$/.exec(p)
    if (m) {
      const app = APPS.find(a => a.id === m![1])!
      const lines = ['Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tEngagement Type\tDevice\tPlatform Version\tTerritory\tCounts\tUnique Counts']
      for (const c of COUNTRIES) {
        const s = seen(app, c, m[2]!)
        const half = Math.floor(s.impressions / 2)
        lines.push(`${m[2]}\t${app.name}\t${app.id}\tImpression\tNo page\tApp Store search\t\tiPhone\tiOS 19\t${c.cc}\t${half}\t${half}`)
        lines.push(`${m[2]}\t${app.name}\t${app.id}\tImpression\tNo page\tApp Store browse\t\tiPhone\tiOS 19\t${c.cc}\t${s.impressions - half}\t1`)
        lines.push(`${m[2]}\t${app.name}\t${app.id}\tPage view\tProduct page\tApp Store search\t\tiPhone\tiOS 19\t${c.cc}\t${s.pageViews}\t1`)
        lines.push(`${m[2]}\t${app.name}\t${app.id}\tPage view\tStore sheet\tApp referrer\t\tiPhone\tiOS 19\t${c.cc}\t999\t1`)
      }
      res.end(zlib.gzipSync(lines.join('\n'))); return
    }

    // ── Google sign-in ──
    if (p === '/token') {
      const form = new URLSearchParams(text)
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') { json(400, { error: 'invalid_grant', error_description: 'Bad code' }); return }
      json(200, { access_token: 'access-1', expires_in: 3600, ...(form.get('grant_type') === 'authorization_code' ? { refresh_token: 'refresh-1' } : {}) })
      return
    }

    // ── AdMob ──
    if (p.startsWith('/v1/accounts')) {
      if (req.headers.authorization !== 'Bearer access-1') { json(401, { error: { message: 'Request had invalid authentication credentials.' } }); return }
      if (p === '/v1/accounts') { json(200, { account: [{ name: 'accounts/pub-1', publisherId: 'pub-1', currencyCode: 'EUR', reportingTimeZone: 'Europe/Madrid' }] }); return }
      if (p === '/v1/accounts/pub-1/apps') {
        json(200, { apps: AD_APPS.map(a => ({ appId: a.id, platform: a.platform, manualAppInfo: { displayName: a.name }, ...(a.storeId ? { linkedAppInfo: { appStoreId: a.storeId, displayName: a.name } } : {}) })) })
        return
      }
      if (p === '/v1/accounts/pub-1/adUnits') {
        json(200, { adUnits: AD_APPS.flatMap(a => a.units.map(un => ({ adUnitId: un.id, appId: a.id, displayName: un.name, adFormat: un.format }))) })
        return
      }
      if (p === '/v1/accounts/pub-1/networkReport:generate') {
        const spec = (JSON.parse(text) as { reportSpec: { dateRange: { startDate: { year: number; month: number; day: number }; endDate: { year: number; month: number; day: number } } } }).reportSpec
        const iso = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
        const out: unknown[] = [{ header: {} }]
        for (let d = iso(spec.dateRange.startDate); d <= iso(spec.dateRange.endDate); d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
          for (const a of AD_APPS) for (const [ui, un] of a.units.entries()) for (const c of COUNTRIES) {
            const x = adDay(Number(a.id.slice(-2)) + ui, c.share, un.ecpm, d)
            if (!x) continue
            out.push({ row: {
              dimensionValues: { DATE: { value: d.replace(/-/g, '') }, APP: { value: a.id, displayLabel: a.name }, AD_UNIT: { value: un.id, displayLabel: un.name }, COUNTRY: { value: c.cc }, FORMAT: { value: un.format }, PLATFORM: { value: a.platform } },
              // The account's currency is EUR: AdMob states earnings in it.
              metricValues: { ESTIMATED_EARNINGS: { microsValue: String(Math.round(x.revenue * RATES['EUR']! * 1e6)) }, IMPRESSIONS: { integerValue: String(x.impressions) }, CLICKS: { integerValue: String(x.clicks) }, AD_REQUESTS: { integerValue: String(x.requests) }, MATCHED_REQUESTS: { integerValue: String(x.matched) } },
            } })
          }
        }
        out.push({ footer: { matchingRowCount: String(out.length - 1) } })
        json(200, out); return
      }
    }

    // ── Unity Ads ──
    m = /^\/stats\/v1\/operate\/organizations\/(.+)$/.exec(p)
    if (m) {
      if (m[1] !== 'org-core-1') { json(404, { errors: [{ msg: 'organization not found' }] }); return }
      if (u.searchParams.get('apikey') !== 'unity-key-1234') { json(400, { errors: [{ msg: 'access token required' }] }); return }
      const start = (u.searchParams.get('start') ?? '').slice(0, 10), end = (u.searchParams.get('end') ?? '').slice(0, 10)
      const lines = ['timestamp,source_game_id,source_name,country,platform,placement,adrequest_count,available_sum,start_count,view_count,revenue_sum']
      for (let d = start; d < end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
        for (const g of UNITY_GAMES) for (const [pi, pl] of g.placements.entries()) for (const c of COUNTRIES) {
          const x = adDay(Number(g.id.slice(-2)) + pi + 50, c.share, pl.ecpm, d)
          if (!x) continue
          lines.push(`${d}T00:00:00.000Z,${g.id},"${g.name}",${c.cc},${g.platform},${pl.id},${x.requests},${x.matched},${x.impressions},${x.impressions - 3},${x.revenue}`)
        }
      }
      res.setHeader('content-type', 'text/csv'); res.end(lines.join('\n')); return
    }

    json(404, { errors: [{ detail: `the fake has no ${req.method} ${p}` }] })
  })
}

// ── The real server ──────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>(r => s.close(() => r()))
  return port
}

async function boot(env: Record<string, string>, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'src/index.ts'], {
    cwd: SERVER_DIR, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  child.stdout!.on('data', (c: Buffer) => { lines.push(c.toString()); if (process.env['VERBOSE']) process.stdout.write(c) })
  child.stderr!.on('data', (c: Buffer) => { lines.push(c.toString()); if (process.env['VERBOSE']) process.stderr.write(c) })
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/app-store`)).ok) return child } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  child.kill()
  throw new Error(`the server did not come up:\n${lines.join('').slice(-2000)}`)
}

interface M { downloads: number; iap: number; proceeds: number; impressions: number | null; pageViews: number | null; adRevenue: number; adImpressions: number; adRequests: number }
interface Report {
  from: string; to: string; prevFrom: string; prevTo: string; days: number; currency: string; approx: boolean
  apps: { id: string; name: string; store: boolean; networks: string[] }[]
  totals: M; prev: M; series: (M & { key: string })[]
  byApp: { id: string; name: string; totals: M }[]
  byCountry: { code: string; downloads: number; proceeds: number; impressions: number | null; adRevenue: number }[]
  bySource: { source: string; impressions: number; pageViews: number }[] | null
  ads: { byNetwork: { key: string; revenue: number; impressions: number }[]; byUnit: { key: string; label: string; revenue: number }[]; byFormat: { key: string }[]; byPlatform: { key: string }[] }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-apps-'))
  let url = ''
  const f = await fake(() => url)
  url = f.url
  const port = SERVE ? 3001 : await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = await boot({
    CACHE_DIR: dir, ASC_API: f.url, ADMOB_API: f.url, UNITY_ADS_API: f.url, GOOGLE_TOKEN_URL: `${f.url}/token`, FX_API: `${f.url}/fx`,
    OPENWEATHER_API_KEY: 'x', OLLAMA_URL: 'http://127.0.0.1:9',
  }, port)

  const api = async <T,>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const res = await fetch(`${base}${route}`, { method, redirect: 'manual', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    const textBody = await res.text()
    let data: unknown = textBody
    try { data = JSON.parse(textBody) } catch { /* a page */ }
    return { status: res.status, data: data as T }
  }
  const report = async (qs: string) => (await api<Report>('GET', `/api/app-store/report?${qs}`)).data
  const waitFor = async (what: string, ok: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) { if (await ok()) return; await new Promise(r => setTimeout(r, 2500)) }
    throw new Error(`timed out waiting for ${what}`)
  }

  try {
    console.log('\nConnecting')
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const saved = await api<{ configured: boolean; error?: string }>('POST', '/api/app-store/config', { issuerId: 'issuer-1', keyId: 'ABCDEF1234', vendorNumber: '87654321', privateKey: pem })
    check('the App Store key is accepted', saved.status === 200 && saved.data.configured, JSON.stringify(saved.data).slice(0, 200))

    const badUnity = await api<{ error?: string }>('POST', '/api/app-store/unity', { orgId: 'org-core-1', apiKey: 'wrong' })
    check('a wrong Unity key is refused with a sentence', badUnity.status === 400 && /key/i.test(badUnity.data.error ?? ''), JSON.stringify(badUnity.data))
    const unity = await api<{ ads: { unity: { connected: boolean; keyTail: string } } }>('POST', '/api/app-store/unity', { orgId: 'org-core-1', apiKey: 'unity-key-1234' })
    check('the right Unity key is saved, and only its tail is sent back', unity.status === 200 && unity.data.ads.unity.connected && unity.data.ads.unity.keyTail === '1234' && !JSON.stringify(unity.data).includes('unity-key-1234'))

    const noApp = await api<string>('GET', '/api/app-store/admob/oauth/start')
    check('AdMob sign-in without a Google app says so', noApp.status === 400 && /Google app/i.test(String(noApp.data)))
    await api('POST', '/api/app-store/admob/app', { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' })
    const start = await fetch(`${base}/api/app-store/admob/oauth/start`, { redirect: 'manual' })
    const loc = new URL(start.headers.get('location') ?? 'http://x')
    check('the sign-in goes to Google asking for AdMob, read-only, offline', loc.hostname === 'accounts.google.com' && loc.searchParams.get('scope') === 'https://www.googleapis.com/auth/admob.readonly' && loc.searchParams.get('access_type') === 'offline')
    const stray = await api<string>('GET', '/api/app-store/admob/oauth/callback?code=good-code&state=not-ours')
    check('a callback this dashboard did not start connects nothing', stray.status === 400)
    const back = await api<string>('GET', `/api/app-store/admob/oauth/callback?code=good-code&state=${loc.searchParams.get('state')}`)
    check('the real callback connects the AdMob account', back.status === 200 && /pub-1/.test(String(back.data)), String(back.data).slice(0, 200))

    console.log('\nReading')
    await api('POST', '/api/app-store/sync')
    interface View { syncing: boolean; lastRun: { ok: boolean; detail: string } | null; salesDaysRead: number; apps: { id: string; name: string; hidden: boolean }[]; yesterday: { downloads: number; apps: number }; ads: { syncing: boolean; admob: { lastRun: { ok: boolean; detail: string } | null }; unity: { lastRun: { ok: boolean; detail: string } | null } } }
    let view!: View
    await waitFor('the first read', async () => {
      view = (await api<View>('GET', '/api/app-store')).data
      if (!view?.ads) return false                                  // the rate limiter answered
      return !view.syncing && !view.ads.syncing && !!view.lastRun && view.salesDaysRead > 300 && !!view.ads.admob.lastRun && !!view.ads.unity.lastRun
    })
    check('the App Store read succeeds', view.lastRun?.ok === true, view.lastRun?.detail)
    check('an app that refuses analytics is named, and costs the others nothing', /analytics for Focus Flow failed/.test(view.lastRun?.detail ?? ''), view.lastRun?.detail)
    check('AdMob read succeeds', view.ads.admob.lastRun?.ok === true, view.ads.admob.lastRun?.detail)
    check('Unity Ads read succeeds', view.ads.unity.lastRun?.ok === true, view.ads.unity.lastRun?.detail)

    console.log('\nThe report')
    const to = ptDaysAgo(3), from = ptDaysAgo(9)                       // seven days, all with every source
    const dates: string[] = []
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) dates.push(d)
    const live = APPS.filter(a => a.scale)
    const sum = <T,>(items: T[], f: (t: T) => number) => items.reduce((n, t) => n + f(t), 0)
    const expDownloads = (apps = live, ccs = COUNTRIES, ds = dates) => sum(ds, d => sum(apps, a => sum(ccs, c => sales(a, c, d).downloads)))
    const expProceeds = (apps = live, ccs = COUNTRIES, ds = dates) => sum(ds, d => sum(apps, a => sum(ccs, c => sales(a, c, d).iap * c.price / RATES[c.cur]!)))
    const expAdmob = (apps: readonly typeof AD_APPS[number][] = AD_APPS, ccs = COUNTRIES, unit?: string) => sum(dates, d => sum([...apps], a => sum([...a.units.entries()].filter(([, un]) => !unit || un.id === unit), ([ui, un]) => sum(ccs, c => adDay(Number(a.id.slice(-2)) + ui, c.share, un.ecpm, d)!.revenue))))
    const expUnity = (games = UNITY_GAMES, ccs = COUNTRIES) => sum(dates, d => sum(games, g => sum([...g.placements.entries()], ([pi, pl]) => sum(ccs, c => adDay(Number(g.id.slice(-2)) + pi + 50, c.share, pl.ecpm, d)!.revenue))))

    const all = await report(`from=${from}&to=${to}`)
    check('seven days, compared with the seven before', all.days === 7 && all.prevTo < all.from && all.series.length === 7, `${all.prevFrom}..${all.prevTo}`)
    check('downloads add up', all.totals.downloads === expDownloads(), `${all.totals.downloads} vs ${expDownloads()}`)
    check('sales in four currencies come to one figure in dollars, marked approximate', near(all.totals.proceeds, expProceeds(), 0.05) && all.approx && all.currency === 'USD', `${all.totals.proceeds} vs ${expProceeds().toFixed(2)}`)
    check('impressions and product page views add up (other page types left out)', all.totals.impressions === expDownloads() * 40 && all.totals.pageViews === expDownloads() * 6, `${all.totals.impressions} / ${all.totals.pageViews}`)
    check('ad revenue is AdMob (from euros) plus Unity', near(all.totals.adRevenue, expAdmob() + expUnity(), 0.1), `${all.totals.adRevenue} vs ${(expAdmob() + expUnity()).toFixed(2)}`)
    check('the days of the series add up to the total', sum(all.series, s => s.downloads) === all.totals.downloads && near(sum(all.series, s => s.adRevenue), all.totals.adRevenue, 0.1))
    check('the stretch before has its own figures', all.prev.downloads > 0 && all.prev.downloads !== all.totals.downloads)
    const sudoku = all.byApp.find(a => a.name === 'Sudoku Zen')
    check('AdMob (by store id) and Unity (by name) both join the App Store app', !!sudoku && near(sudoku.totals.adRevenue, expAdmob([AD_APPS[0]]) + expUnity([UNITY_GAMES[0]!]), 0.1) && sudoku.totals.downloads === expDownloads([APPS[0]!]), JSON.stringify(sudoku?.totals))
    const android = all.apps.find(a => a.name === 'Sudoku Zen Android')
    check('an ad app with no App Store twin stands as its own app', !!android && !android.store && android.id.startsWith('ad:'))
    check('where it was seen is split by source', all.bySource?.length === 2 && all.bySource[0]!.source === 'App Store search' && sum(all.bySource, s => s.impressions) === all.totals.impressions, JSON.stringify(all.bySource))
    check('countries are listed with downloads, sales and ads', all.byCountry[0]?.code === 'US' && all.byCountry.length === 4 && sum(all.byCountry, c => c.downloads) === all.totals.downloads && near(sum(all.byCountry, c => c.adRevenue), all.totals.adRevenue, 0.1))
    check('ads are split by network, unit, format and platform', all.ads.byNetwork.length === 2 && all.ads.byUnit.length === 7 && all.ads.byFormat.length >= 3 && all.ads.byPlatform.length === 2, `${all.ads.byNetwork.length}/${all.ads.byUnit.length}/${all.ads.byFormat.length}/${all.ads.byPlatform.length}`)

    console.log('\nNarrowing it')
    const one = await report(`from=${from}&to=${to}&apps=1000000002`)
    check('one app', one.totals.downloads === expDownloads([APPS[1]!]) && near(one.totals.adRevenue, expAdmob([AD_APPS[1]]), 0.05), `${one.totals.downloads} ${one.totals.adRevenue}`)
    check('…while the app table still lists them all', one.byApp.length === all.byApp.length)
    const mx = await report(`from=${from}&to=${to}&countries=MX`)
    const MX = [COUNTRIES[1]!]
    check('one country: downloads, sales, impressions and ads', mx.totals.downloads === expDownloads(live, MX) && near(mx.totals.proceeds, expProceeds(live, MX), 0.05) && mx.totals.impressions === expDownloads(live, MX) * 40 && near(mx.totals.adRevenue, expAdmob(AD_APPS, MX) + expUnity(UNITY_GAMES, MX), 0.05), JSON.stringify(mx.totals))
    check('…while the country table still lists them all, and sources step aside', mx.byCountry.length === 4 && mx.bySource === null)
    const net = await report(`from=${from}&to=${to}&networks=unity`)
    check('one network', near(net.totals.adRevenue, expUnity(), 0.05) && net.totals.downloads === all.totals.downloads && net.ads.byNetwork.length === 2)
    const unitKey = 'admob:ca-app-pub-1/112'
    const unit = await report(`from=${from}&to=${to}&units=${encodeURIComponent(unitKey)}`)
    check('one ad unit', near(unit.totals.adRevenue, expAdmob(AD_APPS, COUNTRIES, 'ca-app-pub-1/112'), 0.05) && unit.ads.byUnit.length === 7, `${unit.totals.adRevenue}`)
    const both = await report(`from=${from}&to=${to}&apps=1000000001&countries=US,DE`)
    check('an app and two countries together', both.totals.downloads === expDownloads([APPS[0]!], [COUNTRIES[0]!, COUNTRIES[2]!]))
    const weeks = await report(`from=${ptDaysAgo(30)}&to=${to}&group=week`)
    check('grouped by week, Monday to Sunday', weeks.series.length >= 4 && weeks.series.length <= 6 && weeks.series.every((s, i) => i === 0 || new Date(`${s.key}T00:00:00Z`).getUTCDay() === 1) && sum(weeks.series, s => s.downloads) === weeks.totals.downloads)
    const months = await report(`from=${ptDaysAgo(70)}&to=${to}&group=month`)
    check('grouped by month', months.series.length >= 3 && months.series.every((s, i) => i === 0 || s.key.endsWith('-01')))
    const backwards = await report(`from=${to}&to=${from}`)
    check('a range given backwards is read forwards', backwards.from === from && backwards.to === to)

    console.log('\nLeaving an app out')
    await api('POST', '/api/app-store/apps/1000000004/hidden', { hidden: true })
    const hid = await api<View>('POST', '/api/app-store/apps/1000000003/hidden', { hidden: true })
    check('hidden apps stay in the list Settings edits, marked', hid.data.apps.filter(a => a.hidden).length === 2 && hid.data.apps.length === 5)
    const without = await report(`from=${from}&to=${to}`)
    check('…and leave the report, its totals and its ad revenue', !without.byApp.some(a => a.name === 'Pixel Runner' || a.name === 'Focus Flow') && without.totals.downloads === expDownloads([APPS[0]!, APPS[1]!]) && near(without.totals.adRevenue, expAdmob() + expUnity([UNITY_GAMES[0]!]), 0.1), `${without.totals.downloads}`)
    check('…and the corner pill', hid.data.yesterday.apps === 3)
    if (!SERVE) {
      const shown = await api<View>('POST', '/api/app-store/apps/1000000003/hidden', { hidden: false })
      check('showing it again puts it back', shown.data.apps.filter(a => a.hidden).length === 1 && (await report(`from=${from}&to=${to}`)).totals.downloads === expDownloads())
    } else {
      await api('POST', '/api/app-store/apps/1000000003/hidden', { hidden: false })
    }

    console.log('\nWhat is kept')
    const mode = fs.statSync(path.join(dir, 'ads.json')).mode & 0o777
    check('the ad keys are on the volume, readable by the server only', mode === 0o600, mode.toString(8))
    const cur = await api<{ currency: string }>('POST', '/api/app-store/currency', { currency: 'eur' })
    const eur = await report(`from=${from}&to=${to}`)
    check('the display currency can be changed', cur.data.currency === 'EUR' && eur.currency === 'EUR' && near(eur.totals.proceeds, expProceeds() * RATES['EUR']!, 0.05), `${eur.totals.proceeds}`)
    await api('POST', '/api/app-store/currency', { currency: 'USD' })

    console.log(`\n${passed} passed, ${failed} failed`)
    if (SERVE) {
      console.log(`\nServing on ${base} with made-up data. Ctrl-C to stop.`)
      await new Promise(() => { /* until killed */ })
    }
  } finally {
    server.kill()
    await f.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
