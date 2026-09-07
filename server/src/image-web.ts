// Finding a real picture on the web and putting it in the Draw section.
//
// `generate_image` invents pictures and `open_website` shows pages; neither
// gets a photograph of a real thing INTO the gallery, where "Change this",
// the mask editor and the whole edit pipeline live. This does: search, fetch,
// and hand the bytes to addUploadedImage() so the result is an ordinary
// gallery entry with an id, indistinguishable downstream from one added off a
// phone.
//
// Two search providers, both keyless on purpose — this app already runs
// without a search key and adding a required one would make the feature
// unavailable on exactly the boxes that need it most:
//
//   • Openverse — an aggregator of openly-licensed images (Flickr, Wikimedia,
//     museums). Broad, and every result carries a licence, which matters
//     because these land on a screen and may be redrawn.
//   • Wikimedia Commons — the fallback, and the better answer for anything
//     encyclopedic (a species, a landmark, a person).
//
// Everything fetched goes through the same public-URL guard the browse tools
// use: a search result is model-adjacent data and must not be able to point
// this server at its own network.

import { isPublicHttpUrl } from './routes/browse'

const UA = 'TouchSphere/1.0 (dashboard; +https://github.com/danielmartinez98/touchsphere-dashboard)'
/** Bigger than the render cap: a web photo is fetched once and downscaled by the converter. */
const MAX_BYTES = 20 * 1024 * 1024
const FETCH_MS = 15_000

export interface ImageHit {
  url:      string
  title:    string
  source:   string
  license:  string
  width:    number
  height:   number
  /** Where the picture came from, for attribution — the page, not the file. */
  pageUrl:  string
}

async function get(url: string, accept: string, timeoutMs = FETCH_MS): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { headers: { 'user-agent': UA, accept }, signal: ctrl.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

/** Openverse. Anonymous access is rate-limited but needs no key. */
async function searchOpenverse(query: string, limit: number): Promise<ImageHit[]> {
  const qs = new URLSearchParams({
    q: query,
    page_size: String(Math.min(20, limit * 3)),
    // Nothing tiny: a 300px thumbnail is useless as a redraw source.
    size: 'medium,large',
    mature: 'false',
  })
  const res = await get(`https://api.openverse.org/v1/images/?${qs}`, 'application/json')
  if (!res.ok) throw new Error(`Openverse answered ${res.status}`)
  const j = await res.json() as { results?: Record<string, unknown>[] }
  return (j.results ?? []).map(r => ({
    url:     String(r['url'] ?? ''),
    title:   String(r['title'] ?? '').slice(0, 200),
    source:  String(r['source'] ?? 'openverse'),
    license: [r['license'], r['license_version']].filter(Boolean).join(' ').toUpperCase(),
    width:   Number(r['width']) || 0,
    height:  Number(r['height']) || 0,
    pageUrl: String(r['foreign_landing_url'] ?? ''),
  })).filter(h => h.url)
}

/** Wikimedia Commons, via the search generator with image info. */
async function searchCommons(query: string, limit: number): Promise<ImageHit[]> {
  const qs = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: '6', gsrlimit: String(Math.min(20, limit * 3)),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1600',
  })
  const res = await get(`https://commons.wikimedia.org/w/api.php?${qs}`, 'application/json')
  if (!res.ok) throw new Error(`Wikimedia answered ${res.status}`)
  const j = await res.json() as { query?: { pages?: Record<string, Record<string, unknown>> } }
  const pages = Object.values(j.query?.pages ?? {})
  return pages.map(p => {
    const info = (p['imageinfo'] as Record<string, unknown>[] | undefined)?.[0] ?? {}
    const meta = (info['extmetadata'] as Record<string, { value?: string }> | undefined) ?? {}
    return {
      // The scaled version when there is one: Commons originals run to 50 MP.
      url:     String(info['thumburl'] ?? info['url'] ?? ''),
      title:   String(p['title'] ?? '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '').slice(0, 200),
      source:  'wikimedia commons',
      license: String(meta['LicenseShortName']?.value ?? '').slice(0, 60),
      width:   Number(info['thumbwidth'] ?? info['width']) || 0,
      height:  Number(info['thumbheight'] ?? info['height']) || 0,
      pageUrl: String(info['descriptionurl'] ?? ''),
    }
  }).filter(h => h.url)
}

/**
 * Candidates for a query, best first.
 *
 * Openverse leads because it covers photographs of ordinary things; Commons
 * is added after it (not merely as a fallback) because for anything
 * encyclopedic it is the better answer and the two rarely overlap. Neither
 * failing is fatal — one provider down is a thinner list, not an error.
 */
export async function searchImages(query: string, limit = 6): Promise<ImageHit[]> {
  const q = query.trim().slice(0, 200)
  if (!q) return []
  const [ov, wc] = await Promise.allSettled([searchOpenverse(q, limit), searchCommons(q, limit)])
  const hits: ImageHit[] = []
  if (ov.status === 'fulfilled') hits.push(...ov.value)
  else console.warn(`[image-web] openverse: ${ov.reason instanceof Error ? ov.reason.message : ov.reason}`)
  if (wc.status === 'fulfilled') hits.push(...wc.value)
  else console.warn(`[image-web] commons: ${wc.reason instanceof Error ? wc.reason.message : wc.reason}`)

  // Drop anything the server must not fetch, then anything too small to be
  // worth redrawing, keeping unknown sizes (some providers omit them).
  const seen = new Set<string>()
  return hits.filter(h => {
    let u: URL
    try { u = new URL(h.url) } catch { return false }
    if (!isPublicHttpUrl(u)) return false
    if (h.width && h.height && (h.width < 400 || h.height < 400)) return false
    if (seen.has(h.url)) return false
    seen.add(h.url)
    return true
  }).slice(0, limit)
}

export interface FetchedImage { bytes: Buffer; type: string; hit: ImageHit }

/** Download one candidate, refusing anything that isn't an image or is too big. */
export async function fetchImage(hit: ImageHit): Promise<FetchedImage> {
  const u = new URL(hit.url)
  if (!isPublicHttpUrl(u)) throw new Error('that image URL is not fetchable')
  const res = await get(hit.url, 'image/*')
  if (!res.ok) throw new Error(`the image server answered ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error(`that link is ${type || 'not an image'}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len && len > MAX_BYTES) throw new Error('that image is too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('the image came back empty')
  if (buf.length > MAX_BYTES) throw new Error('that image is too large')
  return { bytes: buf, type, hit }
}

/**
 * Search, then download the first candidate that actually works.
 *
 * Tries in order rather than trusting the top hit: a search result is a
 * promise about a URL, and dead links, HTML error pages served as 200 and
 * hotlink blocks are all ordinary. Returns null when nothing survives, and
 * the caller says so rather than inventing a picture.
 */
export async function findAndFetch(query: string): Promise<FetchedImage | null> {
  const hits = await searchImages(query, 6)
  for (const hit of hits) {
    try {
      const got = await fetchImage(hit)
      console.log(`[image-web] "${query}" → ${hit.source} ${got.type} ${(got.bytes.length / 1024).toFixed(0)} KB — ${hit.title || hit.url}`)
      return got
    } catch (err) {
      console.warn(`[image-web] skipped ${hit.url}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return null
}
