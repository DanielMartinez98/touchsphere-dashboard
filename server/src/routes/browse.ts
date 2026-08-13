// Browsing surface — lets the assistant put a web page or a video ON SCREEN.
//
// The chat route already has web_search / web_fetch, but those only feed text
// back to the model so it can *talk* about what it found. This module is the
// other half: two tools (`open_website`, `play_video`) that resolve a target
// and hand the client a small "display" payload, which the dashboard renders in
// a full-screen browser window. The assistant still speaks a one-line summary —
// showing and telling are not exclusive.
//
// Resolution happens here, server-side, because it needs network access the
// kiosk shouldn't do itself:
//   • YouTube search       — Data API v3 when YOUTUBE_API_KEY is set, otherwise
//                            the public results page (parsed from ytInitialData)
//   • Web search fallback  — DuckDuckGo HTML, only used when the model calls
//                            open_website with a query instead of a URL
//   • Embeddability probe  — most sites send X-Frame-Options / frame-ancestors
//                            and simply refuse to render in an iframe. We check
//                            up front and tell the client to use reader mode
//                            instead of showing it a blank white rectangle.
//
// Route:
//   GET /api/browse/page?url=…   → reader-mode extraction (title + plain text)
//                                  used by the overlay for non-embeddable sites
//
// Env vars:
//   YOUTUBE_API_KEY   optional; enables proper YouTube search instead of scraping

import { Router, type Request, type Response } from 'express'

const router = Router()

const YOUTUBE_API_KEY = process.env['YOUTUBE_API_KEY'] ?? ''
const FETCH_TIMEOUT_MS = 10_000
const MAX_HTML_BYTES = 2_000_000
const MAX_READER_CHARS = 20_000

// A browser-ish UA. Several of the endpoints we touch (YouTube results,
// DuckDuckGo HTML, plenty of news sites) serve a stripped or blocked page to
// anything that looks like a script.
const UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  // Skips the EU consent interstitial that would otherwise replace the results.
  'cookie': 'CONSENT=YES+1',
}

/**
 * What the client is told to put on screen. Mirrored in client/src/hooks/useBrowse.ts,
 * whose `openBrowseFromPayload` validates and routes each kind.
 *
 * `video`/`web` open the browser window; `guide` opens the full-screen game guide
 * (a different overlay entirely — see client/src/components/GuideOverlay.tsx);
 * `close` clears whatever is currently up.
 */
export type DisplayPayload =
  | { kind: 'video'; url: string; title: string; videoId: string; channel?: string }
  | { kind: 'web';   url: string; title: string; site: string; embeddable: boolean }
  | { kind: 'guide'; itemId: string; title: string; chapter?: string }
  | { kind: 'close' }

// ── URL helpers ──────────────────────────────────────────────────────────────

/** Parse + normalize a model-supplied URL. Returns null if it isn't usable. */
export function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim().replace(/^<|>$/g, '')
  if (!trimmed) return null
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
}

// The URLs here come from an LLM, which means they can come from a web page the
// LLM read — i.e. ultimately from a stranger. Refuse anything that points back
// at the host or the LAN so a fetch can never be aimed at the Pi's own services.
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|\[?::1\]?|0\.0\.0\.0)$/i
const PRIVATE_IPV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

export function isPublicHttpUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (PRIVATE_HOST.test(host)) return false
  if (PRIVATE_IPV4.test(host)) return false
  if (host.startsWith('[fc') || host.startsWith('[fd')) return false   // IPv6 ULA
  return true
}

/** Human-readable site name for the overlay header ("bbc.co.uk"). */
export function siteOf(u: URL): string {
  return u.hostname.replace(/^www\./, '')
}

/** Extract a YouTube video id from any of its URL shapes. */
export function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0] ?? ''
    return /^[\w-]{11}$/.test(id) ? id : null
  }
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null
  const v = u.searchParams.get('v')
  if (v && /^[\w-]{11}$/.test(v)) return v
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)
  return m?.[1] ?? null
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

export async function fetchText(url: string, headers = BROWSER_HEADERS): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) {
      console.warn(`[browse] fetch ${res.status} ${url.slice(0, 100)}`)
      return null
    }
    // Cap the read so a stray multi-megabyte page can't balloon the Pi's memory.
    const buf = await res.arrayBuffer()
    return Buffer.from(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf).toString('utf8')
  } catch (err) {
    console.warn(`[browse] fetch failed ${url.slice(0, 100)}:`, err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Would this page render in an iframe? Anything that sets X-Frame-Options, or a
 * CSP `frame-ancestors` that isn't a wildcard, comes back as a blank box.
 */
function framesAllowed(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options') ?? ''
  if (/deny|sameorigin|allow-from/i.test(xfo)) return false
  const fa = headers.get('content-security-policy')?.match(/frame-ancestors([^;]*)/i)?.[1] ?? ''
  if (fa && !/\s\*(\s|$)/.test(fa)) return false
  return true
}

/**
 * One request up front, answering both "can we frame this?" and "what is it
 * called?". We fetch before the kiosk does so the overlay never has to show a
 * blank iframe or a bare hostname in its header — and on any error we answer
 * "not embeddable", because reader mode at least shows *something*.
 */
async function probePage(url: string): Promise<{ embeddable: boolean; title: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    // GET, not HEAD: a fair number of sites 405 on HEAD.
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) {
      void res.body?.cancel()
      return { embeddable: false, title: '' }
    }
    const embeddable = framesAllowed(res.headers)
    if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      void res.body?.cancel()
      return { embeddable, title: '' }
    }
    const buf = await res.arrayBuffer()
    const html = Buffer.from(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf).toString('utf8')
    return { embeddable, title: pageTitle(html) }
  } catch {
    return { embeddable: false, title: '' }
  } finally {
    clearTimeout(timer)
  }
}

// ── HTML → text ──────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
}

function metaContent(html: string, prop: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|` +
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i',
  )
  const m = html.match(re)
  return decodeEntities((m?.[1] ?? m?.[2] ?? '').trim())
}

/** og:title, falling back to <title>. */
function pageTitle(html: string): string {
  return metaContent(html, 'og:title')
    || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()).replace(/\s+/g, ' ')
}

/**
 * Crude readability: drop the chrome, keep the prose. Not a full Readability
 * port — on a 720×1280 kiosk we only need headings, paragraphs and list items in
 * a legible column, and the model has already told the user what the page says.
 */
export function extractReadable(html: string): { title: string; text: string; image: string } {
  const title = pageTitle(html)
  const image = metaContent(html, 'og:image')

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|form|select|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')

  // Prefer the main content container when the page marks one and it's
  // substantial; otherwise keep the whole (already de-chromed) body.
  const main = body.match(/<article[\s\S]*?<\/article>/i)?.[0]
    ?? body.match(/<main[\s\S]*?<\/main>/i)?.[0]
  if (main && main.length > 800) body = main

  const text = decodeEntities(
    body
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, '\n\n')
      .replace(/<h([1-3])[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // Orphaned bullets left behind by nav/infobox lists whose text we stripped.
    .replace(/^[•\-–]$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_READER_CHARS)

  return { title, text, image }
}

// ── YouTube search ───────────────────────────────────────────────────────────

export interface VideoHit { videoId: string; title: string; channel?: string }

async function youtubeViaApi(query: string): Promise<VideoHit | null> {
  const url = 'https://www.googleapis.com/youtube/v3/search'
    + `?part=snippet&type=video&videoEmbeddable=true&maxResults=1&safeSearch=moderate`
    + `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
  const raw = await fetchText(url, { 'user-agent': UA, accept: 'application/json' })
  if (!raw) return null
  try {
    const json = JSON.parse(raw) as {
      items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }>
    }
    const hit = json.items?.[0]
    const id = hit?.id?.videoId
    if (!id) return null
    return {
      videoId: id,
      title: decodeEntities(hit?.snippet?.title ?? 'YouTube video'),
      ...(hit?.snippet?.channelTitle ? { channel: hit.snippet.channelTitle } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Pull the JSON object that follows `marker` out of a page, by scanning braces
 * rather than regex — YouTube's ytInitialData contains every bracket character
 * you can think of inside strings, so a lazy `\{.*?\}` match cuts it in half.
 */
function sliceJsonAfter(html: string, marker: string): unknown | null {
  const start = html.indexOf(marker)
  if (start < 0) return null
  const open = html.indexOf('{', start + marker.length)
  if (open < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = open; i < html.length; i++) {
    const c = html[i]!
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(open, i + 1)) } catch { return null }
    }
  }
  return null
}

/** Depth-first search for the first value stored under `key`. */
function findFirst(node: unknown, key: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirst(item, key)
      if (hit) return hit
    }
    return null
  }
  const obj = node as Record<string, unknown>
  const direct = obj[key]
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>
  for (const v of Object.values(obj)) {
    const hit = findFirst(v, key)
    if (hit) return hit
  }
  return null
}

function runsText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const o = node as { simpleText?: string; runs?: Array<{ text?: string }> }
  if (typeof o.simpleText === 'string') return o.simpleText
  return (o.runs ?? []).map(r => r.text ?? '').join('')
}

async function youtubeViaResultsPage(query: string): Promise<VideoHit | null> {
  const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`)
  if (!html) return null
  const data = sliceJsonAfter(html, 'ytInitialData')
  const vr = data ? findFirst(data, 'videoRenderer') : null
  const id = typeof vr?.['videoId'] === 'string' ? (vr['videoId'] as string) : ''
  if (!/^[\w-]{11}$/.test(id)) return null
  const title = runsText(vr?.['title']) || 'YouTube video'
  const channel = runsText(vr?.['ownerText']) || runsText(vr?.['longBylineText'])
  return { videoId: id, title, ...(channel ? { channel } : {}) }
}

export async function searchYouTube(query: string): Promise<VideoHit | null> {
  if (YOUTUBE_API_KEY) {
    const viaApi = await youtubeViaApi(query)
    if (viaApi) return viaApi
    console.warn('[browse] YouTube Data API returned nothing — falling back to the results page')
  }
  return youtubeViaResultsPage(query)
}

// ── Web search fallback ──────────────────────────────────────────────────────

/**
 * Keyless web search: scrape DuckDuckGo's HTML endpoint for organic results.
 * Used as the fallback everywhere a real search API isn't configured — by
 * open_website when the model passes a query instead of a URL, and by the guide
 * researcher (research.ts) when there's no OLLAMA_API_KEY for hosted search.
 */
export async function searchDuckDuckGo(query: string, limit = 1): Promise<Array<{ url: string; title: string }>> {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
  if (!html) return []
  const out: Array<{ url: string; title: string }> = []
  const seen = new Set<string>()
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < limit) {
    let href = decodeEntities(m[1] ?? '')
    // Organic results are wrapped in a redirect: //duckduckgo.com/l/?uddg=<encoded>.
    // Sponsored ones point at /y.js instead and never carry uddg — dropping
    // anything still on duckduckgo.com after unwrapping filters the ads out,
    // which matters here because the top slot is usually one.
    const wrapped = href.match(/[?&]uddg=([^&]+)/)
    if (wrapped?.[1]) href = decodeURIComponent(wrapped[1])
    else if (href.startsWith('//')) href = `https:${href}`
    const parsed = parseUrl(href)
    if (!parsed || !isPublicHttpUrl(parsed)) continue
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) continue
    const url = parsed.toString()
    if (seen.has(url)) continue
    seen.add(url)
    const title = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    out.push({ url, title: title || siteOf(parsed) })
  }
  return out
}

/**
 * Last-resort "find me a page about X" when the model calls open_website with a
 * query and no URL. The model is *told* to search first and pass a real URL —
 * this exists so a small local model that forgets still shows the user something.
 */
async function searchOneUrl(query: string): Promise<{ url: string; title: string } | null> {
  return (await searchDuckDuckGo(query, 1))[0] ?? null
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const BROWSE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_website',
      description:
        'Show a web page ON THE DASHBOARD SCREEN in a browser window the user can read and scroll. ' +
        'Use this when the user asks you to open, show, pull up, browse, or look at a site or article — ' +
        'anything where they want to SEE the page rather than just hear about it. ' +
        'Strongly prefer passing a real `url` you already have (from web_search results, or an obvious ' +
        'one like https://en.wikipedia.org/wiki/... ); only fall back to `query` if you have no URL. ' +
        'After calling this, still say one short sentence about what you put on screen.',
      parameters: {
        type: 'object',
        properties: {
          url:   { type: 'string', description: 'Full URL of the page to display (preferred).' },
          query: { type: 'string', description: 'What to look up, if you have no URL yet.' },
          title: { type: 'string', description: 'Optional short label to show in the window header.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_video',
      description:
        'Find a YouTube video and play it ON THE DASHBOARD SCREEN. ' +
        'Use this for tutorials, how-tos, recipes, walkthroughs, music, trailers, or any time the user ' +
        'asks to watch something or asks a question best answered by showing a video ' +
        '("show me how to...", "play ...", "find me a tutorial on ..."). ' +
        'Pass a natural search query the way you would type it into YouTube. ' +
        'After calling this, still say one short sentence naming what you queued up.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'YouTube search query, e.g. "how to poach an egg".' },
          url:   { type: 'string', description: 'A specific YouTube URL, if you already have one.' },
        },
      },
    },
  },
] as const

export interface BrowseToolResult {
  /** Text fed back to the model so it knows what actually landed on screen. */
  text: string
  /** What the client should render; null when resolution failed. */
  display: DisplayPayload | null
}

async function openWebsite(args: Record<string, unknown>): Promise<BrowseToolResult> {
  const rawUrl = typeof args['url']   === 'string' ? args['url']   : ''
  const query  = typeof args['query'] === 'string' ? args['query'] : ''
  const hint   = typeof args['title'] === 'string' ? args['title'] : ''

  let target = rawUrl ? parseUrl(rawUrl) : null
  let title = hint

  if (target && !isPublicHttpUrl(target)) {
    return { text: `open_website refused "${rawUrl}" — that address is not a public website.`, display: null }
  }
  if (!target) {
    if (!query.trim()) {
      return { text: 'open_website error: pass either a `url` or a `query`.', display: null }
    }
    const found = await searchOneUrl(query.trim().slice(0, 200))
    if (!found) {
      return {
        text: `open_website could not find a page for "${query}". Call web_search first, then call open_website again with the best result's url.`,
        display: null,
      }
    }
    target = parseUrl(found.url)
    if (!target) return { text: 'open_website error: search returned an unusable URL.', display: null }
    if (!title) title = found.title
  }

  // "Open that YouTube link" is a video, not a web page — the embed player is a
  // far better answer than an iframe of youtube.com (which refuses to frame).
  const vid = youtubeId(target)
  if (vid) {
    const display: DisplayPayload = {
      kind: 'video',
      url: `https://www.youtube.com/watch?v=${vid}`,
      title: title || 'YouTube video',
      videoId: vid,
    }
    console.log(`[browse] open_website → video ${vid}`)
    return { text: `Now playing on screen: "${display.title}".`, display }
  }

  const url = target.toString()
  const { embeddable, title: pageName } = await probePage(url)
  const display: DisplayPayload = {
    kind: 'web',
    url,
    // The model's label wins when it gave one — it's usually phrased for the
    // user ("the recipe") rather than the site's own SEO headline.
    title: title || pageName || siteOf(target),
    site: siteOf(target),
    embeddable,
  }
  console.log(`[browse] open_website → ${url.slice(0, 120)} embeddable=${embeddable}`)
  return {
    text:
      `Opened "${display.title}" (${display.site}) on the user's screen` +
      `${embeddable ? '' : ' in reader mode, since the site blocks embedding'}. ` +
      'Tell them in one short sentence what is on screen — do not read out the URL.',
    display,
  }
}

async function playVideo(args: Record<string, unknown>): Promise<BrowseToolResult> {
  const query  = typeof args['query'] === 'string' ? args['query'] : ''
  const rawUrl = typeof args['url']   === 'string' ? args['url']   : ''

  if (rawUrl) {
    const parsed = parseUrl(rawUrl)
    const id = parsed ? youtubeId(parsed) : null
    if (id) {
      const display: DisplayPayload = {
        kind: 'video',
        url: `https://www.youtube.com/watch?v=${id}`,
        title: query || 'YouTube video',
        videoId: id,
      }
      console.log(`[browse] play_video → ${id} (direct url)`)
      return { text: `Now playing on screen: "${display.title}".`, display }
    }
  }

  if (!query.trim()) return { text: 'play_video error: pass a `query` describing the video.', display: null }

  const hit = await searchYouTube(query.trim().slice(0, 200))
  if (!hit) {
    return {
      text: `play_video found no video for "${query}". Say so briefly instead of inventing one.`,
      display: null,
    }
  }
  const display: DisplayPayload = {
    kind: 'video',
    url: `https://www.youtube.com/watch?v=${hit.videoId}`,
    title: hit.title,
    videoId: hit.videoId,
    ...(hit.channel ? { channel: hit.channel } : {}),
  }
  console.log(`[browse] play_video "${query.slice(0, 60)}" → ${hit.videoId} "${hit.title.slice(0, 60)}"`)
  return {
    text:
      `Queued on the user's screen: "${hit.title}"${hit.channel ? ` by ${hit.channel}` : ''}. ` +
      'Name it in one short sentence — do not read out the URL.',
    display,
  }
}

/** Dispatch for the browsing tools. Returns null for names it doesn't own. */
export async function runBrowseTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BrowseToolResult | null> {
  if (name === 'open_website') return openWebsite(args)
  if (name === 'play_video')   return playVideo(args)
  return null
}

// ── Route: reader mode ───────────────────────────────────────────────────────
// The overlay calls this for pages that refuse to be framed. Returning extracted
// text (rather than proxying the HTML) keeps us out of the business of rewriting
// other people's asset URLs, and reads far better on a 7" portrait screen.
router.get('/page', async (req: Request, res: Response) => {
  const raw = typeof req.query['url'] === 'string' ? req.query['url'] : ''
  const target = parseUrl(raw)
  if (!target || !isPublicHttpUrl(target)) {
    return res.status(400).json({ error: 'a public http(s) `url` is required' })
  }
  const html = await fetchText(target.toString())
  if (html === null) {
    return res.status(502).json({ error: 'could not fetch that page' })
  }
  const { title, text, image } = extractReadable(html)
  return res.json({
    url: target.toString(),
    site: siteOf(target),
    title: title || siteOf(target),
    text,
    ...(image ? { image } : {}),
  })
})

export default router
