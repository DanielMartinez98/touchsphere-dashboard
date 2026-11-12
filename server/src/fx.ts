// Exchange rates, so money earned in a dozen storefront currencies can be read
// as one number.
//
// Apple's daily ledger states proceeds in the currency each customer paid in
// (a sale in Mexico is in MXN, one in Germany in EUR), AdMob reports in the
// account's currency and Unity in US dollars. Added up as they are they give
// "12.40 USD + 180 MXN + 3.10 EUR", which is exact and unreadable. This keeps
// one table of rates against the dollar — fetched once a day from a keyless
// public feed, kept on the volume so a day offline changes nothing — and
// converts at TODAY's rate, history included. That makes every converted
// figure an estimate (the screen marks it "≈"); what Apple actually pays is on
// its payments page, converted at its own rate on its own day.

import fs from 'fs'
import path from 'path'

/** FX_API exists for tests only. */
const FEED = (process.env['FX_API'] ?? '').trim() || 'https://open.er-api.com/v6/latest/USD'
const FILE = 'fx-rates.json'
const MAX_AGE_MS = 24 * 60 * 60_000

interface Table { at: string; rates: Record<string, number> }

function file(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, FILE)
}

let table: Table | null = null

function load(): Table | null {
  if (table) return table
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Table>
    if (typeof raw.at === 'string' && raw.rates && typeof raw.rates === 'object') table = { at: raw.at, rates: raw.rates }
  } catch { /* none yet */ }
  return table
}

/** Fetch the day's rates if the table is older than a day. Never throws: stale rates beat none. */
export async function refreshFx(): Promise<void> {
  const t = load()
  if (t && Date.now() - new Date(t.at).getTime() < MAX_AGE_MS) return
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(15_000) })
    const j = await res.json() as { rates?: Record<string, unknown> }
    const rates: Record<string, number> = {}
    for (const [k, v] of Object.entries(j.rates ?? {})) if (typeof v === 'number' && v > 0 && /^[A-Z]{3}$/.test(k)) rates[k] = v
    if (!rates['EUR']) throw new Error('the feed answered without rates')
    rates['USD'] = 1
    table = { at: new Date().toISOString(), rates }
    const p = file()
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(table), 'utf8')
    fs.renameSync(`${p}.tmp`, p)
  } catch (err) {
    console.warn(`[fx] could not refresh exchange rates: ${err instanceof Error ? err.message : err}`)
  }
}

/** `amount` of `from` in `to`, or null when either rate is unknown. */
export function convert(amount: number, from: string, to: string): number | null {
  if (from === to) return amount
  const t = load()
  const a = from === 'USD' ? 1 : t?.rates[from]
  const b = to === 'USD' ? 1 : t?.rates[to]
  if (!a || !b) return null
  return (amount / a) * b
}

export function fxAsOf(): string | null { return load()?.at ?? null }
