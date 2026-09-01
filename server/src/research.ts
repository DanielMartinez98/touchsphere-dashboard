// Web research for the guide generator.
//
// Two providers behind one interface, because the dashboard has to work on a box
// with no API keys at all:
//
//   searchWeb  — Ollama's hosted /api/web_search when OLLAMA_API_KEY is set
//                (good snippets, real ranking), otherwise DuckDuckGo's HTML
//                endpoint scraped by routes/browse.ts.
//   readPage   — fetch + readability extraction, reusing the exact helpers the
//                browser overlay's reader mode already runs on.
//
// This is deliberately NOT the chat tool loop's web_search: that returns one
// pre-formatted string capped at 8000 chars for the model to read aloud from.
// A guide needs several full pages of structured input, so it goes straight at
// the sources instead of through the conversation.

import {
  extractReadable,
  fetchText,
  isPublicHttpUrl,
  parseUrl,
  searchDuckDuckGo,
  siteOf,
} from './routes/browse'

const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''
const WEB_SEARCH_URL = process.env['OLLAMA_WEB_SEARCH_URL'] ?? 'https://ollama.com/api/web_search'
const SEARCH_TIMEOUT_MS = 20_000

export interface SearchHit {
  title:   string
  url:     string
  /** Snippet from the search provider. Empty on the DuckDuckGo path. */
  content: string
}

export interface Page {
  url:   string
  site:  string
  title: string
  text:  string
}

/** Which provider searchWeb will use — reported in the startup/debug logs. */
export const SEARCH_PROVIDER = OLLAMA_API_KEY ? 'ollama' : 'duckduckgo'

async function searchViaOllama(query: string, limit: number): Promise<SearchHit[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch(WEB_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OLLAMA_API_KEY}` },
      signal: ctrl.signal,
      body: JSON.stringify({ query, max_results: limit }),
    })
    if (!res.ok) {
      console.warn(`[research] ollama web_search ${res.status} — falling back to duckduckgo`)
      return []
    }
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    return (json.results ?? [])
      .slice(0, limit)
      .map(r => ({ title: r.title ?? '', url: r.url ?? '', content: r.content ?? '' }))
      .filter(r => r.url.length > 0)
  } catch (err) {
    console.warn('[research] ollama web_search error:', err instanceof Error ? err.message : err)
    return []
  } finally {
    clearTimeout(timer)
  }
}

// DuckDuckGo throttles a burst of scraped searches — it starts answering with a
// challenge page, which parses as zero results. A guide fires a dozen searches
// back to back, so they're spaced out. Nobody is waiting on this: the whole job
// already takes minutes.
const SEARCH_GAP_MS = Number(process.env['GUIDE_SEARCH_GAP_MS'] ?? 1500)
let lastSearchAt = 0

async function paceSearches(): Promise<void> {
  const wait = lastSearchAt + SEARCH_GAP_MS - Date.now()
  if (wait > 0) await new Promise<void>(r => setTimeout(r, wait))
  lastSearchAt = Date.now()
}

/**
 * Search the web for `query`. Hosted search first when configured, DuckDuckGo
 * otherwise — and also as a fallback when hosted search errors or returns
 * nothing, so a lapsed key degrades to keyless rather than to no guide.
 */
export async function searchWeb(query: string, limit = 4): Promise<SearchHit[]> {
  if (OLLAMA_API_KEY) {
    const hits = await searchViaOllama(query, limit)
    if (hits.length > 0) return hits
  }
  await paceSearches()
  let ddg = await searchDuckDuckGo(query, limit)
  if (ddg.length === 0) {
    // Almost always throttling rather than a genuinely empty query. One retry
    // after a longer pause recovers it; two would just be slower.
    await new Promise<void>(r => setTimeout(r, SEARCH_GAP_MS * 2))
    lastSearchAt = Date.now()
    ddg = await searchDuckDuckGo(query, limit)
    if (ddg.length > 0) console.log(`[research] search for "${query.slice(0, 50)}" succeeded on retry`)
  }
  return ddg.map(h => ({ title: h.title, url: h.url, content: '' }))
}

/** Fetch a page and extract its readable text. Null when it can't be read. */
export async function readPage(url: string, maxChars = 6000): Promise<Page | null> {
  const target = parseUrl(url)
  // Same guard as the reader-mode route: these URLs come from search results,
  // i.e. ultimately from strangers, and must never be aimed at the LAN.
  if (!target || !isPublicHttpUrl(target)) return null
  const html = await fetchText(target.toString())
  if (!html) return null
  const { title, text } = extractReadable(html)
  if (text.length < 200) return null   // a consent wall or a JS-only page
  return {
    url:   target.toString(),
    site:  siteOf(target),
    title: title || siteOf(target),
    text:  text.slice(0, maxChars),
  }
}

/**
 * Nav chrome off a hosted-search `content` blob.
 *
 * Hosted search returns the page as markdown-ish text, and a walkthrough site's
 * page opens with its whole navigation — forty link-only lines advertising every
 * other game the site covers. That is not merely wasted context: on a franchise
 * site those links NAME other games, which is precisely the confusion this file
 * is trying to stop. Drop link-only lines and repeated lines; keep prose.
 */
function stripNavChrome(raw: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) { if (out[out.length - 1] !== '') out.push(''); continue }
    // "* [Breath of the Wild](https://…)" / "[](https://…)" — navigation.
    const bare = t.replace(/^[*\-+]\s*/, '')
    if (/^\[[^\]]*\]\([^)]*\)$/.test(bare)) continue
    // A menu repeats itself across a page; prose almost never does verbatim.
    if (t.length < 60) {
      if (seen.has(t)) continue
      seen.add(t)
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Search, then get the text of the first pages that actually come back readable.
 * `limit` is how many usable pages are wanted, not how many are attempted —
 * paywalls, consent walls and JS-only pages are common enough that a fixed
 * "read the top 2 hits" would often come back with nothing.
 *
 * The hosted provider returns the page's full text inline (tens of thousands of
 * characters, not a snippet), so when that's what came back it is used directly
 * rather than re-fetched. That is not just a saved round trip: the fetch is the
 * step that fails: the dedicated walkthrough sites worth reading — StrategyWiki
 * among them — sit behind a Cloudflare interstitial that answers this server
 * with a 403, while the hosted searcher has already been through it. Re-fetching
 * would throw away the good text and keep the wiki-only diet.
 */
export async function researchPages(query: string, limit = 2, maxChars = 6000): Promise<Page[]> {
  const hits = await searchWeb(query, Math.max(limit + 3, 5))
  if (hits.length === 0) {
    // Worth distinguishing from "found pages but none readable": one means the
    // search provider gave us nothing (usually throttling), the other means the
    // pages themselves are paywalls or JS shells.
    console.warn(`[research] no search results for "${query.slice(0, 80)}"`)
    return []
  }
  const pages: Page[] = []
  for (const hit of hits) {
    if (pages.length >= limit) break
    const inline = stripNavChrome(hit.content ?? '')
    let page: Page | null = null
    if (inline.length >= 1200) {
      const parsed = parseUrl(hit.url)
      page = {
        url:   hit.url,
        site:  parsed ? siteOf(parsed) : hit.url,
        title: hit.title || hit.url,
        text:  inline.slice(0, maxChars),
      }
    } else {
      page = await readPage(hit.url, maxChars)
    }
    if (!page) continue
    // Prefer the search provider's title: it's the article's name, where
    // extractReadable's is whatever the site put in <title> (often with SEO
    // boilerplate stapled on).
    pages.push({ ...page, title: hit.title || page.title })
    console.log(`[research] read ${page.site} (${page.text.length} chars) for "${query.slice(0, 60)}"`)
  }
  if (pages.length === 0) {
    console.warn(`[research] ${hits.length} result(s) for "${query.slice(0, 60)}" but none readable`)
  }
  return pages
}

/**
 * Community-first query builder. Guides are supposed to mirror how a game's own
 * community organizes things, so the searches lean on the places that community
 * actually writes: wikis, GameFAQs, and long-running fan sites.
 *
 * Keyword-stuffing hurts on a scraped search engine, so the "wiki"/"walkthrough"
 * hints are only added when the topic doesn't already say them.
 */
export function communityQuery(title: string, topic: string): string {
  const t = topic.trim()
  const hints = ['wiki', 'walkthrough', 'guide'].filter(h => !new RegExp(h, 'i').test(t))
  return `${title} ${t} ${hints.join(' ')}`.replace(/\s+/g, ' ').trim()
}

// ── A user-named source site ──────────────────────────────────────────────────
// The wiki chain below is the default because it needs no key and is never
// throttled — but a user can name a specific site to build from ("make the
// Majora's Mask guide from zeldadungeon.net"), and dedicated walkthrough sites
// often route you through a dungeon where a wiki only describes it. That site is
// reached the ordinary way (site: search + reader extraction), not the MediaWiki
// API, because most of them aren't wikis.

/**
 * Turn "zeldadungeon.net", "https://www.zeldadungeon.net/majoras-mask/", or
 * "www.zeldadungeon.net" into a bare lowercased hostname ("zeldadungeon.net"),
 * or null when there's no usable host. A bare word with no dot ("ign") is
 * rejected: it's too ambiguous to aim a site: search at.
 */
export function normalizeSiteHost(input: string): string | null {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return null
  let host = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try { host = new URL(raw).hostname } catch { return null }
  } else {
    host = raw.split('/')[0] ?? raw
  }
  host = host.replace(/^www\./, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null
  return host
}

/**
 * Pages from one specific site, via a `site:` search then the same reader
 * extraction the open-web path uses. Best-effort: a `site:` query on the scraped
 * search path can be throttled to nothing, so the caller keeps the wiki chain as
 * a fallback — naming a site can only add sources, never empty the guide.
 */
async function researchSiteScoped(host: string, query: string, limit: number, maxChars: number): Promise<Page[]> {
  const hits = await searchWeb(`site:${host} ${query}`.replace(/\s+/g, ' ').trim(), Math.max(limit + 3, 5))
  const pages: Page[] = []
  for (const hit of hits) {
    if (pages.length >= limit) break
    // A `site:` search can still leak the odd off-site result on the scraped
    // path — keep only pages actually on the named host.
    const parsed = parseUrl(hit.url)
    if (!parsed || !parsed.hostname.replace(/^www\./, '').endsWith(host)) continue
    const page = await readPage(hit.url, maxChars)
    if (!page) continue
    pages.push({ ...page, title: hit.title || page.title })
    console.log(`[research] ${host}: "${page.title.slice(0, 50)}" (${page.text.length} chars) for "${query.slice(0, 50)}"`)
  }
  if (pages.length === 0) console.warn(`[research] nothing usable from ${host} for "${query.slice(0, 60)}"`)
  return pages
}

// ── The community's own wiki ──────────────────────────────────────────────────
// Scraped search engines answer a burst of queries with a CAPTCHA, and one guide
// fires a dozen — so the primary source is the game's wiki, read through the
// MediaWiki API. That needs no key, is never rate-limited at this volume, returns
// clean plain text instead of HTML to de-chrome, and (the real point) a wiki's
// own article structure IS how that game's community organizes the game.

/** MediaWiki hosts to try, in order. Most game wikis are on one of these two. */
const WIKI_FARMS = ['fandom.com', 'wiki.gg'] as const
const WIKI_TIMEOUT_MS = 8000

const STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'on', 'to', 'for', 'ii', 'iii', 'iv'])

// ── Which game is this, exactly? ─────────────────────────────────────────────
// The single worst failure this file can produce is research about a DIFFERENT
// GAME, because everything downstream is told "write only from the notes" and
// dutifully obeys. It has happened at scale: a Majora's Mask guide whose final
// chapter was Age of Calamity, whose item list was Spirit Tracks, and whose side
// quests were Skyward Sword's — all of it faithfully transcribed from pages the
// research handed over.
//
// The mechanism is franchise wikis. majorasmask.fandom.com 301s to
// zelda.fandom.com, which covers twenty games, so an unscoped search for a
// section called "Sidequests" or "The Final Battle" exact-matches some other
// Zelda game's article — and title-matching then PROMOTES it. Hence the two
// tools here: a qualifier to scope searches with, and a containment check to
// throw away a page that isn't about this game after all.

/** Words that identify no game on their own and must never be the only match. */
const GENERIC_TITLE_WORDS = new Set([
  'legend', 'game', 'edition', 'remastered', 'remaster', 'deluxe', 'definitive',
  'hd', '3d', 'ultimate', 'collection', 'complete', 'version', 'remake',
])

const looseWords = (s: string): string[] =>
  s.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean)

/**
 * The words that actually pick this game out of its franchise — "majoras",
 * "mask" for Majora's Mask; "hollow", "knight" for Hollow Knight. Stopwords and
 * words like "legend" or "remastered" are dropped: they identify a series or an
 * edition, never a game.
 */
export function titleKeywords(gameTitle: string): string[] {
  return [...new Set(looseWords(gameTitle))]
    .filter(w => w.length >= 3 && !STOPWORDS.has(w) && !GENERIC_TITLE_WORDS.has(w))
}

/**
 * The shortest phrase that names this game unambiguously, for scoping a search
 * on a shared wiki: "Majora's Mask" out of "The Legend of Zelda: Majora's Mask".
 * A subtitle is the distinctive half of a franchise title, so it's preferred
 * when it carries any identifying word of its own; otherwise the whole title is
 * the best we have (and for "The Legend of Zelda" it genuinely is).
 */
export function gameQualifier(gameTitle: string): string {
  const [, afterColon] = gameTitle.split(/[:–-]/).map(s => s.trim())
  if (afterColon && titleKeywords(afterColon).length > 0) return afterColon
  return gameTitle.trim()
}

/**
 * Does this text actually talk about this game?
 *
 * Deliberately cheap and deliberately generous — it is a guard against pages
 * about a *different* game, not a relevance score. A Spirit Tracks item table
 * never says "Majora", which is the whole point: one string check is all it
 * takes to reject the failure that ruined every guide in the store.
 *
 * Generous, because a false negative here silently narrows the research: a page
 * passes on any distinctive word of the title, and a title with no distinctive
 * words at all (the franchise-named "The Legend of Zelda") can't be filtered on,
 * so it isn't — the caller keeps the page rather than pretending to know better.
 */
export function mentionsGame(text: string, gameTitle: string, minMentions = 1): boolean {
  const keywords = titleKeywords(gameTitle)
  if (keywords.length === 0) return true
  const hay = ` ${looseWords(text).join(' ')} `
  // The rarest word carries the most signal: "majoras" identifies the game where
  // "mask" appears on every page of that wiki.
  const ranked = [...keywords].sort((a, b) => b.length - a.length)
  for (const word of ranked.slice(0, 3)) {
    let count = 0
    let at = hay.indexOf(` ${word} `)
    while (at !== -1 && count < minMentions) {
      count++
      at = hay.indexOf(` ${word} `, at + 1)
    }
    if (count >= minMentions) return true
  }
  return false
}

/**
 * A game's wiki, and whether that wiki is the game's alone.
 *
 * `shared` is the important half. On a wiki covering one game, a search for
 * "Bosses" can only mean this game's bosses; on a franchise wiki it means
 * twenty games' bosses, and every query has to be scoped by name and every page
 * checked before it's believed.
 */
export interface GameWiki {
  host:   string
  shared: boolean
}

/**
 * Resolved wiki per game title, for the life of the process. The PROMISE is
 * cached, not the result: the outline resolves the table of contents and the
 * chapter list concurrently, and caching only on completion has both of them
 * probing the whole slug-candidate list before either finishes.
 */
const wikiHostCache = new Map<string, Promise<GameWiki | null>>()

/**
 * Where a host keeps api.php. Fandom and wiki.gg serve it at the root; Wikimedia
 * sites put it under /w/, and a request to the root there returns HTML — which is
 * how the Wikipedia fallback silently did nothing at all.
 */
function apiUrl(host: string): string {
  const path = /(^|\.)wikipedia\.org$|(^|\.)wikimedia\.org$/.test(host) ? '/w/api.php' : '/api.php'
  return `https://${host}${path}`
}

async function wikiApi<T>(host: string, params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams({ format: 'json', ...params }).toString()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiUrl(host)}?${qs}`, {
      headers: { accept: 'application/json', 'user-agent': 'TouchSphere-Dashboard/1.0 (game guides)' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface SearchApiReply { query?: { search?: Array<{ title?: string }> } }

/**
 * Page titles matching `query` on one wiki. `namespace` is MediaWiki's numeric
 * namespace — 0 is articles, 14 is categories (which come back "Category:"-
 * prefixed, and are how the chapter list is found).
 */
async function wikiSearch(host: string, query: string, limit: number, namespace = 0): Promise<string[]> {
  const json = await wikiApi<SearchApiReply>(host, {
    action: 'query', list: 'search', srsearch: query, srlimit: String(limit),
    srnamespace: String(namespace),
  })
  return (json?.query?.search ?? [])
    .map(s => (typeof s.title === 'string' ? s.title : ''))
    .filter(t => t.length > 0)
}

const looseTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Articles that carry the game's name and are not about playing the game:
 * adaptations, soundtracks, and the wiki's entries for published strategy-guide
 * books ("… — Prima Official Game Guide"), which describe a book rather than
 * contain a walkthrough and outrank real pages on exactly the words used here.
 */
const NOT_THE_GAME =
  /\((himekawa|manga|comic|novel|soundtrack|album|cd|book|character|item|disambiguation)\)|[—–]\s*.*\b(guide|manual|magazine|soundtrack|art book)\b/i

/**
 * Search, then promote an article whose title actually matches what was asked
 * for. Relevance ranking alone picks the wrong page often enough to matter — a
 * search for "Super Mario Odyssey" on that wiki ranks a character page above the
 * game's own article, and the guide would then be outlined from the wrong thing.
 */
async function wikiSearchBestFirst(
  host: string,
  query: string,
  limit: number,
  matchAgainst?: string,
): Promise<string[]> {
  const titles = (await wikiSearch(host, query, Math.max(limit, 3)))
    // Landing pages and namespace pages are navigation, not content — a guide
    // outlined from "Join the conversation" is worse than no hint at all.
    .filter(t => !/^(main page|.*\bwiki)$/i.test(t.trim()) && !/^[A-Z][a-z]+:/.test(t))
    // Articles that carry the game's name but aren't the game: its manga
    // adaptation (whose plot differs), and the wiki's articles ABOUT published
    // strategy guides, which are a few thousand characters of publisher, ISBN
    // and page count — they rank well for "walkthrough" and contain none.
    .filter(t => !NOT_THE_GAME.test(t))
  // Title-matching is done against what was actually asked for, which is not
  // always what was searched for: a shared-wiki query carries the game's name
  // as a scope ("Sidequests Majora's Mask") and would then exact-match nothing.
  const want = looseTitle(matchAgainst ?? query)
  const exact = titles.filter(t => looseTitle(t) === want)
  const prefixed = titles.filter(t => !exact.includes(t) && looseTitle(t).startsWith(want))
  return [...exact, ...prefixed, ...titles.filter(t => !exact.includes(t) && !prefixed.includes(t))]
}

interface ExtractApiReply {
  query?: { pages?: Record<string, { title?: string; extract?: string; missing?: unknown }> }
}
interface ParseApiReply {
  parse?: { title?: string; text?: { '*'?: string } }
}

// A rendered wiki page is big (Hollow Knight's is ~900 KB of HTML). Cap what goes
// into the extractor so one article can't balloon memory on the Pi.
const MAX_WIKI_HTML = 400_000

function wikiPageUrl(host: string, pageTitle: string): string {
  return `https://${host}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`
}

/** Below this a rendered page is chrome and stubs, not an article. */
const MIN_RENDERED_CHARS = 1200

/**
 * One wiki article as plain text.
 *
 * RENDERED HTML FIRST, `prop=extracts` second — and the order matters more than
 * it looks. TextExtracts returns clean prose, but "prose" is the whole problem:
 * it drops lists and tables, and on a game wiki that is where the answers live.
 * Zelda's "Mask" article is 5.9k chars through extracts and 20k rendered, and
 * only the rendered one contains "To be sold for 20 Rupees to the Skull Kid in
 * Lost Woods" — i.e. how you actually get the thing. Woodfall Temple is 3.2k
 * versus 14.5k the same way. A guide built on extracts can list what exists and
 * nothing about obtaining it, which is exactly the complaint it produced.
 *
 * extracts stays as the fallback, because `action=parse` can fail on a page that
 * still has a readable extract, and because some Fandom wikis don't install
 * TextExtracts at all (hollowknight.fandom.com answers "Unrecognized value for
 * parameter prop") — so neither route can be the only one.
 */
async function wikiExtract(host: string, pageTitle: string, maxChars: number): Promise<Page | null> {
  const parsed = await wikiApi<ParseApiReply>(host, {
    action: 'parse', page: pageTitle, prop: 'text', redirects: '1',
  })
  const html = parsed?.parse?.text?.['*']
  if (typeof html === 'string' && html.length > 0) {
    const { text } = extractReadable(html.slice(0, MAX_WIKI_HTML))
    if (text.length >= MIN_RENDERED_CHARS) {
      return {
        url:   wikiPageUrl(host, pageTitle),
        site:  host,
        title: parsed?.parse?.title ?? pageTitle,
        text:  text.slice(0, maxChars),
      }
    }
  }

  const json = await wikiApi<ExtractApiReply>(host, {
    action: 'query', prop: 'extracts', explaintext: '1', exlimit: '1', redirects: '1', titles: pageTitle,
  })
  const page = Object.values(json?.query?.pages ?? {})[0]
  const extract = typeof page?.extract === 'string' ? page.extract.trim() : ''
  if (extract.length < 200) return null
  return {
    url:   wikiPageUrl(host, pageTitle),
    site:  host,
    title: page?.title ?? pageTitle,
    text:  extract.slice(0, maxChars),
  }
}

/**
 * Slug candidates for a game's wiki, most specific first. Fandom slugs are
 * usually the franchise rather than the individual game — zelda.fandom.com, not
 * majorasmask.fandom.com — so single significant words are tried too.
 */
function wikiSlugCandidates(gameTitle: string): string[] {
  const clean = gameTitle.toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9: ]+/g, ' ')
  const [beforeColon, afterColon] = clean.split(':').map(s => s.trim())
  const words = clean.replace(/:/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w))
  const join = (ws: string[]) => ws.join('')
  const parts = (s?: string) => (s ?? '').split(/\s+/).filter(w => w && !STOPWORDS.has(w))

  const base = [
    join(words),                                  // hollowknight, eldenring
    join(parts(afterColon)),                      // majorasmask
    join(parts(beforeColon)),                     // legendzelda
    ...words.filter(w => w.length >= 4),          // zelda, majoras…
  ].filter(s => s.length >= 3)

  return [...new Set([
    ...base,
    // Fandom disambiguates a title that clashes with something else by suffixing
    // it — Celeste's wiki is celestegame.fandom.com, not celeste.fandom.com.
    ...base.map(s => `${s}game`),
    ...base.map(s => `${s}wiki`),
  ])].filter(s => s.length >= 3 && s.length <= 40)
}

interface SiteInfoReply { query?: { general?: { server?: string; sitename?: string } } }

/**
 * The host a wiki actually lives on, which is not always the one asked for:
 * majorasmask.fandom.com answers every request as zelda.fandom.com. Following
 * that redirect is how a franchise wiki gets mistaken for a game's own.
 */
async function canonicalWikiHost(host: string): Promise<string | null> {
  const json = await wikiApi<SiteInfoReply>(host, { action: 'query', meta: 'siteinfo' })
  const server = json?.query?.general?.server
  if (!server) return null
  try {
    return new URL(server.startsWith('//') ? `https:${server}` : server).hostname
  } catch {
    return host
  }
}

/**
 * Does this wiki's own name account for the whole game title? "hollowknight"
 * covers "Hollow Knight"; "zelda" does not cover "Majora's Mask", so a wiki
 * living at zelda.fandom.com is a franchise wiki however it was reached.
 *
 * This is the second of the two shared-wiki signals and it catches what the
 * redirect check can't: a slug candidate that hits the franchise wiki head-on
 * (the title's own word "zelda" is a candidate) never redirects anywhere.
 */
function hostCoversTitle(host: string, gameTitle: string): boolean {
  const slug = (host.split('.')[0] ?? '').replace(/(game|wiki)$/, '')
  return titleKeywords(gameTitle).every(w => slug.includes(w))
}

/**
 * Find the wiki that covers this game, by probing slug candidates until one
 * answers a search for the game's own title. Cached — the probe is a handful of
 * requests and the answer never changes within a run.
 */
export function findGameWiki(gameTitle: string): Promise<GameWiki | null> {
  const key = gameTitle.toLowerCase().trim()
  const cached = wikiHostCache.get(key)
  if (cached) return cached
  const pending = probeGameWiki(gameTitle)
  wikiHostCache.set(key, pending)
  return pending
}

async function probeGameWiki(gameTitle: string): Promise<GameWiki | null> {
  for (const slug of wikiSlugCandidates(gameTitle)) {
    for (const farm of WIKI_FARMS) {
      const probe = `${slug}.${farm}`
      const hits = await wikiSearch(probe, gameTitle, 1)
      if (hits.length === 0) continue

      // Two independent ways to be a franchise wiki, and both happen: the probe
      // redirected somewhere else, or it landed on a wiki whose name is only
      // part of this game's title.
      const host = (await canonicalWikiHost(probe)) ?? probe
      // Three independent ways to be a franchise wiki, and all three happen:
      // the probe redirected somewhere else; the wiki's name is only part of
      // this game's title; or — the case neither of those catches — the game IS
      // its franchise's namesake, so "zelda" legitimately covers "The Legend of
      // Zelda" and nothing about the name gives it away. That last one is why
      // the NES game's guide could never be built: every query it ran matched
      // twenty games and nothing could tell it so.
      const shared = host !== probe
        || !hostCoversTitle(host, gameTitle)
        || (await countCategoryMembers(host, 'Category:Games')) >= 4
      const wiki: GameWiki = { host, shared }
      console.log(
        `[research] wiki for "${gameTitle}" → ${host}` +
        (host !== probe ? ` (probed ${probe}, redirected)` : '') +
        (shared ? ' — SHARED across a franchise: queries will be scoped and pages checked' : ''),
      )
      return wiki
    }
  }
  console.warn(`[research] no wiki found for "${gameTitle}" — falling back to Wikipedia and web search`)
  return null
}

// ── The community's own chapter list ─────────────────────────────────────────
// A wiki article's section headings describe the ARTICLE ("Plot", "Development",
// "Reception"), and outlining a guide from those is how a nine-dungeon game came
// out as three story-arc chapters that recap the cutscenes.
//
// A wiki's CATEGORIES describe the GAME, and on a franchise wiki they are
// per-game by necessity — "Category:Dungeons in Majora's Mask" lists exactly the
// ten dungeons of exactly that game. That is the chapter list, written by the
// community, with no model involved and nothing to hallucinate.

/** Category names that are chapters of a guide. Worth two of anything else. */
const PROGRESSION_WORDS =
  /\b(dungeons?|temples?|levels?|chapters?|bosses|areas?|regions?|missions?|worlds?|stages?|acts?|episodes?)\b/i

/** Category names that are the collectible lists a completion guide tracks. */
const COLLECTIBLE_WORDS =
  /\b(masks?|items?|songs?|collectibles?|upgrades?|quests?|sidequests?|hearts?|weapons?|armou?rs?|charms?|abilities|skills?|spells?|equipment|treasures?|secrets?|achievements?|trophies)\b/i

/** Categories that are wiki housekeeping or lore, never a guide chapter. */
const NON_CHAPTER_WORDS =
  /\b(characters?|enemies|enemy|images?|files?|galler(y|ies)|templates?|stubs?|articles?|media|videos?|music|soundtracks?|albums?|staff|credits?|glitch(es)?|translations?|beta|unused|cutscenes?|quotes?|voice|actors?|manga|comics?|books?|guides?|merchandise|categor(y|ies)|pages?|disambiguation)\b/i

/** Past this a category is a gazetteer, not a table of contents. */
const MAX_CATEGORY_MEMBERS = 40

/** How many category listings to put in front of the outline model. */
const MAX_CHAPTER_CATEGORIES = 6

interface CategoryMembersReply { query?: { categorymembers?: Array<{ title?: string }> } }

/**
 * How many pages a category holds. Separate from categoryMembers because that
 * one reports nothing for an over-large category (its job is chapter lists, and
 * a 45-entry category is not one) — while "how many games does this wiki
 * document" wants exactly that number.
 */
async function countCategoryMembers(host: string, category: string): Promise<number> {
  const json = await wikiApi<CategoryMembersReply>(host, {
    action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '50', cmtype: 'page',
  })
  return (json?.query?.categorymembers ?? []).length
}

/** The pages filed under one category, or [] when it's missing or far too broad. */
async function categoryMembers(host: string, category: string): Promise<string[]> {
  const json = await wikiApi<CategoryMembersReply>(host, {
    action: 'query', list: 'categorymembers', cmtitle: category,
    cmlimit: String(MAX_CATEGORY_MEMBERS + 10), cmtype: 'page',
  })
  const members = (json?.query?.categorymembers ?? [])
    .map(m => (typeof m.title === 'string' ? m.title.trim() : ''))
    .filter(t => t.length > 0 && !/^[A-Z][a-z]+:/.test(t))
  return members.length > MAX_CATEGORY_MEMBERS ? [] : members
}

export interface ChapterCategory {
  /** The category's own name, e.g. "Dungeons in Majora's Mask". */
  label:   string
  members: string[]
}

/**
 * The game's own dungeons, masks, songs and bosses, as its wiki files them.
 *
 * Found by searching the CATEGORY namespace for the game's name and keeping the
 * lists that look like guide chapters, rather than by guessing category names:
 * the two conventions in the wild are "Dungeons in Majora's Mask" and "Bosses
 * (Hollow Knight)", a search matches both, and searching the game's name alone
 * also turns up the lists no fixed guess would have asked for — "Masks in
 * Majora's Mask" being exactly the one whose absence shipped a mask chapter
 * with 5 of the game's 24.
 *
 * On a shared wiki a category is only accepted when its NAME contains the game,
 * or "Dungeons" franchise-wide comes back as this game's chapter list.
 */
export async function communityChapters(gameTitle: string): Promise<ChapterCategory[]> {
  const wiki = await findGameWiki(gameTitle)
  if (!wiki) return []
  const qualifier = gameQualifier(gameTitle)

  // Discovery finds the lists nobody would think to ask for ("Masks in Majora's
  // Mask"); the targeted pass guarantees the backbone, because the broad search
  // does not reliably rank "Dungeons in …" into its first page of results and
  // the dungeons are the one list a walkthrough cannot do without.
  const found = new Set(await wikiSearch(wiki.host, qualifier, 25, 14))
  for (const kind of ['Dungeons', 'Temples', 'Levels', 'Chapters', 'Areas', 'Missions']) {
    for (const t of await wikiSearch(wiki.host, `${kind} ${qualifier}`, 3, 14)) found.add(t)
  }

  /**
   * Judge what KIND of list a category is with the game's own name taken out of
   * the name first. Without this the qualifier poisons the match: every category
   * on this wiki ends in "…in Majora's Mask", so every one of them matched the
   * collectible pattern on the word "Mask" — which is how a list of game
   * mechanics scored as a collectible chapter.
   */
  const kindOf = (name: string): string => {
    let s = name.replace(/['’]/g, '')
    for (const w of titleKeywords(gameTitle)) {
      s = s.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ')
    }
    return s
  }

  const scored = [...found]
    .filter(t => /^category:/i.test(t))
    .map(t => ({ title: t, name: t.replace(/^category:/i, '').trim() }))
    .map(c => ({ ...c, kind: kindOf(c.name) }))
    .filter(c => !NON_CHAPTER_WORDS.test(c.kind))
    // On a franchise wiki the name has to say which game at all.
    .filter(c => !wiki.shared || mentionsGame(c.name, gameTitle))
    // And wherever a category names a game explicitly — "Areas (Silksong)",
    // "Dungeons in Majora's Mask" — that game has to be this one. This applies
    // even on a wiki that looked game-specific, because a wiki named for one
    // game grows to cover its sequel: hollowknight.fandom.com hosts Silksong,
    // and its area list is not Hollow Knight's.
    .filter(c => {
      const marker = c.name.match(/\(([^)]+)\)\s*$/)?.[1] ?? c.name.match(/\bin\s+(.+)$/i)?.[1]
      return marker === undefined || mentionsGame(marker, gameTitle)
    })
    .map(c => ({
      ...c,
      score: PROGRESSION_WORDS.test(c.kind) ? 2 : COLLECTIBLE_WORDS.test(c.kind) ? 1 : 0,
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)

  const out: ChapterCategory[] = []
  const takenLists = new Set<string>()
  for (const c of scored) {
    if (out.length >= MAX_CHAPTER_CATEGORIES) break
    const members = await categoryMembers(wiki.host, c.title)
    if (members.length < 3) continue
    // A remake keeps its own categories with the same contents ("Dungeons in
    // Majora's Mask 3D"). Listing both spends a slot, and the prompt's budget,
    // saying the same thing twice.
    const fingerprint = members.join('|').toLowerCase()
    if (takenLists.has(fingerprint)) continue
    takenLists.add(fingerprint)
    out.push({ label: c.name, members })
    console.log(`[research] ${wiki.host}: "${c.name}" lists ${members.length} — ${members.slice(0, 6).join(', ')}`)
  }
  return out
}

interface SectionsApiReply {
  parse?: { sections?: Array<{ line?: string; level?: string; toclevel?: number }> }
}

/**
 * Headings that describe the ARTICLE rather than the GAME.
 *
 * These are the reason guides came out as story recaps. A wiki article about a
 * game is an encyclopedia entry: its headings are Plot, Development, Reception,
 * Legacy — and its Plot section subdivides into "Arrival to a Doomed Land",
 * "The Boy Without a Fairy". Fed to the outline prompt as "this is how the
 * community organizes the game", those became the chapters, and a nine-dungeon
 * game shipped as three chapters recapping the cutscenes. Nothing else in the
 * prompt was a strong enough signal to overrule them.
 */
const ENCYCLOPEDIA_HEADINGS =
  /^(plot|story|synopsis|summary|premise|setting|characters?|development|production|design|music|sound|audio|release|marketing|reception|reviews?|sales|awards?|legacy|sequels?|merchandise|trivia|gallery|references?|notes?|external links|see also|further reading|bibliography|credits|cast|voice cast|versions?|ports?|re-?releases?|history|background|overview|introduction|contents|graphics|translations?|glitch(es)?|nomenclature|speedrun|timeline|beta|unused)\b/i

/**
 * Headings whose entire SUBTREE is encyclopedia material.
 *
 * This is the one that matters, and dropping only the heading itself was not
 * enough. "Story" is a single innocuous line; its four CHILDREN are "Arrival to
 * a Doomed Land", "The Four Giants", "The Final Battle", "Dawn of a New Day" —
 * and those four, passed to the outline as the community's structure, are
 * verbatim the four chapters a shipped guide was built from. The parent is
 * filtered by name; the children can only be caught by their ancestry.
 *
 * Deliberately narrower than the per-heading list: "Gameplay" stays, because on
 * a game wiki its children are things like "Masks and transformations" — real
 * content that a completion guide wants.
 */
const ENCYCLOPEDIA_SUBTREES =
  /^(plot|story|synopsis|summary|premise|development|production|reception|reviews?|sales|awards?|legacy|merchandise|marketing|credits|references?|external links|see also|further reading|bibliography|gallery|trivia|cast|voice cast|game information|versions?|ports?|re-?releases?|nomenclature|translations?)\b/i

/**
 * The section headings of the game's own wiki article, with the encyclopedia
 * furniture removed. What survives is usually the genuinely useful part —
 * "Dungeons", "Items", "Sidequests" — and is only a hint anyway: the real
 * chapter list comes from communityChapters().
 */
export async function communityTableOfContents(gameTitle: string): Promise<string[]> {
  const wiki = await findGameWiki(gameTitle)
  if (!wiki) return []
  const [article] = await wikiSearchBestFirst(wiki.host, gameTitle, 3)
  if (!article) return []
  const json = await wikiApi<SectionsApiReply>(wiki.host, { action: 'parse', page: article, prop: 'sections' })
  const all = (json?.parse?.sections ?? [])
    .map(s => ({
      line:  typeof s.line === 'string' ? s.line.trim() : '',
      depth: typeof s.toclevel === 'number' ? s.toclevel : 1,
    }))
    .filter(s => s.line.length > 0 && s.line.length < 60)

  // Walk in document order, skipping everything nested under a heading that was
  // dropped as encyclopedia material — that is what removes the plot summary's
  // per-act subheadings, which is where the story-recap chapters came from.
  const lines: string[] = []
  let skipBelow: number | null = null
  for (const { line, depth } of all) {
    if (skipBelow !== null && depth > skipBelow) continue
    skipBelow = null
    if (ENCYCLOPEDIA_SUBTREES.test(line)) { skipBelow = depth; continue }
    if (ENCYCLOPEDIA_HEADINGS.test(line)) continue
    lines.push(line)
  }
  if (all.length > 0) {
    console.log(
      `[research] ${wiki.host} lists ${all.length} sections for "${article}" — ` +
      `${lines.length} left after dropping encyclopedia headings`,
    )
  }
  return lines.slice(0, 40)
}

// ── Pictures ─────────────────────────────────────────────────────────────────
//
// A guide's visual aids come from the same wikis its text does, and they are
// subject to the SAME failure this file exists to prevent, in a form that is
// harder to spot: a wrong picture looks authoritative in a way a wrong sentence
// does not. `Woodfall Temple` on zelda.fandom.com carries fifty images, and a
// plain "biggest one wins" picks a Minish Cap artwork; `Bunny Hood` picks a
// Smash Bros screenshot; the page's own lead image — which ought to be safe,
// being what the infobox shows — returns a Cadence of Hyrule render for
// `Deku Mask`. All three were observed, not imagined.
//
// So the filter is the same one that works on text, applied to filenames:
// SUBJECT WORDS, meaning the words of the thing being illustrated with the
// GAME'S OWN title words removed. For "Deku Mask" in Majora's Mask that leaves
// ["deku"], which is exactly the discriminator — every wrong candidate above
// fails it, and it needs no per-game table of abbreviations (MM/MM3D/TWW/HW…),
// which is the other way to do this and the way that stops working on the next
// franchise.

/** One picture on a wiki, resolved far enough to fetch. */
export interface WikiImage {
  url:    string
  /** The File: page title, which is also the closest thing to a caption. */
  title:  string
  width:  number
  height: number
}

interface ImageInfoReply {
  query?: {
    pages?: Record<string, {
      title?: string
      imageinfo?: Array<{ url?: string; width?: number; height?: number; mime?: string }>
    }>
  }
}

/** Anything that is chrome, merchandise or a UI element rather than the game. */
const IMAGE_JUNK = /\b(logo|icon|sprite|symbol|flag|trophy|amiibo|button|banner|stub|disambig|nintendo|printable|papercraft|calendar|box ?art|cover)\b/i

/**
 * Formats worth showing.
 *
 * NOT anchored at the end of the string, which is the obvious way to write it
 * and is wrong for the CDN this actually talks to: Fandom serves
 * `…/MM_Dragonfly_Model.png/revision/latest?cb=…`, so an end-anchored test
 * rejects every image on every Fandom wiki — silently, as "this page has no
 * pictures".
 */
const IMAGE_OK = /\.(png|jpe?g|webp|gif)(?:$|[/?])/i

/** Below this on the shortest side it is a thumbnail or an inline glyph. */
const MIN_IMAGE_SIDE = 250

/**
 * A filename flattened for word matching.
 *
 * Load-bearing because of one character. `titleKeywords()` runs titles through
 * looseWords(), which drops apostrophes — so the keyword for Majora's Mask is
 * `majoras`, while the file is called `Majora's Mask Adventure Map.jpg`, and a
 * plain `includes('majoras')` on the raw filename is false. Every game-map
 * lookup for that game silently returned nothing until both sides were
 * normalized the same way.
 */
const flattenTitle = (s: string): string =>
  s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')

/**
 * Nouns that name a KIND of place or thing rather than a particular one.
 *
 * These recur across the chapters of a single game — Majora's Mask alone has
 * four "Temple" chapters — so they carry no discriminating power inside it, and
 * matching on them is how a search for Woodfall Temple's map returned Stone
 * Tower Temple's. Observed, not hypothetical.
 */
const GENERIC_SUBJECT_NOUNS = new Set([
  'temple', 'dungeon', 'cave', 'grotto', 'field', 'town', 'city', 'village',
  'palace', 'castle', 'tower', 'forest', 'woods', 'mountain', 'valley', 'lake',
  'river', 'sea', 'bay', 'island', 'desert', 'swamp', 'canyon', 'ruins',
  'shrine', 'area', 'areas', 'region', 'regions', 'quest', 'quests', 'sidequest',
  'sidequests', 'boss', 'bosses', 'item', 'items', 'weapon', 'weapons',
  'collectible', 'collectibles', 'walkthrough', 'guide', 'map', 'maps',
])

/**
 * The words that identify this subject, with the game's own name taken out.
 *
 * Removing the game's words is the whole trick. "Deku Mask" in a game called
 * "Majora's Mask" reduces to ["deku"]: keeping "mask" would match every mask
 * image on the wiki including the wrong game's, which is how a filter that
 * looks sound lets the exact failure through.
 */
export function subjectWords(subject: string, gameTitle: string): string[] {
  const game = new Set(looseWords(gameTitle))
  return [...new Set(looseWords(subject))]
    .filter(w => w.length >= 3 && !STOPWORDS.has(w) && !game.has(w))
}

/**
 * The subject words that actually pick this thing out from its siblings.
 *
 * "Woodfall Temple" → ["woodfall"], because "temple" is shared with three other
 * chapters of the same game. Every one of these must appear in a filename for it
 * to be accepted, which is what makes the match specific; the generic words are
 * still allowed to appear, they just cannot carry the decision on their own.
 *
 * Falls back to the full subject-word list when everything was generic ("Side
 * quests"), where requiring all of them is the correct, strict behaviour — and
 * usually yields nothing, which is the honest outcome for a chapter that names
 * no particular place.
 */
function distinctiveWords(subject: string, gameTitle: string): string[] {
  const words = subjectWords(subject, gameTitle)
  const specific = words.filter(w => !GENERIC_SUBJECT_NOUNS.has(w))
  return specific.length > 0 ? specific : words
}

/** Resolve File: titles to URLs and sizes in one call. */
async function imageInfo(host: string, fileTitles: string[]): Promise<WikiImage[]> {
  if (fileTitles.length === 0) return []
  const json = await wikiApi<ImageInfoReply>(host, {
    action: 'query', prop: 'imageinfo', iiprop: 'url|size|mime',
    titles: fileTitles.slice(0, 40).join('|'),
  })
  const out: WikiImage[] = []
  for (const page of Object.values(json?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0]
    const url = typeof info?.url === 'string' ? info.url : ''
    const title = typeof page.title === 'string' ? page.title : ''
    if (!url || !IMAGE_OK.test(url)) continue
    out.push({
      url, title,
      width:  typeof info?.width === 'number' ? info.width : 0,
      height: typeof info?.height === 'number' ? info.height : 0,
    })
  }
  return out
}

/**
 * Rank candidates for illustrating `subject`, best first.
 *
 * Landscape before portrait because a step's aid is a screenshot of a place,
 * and a tall character render tells the player nothing about where to stand.
 * Area breaks ties — on a wiki the bigger file is nearly always the real
 * screenshot and the smaller one a cropped duplicate.
 */
function rankImages(images: WikiImage[], words: string[]): WikiImage[] {
  if (words.length === 0) return []
  return images
    .filter(img => {
      if (Math.min(img.width, img.height) < MIN_IMAGE_SIDE) return false
      if (IMAGE_JUNK.test(img.title)) return false
      const low = flattenTitle(img.title)
      // EVERY distinctive word, not any. `some` is the natural way to write this
      // and it is what returned Stone Tower Temple's map for Woodfall Temple:
      // one shared generic noun was enough to match.
      return words.every(w => low.includes(w))
    })
    .sort((a, b) => {
      const land = Number(b.width >= b.height) - Number(a.width >= a.height)
      if (land !== 0) return land
      return b.width * b.height - a.width * a.height
    })
}

interface PageImagesReply {
  query?: {
    pages?: Record<string, {
      title?: string
      pageimage?: string
      original?: { source?: string; width?: number; height?: number }
    }>
  }
}

/** The image the wiki itself shows for a page — its infobox picture. */
async function wikiLeadImage(host: string, pageTitle: string): Promise<WikiImage | null> {
  const json = await wikiApi<PageImagesReply>(host, {
    action: 'query', prop: 'pageimages', piprop: 'original|name', titles: pageTitle,
  })
  for (const page of Object.values(json?.query?.pages ?? {})) {
    const src = page.original?.source
    if (typeof src !== 'string' || !IMAGE_OK.test(src)) continue
    return {
      url: src,
      // The filename, which is what the subject-word filter reads. `pageimage`
      // is the bare name without the "File:" prefix; either form matches.
      title: typeof page.pageimage === 'string' ? page.pageimage : (page.title ?? ''),
      width:  typeof page.original?.width === 'number' ? page.original.width : 0,
      height: typeof page.original?.height === 'number' ? page.original.height : 0,
    }
  }
  return null
}

/**
 * The best picture of `subject` on this wiki, or null.
 *
 * Null is a perfectly good answer and the common one for an abstract chapter
 * ("Side quests"). A guide with a picture on two thirds of its steps is the
 * shape to aim for; inventing one for the rest is how the wrong-game images get
 * in, since the only way to always return something is to relax the filter that
 * keeps them out.
 */
export async function wikiImageFor(
  host: string, pageTitle: string, gameTitle: string,
): Promise<WikiImage | null> {
  const words = distinctiveWords(pageTitle, gameTitle)
  if (words.length === 0) return null

  // The page's own lead image FIRST, but only if it passes the same filter.
  //
  // Two failures cancel each other out here. The lead image alone is wrong when
  // the infobox art is borrowed from elsewhere in the franchise (`Deku Mask`
  // returns a Cadence of Hyrule render). The ranked list alone is wrong when a
  // crossover title has a bigger, wider screenshot of the same subject (`Bunny
  // Hood` returns a Smash Bros shot). The lead image is the wiki's own answer to
  // "what is this page about", so when it survives the subject-word check it is
  // better than anything size can tell us — and when it doesn't, the ranked list
  // is still there.
  const lead = await wikiLeadImage(host, pageTitle)
  if (lead && rankImages([lead], words).length > 0) return lead
  const json = await wikiApi<ImageInfoReply>(host, {
    action: 'query', generator: 'images', titles: pageTitle, gimlimit: '60',
    prop: 'imageinfo', iiprop: 'url|size|mime',
  })
  const candidates: WikiImage[] = []
  for (const page of Object.values(json?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0]
    const url = typeof info?.url === 'string' ? info.url : ''
    const title = typeof page.title === 'string' ? page.title : ''
    if (!url || !IMAGE_OK.test(url)) continue
    candidates.push({
      url, title,
      width:  typeof info?.width === 'number' ? info.width : 0,
      height: typeof info?.height === 'number' ? info.height : 0,
    })
  }
  return rankImages(candidates, words)[0] ?? null
}

/**
 * The whole-game map — Termina, Hyrule, Hallownest — used by any chapter that
 * has no map of its own.
 *
 * A separate function rather than `wikiMapFor(gameTitle)` because the subject
 * rule inverts here. For a chapter, the game's words are removed: they cannot
 * tell one temple from another. For the game itself they are ALL there is, and
 * subtracting them leaves nothing to match on, so wikiMapFor(gameTitle) returns
 * null every time.
 *
 * The disambiguation being done is also different in kind. A chapter map has to
 * be told apart from its three sibling chapters, which demands every
 * distinctive word; a game map only has to be told apart from OTHER GAMES, and
 * any one distinctive word of the title does that — "Majora's Mask Adventure
 * Map" is unmistakable on the strength of "majora" alone.
 */
export async function wikiGameMap(host: string, gameTitle: string): Promise<WikiImage | null> {
  const keys = titleKeywords(gameTitle)
  if (keys.length === 0) return null
  const qualifier = gameQualifier(gameTitle)
  const titles = new Set<string>()
  for (const q of [`${qualifier} map`, `${qualifier} world map`, `${qualifier} overworld map`]) {
    for (const t of await wikiSearch(host, q, 8, 6)) titles.add(t)
    if (titles.size >= 16) break
  }
  const resolved = await imageInfo(host, [...titles])
  const maps = resolved
    .filter(img => {
      if (Math.min(img.width, img.height) < MIN_IMAGE_SIDE) return false
      if (IMAGE_JUNK.test(img.title)) return false
      const low = flattenTitle(img.title)
      // Any title keyword — see the note above on why `every` is wrong here.
      return /\bmaps?\b/i.test(img.title) && keys.some(k => low.includes(k))
    })
    // Widest first: a world map is a landscape image, and the tall results at
    // this point are nearly always a menu screenshot with the map on one side.
    .sort((a, b) => b.width * b.height - a.width * a.height)
  return maps[0] ?? null
}

/**
 * A map of `subject`, searched for in the File namespace rather than gathered
 * off an article.
 *
 * Different search from wikiImageFor on purpose: a dungeon's map is very often
 * NOT on the dungeon's page — it lives in the File namespace under a name like
 * `WT Map.jpg` that no article embeds. Searching for it by name finds those;
 * walking the page's images does not.
 *
 * The subject-word filter still applies, so a search for "Snowhead Temple map"
 * cannot come back with Hyrule Field's.
 */
export async function wikiMapFor(
  host: string, subject: string, gameTitle: string,
): Promise<WikiImage | null> {
  const words = distinctiveWords(subject, gameTitle)
  if (words.length === 0) return null
  // Both spellings are in the wild — "WT Map.jpg" and "Snowhead Temple Map.png"
  // — and the query is cheap, so ask for the subject with and without the game.
  const queries = [`${subject} map`, `${gameQualifier(gameTitle)} ${subject} map`]
  const titles = new Set<string>()
  for (const q of queries) {
    for (const t of await wikiSearch(host, q, 8, 6)) titles.add(t)
    if (titles.size >= 12) break
  }
  const resolved = await imageInfo(host, [...titles])
  // A map has to look like one: the ranked list is filtered again for the word
  // itself, because "Snowhead Temple Freezards.png" matches the subject words
  // perfectly and is a screenshot of two enemies.
  const maps = rankImages(resolved, words).filter(img => /\bmaps?\b/i.test(img.title))
  return maps[0] ?? null
}

export interface ResearchOptions {
  /** How many usable pages are wanted. */
  limit?:         number
  maxChars?:      number
  /** A site the user explicitly asked the guide to be built from. */
  preferredSite?: string
  /**
   * Ask the open web before the wiki. Worth it for a walkthrough section when
   * hosted search is configured; pointless (and CAPTCHA-prone) without a key.
   */
  webFirst?:      boolean
  /**
   * Throw away pages that never mention this game. On a franchise wiki this is
   * the guard that stops another game's article being written up as a chapter.
   */
  requireGameMention?: boolean
}

/**
 * Research one topic about one game.
 *
 * Source order is deliberately conditional rather than fixed. The wiki-first
 * chain below exists because scraped search answers a burst of queries with a
 * CAPTCHA — a real constraint on a keyless box, and still the default there.
 * But when hosted search IS configured that constraint is gone, and wiki-first
 * becomes actively wrong for a walkthrough: a wiki DESCRIBES a dungeon (theme,
 * layout, lore) where a walkthrough site ROUTES you through it, and the old
 * order only reached the open web if the wiki returned nothing at all — which
 * it almost never does. That is why chapters read like encyclopedia summaries
 * instead of directions. `webFirst` inverts it where it pays.
 */
export async function researchGame(
  gameTitle: string,
  topic: string,
  opts: ResearchOptions = {},
): Promise<Page[]> {
  const { limit = 1, maxChars = 6000, preferredSite, webFirst = false, requireGameMention = false } = opts
  const pages: Page[] = []
  const qualifier = gameQualifier(gameTitle)

  const accept = (candidates: Page[], why: string): void => {
    for (const p of candidates) {
      if (pages.length >= limit) return
      if (pages.some(x => x.url === p.url)) continue
      if (requireGameMention && !mentionsGame(`${p.title}\n${p.text}`, gameTitle)) {
        console.warn(
          `[research] rejected ${p.site} "${p.title.slice(0, 60)}" (${why}) — ` +
          `never mentions "${qualifier}", so it is about a different game`,
        )
        continue
      }
      pages.push(p)
    }
  }

  // A user-named source site is honoured first — it's an explicit "build it from
  // here". The chain below still runs when the site comes up short, so a
  // throttled site: search degrades to the wiki instead of emptying the guide.
  if (preferredSite) {
    accept(await researchSiteScoped(preferredSite, topic || gameTitle, limit, maxChars), 'named site')
  }

  // The open web, scoped by name so a franchise search can't wander off.
  if (webFirst && pages.length < limit) {
    accept(await researchPages(communityQuery(qualifier, topic), limit, maxChars), 'web search')
  }

  const wiki = await findGameWiki(gameTitle)

  if (wiki && pages.length < limit) {
    // A section topic is usually an article in its own right ("Woodfall Temple"),
    // so search the wiki for the topic and read the best matches. On a shared
    // wiki the query carries the game's name too, or "Sidequests" resolves to
    // whichever game in the franchise happens to rank first.
    const want = topic || gameTitle
    const query = wiki.shared && topic ? `${topic} ${qualifier}` : want
    const titles = await wikiSearchBestFirst(wiki.host, query, limit + 2, want)
    const found: Page[] = []
    for (const t of titles) {
      if (found.length >= limit + 1) break
      const page = await wikiExtract(wiki.host, t, maxChars)
      if (!page) continue
      found.push(page)
      console.log(`[research] ${wiki.host}: "${t}" (${page.text.length} chars) for "${query.slice(0, 60)}"`)
    }
    accept(found, `${wiki.host}${wiki.shared ? ', shared wiki' : ''}`)
  }

  if (pages.length === 0) {
    const [wikipediaArticle] = await wikiSearch('en.wikipedia.org', `${gameTitle} ${topic}`.trim(), 1)
    if (wikipediaArticle) {
      const page = await wikiExtract('en.wikipedia.org', wikipediaArticle, maxChars)
      if (page) accept([page], 'wikipedia')
    }
  }

  if (pages.length === 0 && !webFirst) {
    // Last resort on the keyless path: the open web, frequently CAPTCHA-walled,
    // which is exactly why it is last there and first under `webFirst`.
    accept(await researchPages(communityQuery(qualifier, topic), limit, maxChars), 'web search (fallback)')
  }

  return pages.map(p => ({ ...p, text: p.text.slice(0, maxChars) }))
}
