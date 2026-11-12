// What the ads inside the apps earned: Google AdMob and Unity Ads, beside the
// App Store's own numbers in the Apps corner.
//
// The App Store ledger knows what was SOLD. A free app with ads earns through
// an ad network instead, and each network keeps its own books behind its own
// API — so "what did Sudoku make yesterday" was three sign-ins. Both are read
// here on the same hourly beat as App Store Connect and stored the same way.
//
// ADMOB is Google's reporting API (admob.googleapis.com). It has no service
// accounts: the only way in is a person's own Google sign-in, so this is the
// Gmail corner's OAuth dance with one read-only scope, and it can share the
// Google app registered for Mail. What is kept is a refresh token.
//
// UNITY ADS is the Monetization Stats API: an organization id and an API key
// from the Unity dashboard, sent with every request. No sign-in.
//
// ONE ROW SHAPE FOR BOTH: a day, an app, an ad unit (Unity calls it a
// placement), a country, a format, a platform — and what that combination
// earned, showed, was asked for. Kept at that grain, not summed, because the
// questions worth asking ("which unit, in which country") are answered by
// slicing it. The last few days are re-read every run: both networks restate
// recent days as clicks are validated.
//
// Secrets stay on the volume (`ads.json`, 0600); the browser sees ids only.

import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { broadcast } from './routes/system'
import { googleClientApp } from './mail'
import { parseTable } from './app-store'
import { refreshFx } from './fx'

const ADMOB_API = (process.env['ADMOB_API'] ?? '').trim() || 'https://admob.googleapis.com'
const UNITY_API = (process.env['UNITY_ADS_API'] ?? '').trim() || 'https://monetization.api.unity.com'
const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = (process.env['GOOGLE_TOKEN_URL'] ?? '').trim() || 'https://oauth2.googleapis.com/token'
const ADMOB_SCOPE = 'https://www.googleapis.com/auth/admob.readonly'

const CONFIG_FILE = 'ads.json'
const STATS_FILE  = 'ads-stats.json'
/** How far back the first read goes, and how many recent days every later read restates. */
const BACKFILL_DAYS = 180
const RESTATE_DAYS  = 4
const SYNC_EVERY_MS = 60 * 60_000
const FIRST_SYNC_DELAY_MS = 45_000
/** Days kept. Past this the oldest are dropped, so the file cannot grow without limit. */
const KEEP_DAYS = 800

export type Network = 'admob' | 'unity'
export const NETWORKS: Network[] = ['admob', 'unity']

function cacheDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Configuration ────────────────────────────────────────────────────────────

interface AdsConfig {
  /** A Google app of this feature's own; without one the Mail corner's is used. */
  google?: { clientId: string; clientSecret: string }
  admob?:  { refreshToken: string; publisherId: string; currency: string; addedAt: string }
  unity?:  { orgId: string; apiKey: string; addedAt: string }
}

function readConfig(): AdsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), CONFIG_FILE), 'utf8')) as AdsConfig
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeConfig(next: AdsConfig): void {
  const p = path.join(cacheDir(), CONFIG_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, p)
  fs.chmodSync(p, 0o600)
}

function googleApp(): { clientId: string; clientSecret: string; from: 'ads' | 'mail' } | null {
  const own = readConfig().google
  if (own?.clientId && own.clientSecret) return { ...own, from: 'ads' }
  const mail = googleClientApp()
  return mail ? { ...mail, from: 'mail' } : null
}

export function setGoogleApp(clientId: string, clientSecret: string): void {
  const id = clientId.trim(), secret = clientSecret.trim()
  if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error('The client ID ends in .apps.googleusercontent.com — copy it from the Google Cloud console.')
  if (!secret) throw new Error('The client secret is missing.')
  writeConfig({ ...readConfig(), google: { clientId: id, clientSecret: secret } })
}

// ── The store ────────────────────────────────────────────────────────────────

/** One combination's day. Money is in the network's own currency (`currency` on the store). */
export interface AdRow {
  n:    Network
  app:  string
  unit: string
  cc:   string
  fmt:  string
  plat: string
  rev:  number
  imp:  number
  clk:  number
  req:  number
  mat:  number
}

export interface AdApp  { network: Network; id: string; name: string; platform: string; storeId: string }
export interface AdUnit { network: Network; id: string; name: string; format: string; app: string }
interface RunNote { at: string; ok: boolean; detail: string }

export interface AdStore {
  apps:     Record<string, AdApp>
  units:    Record<string, AdUnit>
  /** date → every row of that day, both networks. */
  days:     Record<string, AdRow[]>
  currency: Record<Network, string>
  /** Per network: whether the long first read has been done. */
  filled:   Partial<Record<Network, boolean>>
  lastRun:  Partial<Record<Network, RunNote>>
}

function blank(): AdStore {
  return { apps: {}, units: {}, days: {}, currency: { admob: 'USD', unity: 'USD' }, filled: {}, lastRun: {} }
}

let cache: { dir: string; store: AdStore } | null = null

export function readAds(): AdStore {
  if (cache && cache.dir === cacheDir()) return cache.store
  let store = blank()
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), STATS_FILE), 'utf8')) as Partial<AdStore>
    store = { ...blank(), ...raw, currency: { ...blank().currency, ...(raw.currency ?? {}) } }
  } catch { /* nothing read yet */ }
  cache = { dir: cacheDir(), store }
  return store
}

function writeAds(s: AdStore): void {
  cache = { dir: cacheDir(), store: s }
  const dates = Object.keys(s.days).sort()
  for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete s.days[d]
  const p = path.join(cacheDir(), STATS_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[ads] failed to save:', err)
  }
}

/** Replace one network's rows for every date in [from, to] with `rows` (keyed by date). */
function replaceRange(s: AdStore, network: Network, from: string, to: string, rows: Map<string, AdRow[]>): void {
  for (let d = from; d <= to; d = nextDay(d)) {
    const kept = (s.days[d] ?? []).filter(r => r.n !== network)
    const merged = kept.concat(rows.get(d) ?? [])
    if (merged.length) s.days[d] = merged
    else delete s.days[d]
  }
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

// ── AdMob ────────────────────────────────────────────────────────────────────

export function admobAuthUrl(redirectUri: string, state: string): string {
  const app = googleApp()
  if (!app) throw new Error('No Google app is registered yet. Add the client ID and secret first.')
  const qs = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: ADMOB_SCOPE, access_type: 'offline', prompt: 'consent', state,
  })
  return `${AUTH_URL}?${qs}`
}

let admobToken: { token: string; until: number } | null = null

async function tokenRequest(body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  })
  return await res.json() as { access_token?: string }
}

async function admobAccessToken(): Promise<string> {
  if (admobToken && admobToken.until > Date.now()) return admobToken.token
  const cfg = readConfig()
  const app = googleApp()
  if (!cfg.admob || !app) throw new Error('AdMob is not signed in')
  const j = await tokenRequest({
    client_id: app.clientId, client_secret: app.clientSecret,
    refresh_token: cfg.admob.refreshToken, grant_type: 'refresh_token',
  })
  if (!j.access_token) throw new Error(`AdMob needs signing in again (${j.error_description ?? j.error ?? 'Google refused the saved sign-in'})`)
  admobToken = { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 300) * 1000 }
  return j.access_token
}

async function admob<T>(token: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await axios.request<T>({
    method, url: `${ADMOB_API}${route}`, data: body,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true, timeout: 90_000, maxContentLength: 256 * 1024 * 1024,
  })
  if (res.status !== 200) {
    const e = (res.data as { error?: { message?: string; status?: string } } | undefined)?.error
    const why = e?.message ?? `HTTP ${res.status}`
    if (res.status === 403 && /disabled|not been used|SERVICE_DISABLED/i.test(why)) {
      throw new Error('The AdMob API is not switched on for the Google Cloud project behind this sign-in. Enable "AdMob API" under APIs & Services → Library, wait a minute, and read again.')
    }
    throw new Error(`AdMob: ${why}`)
  }
  return res.data
}

interface AdmobAccount { name: string; publisherId: string; currencyCode?: string; reportingTimeZone?: string }

/** Finish the sign-in: swap the code for a refresh token and find the AdMob account behind it. */
export async function completeAdmobSignIn(code: string, redirectUri: string): Promise<string> {
  const app = googleApp()
  if (!app) throw new Error('No Google app is registered.')
  const j = await tokenRequest({
    code, client_id: app.clientId, client_secret: app.clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  })
  if (!j.access_token) throw new Error(j.error_description ?? j.error ?? 'Google refused the sign-in')
  if (!j.refresh_token) {
    throw new Error('Google returned no refresh token. Remove this app from your Google account\'s third-party access list and sign in again.')
  }
  const list = await admob<{ account?: AdmobAccount[] }>(j.access_token, 'GET', '/v1/accounts')
  const account = list.account?.[0]
  if (!account) throw new Error('That Google account has no AdMob account. Sign in with the one you use at admob.google.com.')
  writeConfig({ ...readConfig(), admob: {
    refreshToken: j.refresh_token, publisherId: account.publisherId,
    currency: account.currencyCode ?? 'USD', addedAt: new Date().toISOString(),
  } })
  admobToken = { token: j.access_token, until: Date.now() + 50 * 60_000 }
  console.log(`[ads] AdMob signed in (${account.publisherId})`)
  void syncAdsNow()
  return account.publisherId
}

export function forgetAdmob(): void {
  const cfg = readConfig()
  delete cfg.admob
  writeConfig(cfg)
  admobToken = null
  broadcast('app-store', { ads: true })
}

interface AdmobValue { value?: string; displayLabel?: string; integerValue?: string; microsValue?: string; doubleValue?: number }
interface AdmobChunk { row?: { dimensionValues?: Record<string, AdmobValue>; metricValues?: Record<string, AdmobValue> } }

const ymd = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return { year: y, month: m, day: d }
}

async function syncAdmob(s: AdStore, log: string[]): Promise<void> {
  const cfg = readConfig().admob
  if (!cfg) return
  const token = await admobAccessToken()
  const account = `accounts/${cfg.publisherId}`

  // The catalogue: every app with its store id (the join to the App Store's
  // list) and every ad unit with the name the user gave it.
  let pageToken = ''
  do {
    const page = await admob<{ apps?: { appId?: string; platform?: string; manualAppInfo?: { displayName?: string }; linkedAppInfo?: { appStoreId?: string; displayName?: string } }[]; nextPageToken?: string }>(
      token, 'GET', `/v1/${account}/apps?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
    for (const a of page.apps ?? []) {
      if (!a.appId) continue
      s.apps[`admob:${a.appId}`] = {
        network: 'admob', id: a.appId,
        name: a.linkedAppInfo?.displayName || a.manualAppInfo?.displayName || a.appId,
        platform: (a.platform ?? '').toLowerCase(), storeId: a.linkedAppInfo?.appStoreId ?? '',
      }
    }
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  pageToken = ''
  do {
    const page = await admob<{ adUnits?: { adUnitId?: string; appId?: string; displayName?: string; adFormat?: string }[]; nextPageToken?: string }>(
      token, 'GET', `/v1/${account}/adUnits?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
    for (const u of page.adUnits ?? []) {
      if (!u.adUnitId) continue
      s.units[`admob:${u.adUnitId}`] = { network: 'admob', id: u.adUnitId, name: u.displayName || u.adUnitId, format: prettyFormat(u.adFormat ?? ''), app: u.appId ?? '' }
    }
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)

  const to = daysAgo(0)
  const from = daysAgo(s.filled.admob ? RESTATE_DAYS : BACKFILL_DAYS)
  let total = 0
  // A week at a time: a report is capped in rows, and day × unit × country adds up.
  for (let start = from; start <= to;) {
    let end = start
    for (let i = 0; i < 6 && end < to; i++) end = nextDay(end)
    const chunks = await admob<AdmobChunk[]>(token, 'POST', `/v1/${account}/networkReport:generate`, {
      reportSpec: {
        dateRange: { startDate: ymd(start), endDate: ymd(end) },
        dimensions: ['DATE', 'APP', 'AD_UNIT', 'COUNTRY', 'FORMAT', 'PLATFORM'],
        metrics: ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS', 'MATCHED_REQUESTS'],
        localizationSettings: { currencyCode: cfg.currency },
      },
    })
    const rows = new Map<string, AdRow[]>()
    for (const c of Array.isArray(chunks) ? chunks : []) {
      const dv = c.row?.dimensionValues, mv = c.row?.metricValues
      if (!dv || !mv) continue
      const raw = dv['DATE']?.value ?? ''
      const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : ''
      if (!date) continue
      const appId = dv['APP']?.value ?? ''
      const unitId = dv['AD_UNIT']?.value ?? ''
      const row: AdRow = {
        n: 'admob', app: appId, unit: unitId,
        cc: (dv['COUNTRY']?.value ?? '').toUpperCase() || '??',
        fmt: prettyFormat(dv['FORMAT']?.value ?? ''),
        plat: (dv['PLATFORM']?.value ?? '').toLowerCase(),
        rev: num(mv['ESTIMATED_EARNINGS']?.microsValue) / 1e6,
        imp: num(mv['IMPRESSIONS']?.integerValue),
        clk: num(mv['CLICKS']?.integerValue),
        req: num(mv['AD_REQUESTS']?.integerValue),
        mat: num(mv['MATCHED_REQUESTS']?.integerValue),
      }
      if (!row.rev && !row.imp && !row.req) continue
      // A unit or app deleted from AdMob is still named in the report's labels.
      if (appId && !s.apps[`admob:${appId}`]) s.apps[`admob:${appId}`] = { network: 'admob', id: appId, name: dv['APP']?.displayLabel || appId, platform: row.plat, storeId: '' }
      if (unitId && !s.units[`admob:${unitId}`]) s.units[`admob:${unitId}`] = { network: 'admob', id: unitId, name: dv['AD_UNIT']?.displayLabel || unitId, format: row.fmt, app: appId }
      const list = rows.get(date) ?? []
      list.push(row)
      rows.set(date, list)
      total++
    }
    replaceRange(s, 'admob', start, end, rows)
    if (end >= to) break
    start = nextDay(end)
  }
  s.currency.admob = cfg.currency
  s.filled.admob = true
  log.push(`AdMob ${from} to ${to}: ${total} rows`)
}

function prettyFormat(f: string): string {
  const t = f.trim().toLowerCase().replace(/_/g, ' ')
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// ── Unity Ads ────────────────────────────────────────────────────────────────

async function unityFetch(orgId: string, apiKey: string, from: string, to: string): Promise<Record<string, string>[]> {
  const res = await axios.get<string>(`${UNITY_API}/stats/v1/operate/organizations/${encodeURIComponent(orgId)}`, {
    params: {
      groupBy: 'country,placement,platform,game',
      fields: 'adrequest_count,available_sum,start_count,view_count,revenue_sum',
      scale: 'day',
      start: `${from}T00:00:00Z`,
      end: `${nextDay(to)}T00:00:00Z`,
      apikey: apiKey,
    },
    // The key goes in the query ONLY. The docs allow the query or an
    // `Authorization: Token` header, and Unity answers a request carrying both
    // with a bare 400 and an empty body, whatever the key (measured 2026-11-12).
    // The query is the one that survives the redirect the data sits behind.
    headers: { Accept: 'text/csv' },
    responseType: 'text', transformResponse: x => x as string,
    validateStatus: () => true, timeout: 120_000, maxContentLength: 256 * 1024 * 1024,
  })
  if (res.status === 408) throw new UnityTimeout()
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /token/i.test(String(res.data)))) throw new Error(`Unity refused the API key (${res.status}). Check the key and the organization id.`)
  if (res.status === 404) throw new Error('Unity does not know that organization id (404).')
  if (res.status === 429) throw new Error('Unity says too many requests (429); the next read will try again.')
  if (res.status !== 200) throw new Error(`Unity Ads: HTTP ${res.status} ${String(res.data).slice(0, 160)}`)
  return parseTable(String(res.data))
}

/** Unity gives up on a request after 60 s; the answer is to ask for less at once. */
class UnityTimeout extends Error { constructor() { super('Unity took too long to answer (408)') } }

/** Save the Unity key after proving it with a one-day request. */
export async function setUnityConfig(orgId: string, apiKey: string): Promise<void> {
  const org = orgId.trim(), key = apiKey.trim() || readConfig().unity?.apiKey || ''
  if (!org) throw new Error('The organization id is missing.')
  if (!key) throw new Error('The API key is missing.')
  await unityFetch(org, key, daysAgo(2), daysAgo(1))
  writeConfig({ ...readConfig(), unity: { orgId: org, apiKey: key, addedAt: new Date().toISOString() } })
  const s = readAds()
  delete s.filled.unity
  console.log('[ads] Unity Ads key saved')
  void syncAdsNow()
}

export function forgetUnity(): void {
  const cfg = readConfig()
  delete cfg.unity
  writeConfig(cfg)
  broadcast('app-store', { ads: true })
}

async function syncUnity(s: AdStore, log: string[]): Promise<void> {
  const cfg = readConfig().unity
  if (!cfg) return
  const to = daysAgo(0)
  const from = daysAgo(s.filled.unity ? RESTATE_DAYS : BACKFILL_DAYS)
  let total = 0
  // A week at a time, and a day at a time once Unity has timed out on a week:
  // its server abandons a request after 60 s, and four group-bys add up.
  let span = 7
  for (let start = from; start <= to;) {
    let end = start
    for (let i = 1; i < span && end < to; i++) end = nextDay(end)
    let table: Record<string, string>[]
    try {
      table = await unityFetch(cfg.orgId, cfg.apiKey, start, end)
    } catch (err) {
      if (err instanceof UnityTimeout && span > 1) { span = 1; continue }
      throw err
    }
    const rows = new Map<string, AdRow[]>()
    for (const r of table) {
      const date = (r['timestamp'] ?? '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const gameId = r['source_game_id'] || r['game'] || ''
      const placement = r['placement'] || ''
      const row: AdRow = {
        n: 'unity', app: gameId, unit: placement ? `${gameId}/${placement}` : '',
        cc: (r['country'] ?? '').toUpperCase() || '??',
        fmt: '', plat: (r['platform'] ?? '').toLowerCase(),
        rev: num(r['revenue_sum']),
        imp: num(r['start_count']),
        clk: 0,
        req: num(r['adrequest_count']),
        mat: num(r['available_sum']),
      }
      if (!row.rev && !row.imp && !row.req) continue
      if (gameId) {
        const known = s.apps[`unity:${gameId}`]
        const name = r['source_name'] || known?.name || gameId
        s.apps[`unity:${gameId}`] = { network: 'unity', id: gameId, name, platform: row.plat || known?.platform || '', storeId: known?.storeId ?? '' }
      }
      if (row.unit) s.units[`unity:${row.unit}`] = { network: 'unity', id: row.unit, name: placement, format: '', app: gameId }
      const list = rows.get(date) ?? []
      list.push(row)
      rows.set(date, list)
      total++
    }
    replaceRange(s, 'unity', start, end, rows)
    if (end >= to) break
    start = nextDay(end)
  }
  s.currency.unity = 'USD'
  s.filled.unity = true
  log.push(`Unity Ads ${from} to ${to}: ${total} rows`)
}

// ── The sync ─────────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function adsConfigured(): boolean {
  const c = readConfig()
  return !!(c.admob || c.unity)
}

export function adsSyncing(): boolean { return inFlight !== null }

/** Read both networks now, or join the read already running. One failing does not stop the other. */
export function syncAdsNow(): Promise<void> {
  if (!inFlight) inFlight = run().finally(() => { inFlight = null })
  return inFlight
}

async function run(): Promise<void> {
  if (!adsConfigured()) return
  await refreshFx()
  const s = readAds()
  const jobs: [Network, (s: AdStore, log: string[]) => Promise<void>][] = [['admob', syncAdmob], ['unity', syncUnity]]
  const cfg = readConfig()
  for (const [network, job] of jobs) {
    if (!cfg[network]) continue
    const log: string[] = []
    try {
      await job(s, log)
      s.lastRun[network] = { at: new Date().toISOString(), ok: true, detail: log.join(' · ') }
      console.log(`[ads] ${log.join(' · ')}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      s.lastRun[network] = { at: new Date().toISOString(), ok: false, detail: msg }
      console.warn(`[ads] ${network} read failed: ${msg}`)
    }
  }
  writeAds(s)
  broadcast('app-store', { ads: true })
}

export function startAdsSync(): void {
  if (timer) return
  setTimeout(() => { void syncAdsNow() }, FIRST_SYNC_DELAY_MS)
  timer = setInterval(() => { void syncAdsNow() }, SYNC_EVERY_MS)
}

// ── For Settings ─────────────────────────────────────────────────────────────

export interface AdsStatus {
  syncing: boolean
  /** Whether a Google app exists to sign in with, and whose it is. */
  googleApp: 'ads' | 'mail' | null
  admob: { connected: boolean; publisherId: string; currency: string; lastRun: RunNote | null }
  unity: { connected: boolean; orgId: string; keyTail: string; lastRun: RunNote | null }
}

export function adsStatus(): AdsStatus {
  const cfg = readConfig()
  const s = readAds()
  return {
    syncing: adsSyncing(),
    googleApp: googleApp()?.from ?? null,
    admob: { connected: !!cfg.admob, publisherId: cfg.admob?.publisherId ?? '', currency: cfg.admob?.currency ?? 'USD', lastRun: s.lastRun.admob ?? null },
    unity: { connected: !!cfg.unity, orgId: cfg.unity?.orgId ?? '', keyTail: cfg.unity ? cfg.unity.apiKey.slice(-4) : '', lastRun: s.lastRun.unity ?? null },
  }
}
