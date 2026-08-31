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

export interface ImageStyle {
  /** Checkpoint filename, or `wf:<id>` for a whole-workflow style. */
  id:    string
  label: string
  kind:  'checkpoint' | 'workflow'
}

interface StylesResponse {
  models?:  string[]
  styles?:  ImageStyle[]
  selected?: string
  quality?:  string
}

/**
 * Styles from the response, tolerating a server that predates them.
 *
 * The dashboard and the server update independently (Watchtower pulls the image
 * on its own schedule), so a client can briefly be newer than the API it talks
 * to. Falling back to the flat `models` list keeps the picker working instead of
 * rendering empty.
 */
function stylesOf(j: StylesResponse): ImageStyle[] {
  if (j.styles?.length) return j.styles
  return (j.models ?? []).map(m => ({ id: m, label: m, kind: 'checkpoint' as const }))
}

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
  // Installed checkpoints and the one in effect. Asked of the server rather
  // than configured here, because ComfyUI is the only thing that knows what is
  // actually on the GPU box's disk.
  // Styles cover BOTH kinds: a checkpoint filename, and a `wf:` workflow style
  // like Anima that is three files behind three loader nodes and has no
  // ckpt_name to swap. The picker shouldn't care which is which.
  const [styles,  setStyles]     = useState<ImageStyle[]>([])
  const [model,   setModelState] = useState('')
  const [quality, setQualityState] = useState('standard')

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

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/image/models')
      const j = await res.json() as StylesResponse
      setStyles(stylesOf(j))
      setModelState(j.selected ?? '')
      setQualityState(j.quality ?? 'standard')
    } catch (err) {
      console.warn('[images] model list failed:', err)
    }
  }, [])

  // Initial model list — inlined with a cancelled guard for the same reason as
  // the gallery load above, rather than routed through loadModels().
  useEffect(() => {
    let cancelled = false
    fetch('/api/image/models')
      .then(r => r.json())
      .then((j: StylesResponse) => {
        if (cancelled) return
        setStyles(stylesOf(j))
        setModelState(j.selected ?? '')
        setQualityState(j.quality ?? 'standard')
      })
      .catch(err => { if (!cancelled) console.warn('[images] model list failed:', err) })
    return () => { cancelled = true }
  }, [])

  /**
   * Switch checkpoints.
   *
   * Optimistic, then reconciled: the picker has to feel instant on a touchscreen,
   * but the server validates the name against what ComfyUI actually has, so its
   * answer wins. Nothing is drawn here — the choice applies to the next picture,
   * from this panel or from the assistant.
   */
  const setModel = useCallback(async (next: string) => {
    setModelState(next)
    try {
      const res = await fetch('/api/image/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] setting model failed:', err)
      void loadModels()          // put the real value back
    }
  }, [loadModels])

  /** Change the quality preset. Same optimistic-then-reconciled shape as setModel. */
  const setQuality = useCallback(async (next: string) => {
    setQualityState(next)
    try {
      const res = await fetch('/api/image/quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] setting quality failed:', err)
      void loadModels()
    }
  }, [loadModels])

  // Retry while the image server is down.
  //
  // `enabled` was fetched exactly once at mount, which is wrong for a kiosk in
  // two ways that both really happen: the Pi boots at the same moment as the
  // server and can win the race, and the GPU box gets switched on hours after
  // the dashboard did. Either way the panel latched on "isn't reachable" and
  // stayed there until someone reloaded — which on a kiosk with no keyboard is
  // nobody. One small request every 30s, only while it is actually broken.
  useEffect(() => {
    if (enabled !== false) return
    const t = setInterval(() => { void refresh(); void loadModels() }, 30_000)
    return () => clearInterval(t)
  }, [enabled, refresh, loadModels])

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

  return {
    images, enabled, loading, busy, phase: busy ? (job?.phase ?? '') : '',
    styles, model, setModel,
    quality, setQuality,
    generate, remove, refresh,
  }
}
