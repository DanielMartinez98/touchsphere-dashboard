// The picture half of a guide: wiki screenshots, item art and maps, cached on
// the volume so the kiosk renders them with no network.
//
// This is routes/artwork.ts's cover cache, pointed at a different source and
// with one difference that matters. A cover is always a JPEG from TMDB or IGDB;
// a wiki image is whatever the wiki has, and Fandom's CDN additionally
// re-encodes on the way out — ask it for a `.jpg` and it will hand you
// `image/webp`. So the extension is taken from the RESPONSE, not from the URL,
// and it lives in the cached filename so the serving route can name the type
// without sniffing the bytes back off disk.
//
// Why cache at all, rather than pointing an <img> at the wiki:
//   • the kiosk is expected to work with the internet down, and a guide whose
//     pictures are all broken frames is worse than one with no pictures;
//   • a guide is thirty steps and the list re-renders on every ticked box, which
//     is not a reason to talk to someone else's CDN thirty times;
//   • Caddy serves this over the kiosk's own TLS, so nothing is mixed content.
//
// Failure is always null and never throws. A picture is an aid; a guide without
// one is the guide this app already shipped.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/** Bigger than any wiki screenshot worth showing on a 720px panel. */
const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 20_000

const TYPES: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

export const MIME_FOR: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
}

function mediaDir(): string {
  const dir = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'guide-media')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[guide-media] created ${dir}`)
  }
  return dir
}

/** Absolute path of a cached image, or null. The filename is validated by the route. */
export function guideImagePath(file: string): string | null {
  const full = path.join(mediaDir(), file)
  return fs.existsSync(full) ? full : null
}

/**
 * Download one image and return its cached filename.
 *
 * The name is a hash of the source URL, so caching the same picture twice is a
 * no-op and two chapters that cite one screenshot share one file — which happens
 * constantly, since a wiki reuses its own art across pages.
 */
export async function cacheGuideImage(url: string): Promise<string | null> {
  if (!/^https:\/\//i.test(url)) return null
  const stem = crypto.createHash('sha1').update(url).digest('hex')

  // Already here under one of the extensions? The URL alone does not say which,
  // so the hit has to be looked for rather than computed.
  for (const ext of new Set(Object.values(TYPES))) {
    const candidate = `${stem}.${ext}`
    if (fs.existsSync(path.join(mediaDir(), candidate))) return candidate
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Fandom's CDN answers a bare fetch with a 403; a real UA and a referer
      // are what the browser sends and what it expects to see.
      headers: { 'User-Agent': 'TouchSphere/1.0 (game guide dashboard)', Accept: 'image/*' },
    })
    if (!res.ok) {
      console.warn(`[guide-media] HTTP ${res.status} for ${url.slice(0, 100)}`)
      return null
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const ext = TYPES[type]
    if (!ext) {
      console.warn(`[guide-media] not an image we serve (${type || 'no content-type'}): ${url.slice(0, 100)}`)
      return null
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    // Checked after the fact rather than from Content-Length, which a CDN
    // serving a re-encode does not always send.
    if (bytes.length > MAX_BYTES) {
      console.warn(`[guide-media] ${(bytes.length / 1024 / 1024).toFixed(1)} MB is too big: ${url.slice(0, 100)}`)
      return null
    }
    if (bytes.length === 0) return null

    const file = `${stem}.${ext}`
    const dest = path.join(mediaDir(), file)
    // Temp-then-rename, like the cover cache: a crash mid-download must not
    // leave a truncated file that every later call then treats as a hit.
    const tmp = `${dest}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, dest)
    console.log(`[guide-media] cached ${file} (${(bytes.length / 1024).toFixed(0)} KB) from ${url.slice(0, 80)}`)
    return file
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[guide-media] failed ${url.slice(0, 100)}: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Delete cached images no guide refers to any more.
 *
 * Guides are evicted at 40 and chapters are rewritten in place, so without this
 * the directory only ever grows — on the same Pi volume the generated pictures
 * live on. Called from the same place that sweeps orphaned guides, with the set
 * of filenames still referenced anywhere in the store.
 */
export function pruneGuideImages(inUse: Set<string>): number {
  let dropped = 0
  try {
    for (const file of fs.readdirSync(mediaDir())) {
      // Leave temp files from a download that is in flight right now.
      if (file.endsWith('.tmp')) continue
      if (inUse.has(file)) continue
      try {
        fs.unlinkSync(path.join(mediaDir(), file))
        dropped++
      } catch { /* already gone */ }
    }
  } catch {
    return 0
  }
  if (dropped > 0) console.log(`[guide-media] pruned ${dropped} unreferenced image(s)`)
  return dropped
}
