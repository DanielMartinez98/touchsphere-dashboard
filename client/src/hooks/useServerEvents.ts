// One shared EventSource for the whole app.
//
// /api/system/events is the server's push channel (see server/src/routes/system.ts
// broadcast()): the restart signal, and game-guide generation progress. Every
// subscriber shares a single connection — a per-hook EventSource would open a
// socket per widget, and each one costs the Pi a kept-alive HTTP request plus a
// 25 s heartbeat.
//
// The connection is opened lazily on the first subscriber and closed when the
// last one goes away, so nothing is held open in tests or on a page with no
// listeners.

import { useEffect } from 'react'

type Handler = (data: unknown) => void

const handlers = new Map<string, Set<Handler>>()
let source: EventSource | null = null
// EventSource listeners are per-event-name, so we track which names we've
// wired up to the live connection and add the rest as they appear.
const wired = new Set<string>()

function attach(event: string): void {
  if (!source || wired.has(event)) return
  wired.add(event)
  source.addEventListener(event, (e: MessageEvent) => {
    let data: unknown
    try { data = e.data ? JSON.parse(e.data as string) : {} } catch { data = {} }
    for (const cb of handlers.get(event) ?? []) {
      try { cb(data) } catch (err) { console.error(`[sse] ${event} handler failed:`, err) }
    }
  })
}

function open(): void {
  if (source) return
  source = new EventSource('/api/system/events')
  source.onerror = () => {
    // EventSource reconnects on its own; log once rather than on every retry.
    if (source?.readyState === EventSource.CLOSED) console.warn('[sse] connection closed')
  }
  wired.clear()
  for (const event of handlers.keys()) attach(event)
  console.log('[sse] connected to /api/system/events')
}

function close(): void {
  if (!source) return
  source.close()
  source = null
  wired.clear()
}

/** Imperative subscribe, for non-component code. Returns an unsubscribe. */
export function onServerEvent(event: string, cb: Handler): () => void {
  let set = handlers.get(event)
  if (!set) { set = new Set(); handlers.set(event, set) }
  set.add(cb)
  open()
  attach(event)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) handlers.delete(event)
    if (handlers.size === 0) close()
  }
}

/**
 * Subscribe to one server event for the lifetime of a component.
 * The callback is stored in a ref-free closure, so pass a stable function
 * (useCallback) or accept that changing it re-subscribes.
 */
export function useServerEvent(event: string, cb: Handler): void {
  useEffect(() => onServerEvent(event, cb), [event, cb])
}
