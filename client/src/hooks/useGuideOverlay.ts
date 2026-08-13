// Which game guide is on screen, if any.
//
// The guide used to be a layer inside the media widget, reachable only by tapping
// through the list. It's now a top-level overlay driven by this store, because
// the assistant has to be able to put one up too ("show me the Majora's Mask
// guide", "open the Woodfall Temple chapter") — and a voice command can't reach
// into another component's useState.
//
// Same module-store shape as useBrowse, for the same reason: non-component code
// (the voice hook's reply handler) needs to open the thing.

import { useSyncExternalStore } from 'react'

export interface GuideTarget {
  itemId: string
  /** Chapter the AI asked for — a name or a 1-based number, resolved in the view. */
  chapter?: string
  /** Bumped on every open, so a repeat command re-applies the chapter hint. */
  seq: number
}

let seq = 0
let current: GuideTarget | null = null

const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot() { return current }
function emit() { listeners.forEach(cb => cb()) }

/** Put a guide on screen. `chapter` opens straight to that chapter. */
export function openGuide(itemId: string, chapter?: string) {
  current = { itemId, ...(chapter ? { chapter } : {}), seq: ++seq }
  console.log(`[guide] open ${itemId}${chapter ? ` → chapter "${chapter}"` : ''}`)
  emit()
}

export function closeGuide() {
  if (!current) return
  current = null
  emit()
}

export function isGuideOpen(): boolean {
  return current !== null
}

/** React hook — re-renders when the guide opens, closes, or changes target. */
export function useGuideTarget() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
