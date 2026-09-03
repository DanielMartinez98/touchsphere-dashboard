// How many pictures across the Draw panel's gallery shows.
//
// A per-DEVICE setting, in localStorage rather than on the server: the same
// build runs on the 7" kiosk, a phone and a desktop browser, and "three
// across" is the right answer on one of those and the wrong one on the
// others. Three is the default everywhere — it used to be a breakpoint
// (two on a phone, three from 380px), which meant the count changed with the
// viewport and could never be changed by the person looking at it.
//
// Same module-store shape as the other cross-tree stores: a value, a setter,
// and a hook that subscribes.

import { useSyncExternalStore } from 'react'

const KEY = 'image.columns'
export const MIN_COLUMNS = 2
export const MAX_COLUMNS = 6
const DEFAULT_COLUMNS = 3

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS ? n : DEFAULT_COLUMNS
  } catch {
    return DEFAULT_COLUMNS
  }
}

let columns = read()
const listeners = new Set<() => void>()

export function setGalleryColumns(n: number): void {
  const next = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(n)))
  if (next === columns) return
  columns = next
  try { localStorage.setItem(KEY, String(next)) } catch { /* private mode; the session keeps it */ }
  listeners.forEach(cb => cb())
}

export function useGalleryColumns(): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => columns,
    () => columns,
  )
}
