// Keeps the Watch/Play list in step with what is actually watched on Plex.
//
// The list used to be hand-kept: add a show, tap "in progress", tap "done".
// Plex already knows all three — what is playing right now (on the kiosk, on
// the TV app, on a phone), how far through a film someone is, how many
// episodes of a show are watched — so this module asks it and writes the
// answer into the list:
//
//   • something starts playing → the film or show is in the list, in
//     progress (a film stays "not started" until it is done, because the
//     list's movie states are only those two)
//   • a film reaches Plex's watched mark, or a show's every episode is
//     watched → the item is done
//
// Sessions come from /status/sessions, which covers EVERY Plex client, not
// just the kiosk's own player; the kiosk's progress reports simply nudge a
// sync sooner. Completion is judged from Plex's own counters (viewCount,
// viewedLeafCount) after playback, never from a timer here, so what the list
// says matches what Plex's apps show. An item remembers its Plex key so a
// renamed or differently-cased title still lines up.
//
// Never undone: a show the user marked done by hand is not put back to "in
// progress" by a rewatch, and nothing here ever removes an item.

import crypto from 'crypto'
import { plexEnabled, plexHeaders, plexItem, plexSessions, PLEX_URL, type PlexItem } from './media-stack'
import { readMedia, writeMedia, type MediaItem } from './routes/dashboard-tools'
import { cacheCover } from './routes/artwork'
import { broadcast } from './routes/system'

const SYNC_EVERY_MS = 60_000
const NUDGE_DELAY_MS = 4_000
/** Keys seen in a session lately, still to be checked for completion once they stop. */
const pending = new Map<string, number>()
const PENDING_TTL_MS = 36 * 3600_000

let timer: NodeJS.Timeout | null = null
let nudge: NodeJS.Timeout | null = null
let running = false

interface Root { key: string; title: string; type: 'movie' | 'show'; thumb?: string; year?: number }

/** The film, or the show an episode belongs to — the thing the list has a row for. */
function rootOf(i: PlexItem): Root | null {
  if (i.type === 'movie') return { key: i.key, title: i.title, type: 'movie', ...(i.thumb ? { thumb: i.thumb } : {}), ...(i.year ? { year: i.year } : {}) }
  if (i.type === 'episode' && i.grandparentKey && i.grandparentTitle) {
    return { key: i.grandparentKey, title: i.grandparentTitle, type: 'show', ...(i.grandparentThumb ? { thumb: i.grandparentThumb } : {}) }
  }
  return null
}

const norm = (s: string) => s.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim()

function findRow(items: MediaItem[], root: Root): MediaItem | undefined {
  return items.find(i => i.plexKey === root.key)
    ?? items.find(i => i.type === root.type && norm(i.title) === norm(root.title))
}

async function plexCover(thumb: string | undefined): Promise<string | undefined> {
  if (!thumb) return undefined
  // The poster through Plex's own transcoder, at list-tile size, with the
  // token in a header rather than the URL so the cache log never prints it.
  const url = `${PLEX_URL}/photo/:/transcode?url=${encodeURIComponent(thumb)}&width=400&height=600&minSize=1&upscale=1`
  const file = await cacheCover(url, plexHeaders())
  return file ?? undefined
}

async function isFinished(root: Root): Promise<boolean> {
  const item = await plexItem(root.key)
  if (!item) return false
  if (item.type === 'movie') return (item.viewCount ?? 0) > 0 && !item.viewOffset
  if (item.type === 'show') return (item.leafCount ?? 0) > 0 && (item.viewedLeafCount ?? 0) >= (item.leafCount ?? 0)
  return false
}

export async function syncPlexWatch(): Promise<void> {
  if (!plexEnabled() || running) return
  running = true
  try {
    const now = Date.now()
    const sessions = await plexSessions()
    const active = new Map<string, Root>()
    for (const s of sessions) {
      const r = rootOf(s)
      if (r) { active.set(r.key, r); pending.set(r.key, now) }
    }
    for (const [k, at] of pending) if (now - at > PENDING_TTL_MS) pending.delete(k)

    const items = readMedia()
    let changed = false
    const log: string[] = []

    // 1. Whatever is playing is in the list, and in progress.
    for (const root of active.values()) {
      let row = findRow(items, root)
      if (!row) {
        row = {
          id: crypto.randomUUID(), title: root.title, type: root.type, done: false,
          status: root.type === 'show' ? 'in_progress' : 'not_started', plexKey: root.key,
        }
        const cover = await plexCover(root.thumb)
        if (cover) row.cover = cover
        items.push(row); changed = true
        log.push(`added "${root.title}" (${root.type})`)
        continue
      }
      if (!row.plexKey) { row.plexKey = root.key; changed = true }
      if (!row.cover) { const c = await plexCover(root.thumb); if (c) { row.cover = c; changed = true } }
      if (row.type === 'show' && (row.status === 'not_started' || row.status === 'dropped')) {
        row.status = 'in_progress'; row.done = false; changed = true
        log.push(`"${row.title}" → in progress`)
      }
    }

    // 2. Anything watched lately and not playing now: finished?
    for (const key of pending.keys()) {
      if (active.has(key)) continue
      const row = items.find(i => i.plexKey === key)
      if (!row || row.status === 'done') { pending.delete(key); continue }
      let finished = false
      try { finished = await isFinished({ key, title: row.title, type: row.type as 'movie' | 'show' }) } catch { /* ask again next time */ }
      if (finished) {
        row.status = 'done'; row.done = true; changed = true
        pending.delete(key)
        log.push(`"${row.title}" → done`)
      }
    }

    if (changed) {
      writeMedia(items)
      for (const l of log) console.log(`[plex-watch] ${l}`)
      broadcast('media', { reason: 'plex' })
    }
  } catch (err) {
    console.warn('[plex-watch] sync failed:', err instanceof Error ? err.message : String(err))
  } finally {
    running = false
  }
}

/** The kiosk just reported playback: sync soon rather than at the next minute. */
export function nudgePlexWatch(key?: string): void {
  if (key) pending.set(key, Date.now())
  if (nudge) clearTimeout(nudge)
  nudge = setTimeout(() => { nudge = null; void syncPlexWatch() }, NUDGE_DELAY_MS)
}

export function startPlexWatch(): void {
  if (!plexEnabled() || timer) return
  timer = setInterval(() => { void syncPlexWatch() }, SYNC_EVERY_MS)
  timer.unref()
  setTimeout(() => { void syncPlexWatch() }, 10_000).unref()
  console.log('[plex-watch] following Plex playback into the Watch/Play list')
}
