// Which generated picture is on screen, if any.
//
// Same module-store shape as useBrowse and useGuideOverlay, and here for the
// same reason: the thing that opens it is usually the voice hook's reply
// handler, which is not a component and can't reach into anyone's useState.
//
// The store holds the TARGET, not the picture. A render takes ten to thirty
// seconds, and the frame goes up at the moment the spoken reply is revealed —
// so most of the time this opens with a job id and no image yet, and the
// picture arrives later over SSE. useImageJob() below is the half that watches
// for it.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { onServerEvent } from './useServerEvents'

export interface ImageTarget {
  jobId:  string
  prompt: string
  /** Present immediately when re-showing a finished picture; absent while drawing. */
  url?:   string
  /** Bumped on every open, so asking for the same picture twice re-opens it. */
  seq:    number
}

let seq = 0
let current: ImageTarget | null = null

const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot() { return current }
function emit() { listeners.forEach(cb => cb()) }

export function openImage(jobId: string, prompt: string, url?: string) {
  current = { jobId, prompt, ...(url ? { url } : {}), seq: ++seq }
  console.log(`[image] open ${jobId}${url ? ' (already drawn)' : ' (drawing)'}`)
  emit()
}

export function closeImage() {
  if (!current) return
  current = null
  emit()
}

export function isImageOpen(): boolean {
  return current !== null
}

/** React hook — re-renders when the picture opens, closes, or changes. */
export function useImageTarget() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Following one render ─────────────────────────────────────────────────────

export interface ImageJobState {
  status:    'queued' | 'running' | 'ready' | 'failed'
  /** Human phrase from the server — "loading the model", "drawing"… */
  phase:     string
  url?:      string
  error?:    string
  elapsedMs: number
  /** How long the last successful render on this box took. 0 = no history yet. */
  etaMs:     number
}

/**
 * Track one job to completion.
 *
 * Two sources, deliberately: a GET on mount and the `image` SSE event after.
 * The event alone isn't enough — the display payload and the SSE frame race, and
 * on a re-show or a page reload every frame for that job is already in the past,
 * so the overlay would sit on "drawing" forever for a picture that finished
 * before it opened.
 */
export function useImageJob(jobId: string | null, alreadyDone: boolean): ImageJobState | null {
  // The job this state belongs to is carried IN the state, and a mismatch reads
  // as null. That's what makes opening a second picture show an empty frame
  // rather than the previous render's progress — without needing to clear the
  // state from an effect, which fires a render after the one that already
  // painted the stale bar.
  const [state, setState] = useState<(ImageJobState & { jobId: string }) | null>(null)

  const onFrame = useCallback((data: unknown) => {
    const d = data as Record<string, unknown> | null
    if (!d || d['id'] !== jobId || !jobId) return
    setState({
      jobId,
      status:    d['status'] as ImageJobState['status'],
      phase:     typeof d['phase'] === 'string' ? d['phase'] : '',
      ...(typeof d['url']   === 'string' ? { url:   d['url']   as string } : {}),
      ...(typeof d['error'] === 'string' ? { error: d['error'] as string } : {}),
      elapsedMs: typeof d['elapsedMs'] === 'number' ? d['elapsedMs'] : 0,
      etaMs:     typeof d['etaMs']     === 'number' ? d['etaMs']     : 0,
    })
  }, [jobId])

  useEffect(() => {
    if (!jobId || alreadyDone) return
    return onServerEvent('image', onFrame)
  }, [jobId, alreadyDone, onFrame])

  useEffect(() => {
    if (!jobId || alreadyDone) return
    let cancelled = false
    // Jobs are in-memory on the server, so a 404 here means the container
    // restarted mid-render. That's a dead end, not a slow one — say so instead
    // of spinning.
    fetch(`/api/image/job/${jobId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (!cancelled) onFrame(j) })
      .catch(() => {
        if (!cancelled) {
          setState({
            jobId, status: 'failed', phase: 'failed', elapsedMs: 0, etaMs: 0,
            error: 'the server restarted while this was being drawn',
          })
        }
      })
    return () => { cancelled = true }
  }, [jobId, alreadyDone, onFrame])

  return state && state.jobId === jobId ? state : null
}
