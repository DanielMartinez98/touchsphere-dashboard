// How many pictures across a grid shows — the Draw panel's gallery, and the
// Plex corner's poster grids.
//
// A per-DEVICE setting, in localStorage rather than on the server: the same
// build runs on the 7" kiosk, a phone and a desktop browser, and "three
// across" is the right answer on one of those and the wrong one on the
// others. Three is the default everywhere — it used to be a breakpoint
// (two on a phone, three from 380px), which meant the count changed with the
// viewport and could never be changed by the person looking at it.
//
// One store per grid family, because a 2:3 poster and a square render want
// different counts on the same screen. Same module-store shape as the other
// cross-tree stores: a value, a setter, and a hook that subscribes.

import { useRef, useSyncExternalStore, type TouchEvent, type TouchList } from 'react'

export const MIN_COLUMNS = 2
export const MAX_COLUMNS = 6

interface ColumnsStore {
  use: () => number
  set: (n: number) => void
}

function columnsStore(key: string, fallback: number): ColumnsStore {
  const read = (): number => {
    try {
      const n = Number(localStorage.getItem(key))
      return Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS ? n : fallback
    } catch {
      return fallback
    }
  }
  let columns = read()
  const listeners = new Set<() => void>()
  const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
  const get = () => columns
  return {
    use: () => useSyncExternalStore(subscribe, get, get),
    set: (n: number) => {
      const next = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(n)))
      if (next === columns) return
      columns = next
      try { localStorage.setItem(key, String(next)) } catch { /* private mode; the session keeps it */ }
      listeners.forEach(cb => cb())
    },
  }
}

const gallery = columnsStore('image.columns', 3)
const plex = columnsStore('plex.columns', 3)

/** The Draw panel's gallery of renders. */
export const useGalleryColumns = gallery.use
export const setGalleryColumns = gallery.set
/** The Plex corner's poster grids. */
export const usePlexColumns = plex.use
export const setPlexColumns = plex.set

/**
 * Pinch-to-resize for a grid: the gesture every photo app uses for exactly
 * this, and the one a finger tries first. Spreading the fingers makes each
 * tile bigger — fewer across — one column per ~35% of spread, counted from
 * the number the pinch began at so a long pinch doesn't run away.
 *
 * Returns the four touch handlers to spread onto the grid element.
 */
export function usePinchColumns(columns: number, set: (n: number) => void) {
  const pinch = useRef<{ start: number; columns: number } | null>(null)
  const distance = (t: TouchList) => {
    const a = t[0], b = t[1]
    return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0
  }
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length === 2) pinch.current = { start: distance(e.touches), columns }
    },
    onTouchMove: (e: TouchEvent) => {
      const p = pinch.current
      if (!p || e.touches.length !== 2 || !p.start) return
      const steps = Math.round(Math.log(distance(e.touches) / p.start) / Math.log(1.35))
      if (steps !== 0) set(p.columns - steps)
    },
    onTouchEnd: () => { pinch.current = null },
    onTouchCancel: () => { pinch.current = null },
  }
}
