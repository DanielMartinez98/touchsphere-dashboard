import { Router, Request, Response } from 'express'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()

// ── Cover art lookup + on-disk cache ──────────────────────────────────────────
// Movies/shows come from TMDB, games from IGDB. Whichever poster an item ends
// up with is downloaded ONCE into $CACHE_DIR/covers and served from there, so
// the list still renders on a Pi with no WAN — same offline-first rule the rest
// of the kiosk follows. Items keep only the cached filename (see MediaItem.cover).

export type MediaType = 'game' | 'show' | 'movie'

export interface ArtworkResult {
  /** Provider-native id, unique per provider. Used as a React key only. */
  id:       string
  title:    string
  year:     number | null
  /** Remote poster URL. Pass back to cacheCover() to pin it to disk. */
  imageUrl: string
}

const TMDB_IMAGE_SIZE = 'w342'   // ~342×513 — plenty for a 720×1280 screen
const HTTP_TIMEOUT_MS = 6000

function coversDir(): string {
  const dir = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'covers')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[artwork] created covers directory: ${dir}`)
  }
  return dir
}

// ── TMDB (movies + shows) ─────────────────────────────────────────────────────
async function searchTmdb(type: 'movie' | 'show', query: string, limit = 8): Promise<ArtworkResult[]> {
  const apiKey = process.env['TMDB_API_KEY']
  if (!apiKey) {
    console.warn('[artwork] TMDB_API_KEY not set — skipping movie/show lookup')
    return []
  }

  const endpoint = type === 'movie' ? 'movie' : 'tv'
  const { data } = await axios.get<{ results?: any[] }>(
    `https://api.themoviedb.org/3/search/${endpoint}`,
    {
      params: { api_key: apiKey, query, include_adult: false },
      timeout: HTTP_TIMEOUT_MS,
    }
  )

  return (data.results ?? [])
    .filter(r => r.poster_path)
    .slice(0, limit)
    .map(r => {
      // TMDB names the fields differently for movies vs TV.
      const date: string = r.release_date ?? r.first_air_date ?? ''
      const year = date ? parseInt(date.slice(0, 4), 10) : NaN
      return {
        id:       `tmdb:${r.id}`,
        title:    r.title ?? r.name ?? '',
        year:     Number.isNaN(year) ? null : year,
        imageUrl: `https://image.tmdb.org/t/p/${TMDB_IMAGE_SIZE}${r.poster_path}`,
      }
    })
}

// ── IGDB (games) ──────────────────────────────────────────────────────────────
// IGDB authenticates through Twitch: a client-credentials token that lives for
// ~60 days. Cache it in memory and refresh a minute before it lapses.
let igdbToken: { value: string; expiresAt: number } | null = null

async function igdbAccessToken(): Promise<string | null> {
  const clientId     = process.env['IGDB_CLIENT_ID']
  const clientSecret = process.env['IGDB_CLIENT_SECRET']
  if (!clientId || !clientSecret) {
    console.warn('[artwork] IGDB_CLIENT_ID/SECRET not set — skipping game lookup')
    return null
  }

  if (igdbToken && Date.now() < igdbToken.expiresAt) return igdbToken.value

  const { data } = await axios.post<{ access_token: string; expires_in: number }>(
    'https://id.twitch.tv/oauth2/token',
    null,
    {
      params: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
      timeout: HTTP_TIMEOUT_MS,
    }
  )
  igdbToken = {
    value:     data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  }
  console.log(`[artwork] IGDB token acquired — valid for ${Math.round(data.expires_in / 86400)}d`)
  return igdbToken.value
}

async function searchIgdb(query: string, limit = 8): Promise<ArtworkResult[]> {
  const token    = await igdbAccessToken()
  const clientId = process.env['IGDB_CLIENT_ID']
  if (!token || !clientId) return []

  // IGDB takes an Apicalypse query as a raw text body, not JSON.
  const body = `search "${query.replace(/"/g, '')}"; fields name,first_release_date,cover.image_id; where cover != null; limit ${limit};`
  const { data } = await axios.post<any[]>('https://api.igdb.com/v4/games', body, {
    headers: {
      'Client-ID':     clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'text/plain',
    },
    timeout: HTTP_TIMEOUT_MS,
  })

  return (data ?? [])
    .filter(g => g.cover?.image_id)
    .map(g => ({
      id:       `igdb:${g.id}`,
      title:    g.name ?? '',
      year:     g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null,
      // t_cover_big is 264×374 — the largest portrait box art IGDB serves.
      imageUrl: `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg`,
    }))
}

// ── Public helpers (also used by routes/state.ts) ──────────────────────────────

/** Search the provider that covers `type`. Returns [] when unconfigured or on failure. */
export async function searchArtwork(type: MediaType, query: string, limit = 8): Promise<ArtworkResult[]> {
  try {
    const results = (type === 'game' ? await searchIgdb(query, limit) : await searchTmdb(type, query, limit))
    console.log(`[artwork] search ${type} "${query}" → ${results.length} result(s)`)
    return results
  } catch (err: any) {
    const status = err?.response?.status ?? 'no-response'
    console.error(`[artwork] search FAILED ${type} "${query}" status=${status}: ${err?.message ?? err}`)
    return []
  }
}

/**
 * Download `imageUrl` into the covers directory and return its filename.
 * The name is a hash of the URL, so re-caching the same poster is a no-op and
 * two items sharing a poster share one file. Returns null on any failure —
 * callers fall back to the generated gradient tile.
 */
export async function cacheCover(imageUrl: string): Promise<string | null> {
  const file = `${crypto.createHash('sha1').update(imageUrl).digest('hex')}.jpg`
  const dest = path.join(coversDir(), file)

  if (fs.existsSync(dest)) {
    console.log(`[artwork] cover cache HIT ${file}`)
    return file
  }

  try {
    const { data } = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: HTTP_TIMEOUT_MS,
    })
    const buffer = Buffer.from(data)
    // Write to a temp name first so a crash mid-download can't leave a
    // truncated jpeg that we'd then treat as a cache hit forever.
    const tmp = `${dest}.${process.pid}.tmp`
    fs.writeFileSync(tmp, buffer)
    fs.renameSync(tmp, dest)
    console.log(`[artwork] cover cached ${file} (${(buffer.length / 1024).toFixed(0)} KB) ← ${imageUrl}`)
    return file
  } catch (err: any) {
    console.error(`[artwork] cover download FAILED ${imageUrl}: ${err?.message ?? err}`)
    return null
  }
}

/**
 * Whether the provider backing `type` actually has credentials. Without this,
 * an unconfigured provider is indistinguishable from "no such title" — both
 * return zero results — and callers end up telling the user their spelling is
 * wrong when the real problem is a missing key on the server.
 */
export function artworkConfigured(type: MediaType): boolean {
  return type === 'game'
    ? !!(process.env['IGDB_CLIENT_ID'] && process.env['IGDB_CLIENT_SECRET'])
    : !!process.env['TMDB_API_KEY']
}

/** Loose title key: case/punctuation/spacing-insensitive, so "Spider-Man 2" == "spider man 2". */
function titleKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface CoverLookup {
  /** Cached filename of the poster we attached, or null if nothing was found. */
  cover:       string | null
  /** The result we attached the cover from. */
  match:       ArtworkResult | null
  /** True when the match's title is effectively identical to what was asked for. */
  exact:       boolean
  /** Other candidates, for "did you mean…?" when the match is loose or absent. */
  suggestions: ArtworkResult[]
}

/**
 * Look up a cover and report how confident the match is. A misspelled title
 * ("Eldn Ring") usually still returns the right game — but silently attaching
 * art for a title the user didn't type is how you end up with a wrong poster
 * nobody notices, so callers get `exact` and can ask before trusting it.
 */
export async function findCover(type: MediaType, title: string): Promise<CoverLookup> {
  const results = await searchArtwork(type, title)

  if (results.length > 0) {
    // Providers rank by popularity, not by title, so the top hit for "Elden Ring"
    // is "Elden Ring Nightreign". Always prefer a result whose title actually
    // matches what was asked for; only fall back to the top hit otherwise.
    const key   = titleKey(title)
    const hit   = results.find(r => titleKey(r.title) === key)
    const match = hit ?? results[0]!
    const exact = hit != null
    const cover = await cacheCover(match.imageUrl)
    console.log(`[artwork] matched ${type} "${title}" → "${match.title}" (${exact ? 'exact' : 'LOOSE'})`)
    return { cover, match, exact, suggestions: results.slice(0, 5) }
  }

  // Nothing matched — the title is probably misspelled. These APIs don't correct
  // typos and don't match partial words, so the only lever is to drop the words
  // most likely to be mangled and search on what's left ("Blade Runer 2049" →
  // "Blade"). That returns a popularity-ranked pool that may not contain the
  // right title near the top, so we pull a wide pool and re-rank it *locally*
  // by how close each title is to what the user actually typed. Suggestions
  // only — art is never auto-attached from a guess.
  const pool = new Map<string, ArtworkResult>()
  for (const probe of probesFor(title)) {
    for (const r of await searchArtwork(type, probe, 30)) pool.set(r.id, r)
    if (pool.size >= 30) break
  }

  if (pool.size === 0) {
    console.log(`[artwork] no match and no suggestions for ${type} "${title}"`)
    return { cover: null, match: null, exact: false, suggestions: [] }
  }

  const suggestions = Array.from(pool.values())
    .map(r => ({ r, d: distance(titleKey(title), titleKey(r.title)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map(x => x.r)

  console.log(`[artwork] no match for ${type} "${title}" — closest of ${pool.size}: "${suggestions[0]!.title}"`)
  return { cover: null, match: null, exact: false, suggestions }
}

/**
 * Fallback queries for a title that returned nothing, best first. Any single
 * word may be the misspelled one, so each probe drops a different part: all but
 * the last word ("Blade Runer 2049" → "Blade"), then the first word, then the
 * last ("Cyberpunck 2077" → "2077", which still finds the game). Each probe is
 * a live API call, so the list stays short and only runs on the failure path.
 */
function probesFor(title: string): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  if (words.length === 1) return [words[0]!]
  return Array.from(new Set([
    words.slice(0, -1).join(' '),
    words[0]!,
    words[words.length - 1]!,
  ])).filter(p => p.length >= 2)
}

/** Levenshtein distance — ranks candidates by closeness to the typed title. */
function distance(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length]!
}

/** Best-effort cover for a freshly added item: top search hit, cached to disk. */
export async function autoCover(type: MediaType, title: string): Promise<string | null> {
  return (await findCover(type, title)).cover
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/artwork/search?type=game|show|movie&q=Title
// Used by the cover picker so the user can correct a wrong auto-match.
router.get('/search', async (req: Request, res: Response) => {
  const type = req.query['type'] as MediaType
  const q    = (req.query['q'] as string ?? '').trim()

  if (!['game', 'show', 'movie'].includes(type)) {
    res.status(400).json({ error: 'type must be game | show | movie' })
    return
  }
  if (!q) {
    res.status(400).json({ error: 'q is required' })
    return
  }

  // Fall back to near-matches when the title finds nothing, so the cover picker
  // can still offer "did you mean…?" for a misspelled item instead of a dead end.
  const results = await searchArtwork(type, q)
  res.json(results.length > 0 ? results : (await findCover(type, q)).suggestions)
})

// GET /api/artwork/cover/:file — serve a cached poster off the volume.
router.get('/cover/:file', (req: Request, res: Response) => {
  const file = String(req.params['file'] ?? '')
  // Filenames are always sha1 + .jpg; reject anything else rather than let a
  // crafted name walk out of the covers directory.
  if (!/^[a-f0-9]{40}\.jpg$/.test(file)) {
    res.status(400).json({ error: 'invalid cover name' })
    return
  }

  const full = path.join(coversDir(), file)
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: 'cover not found' })
    return
  }

  res.setHeader('Content-Type', 'image/jpeg')
  // Content is immutable — the filename is a hash of the source URL.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  fs.createReadStream(full).pipe(res)
})

export default router
