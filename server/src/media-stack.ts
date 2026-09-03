// The media stack: Plex, Sonarr/Radarr, Bazarr, Seerr and qBittorrent, as one
// module of thin typed clients.
//
// Six services, one file, because the kiosk asks them one question each and
// the interesting work is stitching their answers together, not any one API:
//
//   • Plex      — what is IN the library (and how to play it)
//   • Seerr     — asking for something that ISN'T yet ("add season 2 of…")
//   • qBittorrent — whether that request is actually downloading
//   • Sonarr / Radarr — which show or film a torrent hash belongs to, since a
//                 torrent named "Show.S02.1080p.WEB-DL.x264-GROUP" is only
//                 readable by the person who set the stack up
//   • Bazarr    — which subtitle languages are still WANTED, which Plex can't
//                 say (Plex only knows what is on disk)
//
// Every service is optional and independently so: the panel is offered when
// Plex is configured, and each other block simply says it isn't set up rather
// than failing the panel — a torrent list that is down for a VPN restart must
// not take "continue watching" with it.
//
// All addresses are OPERATOR config (MEDIA_*_URL), pointing at the docker host
// or a tailnet address — so, exactly like COMFYUI_URL and RVC_URL, they bypass
// the isPublicHttpUrl() guard that exists for MODEL-supplied URLs. Nothing a
// language model says ever becomes a URL here; the tools take titles and the
// server resolves them against the library.

import axios, { type AxiosRequestConfig } from 'axios'
import crypto from 'crypto'

const HTTP_TIMEOUT_MS = 8000

// ── Config ───────────────────────────────────────────────────────────────────

function env(name: string): string {
  return (process.env[name] ?? '').trim().replace(/\/+$/, '')
}

export const PLEX_URL    = env('MEDIA_PLEX_URL')
export const PLEX_TOKEN  = env('MEDIA_PLEX_TOKEN')
const SONARR_URL  = env('MEDIA_SONARR_URL');  const SONARR_KEY = env('MEDIA_SONARR_KEY')
const RADARR_URL  = env('MEDIA_RADARR_URL');  const RADARR_KEY = env('MEDIA_RADARR_KEY')
const BAZARR_URL  = env('MEDIA_BAZARR_URL');  const BAZARR_KEY = env('MEDIA_BAZARR_KEY')
const SEERR_URL   = env('MEDIA_SEERR_URL');   const SEERR_KEY  = env('MEDIA_SEERR_KEY')
const QBIT_URL    = env('MEDIA_QBIT_URL')
const QBIT_USER   = env('MEDIA_QBIT_USER');   const QBIT_PASS  = process.env['MEDIA_QBIT_PASS'] ?? ''

/** The whole feature hangs off Plex: without it there is nothing to play. */
export function plexEnabled(): boolean { return !!(PLEX_URL && PLEX_TOKEN) }
export function seerrEnabled(): boolean { return !!(SEERR_URL && SEERR_KEY) }
export function qbitEnabled(): boolean { return !!(QBIT_URL && QBIT_USER && QBIT_PASS) }
export function bazarrEnabled(): boolean { return !!(BAZARR_URL && BAZARR_KEY) }
export function sonarrEnabled(): boolean { return !!(SONARR_URL && SONARR_KEY) }
export function radarrEnabled(): boolean { return !!(RADARR_URL && RADARR_KEY) }

// One identity for every request this server makes to Plex. Plex keys
// transcode sessions, "continue watching" and the players list to it, so it is
// stable for the life of the install rather than regenerated per process.
export const PLEX_CLIENT_ID = 'touchsphere-' + crypto
  .createHash('sha1').update(PLEX_TOKEN || 'unconfigured').digest('hex').slice(0, 16)

const PLEX_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'X-Plex-Product': 'TouchSphere',
  'X-Plex-Version': '1.0',
  'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  'X-Plex-Platform': 'Chrome',
  'X-Plex-Device': 'Kiosk',
  'X-Plex-Device-Name': 'TouchSphere',
}

export function plexHeaders(): Record<string, string> {
  return { ...PLEX_HEADERS, 'X-Plex-Token': PLEX_TOKEN }
}

// ── Plex ─────────────────────────────────────────────────────────────────────

export type PlexType = 'movie' | 'show' | 'season' | 'episode' | 'clip'

/** Someone credited on an item. `thumb` is an absolute URL on Plex's public CDN. */
export interface PlexPerson { name: string; role?: string; thumb?: string }
/** One score from one source: "imdb" 6.2 audience, "rottentomatoes" 4.3 critic. */
export interface PlexRating { source: string; value: number; kind: 'audience' | 'critic' }
/** A trailer or featurette Plex fetched for the item; playable by key like anything else. */
export interface PlexExtra { key: string; title: string; subtype?: string; duration?: number; thumb?: string }
/** A shelf: "Related Shows", "More with Yuki Kaji", "Recently Added in Anime". */
export interface PlexHub { id: string; title: string; items: PlexItem[]; more?: boolean }

/** One row of the library, flattened from Plex's Metadata element. */
export interface PlexItem {
  key: string                    // ratingKey — the id everything else takes
  type: PlexType
  title: string
  year?: number
  summary?: string
  /** Plex-relative image paths; the route turns them into /api/plex/img?path= */
  thumb?: string
  art?: string
  duration?: number              // ms
  viewOffset?: number            // ms, present when part-watched
  viewCount?: number
  addedAt?: number               // unix seconds
  lastViewedAt?: number
  /** Episode context: "Show · S2E5 · Title". */
  grandparentTitle?: string
  grandparentKey?: string
  parentTitle?: string
  parentKey?: string
  index?: number                 // episode number / season number
  parentIndex?: number           // season number, on an episode
  /** Show / season progress. */
  leafCount?: number
  viewedLeafCount?: number
  childCount?: number
  /** Content rating and audience score, for the detail card. */
  contentRating?: string
  rating?: number
  /** The critics' score, when the agent found one (Rotten Tomatoes on films). */
  criticRating?: number
  /** Per-file streams; only on items fetched by key (see itemsByKey). */
  media?: PlexMedia[]

  // ── What the agent wrote on the item ──────────────────────────────────────
  // Plex's own apps draw every one of these; the panel used to draw none.
  tagline?: string
  studio?: string
  originalTitle?: string
  /** "2016-04-02" — release or first-air date. */
  originallyAvailableAt?: string
  /** Which library it lives in. */
  sectionId?: number
  sectionTitle?: string
  /** An episode's season poster and its show's poster/backdrop. */
  parentThumb?: string
  grandparentThumb?: string
  grandparentArt?: string
  genres?: string[]
  /**
   * The four corner colours Plex derives from the poster ("UltraBlurColors"),
   * as bare hex — what its new apps paint behind an item page instead of a
   * blurred backdrop, and what makes each page look like its own poster.
   */
  colors?: { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string }

  // ── Only on a full fetch (plexItemFull) ───────────────────────────────────
  countries?: string[]
  directors?: PlexPerson[]
  writers?: PlexPerson[]
  cast?: PlexPerson[]
  ratings?: PlexRating[]
  /** imdb → "tt5603356", tmdb → "66103", tvdb → … */
  guids?: Record<string, string>
  extras?: PlexExtra[]
  related?: PlexHub[]
}

export interface PlexStream {
  id: number
  streamType: 1 | 2 | 3          // video / audio / subtitle
  codec?: string
  language?: string              // "English"
  languageCode?: string          // "eng"
  languageTag?: string           // "en"
  title?: string
  displayTitle?: string
  channels?: number
  forced?: boolean
  hearingImpaired?: boolean
  selected?: boolean
  /** Subtitles: false = embedded, true = sidecar file. */
  external?: boolean
}

export interface PlexMedia {
  id: number
  container?: string
  videoCodec?: string
  audioCodec?: string
  videoResolution?: string
  width?: number
  height?: number
  bitrate?: number
  parts: Array<{ id: number; file?: string; size?: number; streams: PlexStream[] }>
}

type Raw = Record<string, unknown>

function num(v: unknown): number | undefined { return typeof v === 'number' ? v : undefined }
function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined }

function toStream(s: Raw): PlexStream {
  return {
    id: num(s['id']) ?? 0,
    streamType: (num(s['streamType']) ?? 0) as 1 | 2 | 3,
    ...(str(s['codec']) ? { codec: str(s['codec']) } : {}),
    ...(str(s['language']) ? { language: str(s['language']) } : {}),
    ...(str(s['languageCode']) ? { languageCode: str(s['languageCode']) } : {}),
    ...(str(s['languageTag']) ? { languageTag: str(s['languageTag']) } : {}),
    ...(str(s['title']) ? { title: str(s['title']) } : {}),
    ...(str(s['displayTitle']) ? { displayTitle: str(s['displayTitle']) } : {}),
    ...(num(s['channels']) !== undefined ? { channels: num(s['channels']) } : {}),
    ...(s['forced'] ? { forced: true } : {}),
    ...(s['hearingImpaired'] ? { hearingImpaired: true } : {}),
    ...(s['selected'] ? { selected: true } : {}),
    ...(typeof s['key'] === 'string' ? { external: true } : {}),
  }
}

function toMedia(m: Raw): PlexMedia {
  const parts = Array.isArray(m['Part']) ? (m['Part'] as Raw[]) : []
  return {
    id: num(m['id']) ?? 0,
    ...(str(m['container']) ? { container: str(m['container']) } : {}),
    ...(str(m['videoCodec']) ? { videoCodec: str(m['videoCodec']) } : {}),
    ...(str(m['audioCodec']) ? { audioCodec: str(m['audioCodec']) } : {}),
    ...(str(m['videoResolution']) ? { videoResolution: str(m['videoResolution']) } : {}),
    ...(num(m['width']) !== undefined ? { width: num(m['width']) } : {}),
    ...(num(m['height']) !== undefined ? { height: num(m['height']) } : {}),
    ...(num(m['bitrate']) !== undefined ? { bitrate: num(m['bitrate']) } : {}),
    parts: parts.map(p => ({
      id: num(p['id']) ?? 0,
      ...(str(p['file']) ? { file: str(p['file']) } : {}),
      ...(num(p['size']) !== undefined ? { size: num(p['size']) } : {}),
      streams: Array.isArray(p['Stream']) ? (p['Stream'] as Raw[]).map(toStream) : [],
    })),
  }
}

function tags(v: unknown): string[] {
  return Array.isArray(v) ? (v as Raw[]).flatMap(t => (str(t['tag']) ? [str(t['tag'])!] : [])) : []
}

function people(v: unknown): PlexPerson[] {
  if (!Array.isArray(v)) return []
  return (v as Raw[]).flatMap(p => {
    const name = str(p['tag'])
    if (!name) return []
    return [{ name, ...(str(p['role']) ? { role: str(p['role']) } : {}), ...(str(p['thumb']) ? { thumb: str(p['thumb']) } : {}) }]
  })
}

/**
 * Plex names a rating's source in the image URI it ships for its badge —
 * `imdb://image.rating`, `rottentomatoes://image.rating.rotten` — so the
 * scheme is the source.
 */
function ratings(v: unknown): PlexRating[] {
  if (!Array.isArray(v)) return []
  return (v as Raw[]).flatMap(r => {
    const value = num(r['value'])
    const image = str(r['image']) ?? ''
    const source = image.split('://')[0] ?? ''
    if (value === undefined || !source) return []
    return [{ source, value, kind: str(r['type']) === 'critic' ? 'critic' as const : 'audience' as const }]
  })
}

/**
 * `full` adds the long tail — cast, crew, per-source ratings, trailers, the
 * related shelves — which is per-item weight the list views never show and a
 * 24-item grid would otherwise carry 24 casts of.
 */
export function toItem(m: Raw, full = false): PlexItem | null {
  const key = str(m['ratingKey'])
  const type = str(m['type'])
  const title = str(m['title'])
  if (!key || !title || !type) return null
  if (type !== 'movie' && type !== 'show' && type !== 'season' && type !== 'episode' && type !== 'clip') return null
  const opt = <K extends keyof PlexItem>(k: K, v: PlexItem[K] | undefined) =>
    v === undefined ? {} : { [k]: v }
  const ultra = m['UltraBlurColors']
  const colors = ultra && typeof ultra === 'object' ? (ultra as Raw) : null
  const c = (k: string) => (str(colors?.[k]) ?? '').replace(/^#/, '')
  const genres = tags(m['Genre'])
  const related = m['Related'] && typeof m['Related'] === 'object' ? (m['Related'] as Raw)['Hub'] : undefined
  const extras = m['Extras'] && typeof m['Extras'] === 'object' ? (m['Extras'] as Raw)['Metadata'] : undefined
  const guidList = Array.isArray(m['Guid']) ? (m['Guid'] as Raw[]) : []
  const guids: Record<string, string> = {}
  for (const g of guidList) {
    const id = str(g['id']) ?? ''
    const [scheme, value] = id.split('://')
    if (scheme && value) guids[scheme] = value
  }
  return {
    key, type, title,
    ...opt('tagline', str(m['tagline'])),
    ...opt('studio', str(m['studio'])),
    ...opt('originalTitle', str(m['originalTitle'])),
    ...opt('originallyAvailableAt', str(m['originallyAvailableAt'])),
    ...opt('sectionId', num(m['librarySectionID'])),
    ...opt('sectionTitle', str(m['librarySectionTitle'])),
    ...opt('parentThumb', str(m['parentThumb'])),
    ...opt('grandparentThumb', str(m['grandparentThumb'])),
    ...opt('grandparentArt', str(m['grandparentArt'])),
    ...(genres.length ? { genres } : {}),
    ...(colors && c('topLeft') && c('topRight') && c('bottomLeft') && c('bottomRight')
      ? { colors: { topLeft: c('topLeft'), topRight: c('topRight'), bottomLeft: c('bottomLeft'), bottomRight: c('bottomRight') } }
      : {}),
    // The bare `rating` is the critics' number when Plex ships a critic badge
    // for it, and a duplicate of the audience one otherwise.
    ...(str(m['ratingImage']) && num(m['rating']) !== undefined ? { criticRating: num(m['rating']) } : {}),
    ...(full ? {
      ...(tags(m['Country']).length ? { countries: tags(m['Country']) } : {}),
      ...(people(m['Director']).length ? { directors: people(m['Director']) } : {}),
      ...(people(m['Writer']).length ? { writers: people(m['Writer']) } : {}),
      ...(people(m['Role']).length ? { cast: people(m['Role']) } : {}),
      ...(ratings(m['Rating']).length ? { ratings: ratings(m['Rating']) } : {}),
      ...(Object.keys(guids).length ? { guids } : {}),
      ...(Array.isArray(extras) ? {
        extras: (extras as Raw[]).flatMap(e => {
          const k = str(e['ratingKey']); const t = str(e['title'])
          return k && t ? [{
            key: k, title: t,
            ...(str(e['subtype']) ? { subtype: str(e['subtype']) } : {}),
            ...(num(e['duration']) !== undefined ? { duration: num(e['duration']) } : {}),
            ...(str(e['thumb']) ? { thumb: str(e['thumb']) } : {}),
          }] : []
        }),
      } : {}),
      ...(Array.isArray(related) ? { related: hubs(related as Raw[]) } : {}),
    } : {}),
    ...opt('year', num(m['year'])),
    ...opt('summary', str(m['summary'])),
    ...opt('thumb', str(m['thumb'])),
    ...opt('art', str(m['art'])),
    ...opt('duration', num(m['duration'])),
    ...opt('viewOffset', num(m['viewOffset'])),
    ...opt('viewCount', num(m['viewCount'])),
    ...opt('addedAt', num(m['addedAt'])),
    ...opt('lastViewedAt', num(m['lastViewedAt'])),
    ...opt('grandparentTitle', str(m['grandparentTitle'])),
    ...opt('grandparentKey', str(m['grandparentRatingKey'])),
    ...opt('parentTitle', str(m['parentTitle'])),
    ...opt('parentKey', str(m['parentRatingKey'])),
    ...opt('index', num(m['index'])),
    ...opt('parentIndex', num(m['parentIndex'])),
    ...opt('leafCount', num(m['leafCount'])),
    ...opt('viewedLeafCount', num(m['viewedLeafCount'])),
    ...opt('childCount', num(m['childCount'])),
    ...opt('contentRating', str(m['contentRating'])),
    ...opt('rating', num(m['audienceRating']) ?? num(m['rating'])),
    ...(Array.isArray(m['Media']) ? { media: (m['Media'] as Raw[]).map(toMedia) } : {}),
  }
}

/** Plex's shelves, dropping the empty ones and anything that isn't a library item. */
function hubs(list: Raw[]): PlexHub[] {
  return list.flatMap(h => {
    const id = str(h['hubIdentifier']) ?? str(h['key']) ?? ''
    const title = str(h['title']) ?? ''
    const items = Array.isArray(h['Metadata']) ? (h['Metadata'] as Raw[]).map(x => toItem(x)).filter((x): x is PlexItem => !!x) : []
    if (!id || !title || !items.length) return []
    return [{ id, title, items, ...(h['more'] ? { more: true } : {}) }]
  })
}

async function plexGet<T = Raw>(path: string, params: Record<string, string | number> = {}, cfg: AxiosRequestConfig = {}): Promise<T> {
  const { data } = await axios.get<T>(`${PLEX_URL}${path}`, {
    headers: plexHeaders(),
    params,
    timeout: HTTP_TIMEOUT_MS,
    ...cfg,
  })
  return data
}

function container(data: unknown): Raw {
  const mc = (data as Raw | null)?.['MediaContainer']
  return mc && typeof mc === 'object' ? (mc as Raw) : {}
}

function metadata(data: unknown): PlexItem[] {
  const list = container(data)['Metadata']
  return Array.isArray(list) ? (list as Raw[]).map(x => toItem(x)).filter((x): x is PlexItem => !!x) : []
}

export interface PlexIdentity { name: string; version: string; machineIdentifier: string }

export async function plexIdentity(): Promise<PlexIdentity> {
  const mc = container(await plexGet('/'))
  return {
    name: str(mc['friendlyName']) ?? 'Plex',
    version: str(mc['version']) ?? '',
    machineIdentifier: str(mc['machineIdentifier']) ?? '',
  }
}

export interface PlexSection { key: string; title: string; type: 'movie' | 'show' | string }

export async function plexSections(): Promise<PlexSection[]> {
  const list = container(await plexGet('/library/sections'))['Directory']
  if (!Array.isArray(list)) return []
  return (list as Raw[]).flatMap(d => {
    const key = str(d['key']); const title = str(d['title']); const type = str(d['type'])
    return key && title && type ? [{ key, title, type }] : []
  })
}

/** "Continue watching" — the strip Plex itself puts first. */
export async function plexOnDeck(limit = 12): Promise<PlexItem[]> {
  return metadata(await plexGet('/library/onDeck', { 'X-Plex-Container-Size': limit })).slice(0, limit)
}

/**
 * Newest arrivals across every movie/show section, newest first.
 *
 * Plex's recentlyAdded lists the SEASON that arrived, not the show — which
 * drew a grid of season posters captioned "Season 3", "Season 16", each one
 * a tap away from the thing anyone would look for. So a season is replaced by
 * its show (one batched fetch for all of them), once per show, in the order
 * the seasons arrived. Films pass through as they are.
 */
export async function plexRecentlyAdded(limit = 24): Promise<PlexItem[]> {
  const items = metadata(await plexGet('/library/recentlyAdded', { 'X-Plex-Container-Size': limit * 2 }))
  const showKeys = [...new Set(items.flatMap(i => (i.type === 'season' && i.parentKey ? [i.parentKey] : [])))]
  const shows = new Map<string, PlexItem>()
  if (showKeys.length) {
    try {
      for (const s of await plexItemsByKey(showKeys)) shows.set(s.key, s)
    } catch (err) {
      console.warn('[plex] recently added: could not resolve shows:', err instanceof Error ? err.message : String(err))
    }
  }
  const out: PlexItem[] = []
  const seen = new Set<string>()
  for (const i of items) {
    const item = i.type === 'season' && i.parentKey ? shows.get(i.parentKey) ?? i : i
    if (seen.has(item.key)) continue
    seen.add(item.key)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Library search, movies and shows only. Plex's hub search returns every
 * kind — actors, collections, tags, individual episodes — and for "play
 * Severance" the show is the answer, so hubs are filtered to the two kinds a
 * person names, then episodes are added after them for "play the one where…".
 */
export async function plexSearch(query: string, limit = 12): Promise<PlexItem[]> {
  const data = await plexGet('/hubs/search', { query, limit, includeCollections: 0, includeExternalMedia: 0 })
  const hubs = container(data)['Hub']
  if (!Array.isArray(hubs)) return []
  const byType: Record<string, PlexItem[]> = {}
  for (const hub of hubs as Raw[]) {
    const type = str(hub['type']) ?? ''
    const list = Array.isArray(hub['Metadata']) ? (hub['Metadata'] as Raw[]).map(x => toItem(x)).filter((x): x is PlexItem => !!x) : []
    byType[type] = list
  }
  return [...(byType['movie'] ?? []), ...(byType['show'] ?? []), ...(byType['episode'] ?? [])].slice(0, limit)
}

/**
 * Full metadata — including every audio and subtitle stream — for up to a few
 * dozen items at once. Plex accepts a comma-separated list on this endpoint,
 * which is what makes "which languages does this SHOW have" affordable: the
 * list endpoints (children, allLeaves) carry Media/Part but not Stream, so
 * without batching a 200-episode series would be 200 round trips.
 */
export async function plexItemsByKey(keys: string[]): Promise<PlexItem[]> {
  const out: PlexItem[] = []
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25)
    out.push(...metadata(await plexGet(`/library/metadata/${batch.join(',')}`)))
  }
  return out
}

export async function plexItem(key: string): Promise<PlexItem | null> {
  const [item] = await plexItemsByKey([key])
  return item ?? null
}

/**
 * Everything the agent wrote on one item — cast with headshots, crew, every
 * rating source, the trailer, and the "Related" shelves Plex computes (similar
 * titles, more from the studio, more with each lead). One call: the extras
 * and related shelves ride along on the metadata endpoint when asked for.
 */
export async function plexItemFull(key: string): Promise<PlexItem | null> {
  const data = await plexGet(`/library/metadata/${key}`, { includeExtras: 1, includeRelated: 1, includeRelatedCount: 8 })
  const list = container(data)['Metadata']
  const raw = Array.isArray(list) ? (list[0] as Raw | undefined) : undefined
  return raw ? toItem(raw, true) : null
}

// ── Libraries, the way Plex organises them ───────────────────────────────────
//
// A Plex server is a set of LIBRARIES ("sections"): Movies, Anime, TV Shows…
// Each is a folder on disk plus a scanner (which reads the file/folder names)
// and an agent (which fetches the metadata and artwork for what the scanner
// found). Everything below is a view over one library: its shelves, its full
// list sorted and filtered, its genres, its disk folders, its collections.

export interface PlexSectionInfo {
  key: string
  title: string
  type: 'movie' | 'show' | string
  /** How many films or shows. */
  count: number
  /** A few recent posters, for a tile — libraries have no artwork of their own. */
  posters: string[]
}

export async function plexSectionsDetailed(): Promise<PlexSectionInfo[]> {
  const sections = (await plexSections()).filter(s => s.type === 'movie' || s.type === 'show')
  return Promise.all(sections.map(async s => {
    const data = await plexGet(`/library/sections/${s.key}/all`, {
      type: s.type === 'movie' ? 1 : 2, sort: 'addedAt:desc', 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 4,
    })
    const mc = container(data)
    const items = metadata(data)
    return { ...s, count: num(mc['totalSize']) ?? num(mc['size']) ?? items.length, posters: items.flatMap(i => (i.thumb ? [i.thumb] : [])) }
  }))
}

/** The sort keys Plex's own apps offer, as `sort=` values. */
export const SECTION_SORTS: Record<string, string> = {
  title:    'titleSort:asc',
  added:    'addedAt:desc',
  released: 'originallyAvailableAt:desc',
  rating:   'audienceRating:desc',
  watched:  'lastViewedAt:desc',
  random:   'random',
}

export interface SectionQuery { sort?: string; genre?: string; unwatched?: boolean; offset?: number; limit?: number }

/** One page of a library, sorted and filtered the way Plex does it. */
export async function plexSectionItems(section: PlexSection, q: SectionQuery): Promise<{ items: PlexItem[]; total: number }> {
  const params: Record<string, string | number> = {
    type: section.type === 'movie' ? 1 : 2,
    sort: SECTION_SORTS[q.sort ?? 'title'] ?? SECTION_SORTS['title']!,
    'X-Plex-Container-Start': q.offset ?? 0,
    'X-Plex-Container-Size': q.limit ?? 30,
  }
  if (q.genre) params['genre'] = q.genre
  // A film is unwatched; a show has unwatched episodes left. Different flags.
  if (q.unwatched) params[section.type === 'movie' ? 'unwatched' : 'unwatchedLeaves'] = 1
  const data = await plexGet(`/library/sections/${section.key}/all`, params)
  const mc = container(data)
  const items = metadata(data)
  return { items, total: num(mc['totalSize']) ?? num(mc['size']) ?? items.length }
}

export async function plexSectionGenres(sectionKey: string): Promise<{ id: string; title: string }[]> {
  const list = container(await plexGet(`/library/sections/${sectionKey}/genre`))['Directory']
  if (!Array.isArray(list)) return []
  return (list as Raw[]).flatMap(d => (str(d['key']) && str(d['title']) ? [{ id: str(d['key'])!, title: str(d['title'])! }] : []))
}

/** The shelves Plex draws at the top of a library: continue watching, recently added, start watching, top rated… */
export async function plexSectionHubs(sectionKey: string, count = 10): Promise<PlexHub[]> {
  const list = container(await plexGet(`/hubs/sections/${sectionKey}`, { count }))['Hub']
  return Array.isArray(list) ? hubs(list as Raw[]) : []
}

export interface PlexFolderEntry { parent: string; title: string }

/**
 * The library as it is on disk. Plex keeps the folder tree beside the
 * metadata tree, and `folder?parent=` walks it: a folder row has no
 * ratingKey and a `key` pointing one level down; a file is a real item.
 */
export async function plexFolder(sectionKey: string, parent?: string): Promise<{ title: string; folders: PlexFolderEntry[]; items: PlexItem[] }> {
  const data = await plexGet(`/library/sections/${sectionKey}/folder`, parent ? { parent } : {})
  const mc = container(data)
  const list = Array.isArray(mc['Metadata']) ? (mc['Metadata'] as Raw[]) : []
  const folders: PlexFolderEntry[] = []
  const items: PlexItem[] = []
  for (const m of list) {
    if (str(m['ratingKey'])) { const it = toItem(m); if (it) items.push(it); continue }
    const key = str(m['key']) ?? ''
    const p = key.match(/[?&]parent=(\d+)/)?.[1]
    const title = str(m['title'])
    if (p && title) folders.push({ parent: p, title })
  }
  return { title: str(mc['title2']) ?? str(mc['title1']) ?? '', folders, items }
}

export interface PlexCollection { key: string; title: string; count: number; thumb?: string; art?: string }

export async function plexCollections(sectionKey: string): Promise<PlexCollection[]> {
  const list = container(await plexGet(`/library/sections/${sectionKey}/collections`))['Metadata']
  if (!Array.isArray(list)) return []
  return (list as Raw[]).flatMap(m => {
    const key = str(m['ratingKey']); const title = str(m['title'])
    if (!key || !title) return []
    return [{
      key, title, count: num(m['childCount']) ?? 0,
      ...(str(m['thumb']) ? { thumb: str(m['thumb']) } : {}),
      ...(str(m['art']) ? { art: str(m['art']) } : {}),
    }]
  })
}

/** What is playing right now, on every Plex client — the kiosk, the TV app, a phone. */
export async function plexSessions(): Promise<PlexItem[]> {
  return metadata(await plexGet('/status/sessions'))
}

/** Seasons of a show, or episodes of a season. */
export async function plexChildren(key: string): Promise<PlexItem[]> {
  return metadata(await plexGet(`/library/metadata/${key}/children`))
}

/** Every episode of a show, in order. */
export async function plexLeaves(key: string): Promise<PlexItem[]> {
  return metadata(await plexGet(`/library/metadata/${key}/allLeaves`))
}

/**
 * The episode "play" means for a show or season with none named: where they
 * left off, else the first unwatched, else the first. The same rule Plex's own
 * play button uses, shared by the voice tool and the panel so a spoken "play
 * Severance" and a tap on its poster start the same episode.
 */
export async function nextEpisode(key: string, type: 'show' | 'season'): Promise<PlexItem | null> {
  const leaves = type === 'show' ? await plexLeaves(key) : await plexChildren(key)
  if (!leaves.length) return null
  return leaves.find(e => e.viewOffset) ?? leaves.find(e => !e.viewCount) ?? leaves[0]!
}

// ── Languages ────────────────────────────────────────────────────────────────

export interface LanguageSummary {
  /** Distinct audio languages, most common first: "English (5.1)", "Japanese". */
  audio: string[]
  subtitles: string[]
  /** Episodes (or files) examined. */
  files: number
  /** Per-language counts, so the panel can say "Japanese on 8 of 12 episodes". */
  audioCount: Record<string, number>
  subtitleCount: Record<string, number>
}

export function streamLabel(s: PlexStream): string {
  const lang = s.language ?? (s.languageCode ? s.languageCode.toUpperCase() : '') ?? ''
  const base = lang || (s.streamType === 2 ? 'Unknown audio' : 'Unknown')
  const flags: string[] = []
  if (s.streamType === 3) {
    if (s.forced) flags.push('forced')
    if (s.hearingImpaired) flags.push('SDH')
  }
  return flags.length ? `${base} (${flags.join(', ')})` : base
}

/** Fold the streams of many files into one answer. */
export function summarizeLanguages(items: PlexItem[]): LanguageSummary {
  const audioCount: Record<string, number> = {}
  const subtitleCount: Record<string, number> = {}
  let files = 0
  for (const it of items) {
    for (const m of it.media ?? []) for (const p of m.parts) {
      files++
      const seenA = new Set<string>(); const seenS = new Set<string>()
      for (const s of p.streams) {
        const label = streamLabel(s)
        if (s.streamType === 2 && !seenA.has(label)) { seenA.add(label); audioCount[label] = (audioCount[label] ?? 0) + 1 }
        if (s.streamType === 3 && !seenS.has(label)) { seenS.add(label); subtitleCount[label] = (subtitleCount[label] ?? 0) + 1 }
      }
    }
  }
  const order = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k]) => k)
  return { audio: order(audioCount), subtitles: order(subtitleCount), files, audioCount, subtitleCount }
}

/**
 * The languages of one library item, whatever its kind. A movie is its own
 * file; a season or show is every episode under it, fetched in batches.
 */
export async function plexLanguages(key: string): Promise<{ item: PlexItem; summary: LanguageSummary; episodes: PlexItem[] } | null> {
  const item = await plexItem(key)
  if (!item) return null
  if (item.type === 'movie' || item.type === 'episode') {
    return { item, summary: summarizeLanguages([item]), episodes: [] }
  }
  const leaves = item.type === 'show' ? await plexLeaves(key) : await plexChildren(key)
  const episodes = await plexItemsByKey(leaves.map(e => e.key))
  return { item, summary: summarizeLanguages(episodes), episodes }
}

// ── Players (other Plex apps on the network) ─────────────────────────────────

export interface PlexPlayer {
  id: string        // machineIdentifier of the client
  name: string
  product?: string
  address?: string
  port?: number
  protocolCapabilities?: string
}

/** Plex apps that have announced themselves to the server (GDM / Companion). */
export async function plexPlayers(): Promise<PlexPlayer[]> {
  const list = container(await plexGet('/clients'))['Server']
  if (!Array.isArray(list)) return []
  return (list as Raw[]).flatMap(s => {
    const id = str(s['machineIdentifier']); const name = str(s['name'])
    if (!id || !name) return []
    const caps = str(s['protocolCapabilities']) ?? ''
    // Only players that accept playback commands — a Plexamp that only
    // advertises "timeline" can't be told to start a film.
    if (!/playback/.test(caps)) return []
    return [{
      id, name,
      ...(str(s['product']) ? { product: str(s['product']) } : {}),
      ...(str(s['address']) ? { address: str(s['address']) } : {}),
      ...(num(s['port']) !== undefined ? { port: num(s['port']) } : {}),
      protocolCapabilities: caps,
    }]
  })
}

/**
 * The address OTHER devices reach this Plex server on — the LAN one, which is
 * not the docker-gateway address this container uses. Plex lists itself under
 * /servers with that address, so it is asked rather than configured.
 */
async function plexAdvertisedAddress(): Promise<{ address: string; port: number; machineIdentifier: string }> {
  const list = container(await plexGet('/servers'))['Server']
  const first = Array.isArray(list) ? (list as Raw[])[0] : undefined
  const fallback = new URL(PLEX_URL)
  return {
    address: str(first?.['address']) ?? fallback.hostname,
    port: num(first?.['port']) ?? Number(fallback.port || 32400),
    machineIdentifier: str(first?.['machineIdentifier']) ?? (await plexIdentity()).machineIdentifier,
  }
}

/** Tell another Plex app to start playing an item (Plex Companion, via the server's proxy). */
export async function plexPlayOn(playerId: string, key: string, offsetMs = 0): Promise<void> {
  const srv = await plexAdvertisedAddress()
  await axios.get(`${PLEX_URL}/player/playback/playMedia`, {
    headers: { ...plexHeaders(), 'X-Plex-Target-Client-Identifier': playerId },
    params: {
      key: `/library/metadata/${key}`,
      containerKey: `/library/metadata/${key}`,
      offset: offsetMs,
      machineIdentifier: srv.machineIdentifier,
      address: srv.address,
      port: srv.port,
      protocol: 'http',
      commandID: Date.now() % 100000,
      type: 'video',
    },
    timeout: HTTP_TIMEOUT_MS,
  })
}

// ── Playback on the kiosk itself ─────────────────────────────────────────────

export interface PlaySession {
  session: string
  key: string
  /** Path under /video/:/transcode/universal/ for the master playlist. */
  startPath: string
}

/**
 * Parameters for Plex's universal transcoder, the same endpoint Plex Web uses.
 * HLS rather than the raw file, because the kiosk is a Chromium on a Pi: an
 * MKV with DTS audio or HEVC video plays nowhere in a browser, and Plex knows
 * how to turn any of its files into something that does. `directStream=1`
 * lets it remux rather than re-encode when the video track is already fine —
 * an H.264 file costs the server an audio transcode and nothing else.
 */
export function transcodeParams(key: string, session: string, opts: { offsetMs?: number; maxHeight?: number; bitrate?: number } = {}): Record<string, string | number> {
  const height = opts.maxHeight ?? 720
  return {
    path: `/library/metadata/${key}`,
    mediaIndex: 0,
    partIndex: 0,
    protocol: 'hls',
    fastSeek: 1,
    directPlay: 0,
    directStream: 1,
    subtitleSize: 100,
    audioBoost: 100,
    videoQuality: 100,
    videoResolution: `${Math.round(height * 16 / 9)}x${height}`,
    maxVideoBitrate: opts.bitrate ?? (height >= 1080 ? 8000 : 4000),
    session,
    offset: Math.max(0, Math.round((opts.offsetMs ?? 0) / 1000)),
    'X-Plex-Session-Identifier': session,
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Client-Profile-Extra':
      // The kiosk's Chromium: H.264 + AAC in an MPEG-TS segment, nothing else.
      'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&subtitleCodec=&replace=true)',
  }
}

/** Choose the audio/subtitle stream Plex will use for the next play of this file. */
export async function plexSelectStreams(partId: number, audioStreamId?: number, subtitleStreamId?: number | 0): Promise<void> {
  const params: Record<string, number> = { allParts: 1 }
  if (audioStreamId !== undefined) params['audioStreamID'] = audioStreamId
  if (subtitleStreamId !== undefined) params['subtitleStreamID'] = subtitleStreamId
  await axios.put(`${PLEX_URL}/library/parts/${partId}`, null, { headers: plexHeaders(), params, timeout: HTTP_TIMEOUT_MS })
}

/** Stop a transcode session so the server stops burning CPU on a closed window. */
export async function plexStopTranscode(session: string): Promise<void> {
  try {
    await axios.get(`${PLEX_URL}/video/:/transcode/universal/stop`, {
      headers: plexHeaders(), params: { session }, timeout: HTTP_TIMEOUT_MS,
    })
  } catch { /* already gone */ }
}

/** Report where playback is, which is what makes "continue watching" work. */
export async function plexTimeline(key: string, state: 'playing' | 'paused' | 'stopped', timeMs: number, durationMs: number): Promise<void> {
  try {
    await axios.get(`${PLEX_URL}/:/timeline`, {
      headers: plexHeaders(),
      params: {
        ratingKey: key, key: `/library/metadata/${key}`, state,
        time: Math.round(timeMs), duration: Math.round(durationMs),
        'X-Plex-Session-Identifier': PLEX_CLIENT_ID,
      },
      timeout: HTTP_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[plex] timeline update failed:', err instanceof Error ? err.message : err)
  }
}

// ── Sonarr / Radarr ──────────────────────────────────────────────────────────

export interface ArrQueueItem {
  /** Torrent hash, lowercased — the join key against qBittorrent. */
  downloadId: string
  title: string          // "Severance · S2E3 · Who Is Alive?" or the film's title
  kind: 'show' | 'movie'
  status?: string
  trackedState?: string
  sizeleft?: number
  size?: number
  /**
   * Why it is where it is, in Sonarr/Radarr's own words: "waiting for a
   * better release", "import failed: file already exists", "no files found
   * eligible for import". The one thing anyone looking at a stuck row wants.
   */
  note?: string
}

/**
 * Sonarr/Radarr keep the explanation in two places: `statusMessages` (a list
 * of {title, messages[]}) and, for an outright failure, `errorMessage`. Both
 * are flattened to one line; a queue row usually has one sentence and never
 * needs more than a couple.
 */
function arrNote(r: Raw): string | undefined {
  const parts: string[] = []
  const sm = r['statusMessages']
  if (Array.isArray(sm)) {
    for (const m of sm as Raw[]) {
      const msgs = Array.isArray(m['messages']) ? (m['messages'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
      for (const t of msgs) if (t && !parts.includes(t)) parts.push(t)
    }
  }
  const err = str(r['errorMessage'])
  if (err && !parts.includes(err)) parts.unshift(err)
  const line = parts.join(' · ').trim()
  return line ? line.slice(0, 240) : undefined
}

async function arrGet<T>(base: string, key: string, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { data } = await axios.get<T>(`${base}${path}`, {
    headers: { 'X-Api-Key': key, Accept: 'application/json' },
    params, timeout: HTTP_TIMEOUT_MS,
  })
  return data
}

/** What Sonarr and Radarr are each waiting on, keyed by torrent hash. */
export async function arrQueue(): Promise<Map<string, ArrQueueItem>> {
  const out = new Map<string, ArrQueueItem>()
  const jobs: Promise<void>[] = []
  if (sonarrEnabled()) jobs.push((async () => {
    try {
      const data = await arrGet<{ records?: Raw[] }>(SONARR_URL, SONARR_KEY, '/api/v3/queue',
        { pageSize: 200, includeSeries: 'true', includeEpisode: 'true' })
      for (const r of data.records ?? []) {
        const id = str(r['downloadId'])?.toLowerCase(); if (!id) continue
        const series = r['series'] as Raw | undefined; const ep = r['episode'] as Raw | undefined
        const show = str(series?.['title']) ?? str(r['title']) ?? 'Unknown show'
        const se = ep ? ` · S${num(ep['seasonNumber']) ?? '?'}E${num(ep['episodeNumber']) ?? '?'}` : ''
        const epTitle = str(ep?.['title']) ? ` · ${str(ep?.['title'])}` : ''
        out.set(id, {
          downloadId: id, title: `${show}${se}${epTitle}`, kind: 'show',
          ...(str(r['status']) ? { status: str(r['status']) } : {}),
          ...(str(r['trackedDownloadState']) ? { trackedState: str(r['trackedDownloadState']) } : {}),
          ...(num(r['sizeleft']) !== undefined ? { sizeleft: num(r['sizeleft']) } : {}),
          ...(num(r['size']) !== undefined ? { size: num(r['size']) } : {}),
          ...(arrNote(r) ? { note: arrNote(r) } : {}),
        })
      }
    } catch (err) { console.warn('[media] sonarr queue:', err instanceof Error ? err.message : err) }
  })())
  if (radarrEnabled()) jobs.push((async () => {
    try {
      const data = await arrGet<{ records?: Raw[] }>(RADARR_URL, RADARR_KEY, '/api/v3/queue',
        { pageSize: 200, includeMovie: 'true' })
      for (const r of data.records ?? []) {
        const id = str(r['downloadId'])?.toLowerCase(); if (!id) continue
        const movie = r['movie'] as Raw | undefined
        const title = str(movie?.['title']) ?? str(r['title']) ?? 'Unknown film'
        const year = num(movie?.['year'])
        out.set(id, {
          downloadId: id, title: year ? `${title} (${year})` : title, kind: 'movie',
          ...(str(r['status']) ? { status: str(r['status']) } : {}),
          ...(str(r['trackedDownloadState']) ? { trackedState: str(r['trackedDownloadState']) } : {}),
          ...(num(r['sizeleft']) !== undefined ? { sizeleft: num(r['sizeleft']) } : {}),
          ...(num(r['size']) !== undefined ? { size: num(r['size']) } : {}),
          ...(arrNote(r) ? { note: arrNote(r) } : {}),
        })
      }
    } catch (err) { console.warn('[media] radarr queue:', err instanceof Error ? err.message : err) }
  })())
  await Promise.all(jobs)
  return out
}

// ── qBittorrent ──────────────────────────────────────────────────────────────

export interface Torrent {
  hash: string
  name: string
  /** Sonarr/Radarr's explanation of the row's state, when it has one. */
  note?: string
  /** What the *arr stack says this is, when it knows: "Severance · S2E3". */
  label?: string
  kind?: 'show' | 'movie'
  state: string           // qBittorrent's own: downloading, stalledDL, uploading, pausedDL, …
  /** Plain-English state for the screen and the voice: "downloading", "seeding", "paused", "stalled", "queued", "checking", "error". */
  phase: 'downloading' | 'seeding' | 'paused' | 'stalled' | 'queued' | 'checking' | 'done' | 'error'
  progress: number        // 0–1
  size: number            // bytes
  downloaded: number
  dlspeed: number         // bytes/s
  upspeed: number
  eta: number             // seconds; 8640000 = ∞ in qBittorrent
  seeds: number
  peers: number
  ratio: number
  addedOn: number         // unix seconds
  category?: string
}

let qbitCookie: string | null = null

// A failed login is remembered for a while rather than retried on every poll:
// qBittorrent bans the caller's IP after a handful of bad attempts (an hour by
// default), and the status probe alone would burn through that in minutes —
// which is exactly what a wrong MEDIA_QBIT_PASS did the first time it shipped.
const LOGIN_BACKOFF_MS = 10 * 60_000
let qbitLoginFailedAt = 0
let qbitLoginError = ''

async function qbitLogin(): Promise<void> {
  if (qbitLoginFailedAt && Date.now() - qbitLoginFailedAt < LOGIN_BACKOFF_MS) {
    throw new Error(`${qbitLoginError} — not retrying for a few minutes`)
  }
  const body = new URLSearchParams({ username: QBIT_USER, password: QBIT_PASS })
  const res = await axios.post<string>(`${QBIT_URL}/api/v2/auth/login`, body.toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: QBIT_URL, Origin: QBIT_URL },
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
  })
  // Two generations of qBittorrent answer this differently and both are in the
  // wild: 4.x replies `200 "Ok."` (and `200 "Fails."` for a wrong password),
  // 5.1+ replies `204 No Content` with the cookie and nothing else. The cookie
  // moved too — `SID` became `QBT_SID_<port>` — so it is matched by shape
  // rather than by name. The first version of this check accepted only the
  // old pair, which read a *successful* login on a current build as
  // "login failed (204)" and fell back to the *arr queue for good.
  const reply = String(res.data ?? '').trim()
  const ok = (res.status === 200 && /^Ok\.?$/i.test(reply)) || res.status === 204
  if (!ok) {
    qbitLoginFailedAt = Date.now()
    qbitLoginError = res.status === 403
      ? 'qBittorrent refused the login (banned IP or wrong password)'
      : `qBittorrent login failed (${res.status === 200 || res.status === 401 ? 'wrong password' : res.status})`
    throw new Error(qbitLoginError)
  }
  qbitLoginFailedAt = 0
  const cookie = (res.headers['set-cookie'] ?? [])
    .map((c: string) => c.split(';')[0])
    .find((c: string) => /^(QBT_)?SID(_\d+)?=/.test(c))
  if (!cookie) throw new Error('qBittorrent login returned no session cookie')
  qbitCookie = cookie
}

async function qbitFetch<T>(path: string, params: Record<string, string | number> = {}, method: 'get' | 'post' = 'get'): Promise<T> {
  const attempt = async (): Promise<{ status: number; data: T }> => {
    if (!qbitCookie) await qbitLogin()
    const cfg: AxiosRequestConfig = {
      headers: { Cookie: qbitCookie ?? '', Referer: QBIT_URL, ...(method === 'post' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    }
    const res = method === 'get'
      ? await axios.get<T>(`${QBIT_URL}${path}`, { ...cfg, params })
      : await axios.post<T>(`${QBIT_URL}${path}`, new URLSearchParams(params as Record<string, string>).toString(), cfg)
    return { status: res.status, data: res.data }
  }
  let r = await attempt()
  if (r.status === 403) {           // session expired (qBittorrent restarts with gluetun) — log in once more
    qbitCookie = null
    r = await attempt()
  }
  if (r.status !== 200) throw new Error(`qBittorrent ${path} → ${r.status}`)
  return r.data
}

function phaseOf(state: string, progress: number): Torrent['phase'] {
  if (/error|missingFiles/.test(state)) return 'error'
  if (/^(pausedDL|stoppedDL)$/.test(state)) return 'paused'
  if (/^(pausedUP|stoppedUP)$/.test(state)) return 'done'
  if (/checking|allocating|moving/.test(state)) return 'checking'
  if (/queued/.test(state)) return 'queued'
  if (/stalledDL/.test(state)) return 'stalled'
  if (/^(uploading|stalledUP|forcedUP)$/.test(state)) return 'seeding'
  if (progress >= 1) return 'done'
  return 'downloading'
}

/** Every torrent qBittorrent knows about, newest first, with the *arr label joined in. */
export async function torrents(): Promise<Torrent[]> {
  const [raw, labels] = await Promise.all([
    qbitFetch<Raw[]>('/api/v2/torrents/info', { sort: 'added_on', reverse: 'true' }),
    arrQueue(),
  ])
  return raw.flatMap(t => {
    const hash = str(t['hash'])?.toLowerCase(); const name = str(t['name'])
    if (!hash || !name) return []
    const state = str(t['state']) ?? 'unknown'
    const progress = num(t['progress']) ?? 0
    const label = labels.get(hash)
    return [{
      hash, name, state, progress,
      phase: phaseOf(state, progress),
      ...(label ? { label: label.title, kind: label.kind } : {}),
      ...(label?.note ? { note: label.note } : {}),
      size: num(t['size']) ?? 0,
      downloaded: num(t['downloaded']) ?? num(t['completed']) ?? 0,
      dlspeed: num(t['dlspeed']) ?? 0,
      upspeed: num(t['upspeed']) ?? 0,
      eta: num(t['eta']) ?? 8640000,
      seeds: num(t['num_seeds']) ?? 0,
      peers: num(t['num_leechs']) ?? 0,
      ratio: num(t['ratio']) ?? 0,
      addedOn: num(t['added_on']) ?? 0,
      ...(str(t['category']) ? { category: str(t['category']) } : {}),
    }]
  })
}

export interface TransferInfo { dlspeed: number; upspeed: number; connected: boolean }

export async function transferInfo(): Promise<TransferInfo> {
  const t = await qbitFetch<Raw>('/api/v2/transfer/info')
  return {
    dlspeed: num(t['dl_info_speed']) ?? 0,
    upspeed: num(t['up_info_speed']) ?? 0,
    connected: str(t['connection_status']) === 'connected',
  }
}

/**
 * Pause / resume are the only two controls offered. Deleting a torrent by
 * voice or by a mis-tap on a 7" screen throws away hours of download, and the
 * *arr stack would only re-grab it — so it stays in qBittorrent's own UI.
 */
export async function torrentControl(hash: string, action: 'pause' | 'resume'): Promise<void> {
  // qBittorrent 5 renamed pause/resume to stop/start; try the new name first
  // and fall back, since either may be what is installed.
  const paths = action === 'pause' ? ['/api/v2/torrents/stop', '/api/v2/torrents/pause'] : ['/api/v2/torrents/start', '/api/v2/torrents/resume']
  let lastErr: unknown
  for (const p of paths) {
    try { await qbitFetch(p, { hashes: hash }, 'post'); return } catch (err) { lastErr = err }
  }
  throw lastErr instanceof Error ? lastErr : new Error('qBittorrent refused the command')
}

// ── Seerr (requests) ─────────────────────────────────────────────────────────

/** Seerr's own media status codes. */
export type SeerrStatus = 'unknown' | 'pending' | 'processing' | 'partial' | 'available'
const SEERR_STATUS: Record<number, SeerrStatus> = { 1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partial', 5: 'available' }

export interface SeerrResult {
  tmdbId: number
  mediaType: 'movie' | 'tv'
  title: string
  year?: number
  overview?: string
  /** TMDB poster path, e.g. /abc.jpg — the route proxies it. */
  poster?: string
  /** Where the library stands on it: unknown = not requested, available = on Plex. */
  status: SeerrStatus
}

export interface SeerrRequest {
  id: number
  mediaType: 'movie' | 'tv'
  tmdbId: number
  title: string
  year?: number
  poster?: string
  /** Request state: pending approval / approved / declined. */
  requestStatus: 'pending' | 'approved' | 'declined'
  /** Media state: where the download stands. */
  status: SeerrStatus
  createdAt: string
  seasons?: number[]
}

async function seerrGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { data } = await axios.get<T>(`${SEERR_URL}/api/v1${path}`, {
    headers: { 'X-Api-Key': SEERR_KEY, Accept: 'application/json' },
    params, timeout: HTTP_TIMEOUT_MS,
  })
  return data
}

function toSeerrResult(r: Raw): SeerrResult | null {
  const mediaType = str(r['mediaType'])
  const id = num(r['id'])
  if (!id || (mediaType !== 'movie' && mediaType !== 'tv')) return null
  const title = str(r['title']) ?? str(r['name'])
  if (!title) return null
  const date = str(r['releaseDate']) ?? str(r['firstAirDate'])
  const year = date ? Number(date.slice(0, 4)) : NaN
  const info = r['mediaInfo'] as Raw | undefined
  return {
    tmdbId: id, mediaType, title,
    ...(Number.isFinite(year) ? { year } : {}),
    ...(str(r['overview']) ? { overview: str(r['overview']) } : {}),
    ...(str(r['posterPath']) ? { poster: str(r['posterPath']) } : {}),
    status: SEERR_STATUS[num(info?.['status']) ?? 1] ?? 'unknown',
  }
}

/** Search TMDB through Seerr, which annotates each hit with whether it is already in the library. */
export async function seerrSearch(query: string, limit = 10): Promise<SeerrResult[]> {
  const data = await seerrGet<{ results?: Raw[] }>('/search', { query, page: 1, language: 'en' })
  return (data.results ?? []).map(toSeerrResult).filter((x): x is SeerrResult => !!x)
    .filter(r => r.mediaType === 'movie' || r.mediaType === 'tv')
    .slice(0, limit)
}

/** Ask for a film, or every season of a show. */
export async function seerrRequest(mediaType: 'movie' | 'tv', tmdbId: number, seasons?: number[]): Promise<SeerrRequest> {
  const body: Raw = { mediaType, mediaId: tmdbId }
  if (mediaType === 'tv') body['seasons'] = seasons && seasons.length ? seasons : 'all'
  const { data } = await axios.post<Raw>(`${SEERR_URL}/api/v1/request`, body, {
    headers: { 'X-Api-Key': SEERR_KEY, Accept: 'application/json' },
    timeout: HTTP_TIMEOUT_MS,
  })
  const req = await toSeerrRequest(data)
  if (!req) throw new Error('Seerr accepted the request but returned nothing usable')
  return req
}

const REQ_STATUS: Record<number, SeerrRequest['requestStatus']> = { 1: 'pending', 2: 'approved', 3: 'declined' }

async function toSeerrRequest(r: Raw, titles?: Map<string, { title: string; year?: number; poster?: string }>): Promise<SeerrRequest | null> {
  const id = num(r['id']); const media = r['media'] as Raw | undefined
  const mediaType = str(media?.['mediaType']) ?? str(r['type'])
  const tmdbId = num(media?.['tmdbId'])
  if (!id || !tmdbId || (mediaType !== 'movie' && mediaType !== 'tv')) return null
  const cacheKey = `${mediaType}:${tmdbId}`
  let t = titles?.get(cacheKey)
  if (!t) {
    // A request carries ids only; the title lives on TMDB, which Seerr proxies.
    try {
      const d = await seerrGet<Raw>(`/${mediaType}/${tmdbId}`)
      const title = str(d['title']) ?? str(d['name']) ?? `#${tmdbId}`
      const date = str(d['releaseDate']) ?? str(d['firstAirDate'])
      const year = date ? Number(date.slice(0, 4)) : NaN
      t = { title, ...(Number.isFinite(year) ? { year } : {}), ...(str(d['posterPath']) ? { poster: str(d['posterPath']) } : {}) }
    } catch { t = { title: `#${tmdbId}` } }
    titles?.set(cacheKey, t)
  }
  const seasons = Array.isArray(r['seasons'])
    ? (r['seasons'] as Raw[]).map(s => num(s['seasonNumber'])).filter((n): n is number => n !== undefined)
    : []
  return {
    id, mediaType, tmdbId, title: t.title,
    ...(t.year ? { year: t.year } : {}),
    ...(t.poster ? { poster: t.poster } : {}),
    requestStatus: REQ_STATUS[num(r['status']) ?? 1] ?? 'pending',
    status: SEERR_STATUS[num(media?.['status']) ?? 1] ?? 'unknown',
    createdAt: str(r['createdAt']) ?? '',
    ...(seasons.length ? { seasons } : {}),
  }
}

/** The most recent requests, newest first. */
export async function seerrRequests(limit = 15): Promise<SeerrRequest[]> {
  const data = await seerrGet<{ results?: Raw[] }>('/request', { take: limit, skip: 0, sort: 'added', filter: 'all' })
  const titles = new Map<string, { title: string; year?: number; poster?: string }>()
  const out: SeerrRequest[] = []
  for (const r of data.results ?? []) {
    const req = await toSeerrRequest(r, titles)
    if (req) out.push(req)
  }
  return out
}

// ── Bazarr (subtitles still wanted) ──────────────────────────────────────────

export interface BazarrWanted {
  /** Subtitle languages Bazarr is configured to fetch for this title. */
  wanted: string[]
  /** Of those, the ones still missing on at least one file: "Spanish (3 episodes)". */
  missing: string[]
}

async function bazarrGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { data } = await axios.get<T>(`${BAZARR_URL}/api${path}`, {
    headers: { 'X-API-KEY': BAZARR_KEY, Accept: 'application/json' },
    params, timeout: HTTP_TIMEOUT_MS,
  })
  return data
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * What Bazarr still wants for a title. Matched by name, since Plex and Bazarr
 * share no id — Bazarr keys on Sonarr/Radarr ids and Plex on its own. A title
 * Bazarr doesn't track returns null, which the panel shows as nothing rather
 * than as "no subtitles wanted".
 */
export async function bazarrWanted(kind: 'movie' | 'show', title: string, year?: number): Promise<BazarrWanted | null> {
  const want = normTitle(title)
  const pick = (rows: Raw[]): Raw | undefined => {
    const hits = rows.filter(r => normTitle(str(r['title']) ?? '') === want)
    if (hits.length > 1 && year) return hits.find(r => num(r['year']) === year || str(r['year']) === String(year)) ?? hits[0]
    return hits[0]
  }
  if (kind === 'movie') {
    const data = await bazarrGet<{ data?: Raw[] }>('/movies', { start: 0, length: -1 })
    const m = pick(data.data ?? [])
    if (!m) return null
    const missing = Array.isArray(m['missing_subtitles']) ? (m['missing_subtitles'] as Raw[]).map(s => str(s['name']) ?? '').filter(Boolean) : []
    const have = Array.isArray(m['subtitles']) ? (m['subtitles'] as Raw[]).map(s => str(s['name']) ?? '').filter(Boolean) : []
    return { wanted: [...new Set([...have, ...missing])], missing: [...new Set(missing)] }
  }
  const series = await bazarrGet<{ data?: Raw[] }>('/series', { start: 0, length: -1 })
  const s = pick(series.data ?? [])
  const sid = s ? num(s['sonarrSeriesId']) : undefined
  if (!sid) return null
  const eps = await bazarrGet<{ data?: Raw[] }>('/episodes', { 'seriesid[]': sid })
  const missingCount: Record<string, number> = {}
  const wanted = new Set<string>()
  for (const e of eps.data ?? []) {
    for (const sub of Array.isArray(e['subtitles']) ? (e['subtitles'] as Raw[]) : []) { const n = str(sub['name']); if (n) wanted.add(n) }
    for (const sub of Array.isArray(e['missing_subtitles']) ? (e['missing_subtitles'] as Raw[]) : []) {
      const n = str(sub['name']); if (!n) continue
      wanted.add(n); missingCount[n] = (missingCount[n] ?? 0) + 1
    }
  }
  return {
    wanted: [...wanted],
    missing: Object.entries(missingCount).map(([n, c]) => `${n} (${c} episode${c === 1 ? '' : 's'})`),
  }
}

// ── Health ───────────────────────────────────────────────────────────────────

export interface ServiceHealth { configured: boolean; ok: boolean; detail?: string }

async function check(configured: boolean, probe: () => Promise<string>): Promise<ServiceHealth> {
  if (!configured) return { configured: false, ok: false }
  try { return { configured: true, ok: true, detail: await probe() } }
  catch (err) { return { configured: true, ok: false, detail: err instanceof Error ? err.message : String(err) } }
}

export async function stackHealth(): Promise<Record<'plex' | 'sonarr' | 'radarr' | 'bazarr' | 'seerr' | 'qbit', ServiceHealth>> {
  const [plex, sonarr, radarr, bazarr, seerr, qbit] = await Promise.all([
    check(plexEnabled(), async () => { const i = await plexIdentity(); return `${i.name} ${i.version}` }),
    check(sonarrEnabled(), async () => { const d = await arrGet<Raw>(SONARR_URL, SONARR_KEY, '/api/v3/system/status'); return `Sonarr ${str(d['version']) ?? ''}` }),
    check(radarrEnabled(), async () => { const d = await arrGet<Raw>(RADARR_URL, RADARR_KEY, '/api/v3/system/status'); return `Radarr ${str(d['version']) ?? ''}` }),
    check(bazarrEnabled(), async () => { const d = await bazarrGet<Raw>('/system/status'); const v = (d['data'] as Raw | undefined)?.['bazarr_version']; return `Bazarr ${str(v) ?? ''}` }),
    check(seerrEnabled(), async () => { const d = await seerrGet<Raw>('/status'); return `Seerr ${str(d['version']) ?? ''}` }),
    check(qbitEnabled(), async () => { const t = await transferInfo(); return t.connected ? 'connected' : 'no peers connection' }),
  ])
  return { plex, sonarr, radarr, bazarr, seerr, qbit }
}
