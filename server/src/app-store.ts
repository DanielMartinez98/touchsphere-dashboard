// App Store Connect: how the user's own apps are doing — downloads, what they
// earned, how often they were seen — for Settings → Apps and the assistant.
//
// TWO FEEDS, because Apple keeps them apart. SALES AND TRENDS is the ledger:
// one gzipped TSV per day with a row per (app, product type, country, device),
// carrying units and the proceeds per unit in the payout currency — the numbers
// Apple pays on. ANALYTICS REPORTS is the newer App Analytics export: a
// standing request per app makes Apple write a file a day, and the "App Store
// Discovery and Engagement" report carries impressions and product page views,
// which the ledger cannot know. Both come through the official API with a key
// the user generates once (Users and Access → Integrations → App Store Connect
// API), so nothing here ever signs in with an Apple ID or a password.
//
// THE KEY STAYS ON THE VOLUME. `app-store.json` holds the .p8 with the issuer,
// key and vendor ids at mode 0600 — the mail.ts rule for the Gmail secret — and
// the browser only ever sees the key id. Tokens are ES256 JWTs minted here with
// Node's own crypto (no library) and reused for their 20-minute life.
//
// THE DASHBOARD KEEPS ITS OWN HISTORY. Apple deletes a daily sales report a year
// after it appears, so every day fetched is folded into `app-store-stats.json`
// and never asked for again: the first run backfills BACKFILL_DAYS, later runs
// fill only the gap since the last one. Analytics instances are processed once
// each (`seen`), oldest first, and a later instance restating a date OVERWRITES
// that date's analytics fields — Apple completes a day's counts over about
// three days, and adding would count a day twice.
//
// Nothing is live: a sales day is published the next morning Pacific time and
// impressions run up to three days behind, so this is a daily scoreboard, not
// a ticker. The sync runs hourly, enough to catch each day's file the hour it
// lands, and one run at a time.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import axios from 'axios'
import { broadcast } from './routes/system'

const API = 'https://api.appstoreconnect.apple.com'
const CONFIG_FILE = 'app-store.json'
const STATS_FILE  = 'app-store-stats.json'
/** How far back the first run reads daily sales reports. Apple keeps a year; a card needs a season. */
const BACKFILL_DAYS = 90
const SYNC_EVERY_MS = 60 * 60_000
const FIRST_SYNC_DELAY_MS = 20_000
/** Analytics files processed per run — a standing request left for months has one waiting per day. */
const MAX_INSTANCES_PER_RUN = 40
const SERIES_DAYS = 30
const SEEN_CAP = 5000
/** Apple's reporting day is Pacific time: "yesterday" is yesterday in Cupertino. */
const PT = 'America/Los_Angeles'

function cacheDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface AppStoreConfig {
  issuerId:     string
  keyId:        string
  vendorNumber: string
  /** The .p8 file's contents, PEM. */
  privateKey:   string
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

function readStoredConfig(): AppStoreConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), CONFIG_FILE), 'utf8')) as Partial<AppStoreConfig>
    return { issuerId: str(raw.issuerId), keyId: str(raw.keyId), vendorNumber: str(raw.vendorNumber), privateKey: str(raw.privateKey) }
  } catch {
    return { issuerId: '', keyId: '', vendorNumber: '', privateKey: '' }
  }
}

/**
 * What is saved in Settings, each field falling back to the environment
 * (ASC_ISSUER_ID, ASC_KEY_ID, ASC_VENDOR_NUMBER, ASC_PRIVATE_KEY_FILE or
 * ASC_PRIVATE_KEY) for a box set up without a screen.
 */
export function readConfig(): AppStoreConfig {
  const stored = readStoredConfig()
  const env = (k: string) => (process.env[k] ?? '').trim()
  let key = stored.privateKey
  if (!key) {
    const file = env('ASC_PRIVATE_KEY_FILE')
    if (file) { try { key = fs.readFileSync(file, 'utf8') } catch { key = '' } }
    if (!key) key = normalisePrivateKey(env('ASC_PRIVATE_KEY').replace(/\\n/g, '\n'))
  }
  return {
    issuerId:     stored.issuerId     || env('ASC_ISSUER_ID'),
    keyId:        stored.keyId        || env('ASC_KEY_ID'),
    vendorNumber: stored.vendorNumber || env('ASC_VENDOR_NUMBER'),
    privateKey:   key,
  }
}

function complete(c: AppStoreConfig): boolean {
  return !!(c.issuerId && c.keyId && c.vendorNumber && c.privateKey)
}

export function appStoreConfigured(): boolean { return complete(readConfig()) }

/** Where the configuration in effect comes from, for the tab to say. */
export function configSource(): 'settings' | 'env' | 'none' {
  if (complete(readStoredConfig())) return 'settings'
  return complete(readConfig()) ? 'env' : 'none'
}

function writeConfig(next: AppStoreConfig): void {
  const p = path.join(cacheDir(), CONFIG_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    // 0600 before anything is in it: the key signs for the whole account.
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, p)
    fs.chmodSync(p, 0o600)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    throw err
  }
}

/**
 * A pasted .p8 as PEM, whichever way it arrived: the file as is, the base64
 * body alone, or the PEM with its line breaks flattened by a text field.
 */
export function normalisePrivateKey(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const body = t.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return t
  const lines = body.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

/** Throws a sentence when the text is not the kind of key App Store Connect issues (EC P-256, PKCS#8). */
export function checkPrivateKey(pem: string): void {
  let key: crypto.KeyObject
  try {
    key = crypto.createPrivateKey(pem)
  } catch {
    throw new Error('That is not a valid private key. Paste the whole AuthKey_XXXXXXXXXX.p8 file, BEGIN line to END line.')
  }
  const curve = (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve
  if (key.asymmetricKeyType !== 'ec' || (curve && curve !== 'prime256v1')) {
    throw new Error('That key is not the kind App Store Connect issues (an EC P-256 key). Download the .p8 from Users and Access → Integrations.')
  }
}

// ── Tokens ───────────────────────────────────────────────────────────────────

let cachedToken: { token: string; exp: number; fingerprint: string } | null = null

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

/**
 * A bearer token for the key: an ES256 JWT with the issuer id, minted here and
 * reused until a minute before it expires. Apple caps a token at 20 minutes.
 */
export function bearerToken(cfg: AppStoreConfig): string {
  const now = Math.floor(Date.now() / 1000)
  const fingerprint = `${cfg.issuerId}|${cfg.keyId}|${crypto.createHash('sha256').update(cfg.privateKey).digest('hex')}`
  if (cachedToken && cachedToken.fingerprint === fingerprint && cachedToken.exp - now > 60) return cachedToken.token
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }))
  const exp     = now + 19 * 60
  const payload = b64url(JSON.stringify({ iss: cfg.issuerId, iat: now, exp, aud: 'appstoreconnect-v1' }))
  // JWT wants the raw r‖s pair, not the DER envelope sign() writes by default.
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' })
  const token = `${header}.${payload}.${b64url(signature)}`
  cachedToken = { token, exp, fingerprint }
  return token
}

// ── The API ──────────────────────────────────────────────────────────────────

interface AscResponse { status: number; type: string; body: Buffer }

interface Resource { type: string; id: string; attributes?: Record<string, unknown> }
interface Listing { data?: Resource | Resource[]; links?: { next?: string }; errors?: { status?: string; code?: string; title?: string; detail?: string }[] }

async function asc(
  cfg: AppStoreConfig, method: 'GET' | 'POST', route: string,
  opts: { params?: Record<string, string>; json?: unknown } = {},
): Promise<AscResponse> {
  const res = await axios.request<ArrayBuffer>({
    method,
    url: route.startsWith('http') ? route : `${API}${route}`,
    params: opts.params,
    data: opts.json,
    headers: {
      Authorization: `Bearer ${bearerToken(cfg)}`,
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    responseType: 'arraybuffer',
    validateStatus: () => true,
    timeout: 60_000,
    maxContentLength: 256 * 1024 * 1024,
  })
  return { status: res.status, type: String(res.headers['content-type'] ?? ''), body: Buffer.from(res.data) }
}

function jsonOf(r: AscResponse): Listing {
  try { return JSON.parse(r.body.toString('utf8')) as Listing } catch { return {} }
}

/** Apple's error as a sentence: its `detail` when it has one, else the title, else the status. */
function errorOf(r: AscResponse): string {
  const e = jsonOf(r).errors?.[0]
  const why = e?.detail || e?.title || e?.code
  if (r.status === 401) return `Apple refused the key (401${why ? `: ${why}` : ''}). Check the issuer id, the key id and that the key was not revoked.`
  if (r.status === 403) return `Apple says this key may not read that (403${why ? `: ${why}` : ''}). The key needs the Admin role for reports.`
  return why ? `${why} (HTTP ${r.status})` : `HTTP ${r.status} from App Store Connect`
}

/** Every page of a listing, following `links.next` (an absolute URL) up to a sane number of pages. */
async function listAll(cfg: AppStoreConfig, route: string, params?: Record<string, string>): Promise<Resource[]> {
  const out: Resource[] = []
  let next: string | undefined = route
  let query = params
  for (let page = 0; next && page < 25; page++) {
    const r = await asc(cfg, 'GET', next, { params: query })
    if (r.status !== 200) throw new Error(`${route}: ${errorOf(r)}`)
    const j = jsonOf(r)
    if (Array.isArray(j.data)) out.push(...j.data)
    next = j.links?.next
    query = undefined
  }
  return out
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ── Apps ─────────────────────────────────────────────────────────────────────

export interface AppInfo { id: string; name: string; sku: string; bundleId: string }

export async function listApps(cfg: AppStoreConfig): Promise<AppInfo[]> {
  const rows = await listAll(cfg, '/v1/apps', { 'fields[apps]': 'name,bundleId,sku', limit: '200' })
  return rows.map(r => ({
    id: r.id, name: str(r.attributes?.['name']), sku: str(r.attributes?.['sku']), bundleId: str(r.attributes?.['bundleId']),
  }))
}

// ── Report files ─────────────────────────────────────────────────────────────

/** Sales reports arrive gzipped; analytics segments usually do too. Either way, text. */
function inflate(buf: Buffer): string {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8')
  return buf.toString('utf8')
}

function splitLine(line: string, sep: string): string[] {
  if (sep === '\t' || !line.includes('"')) return line.split(sep)
  // A quoted CSV field can hold the separator and doubled quotes.
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * A report file as rows keyed by their lower-cased column name. Tab-separated
 * (the sales ledger) or comma-separated (some analytics files) by the header.
 */
export function parseTable(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)
  if (lines.length < 2) return []
  const sep = lines[0]!.includes('\t') ? '\t' : ','
  const header = splitLine(lines[0]!, sep).map(h => h.trim().toLowerCase())
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, sep)
    // Apple's older ledgers ended with a "Total_Rows" line; anything short of the header is not a row.
    if (cells.length < header.length - 1) continue
    const row: Record<string, string> = {}
    header.forEach((h, i) => { row[h] = (cells[i] ?? '').trim() })
    rows.push(row)
  }
  return rows
}

function num(s: string | undefined): number {
  const n = parseFloat((s ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A ledger row's date, as YYYY-MM-DD, whichever way the file wrote it. */
function isoDate(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)          // MM/DD/YYYY, the ledger's Begin Date
  if (m) return `${m[3]}-${m[1]}-${m[2]}`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

// ── Sales and Trends ─────────────────────────────────────────────────────────

/**
 * What a product type identifier means. The digit is the transaction (1 a
 * first download or purchase, 3 a redownload, 7 an update), the suffix the
 * platform (F universal, T iPad, none iPhone, a leading F the Mac), and IA…
 * is an in-app purchase or subscription. Anything else is left uncounted
 * rather than guessed.
 */
export function transactionKind(productType: string): 'download' | 'redownload' | 'update' | 'iap' | 'other' {
  const t = productType.trim().toUpperCase()
  if (t.startsWith('IA')) return 'iap'
  const core = t.replace(/^F/, '')
  const m = /^([137])(F|T|E|EP|EU|-B)?$/.exec(core)
  if (!m) return 'other'
  return m[1] === '1' ? 'download' : m[1] === '3' ? 'redownload' : 'update'
}

type SalesDay = { kind: 'rows'; rows: Record<string, string>[] } | { kind: 'none' } | { kind: 'not-yet' }

async function fetchSalesDay(cfg: AppStoreConfig, date: string): Promise<SalesDay> {
  const r = await asc(cfg, 'GET', '/v1/salesReports', { params: {
    'filter[frequency]':     'DAILY',
    'filter[reportType]':    'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]':  cfg.vendorNumber,
    'filter[reportDate]':    date,
  } })
  if (r.status === 200) return { kind: 'rows', rows: parseTable(inflate(r.body)) }
  const why = errorOf(r)
  // A day with nothing sold is a 404 with a sentence, not an empty file.
  if (/no sales/i.test(why)) return { kind: 'none' }
  if (/not available|not yet|not ready/i.test(why)) return { kind: 'not-yet' }
  throw new Error(`Sales report for ${date}: ${why}`)
}

// ── The store ────────────────────────────────────────────────────────────────

export interface DayStats {
  /** First-time downloads and purchases of the app itself (product type 1…). */
  downloads:   number
  redownloads: number
  updates:     number
  /** In-app purchase and subscription units. */
  iap:         number
  /** Units refunded (positive number). */
  refunds:     number
  /** What the day earned, by payout currency: units × proceeds per unit, refunds subtracted. */
  proceeds:    Record<string, number>
  /** First-time downloads by App Store country. */
  countries:   Record<string, number>
  // From App Analytics, absent until the first report file lands.
  impressions?: number
  pageViews?:   number
  taps?:        number
  sessions?:    number
  activeDevices?: number
  crashes?:     number
}

interface Stats {
  apps:      Record<string, AppInfo>
  /** appId → date → that day. A date absent under a fetched day is a day with nothing to report. */
  days:      Record<string, Record<string, DayStats>>
  /** date → 'ok' (a file was read) | 'none' (Apple said there were no sales). Never asked again. */
  salesDays: Record<string, 'ok' | 'none'>
  /** Per app: the analytics report requests this dashboard is reading, and when it asked for the history snapshot. */
  requests:  Record<string, { ongoing?: string; snapshot?: string; snapshotAt?: string }>
  /** Analytics instance ids already folded in. */
  seen:      string[]
  /** The header row last seen per report, so a column Apple renamed can be found in the log. */
  headers:   Record<string, string[]>
  lastRun:   { at: string; ok: boolean; detail: string; ms: number } | null
}

function blankStats(): Stats {
  return { apps: {}, days: {}, salesDays: {}, requests: {}, seen: [], headers: {}, lastRun: null }
}

function blankDay(): DayStats {
  return { downloads: 0, redownloads: 0, updates: 0, iap: 0, refunds: 0, proceeds: {}, countries: {} }
}

function statsPath(): string { return path.join(cacheDir(), STATS_FILE) }

function readStats(): Stats {
  try {
    const raw = JSON.parse(fs.readFileSync(statsPath(), 'utf8')) as Partial<Stats>
    const s = blankStats()
    if (raw.apps && typeof raw.apps === 'object') s.apps = raw.apps
    if (raw.days && typeof raw.days === 'object') s.days = raw.days
    if (raw.salesDays && typeof raw.salesDays === 'object') s.salesDays = raw.salesDays
    if (raw.requests && typeof raw.requests === 'object') s.requests = raw.requests
    if (Array.isArray(raw.seen)) s.seen = raw.seen.filter((x): x is string => typeof x === 'string')
    if (raw.headers && typeof raw.headers === 'object') s.headers = raw.headers
    if (raw.lastRun && typeof raw.lastRun === 'object') s.lastRun = raw.lastRun
    return s
  } catch {
    return blankStats()
  }
}

function writeStats(s: Stats): void {
  const p = statsPath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[app-store] failed to save stats:', err)
  }
}

function dayOf(s: Stats, appId: string, date: string): DayStats {
  const byApp = s.days[appId] ?? (s.days[appId] = {})
  return byApp[date] ?? (byApp[date] = blankDay())
}

/**
 * Fold one day's ledger in. In-app purchase rows name the app by its SKU in
 * `Parent Identifier`, not by Apple id, so the apps list is the join. The sales
 * fields are REPLACED for every app the file names, never added to — a day is
 * read once, but a re-read must not double it.
 */
export function applySales(s: Stats, date: string, rows: Record<string, string>[], skuToApp: Record<string, string>): void {
  const touched = new Map<string, DayStats>()
  for (const row of rows) {
    const own = row['apple identifier'] ?? ''
    const parentSku = row['parent identifier'] ?? ''
    const appId = (parentSku && skuToApp[parentSku]) || skuToApp[row['sku'] ?? ''] || own
    if (!appId) continue
    let d = touched.get(appId)
    if (!d) { d = blankDay(); touched.set(appId, d) }
    const units = num(row['units'])
    const perUnit = num(row['developer proceeds'])
    const currency = (row['currency of proceeds'] || 'USD').toUpperCase()
    const kind = transactionKind(row['product type identifier'] ?? '')
    if (units < 0) d.refunds += -units
    else if (kind === 'download') {
      d.downloads += units
      const cc = (row['country code'] ?? '').toUpperCase()
      if (cc) d.countries[cc] = (d.countries[cc] ?? 0) + units
    } else if (kind === 'redownload') d.redownloads += units
    else if (kind === 'update') d.updates += units
    else if (kind === 'iap') d.iap += units
    const money = units * perUnit
    if (money) d.proceeds[currency] = round2((d.proceeds[currency] ?? 0) + money)
    // An app the apps list does not have (removed, or sold under another team) still gets a name.
    if (!s.apps[appId] && !parentSku) s.apps[appId] = { id: appId, name: row['title'] || appId, sku: row['sku'] ?? '', bundleId: '' }
  }
  for (const [appId, d] of touched) {
    const stored = dayOf(s, appId, date)
    stored.downloads = d.downloads; stored.redownloads = d.redownloads; stored.updates = d.updates
    stored.iap = d.iap; stored.refunds = d.refunds; stored.proceeds = d.proceeds; stored.countries = d.countries
  }
}

// ── App Analytics ────────────────────────────────────────────────────────────

interface ReportSpec {
  name:   string
  /** The DayStats fields this report owns; a new file for a date replaces exactly these. */
  fields: (keyof DayStats)[]
  apply:  (d: DayStats, row: Record<string, string>) => void
}

const REPORTS: ReportSpec[] = [
  {
    // Impressions are the app seen in a list (search, charts, a tab); a page
    // view is its product page opened; a tap is either acted on.
    name: 'App Store Discovery and Engagement',
    fields: ['impressions', 'pageViews', 'taps'],
    apply: (d, row) => {
      const event = (row['event'] ?? '').toLowerCase()
      const n = num(row['counts'])
      if (event === 'impression') d.impressions = (d.impressions ?? 0) + n
      else if (event === 'page view') { if (/product/i.test(row['page type'] ?? '')) d.pageViews = (d.pageViews ?? 0) + n }
      else if (event === 'tap') d.taps = (d.taps ?? 0) + n
    },
  },
  {
    name: 'App Sessions',
    fields: ['sessions', 'activeDevices'],
    apply: (d, row) => {
      if ('sessions' in row) d.sessions = (d.sessions ?? 0) + num(row['sessions'])
      if ('unique devices' in row) d.activeDevices = (d.activeDevices ?? 0) + num(row['unique devices'])
    },
  },
  {
    name: 'App Crashes',
    fields: ['crashes'],
    apply: (d, row) => { if ('crashes' in row) d.crashes = (d.crashes ?? 0) + num(row['crashes']) },
  },
]

/** The Standard variant of a report — the Detailed one carries the same counts split finer. */
function wantedName(name: string, base: string): boolean {
  return name === base || name === `${base} Standard`
}

async function createRequest(cfg: AppStoreConfig, appId: string, accessType: 'ONGOING' | 'ONE_TIME_SNAPSHOT'): Promise<Resource> {
  const r = await asc(cfg, 'POST', '/v1/analyticsReportRequests', { json: {
    data: {
      type: 'analyticsReportRequests',
      attributes: { accessType },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  } })
  if (r.status !== 201 && r.status !== 200) throw new Error(`Could not ask Apple for ${accessType} analytics: ${errorOf(r)}`)
  const data = jsonOf(r).data
  if (!data || Array.isArray(data)) throw new Error('Apple answered the analytics request without a resource')
  return data
}

async function download(url: string): Promise<Buffer> {
  // A segment URL is pre-signed: no bearer token, and sending ours elsewhere would be wrong.
  const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: 512 * 1024 * 1024 })
  return Buffer.from(res.data)
}

function markSeen(s: Stats, id: string): void {
  s.seen.push(id)
  if (s.seen.length > SEEN_CAP) s.seen.splice(0, s.seen.length - SEEN_CAP)
}

/**
 * One app's analytics: make sure Apple is writing daily files for it (an
 * ONGOING request, re-made if Apple stopped it for inactivity, plus one
 * ONE_TIME_SNAPSHOT for the history), then fold in every daily instance of
 * the reports this dashboard reads that it has not folded in yet.
 */
async function syncAnalytics(cfg: AppStoreConfig, s: Stats, app: AppInfo, budget: { left: number }, log: string[]): Promise<void> {
  const attr = (r: Resource, k: string) => r.attributes?.[k]
  const requests = await listAll(cfg, `/v1/apps/${app.id}/analyticsReportRequests`, { limit: '200' })
  const mine = s.requests[app.id] ?? (s.requests[app.id] = {})

  let ongoing = requests.find(r => attr(r, 'accessType') === 'ONGOING' && attr(r, 'stoppedDueToInactivity') !== true)
  if (!ongoing) {
    ongoing = await createRequest(cfg, app.id, 'ONGOING')
    log.push(`asked Apple to start daily analytics for ${app.name}`)
  }
  mine.ongoing = ongoing.id

  let snapshot = requests.find(r => attr(r, 'accessType') === 'ONE_TIME_SNAPSHOT')
  if (!snapshot && !mine.snapshotAt) {
    mine.snapshotAt = new Date().toISOString()
    try {
      snapshot = await createRequest(cfg, app.id, 'ONE_TIME_SNAPSHOT')
      log.push(`asked Apple for the analytics history of ${app.name}`)
    } catch (err) {
      // The history is a nicety; the daily files are the feature. Asked once, not every hour.
      console.warn(`[app-store] history snapshot for ${app.name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (snapshot) mine.snapshot = snapshot.id

  const seen = new Set(s.seen)
  for (const req of [snapshot, ongoing]) {
    if (!req) continue
    const reports = await listAll(cfg, `/v1/analyticsReportRequests/${req.id}/reports`, { limit: '200' })
    for (const spec of REPORTS) {
      const report = reports.find(r => wantedName(str(attr(r, 'name')), spec.name))
      if (!report) continue
      const instances = await listAll(cfg, `/v1/analyticsReports/${report.id}/instances`, { 'filter[granularity]': 'DAILY', limit: '200' })
      const fresh = instances
        .filter(i => !seen.has(i.id))
        .sort((a, b) => str(attr(a, 'processingDate')).localeCompare(str(attr(b, 'processingDate'))))
      for (const inst of fresh) {
        if (budget.left <= 0) return
        budget.left--
        const segments = await listAll(cfg, `/v1/analyticsReportInstances/${inst.id}/segments`, { limit: '200' })
        const partial = new Map<string, DayStats>()
        for (const seg of segments) {
          const url = str(attr(seg, 'url'))
          if (!url) continue
          const rows = parseTable(inflate(await download(url)))
          if (rows[0]) s.headers[spec.name] = Object.keys(rows[0])
          for (const row of rows) {
            const date = isoDate(row['date'] ?? '')
            if (!date) continue
            const appId = row['app apple identifier'] || app.id
            const key = `${appId}|${date}`
            let d = partial.get(key)
            if (!d) { d = blankDay(); partial.set(key, d) }
            spec.apply(d, row)
          }
        }
        for (const [key, d] of partial) {
          const [appId, date] = key.split('|') as [string, string]
          const stored = dayOf(s, appId, date)
          for (const f of spec.fields) {
            const v = d[f]
            if (typeof v === 'number') (stored as unknown as Record<string, number>)[f] = v
          }
        }
        markSeen(s, inst.id)
        seen.add(inst.id)
        await pause(100)
      }
    }
  }
}

// ── The sync ─────────────────────────────────────────────────────────────────

/** YYYY-MM-DD in Pacific time, `daysAgo` days back. */
function ptDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function ptHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', hour12: false }).format(new Date()))
}

let inFlight: Promise<void> | null = null
let nextRunAt: string | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Run a sync now, or join the one already running. */
export function syncNow(): Promise<void> {
  if (!inFlight) inFlight = run().finally(() => { inFlight = null })
  return inFlight
}

export function syncing(): boolean { return inFlight !== null }

async function run(): Promise<void> {
  const cfg = readConfig()
  if (!complete(cfg)) return
  const s = readStats()
  const started = Date.now()
  const log: string[] = []
  try {
    const apps = await listApps(cfg)
    for (const a of apps) s.apps[a.id] = a
    const skuToApp: Record<string, string> = {}
    for (const a of Object.values(s.apps)) if (a.sku) skuToApp[a.sku] = a.id

    // The ledger: every day in the window this dashboard has not read yet, newest first.
    let read = 0, empty = 0
    for (let n = 1; n <= BACKFILL_DAYS; n++) {
      const date = ptDate(n)
      if (s.salesDays[date]) continue
      const day = await fetchSalesDay(cfg, date)
      if (day.kind === 'not-yet') continue
      if (day.kind === 'none') {
        // Yesterday's file lands by about 8 am Pacific; "no sales" before then may just mean "no file yet".
        if (n === 1 && ptHour() < 9) continue
        s.salesDays[date] = 'none'
        empty++
        continue
      }
      applySales(s, date, day.rows, skuToApp)
      s.salesDays[date] = 'ok'
      read++
      await pause(150)
    }

    const budget = { left: MAX_INSTANCES_PER_RUN }
    for (const a of apps) {
      await syncAnalytics(cfg, s, a, budget, log)
      if (budget.left <= 0) { log.push('more analytics files wait for the next run'); break }
    }
    const files = MAX_INSTANCES_PER_RUN - budget.left
    const detail = [`${apps.length} app${apps.length === 1 ? '' : 's'}`, `${read} sales day${read === 1 ? '' : 's'} read`, `${empty} with nothing sold`, `${files} analytics file${files === 1 ? '' : 's'}`, ...log].join(' · ')
    s.lastRun = { at: new Date().toISOString(), ok: true, detail, ms: Date.now() - started }
    console.log(`[app-store] synced: ${detail}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    s.lastRun = { at: new Date().toISOString(), ok: false, detail: msg, ms: Date.now() - started }
    console.warn(`[app-store] sync failed: ${msg}`)
  }
  writeStats(s)
  broadcast('app-store', { at: s.lastRun?.at ?? null, ok: s.lastRun?.ok ?? false })
}

/** Hourly, starting shortly after boot. A no-op each time until the key is configured. */
export function startAppStoreSync(): void {
  if (timer) return
  const arm = () => { nextRunAt = new Date(Date.now() + SYNC_EVERY_MS).toISOString() }
  setTimeout(() => { void syncNow(); arm() }, FIRST_SYNC_DELAY_MS)
  nextRunAt = new Date(Date.now() + FIRST_SYNC_DELAY_MS).toISOString()
  timer = setInterval(() => { void syncNow(); arm() }, SYNC_EVERY_MS)
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Save the key after proving it: the PEM must parse as the right kind of key
 * and Apple must accept a token from it, so a typo in the issuer id is caught
 * at the paste and not at three in the morning. `privateKey` may be omitted to
 * keep the one already saved.
 */
export async function setAppStoreConfig(input: { issuerId: string; keyId: string; vendorNumber: string; privateKey?: string }): Promise<void> {
  const stored = readStoredConfig()
  const next: AppStoreConfig = {
    issuerId:     input.issuerId.trim(),
    keyId:        input.keyId.trim().toUpperCase(),
    vendorNumber: input.vendorNumber.trim(),
    privateKey:   input.privateKey?.trim() ? normalisePrivateKey(input.privateKey) : stored.privateKey,
  }
  if (!next.issuerId) throw new Error('The issuer id is missing — it is at the top of the API keys page.')
  if (!/^[A-Z0-9]{6,20}$/.test(next.keyId)) throw new Error('The key id is the 10-character code beside the key on the API keys page.')
  if (!/^\d{5,12}$/.test(next.vendorNumber)) throw new Error('The vendor number is the number at the top of Payments and Financial Reports.')
  if (!next.privateKey) throw new Error('The .p8 key file is missing.')
  checkPrivateKey(next.privateKey)
  cachedToken = null
  try {
    await listApps(next)
    // The apps list proves the key; only a sales report proves the vendor
    // number, and a wrong one would otherwise fail every sync from now on.
    await fetchSalesDay(next, ptDate(2))
  } catch (err) {
    cachedToken = null
    throw new Error(err instanceof Error ? err.message.replace(/^\/v1\/apps: /, '') : String(err))
  }
  writeConfig(next)
  console.log(`[app-store] key ${next.keyId} saved`)
  void syncNow()
}

export function clearAppStoreConfig(): void {
  try { fs.unlinkSync(path.join(cacheDir(), CONFIG_FILE)) } catch { /* nothing */ }
  cachedToken = null
  console.log('[app-store] key forgotten')
}

// ── The view ─────────────────────────────────────────────────────────────────

export interface PeriodTotals {
  from:        string
  to:          string
  downloads:   number
  redownloads: number
  updates:     number
  iap:         number
  refunds:     number
  proceeds:    Record<string, number>
  /** null when no day in the range has that report yet. */
  impressions: number | null
  pageViews:   number | null
  taps:        number | null
  sessions:    number | null
  crashes:     number | null
}

export interface AppView {
  id:       string
  name:     string
  sku:      string
  bundleId: string
  /** The most recent day with a sales file, and the most recent with analytics. */
  latestSalesDay:     string | null
  latestAnalyticsDay: string | null
  periods: { yesterday: PeriodTotals; week: PeriodTotals; prevWeek: PeriodTotals; month: PeriodTotals; prevMonth: PeriodTotals }
  /** The last SERIES_DAYS days, oldest first, for the sparkline. */
  series: { date: string; downloads: number; proceeds: number; impressions: number | null; pageViews: number | null }[]
  /** First-time downloads by country over the month, most first. */
  countries: { code: string; downloads: number }[]
}

export interface AppStoreView {
  configured:   boolean
  source:       'settings' | 'env' | 'none'
  keyId:        string
  issuerId:     string
  vendorNumber: string
  lastRun:      Stats['lastRun']
  nextRunAt:    string | null
  syncing:      boolean
  /** Which payout currency the headline money is in: the one that earned most over the month. */
  currency:     string | null
  /** The day the sales window ends on (yesterday, Pacific time). */
  asOf:         string
  /** Sales days read so far, for the "first sync" message. */
  salesDaysRead: number
  apps:         AppView[]
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function totals(days: Record<string, DayStats>, from: string, to: string): PeriodTotals {
  const t: PeriodTotals = { from, to, downloads: 0, redownloads: 0, updates: 0, iap: 0, refunds: 0, proceeds: {}, impressions: null, pageViews: null, taps: null, sessions: null, crashes: null }
  const add = (k: 'impressions' | 'pageViews' | 'taps' | 'sessions' | 'crashes', v: number | undefined) => {
    if (typeof v === 'number') t[k] = (t[k] ?? 0) + v
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = days[d]
    if (!day) continue
    t.downloads += day.downloads; t.redownloads += day.redownloads; t.updates += day.updates
    t.iap += day.iap; t.refunds += day.refunds
    for (const [cur, amount] of Object.entries(day.proceeds)) t.proceeds[cur] = round2((t.proceeds[cur] ?? 0) + amount)
    add('impressions', day.impressions); add('pageViews', day.pageViews); add('taps', day.taps)
    add('sessions', day.sessions); add('crashes', day.crashes)
  }
  return t
}

export function appStoreView(): AppStoreView {
  const cfg = readConfig()
  const s = readStats()
  const asOf = ptDate(1)
  const apps: AppView[] = []
  const currencyTotals: Record<string, number> = {}

  for (const app of Object.values(s.apps)) {
    const days = s.days[app.id] ?? {}
    const dates = Object.keys(days).sort()
    const latestSalesDay = [...dates].reverse().find(d => s.salesDays[d] === 'ok' || days[d]!.downloads > 0) ?? null
    const latestAnalyticsDay = [...dates].reverse().find(d => typeof days[d]!.impressions === 'number') ?? null
    const month = totals(days, addDays(asOf, -29), asOf)
    for (const [cur, amount] of Object.entries(month.proceeds)) currencyTotals[cur] = (currencyTotals[cur] ?? 0) + Math.abs(amount)
    const countries: Record<string, number> = {}
    for (let d = addDays(asOf, -29); d <= asOf; d = addDays(d, 1)) {
      for (const [cc, n] of Object.entries(days[d]?.countries ?? {})) countries[cc] = (countries[cc] ?? 0) + n
    }
    apps.push({
      id: app.id, name: app.name, sku: app.sku, bundleId: app.bundleId,
      latestSalesDay, latestAnalyticsDay,
      periods: {
        yesterday: totals(days, asOf, asOf),
        week:      totals(days, addDays(asOf, -6), asOf),
        prevWeek:  totals(days, addDays(asOf, -13), addDays(asOf, -7)),
        month,
        prevMonth: totals(days, addDays(asOf, -59), addDays(asOf, -30)),
      },
      series: [],
      countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, downloads]) => ({ code, downloads })),
    })
  }

  const currency = Object.entries(currencyTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  for (const view of apps) {
    const days = s.days[view.id] ?? {}
    for (let i = SERIES_DAYS - 1; i >= 0; i--) {
      const date = addDays(asOf, -i)
      const day = days[date]
      view.series.push({
        date,
        downloads:   day?.downloads ?? 0,
        proceeds:    currency ? (day?.proceeds[currency] ?? 0) : 0,
        impressions: typeof day?.impressions === 'number' ? day.impressions : null,
        pageViews:   typeof day?.pageViews === 'number' ? day.pageViews : null,
      })
    }
  }
  apps.sort((a, b) => b.periods.month.downloads - a.periods.month.downloads || a.name.localeCompare(b.name))

  return {
    configured: complete(cfg),
    source: configSource(),
    keyId: cfg.keyId,
    issuerId: cfg.issuerId,
    vendorNumber: cfg.vendorNumber,
    lastRun: s.lastRun,
    nextRunAt,
    syncing: syncing(),
    currency,
    asOf,
    salesDaysRead: Object.keys(s.salesDays).length,
    apps,
  }
}

/** The money in a totals block as words: the main currency first, any other after it. */
export function proceedsText(p: Record<string, number>, mainCurrency: string | null): string {
  const entries = Object.entries(p).filter(([, v]) => v !== 0)
  if (entries.length === 0) return 'nothing'
  entries.sort((a, b) => (a[0] === mainCurrency ? -1 : b[0] === mainCurrency ? 1 : Math.abs(b[1]) - Math.abs(a[1])))
  return entries.map(([cur, v]) => `${v.toFixed(2)} ${cur}`).join(' and ')
}
