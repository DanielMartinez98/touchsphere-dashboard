// The dashboard's browser window — what the assistant last asked to put on
// screen (a web page or a YouTube video), if anything.
//
// The server resolves the target during the chat turn and returns it as
// `display` on the chat reply; useVoice hands it here at the moment the spoken
// reply is revealed, so the window appears in step with "here's that tutorial"
// rather than a beat before it.
//
// Module-level store (same pattern as useMuted) so non-component code — the
// voice hook's TTS callback — can open the window without prop-drilling.

import { useSyncExternalStore } from 'react'
import { closeGuide, openGuide } from './useGuideOverlay'
import { closeImage, openImage } from './useImageOverlay'
import { closePlexPlayer, openPlexPlayer, requestPlexPanel } from './usePlex'

/** Mirrors DisplayPayload in server/src/routes/browse.ts. */
export type BrowseTarget =
  | { kind: 'video'; url: string; title: string; videoId: string; channel?: string }
  | { kind: 'web';   url: string; title: string; site: string; embeddable: boolean }

// Bumped on every open so re-showing the same target still remounts the
// overlay's player/reader (used as a React key).
let seq = 0
let current: (BrowseTarget & { seq: number }) | null = null

const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot() { return current }
function emit() { listeners.forEach(cb => cb()) }

/** Show a target. One window at a time — this replaces whatever is up. */
export function openBrowse(target: BrowseTarget) {
  current = { ...target, seq: ++seq }
  console.log(`[browse] open ${target.kind}: ${target.title}`)
  emit()
}

export function closeBrowse() {
  if (!current) return
  current = null
  emit()
}

/** Validate an untrusted `display` payload from /api/chat before opening it. */
export function openBrowseFromPayload(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const d = raw as Record<string, unknown>

  // Not every thing the assistant puts on screen is a browser window. A guide is
  // its own overlay, and "close that" clears whatever is up — both arrive on the
  // same `display` field, so they're dispatched here rather than duplicating the
  // validation at the call site.
  if (d['kind'] === 'guide' && typeof d['itemId'] === 'string' && d['itemId']) {
    closeBrowse()
    closePlexPlayer()
    openGuide(d['itemId'], typeof d['chapter'] === 'string' && d['chapter'] ? d['chapter'] : undefined)
    return
  }
  // A generated picture is its own overlay too, and — unlike the others — it
  // usually arrives with NO url, because the render hasn't finished. It has to
  // be handled above the http(s) check below, which would drop it.
  // An edit PLAN opens the same frame with no job yet: the frame follows the
  // plan's current step as the plan reports it.
  const planId = typeof d['planId'] === 'string' && /^[a-f0-9]{32}$/.test(d['planId']) ? d['planId'] : ''
  if (d['kind'] === 'image' && typeof d['jobId'] === 'string' && (/^[a-f0-9]{32}$/.test(d['jobId']) || planId)) {
    closeBrowse()
    // The url, when present, is our own relative /api/image/file/<32 hex>.png.
    // Anything else on that field is not from us and is ignored rather than
    // rendered as an <img src>.
    const src = typeof d['url'] === 'string' && /^\/api\/image\/file\/[a-f0-9]{32}\.png$/.test(d['url'])
      ? d['url'] : undefined
    openImage(planId ? '' : d['jobId'], typeof d['prompt'] === 'string' ? d['prompt'] : '', src, planId || undefined)
    return
  }
  // The media stack: `play` starts a library item full screen (the player
  // starts the transcode itself — a relative /api/plex path, no url here to
  // guard); `open` brings the Plex corner up on a tab.
  if (d['kind'] === 'plex') {
    const title = typeof d['title'] === 'string' ? d['title'] : ''
    if (d['action'] === 'play' && typeof d['key'] === 'string' && /^\d+$/.test(d['key'])) {
      closeBrowse()
      openPlexPlayer({ key: d['key'], title: title || 'Plex' })
      return
    }
    if (d['action'] === 'open' && (d['tab'] === 'library' || d['tab'] === 'downloads' || d['tab'] === 'requests')) {
      requestPlexPanel({
        tab: d['tab'],
        ...(typeof d['key'] === 'string' && /^\d+$/.test(d['key']) ? { key: d['key'] } : {}),
        ...(typeof d['query'] === 'string' && d['query'] ? { query: d['query'] } : {}),
      })
    }
    return
  }
  if (d['kind'] === 'close') {
    closeBrowse()
    closeGuide()
    closeImage()
    closePlexPlayer()
    return
  }

  const url   = typeof d['url']   === 'string' ? d['url']   : ''
  const title = typeof d['title'] === 'string' ? d['title'] : ''
  if (!/^https?:\/\//i.test(url)) return
  // One window at a time: a video or page arriving while a film is playing
  // replaces it, as it would replace another page.
  closePlexPlayer()
  if (d['kind'] === 'video' && typeof d['videoId'] === 'string' && /^[\w-]{11}$/.test(d['videoId'])) {
    openBrowse({
      kind: 'video',
      url,
      title: title || 'Video',
      videoId: d['videoId'],
      ...(typeof d['channel'] === 'string' ? { channel: d['channel'] } : {}),
    })
    return
  }
  if (d['kind'] === 'web') {
    const site = typeof d['site'] === 'string' ? d['site'] : new URL(url).hostname
    openBrowse({ kind: 'web', url, title: title || site, site, embeddable: d['embeddable'] === true })
  }
}

/** React hook — re-renders when the window opens, closes, or changes target. */
export function useBrowse() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
