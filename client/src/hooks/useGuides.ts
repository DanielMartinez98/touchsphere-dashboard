// Game guides, client side.
//
//   useGuides()        — the summary per game (percent, status), for the list rows
//                        and the collapsed pill. Cheap: one small array.
//   useGuide(itemId)   — the full document for the guide view, plus the actions
//                        that mutate it.
//
// Both follow the server's `guide` SSE event (see server/src/guide-generator.ts),
// which fires on every section as a guide is built — that's what makes the view
// fill in while you watch instead of after a blind five-minute wait.

import { useCallback, useEffect, useState } from 'react'
import type { Guide, GuideSummary } from '../types'
import { onServerEvent } from './useServerEvents'

const API = '/api/guides'

/** Shape of the server's `guide` SSE payload. */
interface GuideEvent {
  itemId?: string
  status?: string
  percent?: number
  phase?: string
  title?: string
}

function asEvent(raw: unknown): GuideEvent {
  return (raw && typeof raw === 'object' ? raw : {}) as GuideEvent
}

// ── Mutations ────────────────────────────────────────────────────────────────
// Plain functions rather than hook methods: the guide is reachable from the media
// widget, from the top-level overlay, and (indirectly) from the assistant, and
// none of those should have to hold the summaries hook just to start a rebuild.

/** Start or rebuild a guide. `order` overrides the community ordering. */
export function requestGuide(itemId: string, title: string, order?: string): Promise<Response | void> {
  console.log(`[Guides] generate "${title}"${order ? ` order="${order}"` : ''}`)
  return fetch(`${API}/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...(order ? { order } : {}) }),
  }).catch(err => console.error('[Guides] generate failed:', err))
}

export function removeGuide(itemId: string): Promise<Response | void> {
  return fetch(`${API}/${itemId}`, { method: 'DELETE' })
    .catch(err => console.error('[Guides] delete failed:', err))
}

/**
 * Summaries for every guide, keyed by media item id. Refetches when a guide
 * changes on the server (SSE) and when a chat tool touches the `guides` slice.
 */
export function useGuides() {
  const [byItem, setByItem] = useState<Record<string, GuideSummary>>({})

  useEffect(() => {
    let cancelled = false
    const load = (reason: string) => {
      fetch(API)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<GuideSummary[]>
        })
        .then(list => {
          if (cancelled) return
          const map: Record<string, GuideSummary> = {}
          for (const g of list) map[g.itemId] = g
          setByItem(map)
          if (list.length > 0) console.log(`[Guides] ${list.length} guide(s) loaded (${reason})`)
        })
        .catch(err => console.error('[Guides] failed to load summaries:', err))
    }
    load('mount')

    const offSse = onServerEvent('guide', raw => {
      const e = asEvent(raw)
      if (!e.itemId) return
      // The event carries everything a summary row shows, so patch it straight
      // in — a refetch per section would be one request per ~30 s of generation
      // against a 60/min budget shared with every other widget.
      setByItem(prev => {
        const existing = prev[e.itemId!]
        return {
          ...prev,
          [e.itemId!]: {
            itemId:   e.itemId!,
            title:    e.title ?? existing?.title ?? '',
            status:   (e.status as GuideSummary['status']) ?? existing?.status ?? 'generating',
            ...(e.phase ? { phase: e.phase } : {}),
            percent:  typeof e.percent === 'number' ? e.percent : existing?.percent ?? 0,
            counted:  existing?.counted ?? { done: 0, total: 0 },
            sections: typeof (raw as { sections?: number })?.sections === 'number'
              ? (raw as { sections: number }).sections
              : existing?.sections ?? 0,
          },
        }
      })
      // A finished guide also settles the exact counts, which the event only
      // approximates via `percent`.
      if (e.status === 'ready' || e.status === 'failed') load('guide-finished')
    })

    const onChange = (ev: Event) => {
      const slices = (ev as CustomEvent<{ slices?: string[] }>).detail?.slices
      if (!slices || slices.includes('guides')) load('chat-tool')
    }
    window.addEventListener('ts:state-changed', onChange)
    return () => {
      cancelled = true
      offSse()
      window.removeEventListener('ts:state-changed', onChange)
    }
  }, [])

  /** Start (or regenerate) a guide. `order` overrides the community ordering. */
  const generate = useCallback((itemId: string, title: string, order?: string) => {
    // Show the spinner immediately rather than waiting for the first SSE frame —
    // on the Pi the outline research can take ten seconds before anything moves.
    setByItem(prev => ({
      ...prev,
      [itemId]: {
        itemId, title, status: 'generating', phase: 'Starting…',
        percent: 0, counted: { done: 0, total: 0 }, sections: 0,
      },
    }))
    return requestGuide(itemId, title, order)
  }, [])

  const remove = useCallback((itemId: string) => {
    setByItem(prev => {
      const next = { ...prev }
      delete next[itemId]
      return next
    })
    return removeGuide(itemId)
  }, [])

  return { byItem, generate, remove }
}

/**
 * The full guide for one item. `null` means "no guide yet" (a 404), which is a
 * normal state — distinct from `loading`, which is the first fetch in flight.
 */
export function useGuide(itemId: string | null) {
  // The id is held alongside the document so `loading` can be derived from
  // "the fetch for the id we're being asked about hasn't landed yet" — no
  // setState in an effect body, and no stale guide flashing under a new title.
  const [loaded, setLoaded] = useState<{ id: string; guide: Guide | null } | null>(null)

  const load = useCallback((id: string) => {
    return fetch(`${API}/${id}`)
      .then(res => {
        if (res.status === 404) return null   // no guide yet — a normal state
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(g => { setLoaded({ id, guide: g }) })
      .catch(err => console.error('[Guides] failed to load guide:', err))
  }, [])

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    void fetch(`${API}/${itemId}`)
      .then(res => {
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(g => { if (!cancelled) setLoaded({ id: itemId, guide: g }) })
      .catch(err => console.error('[Guides] failed to load guide:', err))
    return () => { cancelled = true }
  }, [itemId])

  const guide   = loaded && loaded.id === itemId ? loaded.guide : null
  const loading = itemId !== null && loaded?.id !== itemId

  // Follow generation: every section the server finishes broadcasts an event,
  // and the whole document is small enough to just refetch each time.
  useEffect(() => {
    if (!itemId) return
    return onServerEvent('guide', raw => {
      const e = asEvent(raw)
      if (e.itemId !== itemId) return
      void load(itemId)
    })
  }, [itemId, load])

  /**
   * Tick or untick one step. Optimistic — the value is computed from the current
   * document *before* setState, never inside the updater, so the PATCH can't
   * carry a stale value (same trap documented in useMediaList's toggleStar).
   */
  const toggleStep = useCallback((sectionId: string, stepId: string) => {
    if (!itemId || !guide) return
    const section = guide.sections.find(s => s.id === sectionId)
    const step = section?.steps.find(s => s.id === stepId)
    if (!step) return
    const next = !step.done

    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        sections: guide.sections.map(sec => sec.id !== sectionId ? sec : {
          ...sec,
          steps: sec.steps.map(s => s.id !== stepId ? s : { ...s, done: next }),
        }),
      },
    })

    fetch(`${API}/${itemId}/steps/${sectionId}/${stepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: next }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(updated => setLoaded({ id: itemId, guide: updated }))
      .catch(err => {
        console.error('[Guides] toggleStep failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

  /**
   * Tick or clear a whole chapter — the "I already finished that dungeon"
   * shortcut. Optimistic like toggleStep, and one request rather than one per
   * step: sixty PATCHes would blow the 60/min data budget on a single tap.
   */
  const toggleSection = useCallback((sectionId: string, done: boolean) => {
    if (!itemId || !guide) return
    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        sections: guide.sections.map(sec => sec.id !== sectionId ? sec : {
          ...sec,
          steps: sec.steps.map(s => ({ ...s, done })),
        }),
      },
    })

    fetch(`${API}/${itemId}/sections/${sectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(updated => setLoaded({ id: itemId, guide: updated }))
      .catch(err => {
        console.error('[Guides] toggleSection failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

  /**
   * Re-research one chapter. The rest of the guide, and every tick in it, stays
   * put — so a chapter that came out thin is a one-tap fix rather than a reason
   * to rebuild the whole thing.
   */
  const rebuildSection = useCallback((sectionId: string) => {
    if (!itemId || !guide) return
    // Show it working straight away: the first SSE frame is a research call away.
    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        status: 'generating',
        phase: `Rewriting ${guide.sections.find(s => s.id === sectionId)?.title ?? 'chapter'}…`,
        sections: guide.sections.map(sec => sec.id !== sectionId ? sec : { ...sec, state: 'pending' }),
      },
    })
    console.log(`[Guides] rewrite section ${sectionId} of "${guide.title}"`)

    fetch(`${API}/${itemId}/sections/${sectionId}/regenerate`, { method: 'POST' })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`) })
      .catch(err => {
        console.error('[Guides] section rebuild failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

  const refresh = useCallback(() => {
    if (itemId) void load(itemId)
  }, [itemId, load])

  return { guide, loading, toggleStep, toggleSection, rebuildSection, refresh }
}
