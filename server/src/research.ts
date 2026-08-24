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
 * Search, then read the first pages that actually come back with prose.
 * `limit` is how many readable pages are wanted, not how many are attempted —
 * paywalls, consent walls and JS-only pages are common enough that a fixed
 * "read the top 2 hits" would often come back with nothing.
 */
export async function researchPages(query: string, limit = 2): Promise<Page[]> {
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
    const page = await readPage(hit.url)
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

/** Resolved wiki host per game title, for the life of the process. */
const wikiHostCache = new Map<string, string | null>()

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

/** Page titles matching `query` on one wiki. */
async function wikiSearch(host: string, query: string, limit: number): Promise<string[]> {
  const json = await wikiApi<SearchApiReply>(host, {
    action: 'query', list: 'search', srsearch: query, srlimit: String(limit),
  })
  return (json?.query?.search ?? [])
    .map(s => (typeof s.title === 'string' ? s.title : ''))
    .filter(t => t.length > 0)
}

const looseTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Search, then promote an article whose title actually matches what was asked
 * for. Relevance ranking alone picks the wrong page often enough to matter — a
 * search for "Super Mario Odyssey" on that wiki ranks a character page above the
 * game's own article, and the guide would then be outlined from the wrong thing.
 */
async function wikiSearchBestFirst(host: string, query: string, limit: number): Promise<string[]> {
  const titles = (await wikiSearch(host, query, Math.max(limit, 3)))
    // Landing pages and namespace pages are navigation, not content — a guide
    // outlined from "Join the conversation" is worse than no hint at all.
    .filter(t => !/^(main page|.*\bwiki)$/i.test(t.trim()) && !/^[A-Z][a-z]+:/.test(t))
  const want = looseTitle(query)
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

/**
 * Find the wiki that covers this game, by probing slug candidates until one
 * answers a search for the game's own title. Cached — the probe is a handful of
 * requests and the answer never changes within a run.
 */
export async function findGameWiki(gameTitle: string): Promise<string | null> {
  const key = gameTitle.toLowerCase().trim()
  const cached = wikiHostCache.get(key)
  if (cached !== undefined) return cached

  for (const slug of wikiSlugCandidates(gameTitle)) {
    for (const farm of WIKI_FARMS) {
      const host = `${slug}.${farm}`
      const hits = await wikiSearch(host, gameTitle, 1)
      if (hits.length > 0) {
        console.log(`[research] wiki for "${gameTitle}" → ${host}`)
        wikiHostCache.set(key, host)
        return host
      }
    }
  }
  console.warn(`[research] no wiki found for "${gameTitle}" — falling back to Wikipedia and web search`)
  wikiHostCache.set(key, null)
  return null
}

interface SectionsApiReply { parse?: { sections?: Array<{ line?: string; level?: string }> } }

/**
 * The section headings of the game's own wiki article — the community's literal
 * table of contents, which is the best possible answer to "how do they organize
 * this game?". Empty array when there's no wiki or no such article.
 */
export async function communityTableOfContents(gameTitle: string): Promise<string[]> {
  const host = await findGameWiki(gameTitle)
  if (!host) return []
  const [article] = await wikiSearchBestFirst(host, gameTitle, 3)
  if (!article) return []
  const json = await wikiApi<SectionsApiReply>(host, { action: 'parse', page: article, prop: 'sections' })
  const lines = (json?.parse?.sections ?? [])
    .map(s => (typeof s.line === 'string' ? s.line.trim() : ''))
    .filter(l => l.length > 0 && l.length < 60)
  if (lines.length > 0) console.log(`[research] ${host} lists ${lines.length} sections for "${article}"`)
  return lines.slice(0, 40)
}

/**
 * Research one topic about one game. Wiki first (reliable, clean, and the
 * community's own words), Wikipedia next, scraped web search last — so a
 * throttled search engine degrades the guide instead of emptying it.
 */
export async function researchGame(
  gameTitle: string,
  topic: string,
  limit = 1,
  maxChars = 6000,
  preferredSite?: string,
): Promise<Page[]> {
  const pages: Page[] = []

  // A user-named source site is honoured first — it's an explicit "build it from
  // here". The wiki chain below still runs when the site comes up short, so a
  // throttled site: search degrades to the wiki instead of emptying the guide.
  if (preferredSite) {
    for (const p of await researchSiteScoped(preferredSite, topic || gameTitle, limit, maxChars)) {
      if (pages.length >= limit) break
      if (!pages.some(x => x.url === p.url)) pages.push(p)
    }
  }

  const host = await findGameWiki(gameTitle)

  if (host && pages.length < limit) {
    // A section topic is usually an article in its own right ("Woodfall Temple"),
    // so search the wiki for the topic and read the best matches.
    const titles = await wikiSearchBestFirst(host, topic || gameTitle, limit + 2)
    for (const t of titles) {
      if (pages.length >= limit) break
      const page = await wikiExtract(host, t, maxChars)
      if (!page) continue
      pages.push(page)
      console.log(`[research] ${host}: "${t}" (${page.text.length} chars) for "${topic || gameTitle}"`)
    }
  }

  if (pages.length === 0) {
    const [wikipediaArticle] = await wikiSearch('en.wikipedia.org', `${gameTitle} ${topic}`.trim(), 1)
    if (wikipediaArticle) {
      const page = await wikiExtract('en.wikipedia.org', wikipediaArticle, maxChars)
      if (page) {
        pages.push(page)
        console.log(`[research] wikipedia: "${wikipediaArticle}" (${page.text.length} chars)`)
      }
    }
  }

  if (pages.length === 0) {
    // Last resort: the open web. Frequently CAPTCHA-walled without an API key,
    // which is exactly why it is last and not first.
    pages.push(...(await researchPages(communityQuery(gameTitle, topic), limit)))
  }

  return pages.map(p => ({ ...p, text: p.text.slice(0, maxChars) }))
}
