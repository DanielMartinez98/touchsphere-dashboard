// The generated-image gallery, and the tap half of drawing.
//
// The voice half already existed (`generate_image` → a display payload →
// ImageOverlay). This is the other half of the rule the rest of the app follows:
// everything reachable by asking is reachable by tapping. Same store on disk,
// same job engine — the widget just POSTs the request the assistant would have.
//
// Refreshes off the shared `image` SSE event rather than polling, so a picture
// the ASSISTANT was asked for appears in the widget's grid too, without the
// widget knowing anything about the conversation.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export interface StoredImage {
  id:     string
  prompt: string
  file:   string
  url:    string
  width:  number
  height: number
  seed:   number
  at:     string
}

export type Orientation = 'portrait' | 'landscape' | 'square'

// Mirrors SIZES in server/src/routes/image-tools.ts. Duplicated rather than
// fetched: it's three constants, and the widget has to draw the aspect-ratio
// buttons before it has spoken to the server at all.
export const SIZES: Record<Orientation, { width: number; height: number }> = {
  portrait:  { width: 768,  height: 1152 },
  landscape: { width: 1152, height: 768  },
  square:    { width: 896,  height: 896  },
}

export function useImages() {
  const [images,  setImages]  = useState<StoredImage[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)   // null = not asked yet
  const [loading, setLoading] = useState(true)
  // Whatever is rendering right now, from ANY source. The collapsed pill and the
  // Draw button both read this, so a picture the assistant was asked for shows
  // as "Drawing…" in the corner too — one GPU, one queue, one busy flag.
  const [job, setJob] = useState<{ status: string; phase: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/image')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json() as { enabled: boolean; images: StoredImage[] }
      setImages(j.images ?? [])
      setEnabled(j.enabled)
    } catch (err) {
      console.warn('[images] list failed:', err)
      setEnabled(false)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load. Inlined with a cancelled guard rather than calling refresh(),
  // matching useGuides — an unmount mid-flight must not set state on a dead hook.
  useEffect(() => {
    let cancelled = false
    fetch('/api/image')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { enabled: boolean; images: StoredImage[] }) => {
        if (cancelled) return
        setImages(j.images ?? [])
        setEnabled(j.enabled)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        console.warn('[images] list failed:', err)
        setEnabled(false)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Follow every render, from whichever source started it: phase frames drive
  // the busy state, and 'ready' additionally refetches the list.
  useEffect(() => onServerEvent('image', data => {
    const d = data as Record<string, unknown> | null
    const status = typeof d?.['status'] === 'string' ? d['status'] : ''
    if (!status) return
    setJob({ status, phase: typeof d?.['phase'] === 'string' ? d['phase'] : '' })
    if (status === 'ready') void refresh()
  }), [refresh])

  // Catch up on a render already in flight when the dashboard loads or the
  // widget mounts — SSE only carries what happens from now on, and a Pi that
  // reloaded mid-render would otherwise show an idle corner over a busy GPU.
  useEffect(() => {
    let cancelled = false
    fetch('/api/image/active')
      .then(r => (r.ok ? r.json() : null))
      .then((j: { status?: string; phase?: string } | null) => {
        if (!cancelled && j?.status) setJob({ status: j.status, phase: j.phase ?? '' })
      })
      .catch(() => { /* offline server; the pill already says so via `enabled` */ })
    return () => { cancelled = true }
  }, [])

  /** Queue a render. Returns the new job id, or null if the server refused. */
  const generate = useCallback(async (prompt: string, orientation: Orientation): Promise<string | null> => {
    const size = SIZES[orientation]
    try {
      const res = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, width: size.width, height: size.height }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const j = await res.json() as { id: string }
      return j.id
    } catch (err) {
      console.error('[images] generate failed:', err)
      return null
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    // Optimistic: the grid is the user's own tap, and a failed DELETE is put
    // back by the next refresh rather than blocking the animation.
    setImages(prev => prev.filter(i => i.id !== id))
    try {
      const res = await fetch(`/api/image/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] delete failed:', err)
      void refresh()
    }
  }, [refresh])

  const busy = job?.status === 'queued' || job?.status === 'running'

  return { images, enabled, loading, busy, phase: busy ? (job?.phase ?? '') : '', generate, remove, refresh }
}
