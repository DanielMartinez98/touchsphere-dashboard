// REST surface for the media stack (Plex + Seerr + qBittorrent + *arr + Bazarr).
// The clients are in ../media-stack.ts; this file only shapes their answers for
// the screen and proxies the two things a browser can't fetch from Plex itself:
// images and the HLS stream, both of which need the token this server holds.

import { Router, Request, Response } from 'express'
import axios from 'axios'
import crypto from 'crypto'
import { broadcast, kioskCount } from './system'
import { nudgePlexWatch } from '../plex-watch'
import { diagnose, diagnoseStack } from '../downloads'
import {
  arrQueue,
  bazarrEnabled,
  bazarrWanted,
  nextEpisode,
  PLEX_URL,
  plexChildren,
  plexCollections,
  plexEnabled,
  plexFolder,
  plexHeaders,
  plexItem,
  plexItemFull,
  plexLanguages,
  plexSectionGenres,
  plexSectionHubs,
  plexSectionItems,
  plexSections,
  plexSectionsDetailed,
  plexOnDeck,
  plexPlayOn,
  plexPlayers,
  plexRecentlyAdded,
  plexSearch,
  plexSelectStreams,
  plexStopTranscode,
  plexTimeline,
  qbitEnabled,
  seerrEnabled,
  seerrRequest,
  seerrRequests,
  seerrSearch,
  stackHealth,
  arrQueueRemove,
  arrRefreshImports,
  stackDownloadHealth,
  torrentCommand,
  torrentControl,
  torrentProperties,
  torrentRemove,
  torrents,
  torrentTrackers,
  transcodeParams,
  transferInfo,
  type PlexItem,
} from '../media-stack'

const router = Router()

const disabled = (res: Response, what = 'Plex') =>
  res.status(503).json({ error: `${what} isn't configured on this server` })

function msg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

// ── Status ───────────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  const health = await stackHealth()
  res.json({
    enabled: plexEnabled(),
    services: health,
    // The three optional blocks the panel offers, so it can hide what isn't there.
    features: { requests: seerrEnabled(), torrents: qbitEnabled(), subtitles: bazarrEnabled() },
  })
})

// ── Library ──────────────────────────────────────────────────────────────────

/** Strip the per-file stream detail the list views don't need. */
function slim(item: PlexItem): PlexItem {
  const { media: _m, ...rest } = item
  return rest
}

router.get('/home', async (_req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try {
    const [onDeck, recent] = await Promise.all([plexOnDeck(12), plexRecentlyAdded(24)])
    res.json({ onDeck: onDeck.map(slim), recent: recent.map(slim) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

// ── Libraries ────────────────────────────────────────────────────────────────
// The way Plex itself is organised: a library per folder on disk, each with
// its own shelves, its sortable/filterable list, its genres, its disk folders
// and its collections. Everything here is read straight from the section.

router.get('/sections', async (_req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try { res.json({ sections: await plexSectionsDetailed() }) }
  catch (err) { res.status(502).json({ error: `Plex: ${msg(err)}` }) }
})

async function sectionOr404(id: string, res: Response) {
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'bad section' }); return null }
  const s = (await plexSections()).find(x => x.key === id)
  if (!s) { res.status(404).json({ error: 'no such library' }); return null }
  return s
}

router.get('/section/:id', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try {
    const s = await sectionOr404(String(req.params['id'] ?? ''), res)
    if (!s) return
    const offset = Math.max(0, Number(req.query['offset']) || 0)
    const limit = Math.min(60, Math.max(1, Number(req.query['limit']) || 30))
    const genre = String(req.query['genre'] ?? '')
    const { items, total } = await plexSectionItems(s, {
      sort: String(req.query['sort'] ?? 'title'),
      ...(/^\d+$/.test(genre) ? { genre } : {}),
      unwatched: req.query['unwatched'] === '1',
      offset, limit,
    })
    res.json({ section: s, items: items.map(slim), total, offset })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

router.get('/section/:id/genres', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  try {
    const s = await sectionOr404(String(req.params['id'] ?? ''), res)
    if (!s) return
    res.json({ genres: await plexSectionGenres(s.key) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

router.get('/section/:id/hubs', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try {
    const s = await sectionOr404(String(req.params['id'] ?? ''), res)
    if (!s) return
    const hubs = await plexSectionHubs(s.key, 12)
    res.json({ hubs: hubs.map(h => ({ ...h, items: h.items.map(slim) })) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

router.get('/section/:id/folder', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try {
    const s = await sectionOr404(String(req.params['id'] ?? ''), res)
    if (!s) return
    const parent = String(req.query['parent'] ?? '')
    const f = await plexFolder(s.key, /^\d+$/.test(parent) ? parent : undefined)
    res.json({ ...f, items: f.items.map(slim) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

router.get('/section/:id/collections', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  try {
    const s = await sectionOr404(String(req.params['id'] ?? ''), res)
    if (!s) return
    res.json({ collections: await plexCollections(s.key) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

/** A collection's members — Plex models a collection as an item with children. */
router.get('/collection/:key', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const key = String(req.params['key'] ?? '')
  if (!/^\d+$/.test(key)) return res.status(400).json({ error: 'bad key' })
  try { res.json({ items: (await plexChildren(key)).map(slim) }) }
  catch (err) { res.status(502).json({ error: `Plex: ${msg(err)}` }) }
})

router.get('/search', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const q = String(req.query['q'] ?? '').trim()
  if (!q) return res.json({ items: [] })
  try {
    res.json({ items: (await plexSearch(q, 20)).map(slim) })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

/**
 * One item in full: its children (seasons of a show, episodes of a season),
 * the languages across every file under it, and — when Bazarr is configured —
 * which subtitle languages are still being hunted for.
 */
router.get('/item/:key', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const key = String(req.params['key'] ?? '')
  if (!/^\d+$/.test(key)) return res.status(400).json({ error: 'bad key' })
  res.setHeader('Cache-Control', 'no-store')
  try {
    const langs = await plexLanguages(key)
    if (!langs) return res.status(404).json({ error: 'not in the library' })
    const { summary, episodes } = langs
    // The stream-bearing item from the languages pass, plus everything the
    // agent wrote on it — cast, ratings, trailer, related — from the full one.
    let item = langs.item
    try {
      const full = await plexItemFull(key)
      if (full) item = { ...full, ...(item.media ? { media: item.media } : {}) }
    } catch (err) { console.warn('[plex] full metadata:', msg(err)) }
    const children = item.type === 'show' || item.type === 'season' ? await plexChildren(key) : []
    let subtitles: Awaited<ReturnType<typeof bazarrWanted>> = null
    if (bazarrEnabled() && (item.type === 'show' || item.type === 'movie')) {
      try { subtitles = await bazarrWanted(item.type, item.title, item.year) } catch (err) { console.warn('[plex] bazarr:', msg(err)) }
    }
    // Per-episode language rows for a season page, so a mixed season ("only
    // episodes 1–4 have the dub") is visible without opening each one.
    const perEpisode = item.type === 'season'
      ? episodes.map(e => ({ key: e.key, audio: languagesOf(e, 2), subtitles: languagesOf(e, 3) }))
      : []
    res.json({ item, children: children.map(slim), languages: summary, subtitles, perEpisode })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

function languagesOf(item: PlexItem, streamType: 2 | 3): string[] {
  const out = new Set<string>()
  for (const m of item.media ?? []) for (const p of m.parts) for (const s of p.streams) {
    if (s.streamType === streamType) out.add(s.language ?? s.languageCode?.toUpperCase() ?? 'Unknown')
  }
  return [...out]
}

// ── Images ───────────────────────────────────────────────────────────────────

/**
 * Poster / backdrop, resized by Plex's own transcoder. The token never reaches
 * the browser; only Plex-relative library paths are accepted so this can't be
 * turned into an open proxy.
 */
router.get('/img', async (req: Request, res: Response) => {
  if (!plexEnabled()) return res.status(503).end()
  const path = String(req.query['path'] ?? '')
  if (!/^\/(library|photo)\/[\w\-./:%]+$/.test(path)) return res.status(400).end()
  const width = Math.min(1200, Math.max(60, Number(req.query['w']) || 300))
  const height = Math.min(1800, Math.max(60, Number(req.query['h']) || Math.round(width * 1.5)))
  try {
    const upstream = await axios.get<ArrayBuffer>(`${PLEX_URL}/photo/:/transcode`, {
      headers: plexHeaders(),
      params: { url: path, width, height, minSize: 1, upscale: 1 },
      responseType: 'arraybuffer',
      timeout: 10_000,
    })
    res.setHeader('Content-Type', String(upstream.headers['content-type'] ?? 'image/jpeg'))
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(Buffer.from(upstream.data))
  } catch {
    res.status(502).end()
  }
})

/** TMDB poster for a Seerr search hit / request. Public CDN, sized for a card. */
router.get('/poster/:file', async (req: Request, res: Response) => {
  const file = String(req.params['file'] ?? '')
  if (!/^[\w-]+\.(jpg|png|webp)$/i.test(file)) return res.status(400).end()
  try {
    const upstream = await axios.get<ArrayBuffer>(`https://image.tmdb.org/t/p/w342/${file}`, {
      responseType: 'arraybuffer', timeout: 10_000,
    })
    res.setHeader('Content-Type', String(upstream.headers['content-type'] ?? 'image/jpeg'))
    res.setHeader('Cache-Control', 'public, max-age=604800')
    res.send(Buffer.from(upstream.data))
  } catch {
    res.status(502).end()
  }
})

// ── Playback ─────────────────────────────────────────────────────────────────

router.get('/players', async (_req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  res.setHeader('Cache-Control', 'no-store')
  try { res.json({ players: await plexPlayers() }) }
  catch (err) { res.status(502).json({ error: `Plex: ${msg(err)}` }) }
})

/**
 * Live transcode sessions started from this server, keyed by the session id
 * the client is handed. The HLS proxy needs the query the master playlist was
 * asked with, and the client must never see it — it would carry the token.
 */
interface Session { key: string; params: Record<string, string | number>; startedAt: number; lastSeen: number }
const sessions = new Map<string, Session>()
const SESSION_IDLE_MS = 10 * 60_000

// A window closed by a crash or a power cut never sends /stop; sweep the ones
// nobody has fetched a segment for in ten minutes so Plex stops transcoding.
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) { sessions.delete(id); void plexStopTranscode(id) }
  }
}, 60_000).unref()

router.post('/play', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const body = (req.body ?? {}) as Record<string, unknown>
  let key = String(body['key'] ?? '')
  if (!/^\d+$/.test(key)) return res.status(400).json({ error: 'bad key' })
  const player = typeof body['player'] === 'string' && body['player'] ? body['player'] : null
  const audio = typeof body['audioStreamId'] === 'number' ? body['audioStreamId'] : undefined
  const subs = typeof body['subtitleStreamId'] === 'number' ? body['subtitleStreamId'] : undefined
  const partId = typeof body['partId'] === 'number' ? body['partId'] : undefined
  const offsetMs = typeof body['offsetMs'] === 'number' && body['offsetMs'] >= 0 ? body['offsetMs'] : undefined

  try {
    let item = await plexItem(key)
    if (!item) return res.status(404).json({ error: 'not in the library' })
    if (item.type === 'show' || item.type === 'season') {
      // A show's poster was tapped: play the episode they are on.
      item = await nextEpisode(item.key, item.type)
      if (!item) return res.status(404).json({ error: 'no episodes in the library yet' })
    }
    key = item.key
    // Plex records the stream choice on the file, so setting it before starting
    // the transcode is what makes the transcoder pick it up.
    if (partId !== undefined && (audio !== undefined || subs !== undefined)) {
      await plexSelectStreams(partId, audio, subs)
    }
    const startAt = offsetMs ?? item.viewOffset ?? 0

    if (player) {
      await plexPlayOn(player, key, startAt)
      return res.json({ mode: 'remote', key, title: displayTitle(item) })
    }

    const session = crypto.randomUUID()
    const maxHeight = typeof body['maxHeight'] === 'number' ? body['maxHeight'] : 720
    sessions.set(session, { key, params: transcodeParams(key, session, { offsetMs: startAt, maxHeight }), startedAt: Date.now(), lastSeen: Date.now() })
    res.json({
      mode: 'local', key, session,
      title: displayTitle(item),
      src: `/api/plex/hls/${session}/start.m3u8`,
      offsetMs: startAt,
      durationMs: item.duration ?? 0,
    })
  } catch (err) {
    res.status(502).json({ error: `Plex: ${msg(err)}` })
  }
})

export function displayTitle(item: PlexItem): string {
  if (item.type === 'episode') {
    const se = item.parentIndex !== undefined && item.index !== undefined ? ` S${item.parentIndex}E${item.index}` : ''
    return `${item.grandparentTitle ?? ''}${se} · ${item.title}`.replace(/^ · /, '')
  }
  return item.year ? `${item.title} (${item.year})` : item.title
}

/**
 * The HLS proxy. Plex's master playlist points at `session/<id>/base/index.m3u8`
 * relative to itself and the media playlist at `00001.ts` relative to THAT, so
 * mounting `/video/:/transcode/universal/` at `/api/plex/hls/<session>/` keeps
 * every reference resolving without rewriting a byte — the session id in the
 * path is how the token-bearing query is looked up for the first request.
 */
router.get('/hls/:session/{*rest}', async (req: Request, res: Response) => {
  if (!plexEnabled()) return res.status(503).end()
  const sessionId = String(req.params['session'] ?? '')
  const s = sessions.get(sessionId)
  if (!s) return res.status(404).end()
  s.lastSeen = Date.now()
  const restParam = req.params['rest'] as unknown
  const rest = Array.isArray(restParam) ? restParam.join('/') : String(restParam ?? '')
  if (!/^[\w\-./:]+$/.test(rest) || rest.includes('..')) return res.status(400).end()

  const isStart = rest === 'start.m3u8'
  const upstreamPath = `/video/:/transcode/universal/${rest}`
  try {
    const upstream = await axios.get(`${PLEX_URL}${upstreamPath}`, {
      headers: plexHeaders(),
      params: isStart ? s.params : {},
      responseType: 'stream',
      timeout: 60_000,
      validateStatus: () => true,
    })
    res.status(upstream.status)
    const ct = String(upstream.headers['content-type'] ?? (rest.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'))
    res.setHeader('Content-Type', ct)
    res.setHeader('Cache-Control', 'no-store')
    if (rest.endsWith('.m3u8')) {
      // Playlists are small; buffer them so an absolute reference (Plex has
      // used `/video/:/transcode/universal/…` in some versions) can be pointed
      // back through this proxy.
      const chunks: Buffer[] = []
      for await (const c of upstream.data as AsyncIterable<Buffer>) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
        .replace(/^\/video\/:\/transcode\/universal\//gm, `/api/plex/hls/${sessionId}/`)
      res.send(text)
    } else {
      req.on('close', () => { try { (upstream.data as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.() } catch { /* */ } })
      ;(upstream.data as NodeJS.ReadableStream).pipe(res)
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).end()
    console.warn('[plex] hls proxy:', msg(err))
  }
})

router.post('/stop', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const session = String(body['session'] ?? '')
  const s = sessions.get(session)
  if (s) {
    sessions.delete(session)
    const timeMs = typeof body['timeMs'] === 'number' ? body['timeMs'] : undefined
    const durationMs = typeof body['durationMs'] === 'number' ? body['durationMs'] : 0
    if (timeMs !== undefined) await plexTimeline(s.key, 'stopped', timeMs, durationMs)
    await plexStopTranscode(session)
  }
  res.json({ ok: true })
})

/** Progress heartbeat from the player — this is what "continue watching" is built from. */
// ── The kiosk's player, seen from a phone ────────────────────────────────────
//
// The kiosk reports its position every 10 s anyway (for Plex's own resume
// point); keeping the last report here is what lets the phone say "Akira,
// 0:41:12, playing" without the kiosk having to be asked. Only the KIOSK's
// reports count — a phone playing something itself is not "on the kiosk".

interface NowPlaying { key: string; title: string; thumb?: string; state: 'playing' | 'paused' | 'stopped'; timeMs: number; durationMs: number; at: number }
let nowPlaying: NowPlaying | null = null
const titleCache = new Map<string, { title: string; thumb?: string }>()

async function describe(key: string): Promise<{ title: string; thumb?: string }> {
  const hit = titleCache.get(key)
  if (hit) return hit
  const item = await plexItem(key)
  const d = item ? { title: displayTitle(item), ...(item.thumb ?? item.grandparentThumb ? { thumb: (item.thumb ?? item.grandparentThumb)! } : {}) } : { title: 'Plex' }
  titleCache.set(key, d)
  if (titleCache.size > 200) titleCache.delete(titleCache.keys().next().value!)
  return d
}

router.post('/progress', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const body = (req.body ?? {}) as Record<string, unknown>
  const key = String(body['key'] ?? '')
  const state = body['state']
  if (!/^\d+$/.test(key) || (state !== 'playing' && state !== 'paused' && state !== 'stopped')) {
    return res.status(400).json({ error: 'bad progress' })
  }
  const timeMs = Number(body['timeMs']) || 0
  const durationMs = Number(body['durationMs']) || 0
  const session = typeof body['session'] === 'string' ? sessions.get(body['session']) : undefined
  if (session) session.lastSeen = Date.now()
  await plexTimeline(key, state, timeMs, durationMs)
  // The list follows: added and in progress on play, done once Plex says so.
  nudgePlexWatch()
  if (body['role'] !== 'companion') {
    if (state === 'stopped') nowPlaying = null
    else {
      const d = await describe(key).catch(() => ({ title: 'Plex' }))
      nowPlaying = { key, ...d, state, timeMs, durationMs, at: Date.now() }
    }
    broadcast('plex-now', { playing: nowPlaying }, 'companion')
  }
  res.json({ ok: true })
})

/** What the kiosk is playing right now, if anything, and whether one is listening at all. */
router.get('/now', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  // A report older than 90 s is a player that went away without saying so.
  const fresh = nowPlaying && Date.now() - nowPlaying.at < 90_000 ? nowPlaying : null
  res.json({ playing: fresh, kiosks: kioskCount() })
})

/**
 * Tell the kiosk's player what to do. Goes to the KIOSK connections only —
 * the phone that sent it must not open a player of its own — and answers with
 * how many kiosks heard it, which is the honest thing to show when none did.
 */
router.post('/remote', async (req: Request, res: Response) => {
  if (!plexEnabled()) return disabled(res)
  const body = (req.body ?? {}) as Record<string, unknown>
  const action = body['action']
  if (action !== 'play' && action !== 'pause' && action !== 'resume' && action !== 'stop') {
    return res.status(400).json({ error: 'action must be play, pause, resume or stop' })
  }
  const key = String(body['key'] ?? '')
  if (action === 'play' && !/^\d+$/.test(key)) return res.status(400).json({ error: 'play needs a key' })
  let title = typeof body['title'] === 'string' ? body['title'] : ''
  if (action === 'play' && !title) title = (await describe(key).catch(() => ({ title: 'Plex' }))).title
  const kiosks = kioskCount()
  broadcast('plex-remote', { action, ...(action === 'play' ? { key, title } : {}) }, 'kiosk')
  console.log(`[plex] remote ${action}${key ? ` ${key}` : ''} → ${kiosks} kiosk(s)`)
  res.json({ ok: true, kiosks })
})

// ── Downloads ────────────────────────────────────────────────────────────────

router.get('/torrents', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  // Without qBittorrent — not configured, or configured and not answering,
  // which on this stack means a wrong password or gluetun mid-reconnect — the
  // *arr queues still say what is on the way, just without speeds. Better
  // than an empty tab, and the same shape, so the panel needn't know.
  let qbitError: string | null = null
  if (qbitEnabled()) {
    try {
      // The per-row verdict here is the CHEAP one: no trackers and no
      // properties, because those are a call each and this list runs to a
      // hundred rows. Opening a row fetches them and re-judges it precisely.
      const [list, transfer, health, arr] = await Promise.all([
        torrents(), transferInfo(), stackDownloadHealth(), arrQueue(),
      ])
      return res.json({
        source: 'qbit',
        torrents: list.map(t => ({ ...t, advice: diagnose({ torrent: t, arr: arr.get(t.hash), stack: health }) })),
        transfer,
        health,
        stackAdvice: diagnoseStack(health, list),
      })
    } catch (err) {
      qbitError = msg(err)
    }
  }
  try {
    const queue = [...(await arrQueue()).values()]
    res.json({ source: 'arr', ...(qbitError ? { warning: `qBittorrent: ${qbitError}` } : {}), torrents: queue.map(q => ({
      hash: q.downloadId, name: q.title, label: q.title, kind: q.kind, state: q.status ?? 'unknown',
      ...(q.note ? { note: q.note } : {}),
      phase: q.trackedState === 'importPending' || q.trackedState === 'importing' ? 'done' : 'downloading',
      progress: q.size && q.sizeleft !== undefined ? 1 - q.sizeleft / q.size : 0,
      size: q.size ?? 0, downloaded: (q.size ?? 0) - (q.sizeleft ?? 0),
      dlspeed: 0, upspeed: 0, eta: 8640000, seeds: 0, peers: 0, ratio: 0, addedOn: 0,
    })), transfer: null, health: null, stackAdvice: [] })
  } catch (err) {
    res.status(502).json({ error: qbitError ? `qBittorrent: ${qbitError}` : msg(err) })
  }
})

/**
 * Everything known about one download, and the precise verdict — the list's
 * cheap one re-judged with the trackers and properties, which is what turns
 * "no seeders" into "the tracker has dropped this torrent".
 */
router.get('/torrents/:hash', async (req: Request, res: Response) => {
  if (!qbitEnabled()) return disabled(res, 'qBittorrent')
  const hash = String(req.params['hash'] ?? '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hash)) return res.status(400).json({ error: 'bad hash' })
  res.setHeader('Cache-Control', 'no-store')
  try {
    const [list, arr, health] = await Promise.all([torrents(), arrQueue(), stackDownloadHealth()])
    const torrent = list.find(t => t.hash === hash)
    if (!torrent) return res.status(404).json({ error: 'qBittorrent has no torrent with that hash' })
    // These two are per-torrent calls, which is why they are here and not in
    // the list. Either failing costs precision, not the answer.
    const [trackers, props] = await Promise.all([
      torrentTrackers(hash).catch(() => undefined),
      torrentProperties(hash).catch(() => undefined),
    ])
    const item = arr.get(hash)
    res.json({
      torrent, trackers: trackers ?? [], props: props ?? null, health,
      arr: item ?? null,
      advice: diagnose({ torrent, arr: item, trackers, props: props ?? undefined, stack: health }),
    })
  } catch (err) {
    res.status(502).json({ error: `qBittorrent: ${msg(err)}` })
  }
})

const ACTIONS = new Set(['pause', 'resume', 'recheck', 'reannounce', 'force-start', 'top', 'refresh-import', 'replace'])

/**
 * Do something about one download.
 *
 * The first six go straight to qBittorrent. `refresh-import` pokes the *arr
 * into re-examining its queue. `replace` is the compound one people actually
 * want for a dead release: blocklist it so the *arr never grabs that file
 * again, search for a different one, and bin the torrent and its data.
 */
router.post('/torrents/:hash/:action', async (req: Request, res: Response) => {
  if (!qbitEnabled()) return disabled(res, 'qBittorrent')
  const hash = String(req.params['hash'] ?? '').toLowerCase()
  const action = String(req.params['action'] ?? '')
  if (!/^[0-9a-f]{40}$/.test(hash)) return res.status(400).json({ error: 'bad hash' })
  if (!ACTIONS.has(action)) return res.status(400).json({ error: `action must be one of ${[...ACTIONS].join(', ')}` })
  try {
    if (action === 'pause' || action === 'resume') {
      await torrentControl(hash, action)
      return res.json({ ok: true, did: action })
    }
    if (action === 'refresh-import') {
      const item = (await arrQueue()).get(hash)
      const names = await arrRefreshImports(item?.kind)
      return res.json({ ok: true, did: 'refresh-import', detail: names.length ? `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} re-checking the queue.` : 'No *arr is configured to import this.' })
    }
    if (action === 'replace') {
      const item = (await arrQueue()).get(hash)
      let arrName: string | null = null
      if (item) arrName = await arrQueueRemove(item, { blocklist: true, search: true, removeFromClient: false })
      await torrentRemove(hash, true)
      return res.json({
        ok: true, did: 'replace',
        detail: arrName
          ? `${arrName} has blocklisted that release and is searching for another; the torrent and its files are gone.`
          : 'The torrent and its files are gone. No *arr was tracking it, so nothing will be searched for automatically.',
      })
    }
    await torrentCommand(hash, action as 'recheck' | 'reannounce' | 'force-start' | 'top')
    res.json({ ok: true, did: action })
  } catch (err) {
    res.status(502).json({ error: msg(err) })
  }
})

/**
 * Remove a download. `files=1` deletes what it downloaded, `blocklist=1`
 * records the release as bad in the *arr so it is never grabbed again, and
 * `search=1` asks for a replacement. The three are separate because "I have
 * this already" and "this release is broken" want different combinations.
 */
router.delete('/torrents/:hash', async (req: Request, res: Response) => {
  if (!qbitEnabled()) return disabled(res, 'qBittorrent')
  const hash = String(req.params['hash'] ?? '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hash)) return res.status(400).json({ error: 'bad hash' })
  const files = req.query['files'] === '1'
  const blocklist = req.query['blocklist'] === '1'
  const search = req.query['search'] === '1'
  try {
    const item = (await arrQueue()).get(hash)
    let arrName: string | null = null
    // The *arr goes first: removing the torrent underneath it would leave the
    // queue row orphaned and complaining about a download that no longer exists.
    if (item) arrName = await arrQueueRemove(item, { blocklist, search, removeFromClient: false })
    await torrentRemove(hash, files)
    const parts = [files ? 'the torrent and its files are gone' : 'the torrent is gone, its files are still on disk']
    if (arrName && blocklist) parts.push(`${arrName} has blocklisted that release`)
    if (arrName && search) parts.push('and is searching for another')
    else if (arrName) parts.push(`and dropped it from ${arrName}'s queue`)
    console.log(`[plex] removed torrent ${hash.slice(0, 8)} files=${files} blocklist=${blocklist} search=${search}`)
    res.json({ ok: true, detail: `${parts.join(', ')}.` })
  } catch (err) {
    res.status(502).json({ error: msg(err) })
  }
})

// ── Requests ─────────────────────────────────────────────────────────────────

router.get('/requests', async (_req: Request, res: Response) => {
  if (!seerrEnabled()) return disabled(res, 'Seerr')
  res.setHeader('Cache-Control', 'no-store')
  try { res.json({ requests: await seerrRequests(20) }) }
  catch (err) { res.status(502).json({ error: `Seerr: ${msg(err)}` }) }
})

router.get('/discover', async (req: Request, res: Response) => {
  if (!seerrEnabled()) return disabled(res, 'Seerr')
  const q = String(req.query['q'] ?? '').trim()
  if (!q) return res.json({ results: [] })
  try { res.json({ results: await seerrSearch(q, 12) }) }
  catch (err) { res.status(502).json({ error: `Seerr: ${msg(err)}` }) }
})

router.post('/request', async (req: Request, res: Response) => {
  if (!seerrEnabled()) return disabled(res, 'Seerr')
  const body = (req.body ?? {}) as Record<string, unknown>
  const mediaType = body['mediaType']
  const tmdbId = Number(body['tmdbId'])
  if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'mediaType (movie|tv) and tmdbId required' })
  }
  const seasons = Array.isArray(body['seasons']) ? (body['seasons'] as unknown[]).map(Number).filter(n => Number.isInteger(n) && n >= 0) : undefined
  try { res.json({ request: await seerrRequest(mediaType, tmdbId, seasons) }) }
  catch (err) {
    // Seerr answers a duplicate with a 409 and a message worth relaying.
    const status = axios.isAxiosError(err) ? err.response?.status : undefined
    const detail = axios.isAxiosError(err) ? (err.response?.data as { message?: string } | undefined)?.message : undefined
    res.status(status === 409 ? 409 : 502).json({ error: detail ?? `Seerr: ${msg(err)}` })
  }
})

export default router
