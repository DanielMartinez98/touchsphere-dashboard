import { useSyncExternalStore } from 'react'

// Lightweight runtime error log for the Settings → Debug tab. Captures
// uncaught errors, unhandled promise rejections, and console.error calls into
// a small ring buffer so problems on the kiosk (where DevTools is out of
// reach) can be read from the touchscreen.

export interface DebugLogEntry {
  ts:      number
  kind:    'error' | 'rejection' | 'console'
  message: string
}

const MAX_ENTRIES = 50

let entries: DebugLogEntry[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function push(kind: DebugLogEntry['kind'], message: string) {
  // New array each push so useSyncExternalStore sees a fresh snapshot.
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), { ts: Date.now(), kind, message: message.slice(0, 500) }]
  emit()
}

function stringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

let installed = false

/** Call once at app startup (main.tsx). Safe to call twice — no-ops. */
export function installDebugLog() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', e => {
    push('error', e.message ?? 'Unknown error')
  })
  window.addEventListener('unhandledrejection', e => {
    push('rejection', stringify(e.reason))
  })

  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    original(...args)
    push('console', args.map(stringify).join(' '))
  }
}

export function clearDebugLog() {
  entries = []
  emit()
}

export function getDebugLog(): DebugLogEntry[] {
  return entries
}

export function useDebugLog(): DebugLogEntry[] {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => entries,
  )
}
