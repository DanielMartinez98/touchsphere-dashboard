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
  const url   = typeof d['url']   === 'string' ? d['url']   : ''
  const title = typeof d['title'] === 'string' ? d['title'] : ''
  if (!/^https?:\/\//i.test(url)) return
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
