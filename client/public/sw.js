/* TouchSphere companion — the phone's offline layer.
 *
 * Registered ONLY on a companion (see main.tsx): the kiosk must never be
 * handed a stale build by its own cache. Three strategies, chosen per URL:
 *
 *   • the app shell and hashed /assets: cache-first. Vite names them by
 *     content hash, so a cached one is never wrong, and a phone with no
 *     signal still gets a page.
 *   • pictures — posters, covers, renders: cache-first with a size cap, since
 *     a poster never changes under its path and a gallery of renders is the
 *     thing worth having on the train.
 *   • the glanceable data — weather, calendar, the Plex home, the gallery
 *     list, the version: network-first, falling back to the last good copy.
 *     Stale weather beats no weather; a cached calendar is still today's.
 *
 * Never touched: anything that isn't GET, the SSE stream, HLS video, the
 * Ollama-backed routes, and the host-update API — none of those make sense
 * from a cache, and a cached "reboot" would be worse than useless.
 */

const VERSION = 'ts-companion-v1'
const SHELL = `${VERSION}-shell`
const MEDIA = `${VERSION}-media`
const DATA = `${VERSION}-data`
const MEDIA_MAX = 400

const NEVER = /^\/api\/(system\/events|plex\/hls|chat|stt|tts|host|image\/generate|image\/upload)/
const MEDIA_RE = /^\/api\/(plex\/img|plex\/poster|image\/file|artwork\/cover)/
const DATA_RE = /^\/api\/(weather|forecast|airquality|calendar|image(\?|$)|image\/models|image\/queue|plex\/home|plex\/sections|plex\/status|plex\/now|system\/version|state\/media|guides$)/

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(['/']).catch(() => {})).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function trim(name, max) {
  const cache = await caches.open(name)
  const keys = await cache.keys()
  if (keys.length <= max) return
  // Oldest first is insertion order for a Cache; drop the surplus.
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)))
}

async function cacheFirst(request, name, max) {
  const cache = await caches.open(name)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) {
    cache.put(request, res.clone())
    if (max) trim(name, max)
  }
  return res
}

async function networkFirst(request, name) {
  const cache = await caches.open(name)
  try {
    const res = await fetch(request)
    if (res.ok) cache.put(request, res.clone())
    return res
  } catch (err) {
    const hit = await cache.match(request)
    if (hit) {
      // Say so on the way through: the page can show "as of …" from this.
      const h = new Headers(hit.headers)
      h.set('X-TouchSphere-Cached', '1')
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h })
    }
    throw err
  }
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname + (url.search && DATA_RE.test(url.pathname + url.search) ? url.search : '')

  if (NEVER.test(url.pathname)) return

  // Navigations: the shell, network-first so a new build lands, cache when dark.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(new Request('/'), SHELL))
    return
  }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg' || url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req, SHELL))
    return
  }
  if (MEDIA_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req, MEDIA, MEDIA_MAX))
    return
  }
  if (DATA_RE.test(path)) {
    event.respondWith(networkFirst(req, DATA))
  }
})
