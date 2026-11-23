// What the Apple Ads campaigns cost and what they bought: spend, impressions,
// taps and installs, per campaign, per country and per keyword, beside the App
// Store's own numbers and the ad networks' earnings in the Apps corner.
//
// AdMob and Unity (ads.ts) are money coming IN from ads shown inside the apps;
// this is money going OUT on ads for the apps, on the App Store itself. Kept in
// a file of its own for that reason — its rows have spend and installs where
// theirs have revenue and fill rate — but read on the same hourly beat, stored
// the same way and folded into the same report (app-report.ts).
//
// THE API is the Apple Ads Platform API (api.ads.apple.com/v1), not the older
// Campaign Management API v5 at api.searchads.apple.com, which Apple has
// deprecated and sunsets on 26 January 2027 — building on it would mean
// building this twice. Auth is the same in both: OAuth client credentials,
// where the client secret is an ES256 JWT this server signs with a private key
// whose PUBLIC half was uploaded in Apple Ads (Account Settings → API). Apple
// shows a client id, a team id and a key id for it; those three plus the key
// are everything kept. The key pair is made HERE on request (`newAppleAdsKey`)
// so nobody has to run openssl to connect a kiosk; a key made elsewhere can be
// pasted instead.
//
// WHAT IS READ: the campaign report by day and country (`countryOrRegion`), and
// for each campaign that spent anything, its keyword report by day. Apple says
// DAILY covers at most 90 days a request, so the first read walks 180 days in
// 30-day steps; every later read restates the last RESTATE_DAYS, because
// installs are attributed to the day of the tap and keep arriving for days.
// Days are in the ad account's own time zone (ORTZ), so the figures match the
// Apple Ads screens to the cent.
//
// THE JOIN to an app is the campaign's promoted object, which is the App Store
// app's Apple id — the same id app-store.ts keys apps by — so no name matching
// is needed.
//
// Secrets stay on the volume (`apple-ads.json`, 0600); the browser sees ids only.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import axios from 'axios'
import { broadcast } from './routes/system'
import { refreshFx } from './fx'

const API       = (process.env['APPLE_ADS_API'] ?? '').trim().replace(/\/$/, '') || 'https://api.ads.apple.com'
const TOKEN_URL = (process.env['APPLE_ADS_TOKEN_URL'] ?? '').trim() || 'https://appleid.apple.com/auth/oauth2/token'

const CONFIG_FILE = 'apple-ads.json'
const STATS_FILE  = 'apple-ads-stats.json'
const BACKFILL_DAYS = 180
const RESTATE_DAYS  = 7
/** Apple allows 90 days a DAILY request; a smaller step keeps each answer small. */
const STEP_DAYS = 30
const PAGE_SIZE = 1000
const SYNC_EVERY_MS = 60 * 60_000
const FIRST_SYNC_DELAY_MS = 50_000
const KEEP_DAYS = 800

function cacheDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Configuration ────────────────────────────────────────────────────────────

interface AppleAdsConfig {
  /** The private key, PEM. Present as soon as one is made, before the rest is filled in. */
  privateKey?: string
  /** When the key was made here (and so its public half is worth showing again). */
  keyMadeAt?:  string
  clientId?:   string
  teamId?:     string
  keyId?:      string
  /** The ad account read; an API user may see several. */
  adAccountId?:   string
  adAccountName?: string
  currency?:      string
  timezone?:      string
  /** Every account the key can see, for the picker. */
  accounts?:      { id: string; name: string }[]
  addedAt?:       string
}

function readConfig(): AppleAdsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), CONFIG_FILE), 'utf8')) as AppleAdsConfig
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeConfig(next: AppleAdsConfig): void {
  const p = path.join(cacheDir(), CONFIG_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, p)
  fs.chmodSync(p, 0o600)
}

const connected = (c: AppleAdsConfig) => !!(c.privateKey && c.clientId && c.teamId && c.keyId && c.adAccountId)

export function appleAdsConfigured(): boolean { return connected(readConfig()) }

function publicKeyOf(pem: string): string {
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()
}

/** A pasted key as PEM, whichever way it arrived (SEC1 from openssl, or PKCS#8). */
function normaliseKey(text: string): string {
  const t = text.trim()
  if (!t) return ''
  let key: crypto.KeyObject
  try {
    key = crypto.createPrivateKey(t)
  } catch {
    throw new Error('That is not a valid private key. Paste the whole file, from the BEGIN line to the END line.')
  }
  const curve = (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve
  if (key.asymmetricKeyType !== 'ec' || (curve && curve !== 'prime256v1')) {
    throw new Error('Apple Ads needs an EC P-256 key (openssl ecparam -genkey -name prime256v1). That one is a different kind.')
  }
  return key.export({ type: 'pkcs8', format: 'pem' }).toString()
}

/**
 * Make the key pair here and keep the private half. Returns the public half,
 * which is what gets pasted into Apple Ads. Making a new one while connected
 * disconnects: the old public key on Apple's side no longer matches.
 */
export function newAppleAdsKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const cfg = readConfig()
  writeConfig({ privateKey: pem, keyMadeAt: new Date().toISOString(), clientId: cfg.clientId, teamId: cfg.teamId, keyId: undefined })
  token = null
  broadcast('app-store', { ads: true })
  return publicKeyOf(pem)
}

// ── Tokens ───────────────────────────────────────────────────────────────────

let token: { value: string; until: number; fingerprint: string } | null = null

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/** The client secret: an ES256 JWT, good for (just under) the 180 days Apple allows. */
function clientSecret(c: Required<Pick<AppleAdsConfig, 'privateKey' | 'clientId' | 'teamId' | 'keyId'>>): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: c.keyId }))
  const payload = b64url(JSON.stringify({ sub: c.clientId, iss: c.teamId, aud: 'https://appleid.apple.com', iat: now, exp: now + 179 * 86_400 }))
  // JWT wants the raw r‖s pair, not the DER envelope sign() writes by default.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: c.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${b64url(sig)}`
}

async function accessToken(c: AppleAdsConfig): Promise<string> {
  if (!c.privateKey || !c.clientId || !c.teamId || !c.keyId) throw new Error('Apple Ads is not connected')
  const fingerprint = `${c.clientId}|${c.teamId}|${c.keyId}|${crypto.createHash('sha256').update(c.privateKey).digest('hex')}`
  if (token && token.fingerprint === fingerprint && token.until > Date.now()) return token.value
  const res = await axios.post<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(TOKEN_URL,
    new URLSearchParams({
      grant_type: 'client_credentials', client_id: c.clientId, scope: 'searchadsorg',
      client_secret: clientSecret({ privateKey: c.privateKey, clientId: c.clientId, teamId: c.teamId, keyId: c.keyId }),
    }).toString(),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 20_000 })
  if (res.status !== 200 || !res.data?.access_token) {
    const why = res.data?.error === 'invalid_client'
      ? 'Apple did not accept the client id, team id and key id with this key. Check all three were copied from the same API key in Apple Ads (Account Settings → API), and that the public key shown here is the one uploaded there.'
      : res.data?.error_description || res.data?.error || `HTTP ${res.status}`
    throw new Error(`Apple Ads sign-in failed: ${why}`)
  }
  token = { value: res.data.access_token, until: Date.now() + Math.max(60, (res.data.expires_in ?? 3600) - 300) * 1000, fingerprint }
  return token.value
}

async function call<T>(c: AppleAdsConfig, method: 'GET' | 'POST', route: string, body?: unknown, account = true): Promise<T> {
  const bearer = await accessToken(c)
  const res = await axios.request<T & { error?: { errors?: { message?: string; messageCode?: string }[] } | string }>({
    method, url: `${API}${route}`, data: body,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(account && c.adAccountId ? { 'X-AP-Context': `adAccountId=${c.adAccountId}` } : {}),
    },
    validateStatus: () => true, timeout: 90_000, maxContentLength: 128 * 1024 * 1024,
  })
  if (res.status === 401) { token = null; throw new Error('Apple Ads refused the sign-in (401). The API key may have been revoked in Apple Ads.') }
  if (res.status === 403) throw new Error('This Apple Ads user may not read that account (403). Give the API user a role on it in Apple Ads → Account Settings → User Management.')
  if (res.status === 429) throw new Error('Apple Ads says too many requests (429); the next read will try again.')
  if (res.status < 200 || res.status >= 300) {
    const e = res.data?.error
    const why = typeof e === 'string' ? e : e?.errors?.map(x => x.message ?? x.messageCode).filter(Boolean).join('; ')
    throw new Error(`Apple Ads: ${why || `HTTP ${res.status}`}`)
  }
  return res.data
}

interface Acl { adAccount?: { id?: number | string; name?: string; orgId?: number | string }; roles?: string[] }

/**
 * Save the three ids (and a pasted key, if one is given instead of the one
 * made here) after proving them: a token, the accounts the user may see, and
 * the chosen account's currency and time zone.
 */
export async function setAppleAdsConfig(input: { clientId: string; teamId: string; keyId: string; privateKey?: string; adAccountId?: string }): Promise<void> {
  const cur = readConfig()
  const privateKey = input.privateKey?.trim() ? normaliseKey(input.privateKey) : cur.privateKey
  const next: AppleAdsConfig = {
    ...cur,
    privateKey,
    clientId: input.clientId.trim() || cur.clientId,
    teamId: input.teamId.trim() || cur.teamId,
    keyId: input.keyId.trim() || cur.keyId,
  }
  if (!next.privateKey) throw new Error('There is no key yet. Press “Make a key” first, or paste one you made.')
  if (!next.clientId || !/^SEARCHADS\./i.test(next.clientId)) throw new Error('The client ID starts with SEARCHADS. — copy it from Apple Ads → Account Settings → API.')
  if (!next.teamId || !/^SEARCHADS\./i.test(next.teamId)) throw new Error('The team ID starts with SEARCHADS. — copy it from the same place.')
  if (!next.keyId) throw new Error('The key ID is missing.')
  token = null
  const acls = await call<{ result?: { acls?: Acl[] } }>(next, 'GET', '/v1/acls', undefined, false)
  const accounts = (acls.result?.acls ?? [])
    .filter(a => a.adAccount?.id !== undefined)
    .map(a => ({ id: String(a.adAccount!.id), name: a.adAccount!.name ?? String(a.adAccount!.id) }))
  if (accounts.length === 0) throw new Error('Signed in, but this API user has no ad account. Give it a role on one in Apple Ads → Account Settings → User Management.')
  const want = (input.adAccountId ?? '').trim() || cur.adAccountId
  const pick = accounts.find(a => a.id === want) ?? accounts[0]!
  next.adAccountId = pick.id
  next.adAccountName = pick.name
  next.accounts = accounts
  try {
    const acct = await call<{ result?: { currency?: string; timezone?: string; timeZone?: string } }>(next, 'GET', `/v1/ad-accounts/${encodeURIComponent(pick.id)}`)
    next.currency = acct.result?.currency || 'USD'
    next.timezone = acct.result?.timezone || acct.result?.timeZone || ''
  } catch {
    next.currency = next.currency || 'USD'
  }
  const accountChanged = cur.adAccountId !== next.adAccountId
  next.addedAt = new Date().toISOString()
  writeConfig(next)
  if (accountChanged) { const s = readAppleAds(); s.days = {}; s.kwDays = {}; s.campaigns = {}; s.keywords = {}; delete s.filled; writeAppleAds(s) }
  console.log(`[apple-ads] connected to ${pick.name} (${pick.id})`)
  void syncAppleAdsNow()
}

export function forgetAppleAds(): void {
  writeConfig({})
  token = null
  broadcast('app-store', { ads: true })
}

// ── The store ────────────────────────────────────────────────────────────────

/** One campaign in one country on one day. Spend in the account currency. */
export interface AsRow {
  c:   string
  app: string
  cc:  string
  sp:  number
  im:  number
  tp:  number
  /** Total installs (tap-through and view-through). */
  in:  number
  nd:  number
  rd:  number
}

/** One keyword on one day, every country together. */
export interface AsKwRow { c: string; k: string; sp: number; im: number; tp: number; in: number }

export interface AsCampaign { id: string; name: string; app: string; appName: string; status: string }
export interface AsKeyword  { id: string; text: string; matchType: string; campaign: string; adGroup: string }
interface RunNote { at: string; ok: boolean; detail: string }

export interface AppleAdsStore {
  campaigns: Record<string, AsCampaign>
  keywords:  Record<string, AsKeyword>
  days:      Record<string, AsRow[]>
  kwDays:    Record<string, AsKwRow[]>
  currency:  string
  filled?:   boolean
  lastRun?:  RunNote
}

function blank(): AppleAdsStore {
  return { campaigns: {}, keywords: {}, days: {}, kwDays: {}, currency: 'USD' }
}

let cache: { dir: string; store: AppleAdsStore } | null = null

export function readAppleAds(): AppleAdsStore {
  if (cache && cache.dir === cacheDir()) return cache.store
  let store = blank()
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), STATS_FILE), 'utf8')) as Partial<AppleAdsStore>
    store = { ...blank(), ...raw }
  } catch { /* nothing read yet */ }
  cache = { dir: cacheDir(), store }
  return store
}

function writeAppleAds(s: AppleAdsStore): void {
  cache = { dir: cacheDir(), store: s }
  for (const key of ['days', 'kwDays'] as const) {
    const dates = Object.keys(s[key]).sort()
    for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete s[key][d]
  }
  const p = path.join(cacheDir(), STATS_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[apple-ads] failed to save:', err)
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
  if (v && typeof v === 'object' && 'amount' in (v as Record<string, unknown>)) return num((v as { amount: unknown }).amount)
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

// ── Reading ──────────────────────────────────────────────────────────────────

type Metrics = Record<string, unknown> & { date?: string; countryOrRegion?: string }
interface ReportRow { metadata?: Record<string, unknown>; granularMetrics?: Metrics[] }
interface ReportAnswer { result?: { rows?: ReportRow[] }; pagination?: { totalCount?: number; offset?: number; pageSize?: number } }

/** Every row of one report query, page by page. */
async function query(c: AppleAdsConfig, route: string, body: Record<string, unknown>): Promise<ReportRow[]> {
  const out: ReportRow[] = []
  // Advanced by what came back, not by what was asked for: Apple may answer
  // with a smaller page than requested, and `totalCount` is the only end marker.
  for (let offset = 0, i = 0; i < 200; i++) {
    const page = await call<ReportAnswer>(c, 'POST', route, { ...body, pagination: { offset, pageSize: PAGE_SIZE } })
    const rows = page.result?.rows ?? []
    out.push(...rows)
    offset += rows.length
    const total = page.pagination?.totalCount ?? 0
    if (rows.length === 0 || offset >= total) break
  }
  return out
}

/** Installs, whichever way this version of the API names them. */
const installs = (m: Metrics) => num(m['totalInstalls'] ?? m['installs'] ?? (num(m['tapInstalls']) + num(m['viewInstalls'])))
const newDownloads = (m: Metrics) => num(m['totalNewDownloads'] ?? m['newDownloads'] ?? m['tapNewDownloads'])
const redownloads = (m: Metrics) => num(m['totalRedownloads'] ?? m['redownloads'] ?? m['tapRedownloads'])

async function syncAppleAds(s: AppleAdsStore, log: string[]): Promise<void> {
  const cfg = readConfig()
  const to = daysAgo(0)
  const from = daysAgo(s.filled ? RESTATE_DAYS : BACKFILL_DAYS)
  let rowsRead = 0, kwRead = 0
  for (let start = from; start <= to;) {
    let end = start
    for (let i = 1; i < STEP_DAYS && end < to; i++) end = nextDay(end)
    const timeRange = { start, end, timeZone: 'ORTZ', granularity: 'DAILY' }
    const campaigns = await query(cfg, '/v1/reports/apps/campaigns/query', { timeRange, groupBy: ['countryOrRegion'] })
    const byDate = new Map<string, AsRow[]>()
    const spent = new Set<string>()
    for (const r of campaigns) {
      const md = r.metadata ?? {}
      const id = String(md['id'] ?? md['campaignId'] ?? '')
      if (!id) continue
      const promoted = (md['promotedObject'] ?? {}) as { name?: string; id?: unknown }
      const app = String(md['promotedObjectId'] ?? promoted.id ?? md['adamId'] ?? '')
      s.campaigns[id] = {
        id, name: String(md['name'] ?? md['campaignName'] ?? id), app,
        appName: String(promoted.name ?? (md['app'] as { appName?: string } | undefined)?.appName ?? s.campaigns[id]?.appName ?? ''),
        status: String(md['displayStatus'] ?? md['status'] ?? ''),
      }
      for (const m of r.granularMetrics ?? []) {
        const date = String(m.date ?? '').slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
        const row: AsRow = {
          c: id, app,
          cc: String(m.countryOrRegion ?? md['countryOrRegion'] ?? '').toUpperCase() || '??',
          sp: num(m['localSpend']), im: num(m['impressions']), tp: num(m['taps']),
          in: installs(m), nd: newDownloads(m), rd: redownloads(m),
        }
        if (!row.sp && !row.im && !row.tp && !row.in) continue
        if (row.sp > 0 || row.tp > 0) spent.add(id)
        const list = byDate.get(date) ?? []
        list.push(row)
        byDate.set(date, list)
        rowsRead++
      }
    }
    // Keywords: one query per campaign that did anything in this stretch. A
    // Search Match–only campaign has none, and answers with an empty list.
    const kwByDate = new Map<string, AsKwRow[]>()
    for (const campaignId of spent) {
      let kws: ReportRow[]
      try {
        kws = await query(cfg, '/v1/reports/apps/keywords/query', {
          timeRange, filters: [{ field: 'campaignId', operator: 'EQUALS', value: campaignId }],
        })
      } catch (err) {
        // Keywords are a breakdown, not the figures: one failing costs that table only.
        log.push(`keywords for ${s.campaigns[campaignId]?.name ?? campaignId} failed (${err instanceof Error ? err.message : String(err)})`)
        continue
      }
      for (const r of kws) {
        const md = r.metadata ?? {}
        const kid = String(md['id'] ?? md['keywordId'] ?? '')
        if (!kid) continue
        s.keywords[kid] = {
          id: kid, text: String(md['text'] ?? md['keyword'] ?? kid), matchType: String(md['matchType'] ?? ''),
          campaign: campaignId, adGroup: String(md['adGroupId'] ?? ''),
        }
        for (const m of r.granularMetrics ?? []) {
          const date = String(m.date ?? '').slice(0, 10)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
          const row: AsKwRow = { c: campaignId, k: kid, sp: num(m['localSpend']), im: num(m['impressions']), tp: num(m['taps']), in: installs(m) }
          if (!row.sp && !row.im && !row.tp && !row.in) continue
          const list = kwByDate.get(date) ?? []
          list.push(row)
          kwByDate.set(date, list)
          kwRead++
        }
      }
    }
    for (let d = start; d <= end; d = nextDay(d)) {
      const rows = byDate.get(d)
      if (rows?.length) s.days[d] = rows; else delete s.days[d]
      const kw = kwByDate.get(d)
      if (kw?.length) s.kwDays[d] = kw; else delete s.kwDays[d]
    }
    if (end >= to) break
    start = nextDay(end)
  }
  s.currency = cfg.currency || 'USD'
  s.filled = true
  log.unshift(`Apple Ads ${from} to ${to}: ${rowsRead} rows, ${kwRead} keyword rows`)
}

// ── The sync ─────────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function appleAdsSyncing(): boolean { return inFlight !== null }

export function syncAppleAdsNow(): Promise<void> {
  if (!inFlight) inFlight = run().finally(() => { inFlight = null })
  return inFlight
}

async function run(): Promise<void> {
  if (!appleAdsConfigured()) return
  await refreshFx()
  const s = readAppleAds()
  const log: string[] = []
  try {
    await syncAppleAds(s, log)
    s.lastRun = { at: new Date().toISOString(), ok: true, detail: log.join(' · ') }
    console.log(`[apple-ads] ${log.join(' · ')}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    s.lastRun = { at: new Date().toISOString(), ok: false, detail: msg }
    console.warn(`[apple-ads] read failed: ${msg}`)
  }
  writeAppleAds(s)
  broadcast('app-store', { ads: true })
}

export function startAppleAdsSync(): void {
  if (timer) return
  setTimeout(() => { void syncAppleAdsNow() }, FIRST_SYNC_DELAY_MS)
  timer = setInterval(() => { void syncAppleAdsNow() }, SYNC_EVERY_MS)
}

// ── For Settings ─────────────────────────────────────────────────────────────

export interface AppleAdsStatus {
  connected:   boolean
  syncing:     boolean
  /** The public half of a key that exists, to paste into Apple Ads. Empty with no key. */
  publicKey:   string
  /** Whether that key was made here (rather than pasted). */
  keyMadeHere: boolean
  clientId:    string
  teamId:      string
  keyId:       string
  adAccountId:   string
  adAccountName: string
  accounts:    { id: string; name: string }[]
  currency:    string
  lastRun:     RunNote | null
}

export function appleAdsStatus(): AppleAdsStatus {
  const c = readConfig()
  let publicKey = ''
  try { if (c.privateKey) publicKey = publicKeyOf(c.privateKey) } catch { /* a broken file: no key */ }
  return {
    connected: connected(c),
    syncing: appleAdsSyncing(),
    publicKey,
    keyMadeHere: !!c.keyMadeAt,
    clientId: c.clientId ?? '', teamId: c.teamId ?? '', keyId: c.keyId ?? '',
    adAccountId: c.adAccountId ?? '', adAccountName: c.adAccountName ?? '',
    accounts: c.accounts ?? [],
    currency: c.currency ?? 'USD',
    lastRun: readAppleAds().lastRun ?? null,
  }
}
