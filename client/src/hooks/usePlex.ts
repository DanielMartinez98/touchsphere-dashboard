// The media stack, as the client sees it: types mirrored from
// server/src/media-stack.ts, small fetch helpers, and the two module stores
// that cross the component tree —
//
//   • the PLAYER target (usePlexPlayer): which library item is playing full
//     screen. A module store for the usual reason: `play_media` is a voice tool,
//     and a voice command can't reach into a component's useState.
//   • the PANEL request (onPlexPanelRequest): "open the Plex corner on this
//     tab / this title". Same event shape as onDrawPanelRequest — App.tsx
//     subscribes and opens the corner, the panel reads what it was opened on.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

// ── Types (mirror server/src/media-stack.ts) ─────────────────────────────────

export type PlexType = 'movie' | 'show' | 'season' | 'episode' | 'clip'

export interface PlexPerson { name: string; role?: string; thumb?: string }
export interface PlexRating { source: string; value: number; kind: 'audience' | 'critic' }
export interface PlexExtra { key: string; title: string; subtype?: string; duration?: number; thumb?: string }
export interface PlexHub { id: string; title: string; items: PlexItem[]; more?: boolean }
export interface PlexSectionInfo { key: string; title: string; type: 'movie' | 'show' | string; count: number; posters: string[] }
export interface PlexFolderEntry { parent: string; title: string }
export interface PlexCollection { key: string; title: string; count: number; thumb?: string; art?: string }
export type SectionSort = 'title' | 'added' | 'released' | 'rating' | 'watched' | 'random'

export interface PlexItem {
  key: string
  type: PlexType
  title: string
  year?: number
  summary?: string
  thumb?: string
  art?: string
  duration?: number
  viewOffset?: number
  viewCount?: number
  addedAt?: number
  lastViewedAt?: number
  grandparentTitle?: string
  grandparentKey?: string
  parentTitle?: string
  parentKey?: string
  index?: number
  parentIndex?: number
  leafCount?: number
  viewedLeafCount?: number
  childCount?: number
  contentRating?: string
  rating?: number
  criticRating?: number
  media?: PlexMedia[]
  tagline?: string
  studio?: string
  originalTitle?: string
  originallyAvailableAt?: string
  sectionId?: number
  sectionTitle?: string
  parentThumb?: string
  grandparentThumb?: string
  grandparentArt?: string
  genres?: string[]
  colors?: { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string }
  countries?: string[]
  directors?: PlexPerson[]
  writers?: PlexPerson[]
  cast?: PlexPerson[]
  ratings?: PlexRating[]
  guids?: Record<string, string>
  extras?: PlexExtra[]
  related?: PlexHub[]
}

export interface PlexStream {
  id: number
  streamType: 1 | 2 | 3
  codec?: string
  language?: string
  languageCode?: string
  title?: string
  displayTitle?: string
  channels?: number
  forced?: boolean
  hearingImpaired?: boolean
  selected?: boolean
  external?: boolean
}

export interface PlexMedia {
  id: number
  container?: string
  videoCodec?: string
  audioCodec?: string
  videoResolution?: string
  parts: Array<{ id: number; file?: string; size?: number; streams: PlexStream[] }>
}

export interface LanguageSummary {
  audio: string[]
  subtitles: string[]
  files: number
  audioCount: Record<string, number>
  subtitleCount: Record<string, number>
}

export interface PlexItemDetail {
  item: PlexItem
  children: PlexItem[]
  languages: LanguageSummary
  subtitles: { wanted: string[]; missing: string[] } | null
  perEpisode: Array<{ key: string; audio: string[]; subtitles: string[] }>
}

export interface PlexPlayerInfo { id: string; name: string; product?: string }

/** What the panel can offer to do about a download (server/src/downloads.ts). */
export type DownloadAction =
  | 'resume' | 'pause' | 'recheck' | 'reannounce' | 'force-start' | 'top'
  | 'refresh-import' | 'replace' | 'remove' | 'remove-data'

export interface DownloadAdvice {
  level: 'ok' | 'working' | 'info' | 'warn' | 'error'
  headline: string
  detail: string
  actions: DownloadAction[]
  evidence: string[]
}

export interface StackAdvice { level: DownloadAdvice['level']; headline: string; detail: string }

export interface StackHealth {
  connection: 'connected' | 'firewalled' | 'disconnected' | 'unknown'
  dhtNodes: number
  altSpeed: boolean
  altDownKB: number
  altUpKB: number
  maxConnections: number
  maxActiveDownloads: number
  queueing: boolean
  freeSpaceGB: number | null
  systemFreeGB: number | null
  downloadPath: string | null
}

export interface TorrentTracker { url: string; status: number; msg?: string; peers: number; seeds: number }

export interface TorrentProps {
  savePath?: string
  seeds: number; seedsTotal: number; peers: number; peersTotal: number
  connections: number; uploaded: number; wasted: number
  timeElapsedSec: number; seedingTimeSec: number; lastSeenComplete: number
  piecesHave: number; piecesNum: number; reannounceInSec: number
}

export interface ArrQueueRow {
  downloadId: string; queueId: number; title: string; kind: 'show' | 'movie'
  status?: string; trackedState?: string; sizeleft?: number; size?: number; note?: string
}

export interface TorrentDetail {
  torrent: Torrent
  trackers: TorrentTracker[]
  props: TorrentProps | null
  health: StackHealth | null
  arr: ArrQueueRow | null
  advice: DownloadAdvice
}

export interface Torrent {
  hash: string
  name: string
  note?: string
  /** The server's verdict: what is wrong and what would fix it. */
  advice?: DownloadAdvice
  label?: string
  kind?: 'show' | 'movie'
  state: string
  phase: 'downloading' | 'seeding' | 'paused' | 'stalled' | 'queued' | 'checking' | 'done' | 'error'
  progress: number
  size: number
  downloaded: number
  dlspeed: number
  upspeed: number
  eta: number
  seeds: number
  peers: number
  swarmSeeds: number
  swarmPeers: number
  ratio: number
  addedOn: number
  category?: string
}

export type SeerrStatus = 'unknown' | 'pending' | 'processing' | 'partial' | 'available'

export interface SeerrResult {
  tmdbId: number
  mediaType: 'movie' | 'tv'
  title: string
  year?: number
  overview?: string
  poster?: string
  status: SeerrStatus
}

export interface SeerrRequest {
  id: number
  mediaType: 'movie' | 'tv'
  tmdbId: number
  title: string
  year?: number
  poster?: string
  requestStatus: 'pending' | 'approved' | 'declined'
  status: SeerrStatus
  createdAt: string
  seasons?: number[]
}

export interface PlexStatus {
  enabled: boolean
  services: Record<'plex' | 'sonarr' | 'radarr' | 'bazarr' | 'seerr' | 'qbit', { configured: boolean; ok: boolean; detail?: string }>
  features: { requests: boolean; torrents: boolean; subtitles: boolean }
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

async function delJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' })
  const data = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** Poster URL for a Plex item — the server proxies it, so the token stays on the server. */
export function plexImg(path: string | undefined, w = 300): string | null {
  if (!path) return null
  // Cast headshots are absolute URLs on Plex's public CDN; nothing to proxy.
  if (/^https?:/.test(path)) return path
  return `/api/plex/img?path=${encodeURIComponent(path)}&w=${w}&h=${Math.round(w * 1.5)}`
}

/** Backdrop URL, 16:9. Same proxy, landscape size. */
export function plexArt(path: string | undefined, w = 720): string | null {
  if (!path) return null
  return `/api/plex/img?path=${encodeURIComponent(path)}&w=${w}&h=${Math.round(w * 9 / 16)}`
}

/** TMDB poster for a Seerr hit; `poster` is "/abc.jpg". */
export function tmdbPoster(poster: string | undefined): string | null {
  if (!poster) return null
  return `/api/plex/poster/${poster.replace(/^\//, '')}`
}

export const plexApi = {
  status:   () => getJson<PlexStatus>('/api/plex/status'),
  home:     () => getJson<{ onDeck: PlexItem[]; recent: PlexItem[] }>('/api/plex/home'),
  search:   (q: string) => getJson<{ items: PlexItem[] }>(`/api/plex/search?q=${encodeURIComponent(q)}`),
  sections: () => getJson<{ sections: PlexSectionInfo[] }>('/api/plex/sections'),
  section:  (id: string, q: { sort?: SectionSort; genre?: string; unwatched?: boolean; offset?: number; limit?: number }) => {
    const p = new URLSearchParams()
    if (q.sort) p.set('sort', q.sort)
    if (q.genre) p.set('genre', q.genre)
    if (q.unwatched) p.set('unwatched', '1')
    if (q.offset) p.set('offset', String(q.offset))
    if (q.limit) p.set('limit', String(q.limit))
    return getJson<{ items: PlexItem[]; total: number; offset: number }>(`/api/plex/section/${id}?${p.toString()}`)
  },
  sectionGenres:      (id: string) => getJson<{ genres: { id: string; title: string }[] }>(`/api/plex/section/${id}/genres`),
  sectionHubs:        (id: string) => getJson<{ hubs: PlexHub[] }>(`/api/plex/section/${id}/hubs`),
  sectionFolder:      (id: string, parent?: string) => getJson<{ title: string; folders: PlexFolderEntry[]; items: PlexItem[] }>(`/api/plex/section/${id}/folder${parent ? `?parent=${parent}` : ''}`),
  sectionCollections: (id: string) => getJson<{ collections: PlexCollection[] }>(`/api/plex/section/${id}/collections`),
  collection:         (key: string) => getJson<{ items: PlexItem[] }>(`/api/plex/collection/${key}`),
  item:     (key: string) => getJson<PlexItemDetail>(`/api/plex/item/${key}`),
  players:  () => getJson<{ players: PlexPlayerInfo[] }>('/api/plex/players'),
  play:     (body: { key: string; player?: string; partId?: number; audioStreamId?: number; subtitleStreamId?: number; offsetMs?: number; maxHeight?: number }) =>
    postJson<{ mode: 'local'; key: string; session: string; title: string; src: string; offsetMs: number; durationMs: number } | { mode: 'remote'; key: string; title: string }>('/api/plex/play', body),
  stop:     (session: string, timeMs?: number, durationMs?: number) => postJson<{ ok: true }>('/api/plex/stop', { session, timeMs, durationMs }),
  progress: (body: { key: string; state: 'playing' | 'paused' | 'stopped'; timeMs: number; durationMs: number; session?: string; role?: string }) => postJson<{ ok: true }>('/api/plex/progress', body),
  /** What the kiosk is playing, for the phone. */
  now:      () => getJson<{ playing: { key: string; title: string; thumb?: string; state: 'playing' | 'paused' | 'stopped'; timeMs: number; durationMs: number; at: number } | null; kiosks: number }>('/api/plex/now'),
  /** Tell the kiosk's player what to do. */
  remote:   (body: { action: 'play' | 'pause' | 'resume' | 'stop'; key?: string; title?: string }) => postJson<{ ok: true; kiosks: number }>('/api/plex/remote', body),
  torrents: () => getJson<{
    source: 'qbit' | 'arr'; warning?: string; torrents: Torrent[]
    transfer: { dlspeed: number; upspeed: number; connected: boolean } | null
    health: StackHealth | null; stackAdvice: StackAdvice[]
  }>('/api/plex/torrents'),
  /** One download in full, with the trackers and the precise verdict. */
  torrent:  (hash: string) => getJson<TorrentDetail>(`/api/plex/torrents/${hash}`),
  torrentAction: (hash: string, action: DownloadAction) =>
    postJson<{ ok: true; did?: string; detail?: string }>(`/api/plex/torrents/${hash}/${action}`, {}),
  removeTorrent: (hash: string, opts: { files: boolean; blocklist: boolean; search: boolean }) => {
    const p = new URLSearchParams()
    if (opts.files) p.set('files', '1')
    if (opts.blocklist) p.set('blocklist', '1')
    if (opts.search) p.set('search', '1')
    return delJson<{ ok: true; detail?: string }>(`/api/plex/torrents/${hash}?${p.toString()}`)
  },
  requests: () => getJson<{ requests: SeerrRequest[] }>('/api/plex/requests'),
  discover: (q: string) => getJson<{ results: SeerrResult[] }>(`/api/plex/discover?q=${encodeURIComponent(q)}`),
  request:  (mediaType: 'movie' | 'tv', tmdbId: number, seasons?: number[]) => postJson<{ request: SeerrRequest }>('/api/plex/request', { mediaType, tmdbId, seasons }),
}

// ── Enabled? ─────────────────────────────────────────────────────────────────

/**
 * Whether the media stack is configured — and, like the Draw corner's
 * `enabled`, re-polled while false, because the server and the app container
 * come up in whatever order the box pleases and a kiosk has nothing to reload
 * itself with.
 */
export function usePlexStatus() {
  const [status, setStatus] = useState<PlexStatus | null>(null)
  const refresh = useCallback(async () => {
    try { setStatus(await plexApi.status()) } catch { setStatus(null) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (status?.enabled && status.services.plex.ok) return
    const t = setInterval(() => { void refresh() }, 30_000)
    return () => clearInterval(t)
  }, [status, refresh])
  return status
}

// ── Player store ─────────────────────────────────────────────────────────────

export interface PlayTarget {
  key: string
  title: string
  /** Chosen streams, when picked in the detail view before pressing Play. */
  partId?: number
  audioStreamId?: number
  subtitleStreamId?: number
  /** Start here rather than at the saved position; 0 = from the beginning. */
  offsetMs?: number
  seq: number
}

let seq = 0
let target: PlayTarget | null = null
const playerListeners = new Set<() => void>()
function subscribePlayer(cb: () => void) { playerListeners.add(cb); return () => { playerListeners.delete(cb) } }
function getPlayer() { return target }
function emitPlayer() { playerListeners.forEach(cb => cb()) }

/** Play a library item full screen on the kiosk. */
export function openPlexPlayer(t: Omit<PlayTarget, 'seq'>) {
  target = { ...t, seq: ++seq }
  emitPlayer()
}

export function closePlexPlayer() {
  if (!target) return
  target = null
  emitPlayer()
}

export function isPlexPlayerOpen(): boolean { return target !== null }

export function usePlexPlayerTarget() {
  return useSyncExternalStore(subscribePlayer, getPlayer, getPlayer)
}

// ── Panel request ────────────────────────────────────────────────────────────

export type PlexTab = 'library' | 'downloads' | 'requests'

export interface PlexPanelRequest {
  tab: PlexTab
  /** Open straight onto this item. */
  key?: string
  /** Pre-fill the search field. */
  query?: string
  seq: number
}

let panelReq: PlexPanelRequest | null = null
const panelListeners = new Set<() => void>()
const openListeners = new Set<() => void>()
function subscribePanel(cb: () => void) { panelListeners.add(cb); return () => { panelListeners.delete(cb) } }
function getPanel() { return panelReq }

/** Bring the Plex corner up on a tab (and optionally an item or a search). */
export function requestPlexPanel(req: Omit<PlexPanelRequest, 'seq'>) {
  panelReq = { ...req, seq: ++seq }
  panelListeners.forEach(cb => cb())
  openListeners.forEach(cb => cb())
}

/** App.tsx: open the corner whenever something asks for it. */
export function onPlexPanelRequest(cb: () => void) {
  openListeners.add(cb)
  return () => { openListeners.delete(cb) }
}

/** The panel: what it was last asked to show. */
export function usePlexPanelRequest() {
  return useSyncExternalStore(subscribePanel, getPanel, getPanel)
}
