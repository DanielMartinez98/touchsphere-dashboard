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
   * Tick or untick one sub-step.
   *
   * The optimistic update has to reproduce the SERVER's cascade, not just flip
   * the box: setSubStepDone() completes the parent step when its last sub is
   * ticked and reopens it when any is cleared. Flipping only the sub here would
   * leave the step's own checkbox stale for the length of a round trip — and on
   * the last sub of a step that is the exact moment the user is looking at it.
   */
  const toggleSubStep = useCallback((sectionId: string, stepId: string, subId: string) => {
    if (!itemId || !guide) return
    const step = guide.sections.find(s => s.id === sectionId)?.steps.find(s => s.id === stepId)
    const sub = step?.subs?.find(x => x.id === subId)
    if (!step?.subs || !sub) return
    const next = !sub.done
    const subs = step.subs.map(x => x.id !== subId ? x : { ...x, done: next })
    const stepDone = subs.every(x => x.done)

    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        sections: guide.sections.map(sec => sec.id !== sectionId ? sec : {
          ...sec,
          steps: sec.steps.map(s => s.id !== stepId ? s : { ...s, subs, done: stepDone }),
        }),
      },
    })

    fetch(`${API}/${itemId}/steps/${sectionId}/${stepId}/subs/${subId}`, {
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
        console.error('[Guides] toggleSubStep failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

  /**
   * Tick or clear one sub-chapter — the run of steps starting at `fromIndex`.
   *
   * Addressed by index rather than by heading because a heading can legitimately
   * recur inside a chapter, and both sides group by consecutive runs for exactly
   * that reason. Walking forward while the group matches is the same loop the
   * server runs, so what is ticked here and there is always the same run.
   */
  const togglePart = useCallback((sectionId: string, fromIndex: number, done: boolean) => {
    if (!itemId || !guide) return
    const section = guide.sections.find(s => s.id === sectionId)
    const first = section?.steps[fromIndex]
    if (!section || !first) return
    const group = first.group ?? ''

    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        sections: guide.sections.map(sec => sec.id !== sectionId ? sec : {
          ...sec,
          steps: sec.steps.map((s, i) => {
            if (i < fromIndex || (s.group ?? '') !== group) return s
            // Stop at the end of the run. `map` cannot break, so the group check
            // above carries it — which is correct as long as the run is
            // contiguous, and it is by construction.
            return { ...s, done, ...(s.subs ? { subs: s.subs.map(u => ({ ...u, done })) } : {}) }
          }),
        }),
      },
    })

    fetch(`${API}/${itemId}/parts/${sectionId}/${fromIndex}`, {
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
        console.error('[Guides] togglePart failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

  /**
   * The map calls, which are deliberately NOT optimistic.
   *
   * Every other mutation here is a checkbox: the user knows what they pressed,
   * the answer is a boolean, and showing it immediately is worth a rare
   * rollback. A pin is not — it is created by the server (which mints its id),
   * it can be refused because the map is full, and the thing being edited is a
   * position the user is dragging. Waiting for the real document is both simpler
   * and, at one tap per pin rather than one per box, cheap enough to afford.
   */
  const mapCall = useCallback((path: string, method: string, body?: unknown) => {
    if (!itemId) return Promise.resolve()
    return fetch(`${API}/${itemId}/map/${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(updated => setLoaded({ id: itemId, guide: updated }))
      .catch(err => {
        console.error('[Guides] map update failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, load])

  /** `sectionId` null means the whole-game map, which the URL spells "-". */
  const scope = (sectionId: string | null) => sectionId ?? '-'

  const addPin = useCallback((sectionId: string | null, x: number, y: number, label: string) =>
    mapCall(`${scope(sectionId)}/pins`, 'POST', { x, y, label }), [mapCall])

  const movePin = useCallback((sectionId: string | null, pinId: string, x: number, y: number) =>
    mapCall(`${scope(sectionId)}/pins/${pinId}`, 'PATCH', { x, y }), [mapCall])

  const labelPin = useCallback((sectionId: string | null, pinId: string, label: string) =>
    mapCall(`${scope(sectionId)}/pins/${pinId}`, 'PATCH', { label }), [mapCall])

  const removePin = useCallback((sectionId: string | null, pinId: string) =>
    mapCall(`${scope(sectionId)}/pins/${pinId}`, 'DELETE'), [mapCall])

  /** Drag a generated step pin into the right place. Clears its `approx` flag. */
  const moveStepPin = useCallback((sectionId: string, stepId: string, x: number, y: number) => {
    if (!itemId) return Promise.resolve()
    return fetch(`${API}/${itemId}/steps/${sectionId}/${stepId}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Guide>
      })
      .then(updated => setLoaded({ id: itemId, guide: updated }))
      .catch(err => {
        console.error('[Guides] moveStepPin failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, load])

  /**
   * Re-research one chapter. The rest of the guide, and every tick in it, stays
   * put — so a chapter that came out thin is a one-tap fix rather than a reason
   * to rebuild the whole thing.
   */
  /**
   * Add detail, pictures and map pins to a chapter that already exists.
   *
   * Deliberately does NOT mark the section 'pending' the way rebuildSection
   * does. Pending is what draws the chapter as being rewritten — greyed, with
   * its steps treated as provisional — and that would be a lie here: every step
   * and every tick stays exactly where it is while this runs, and the chapter is
   * readable and tickable throughout.
   */
  const enrichSection = useCallback((sectionId: string) => {
    if (!itemId || !guide) return
    setLoaded({
      id: itemId,
      guide: {
        ...guide,
        status: 'generating',
        phase: `Adding detail to ${guide.sections.find(s => s.id === sectionId)?.title ?? 'chapter'}…`,
      },
    })
    console.log(`[Guides] enrich section ${sectionId} of "${guide.title}"`)

    fetch(`${API}/${itemId}/sections/${sectionId}/enrich`, { method: 'POST' })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`) })
      .catch(err => {
        console.error('[Guides] section enrich failed — reloading:', err)
        void load(itemId)
      })
  }, [itemId, guide, load])

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

  return {
    guide, loading, refresh,
    toggleStep, toggleSubStep, togglePart, toggleSection, rebuildSection, enrichSection,
    addPin, movePin, labelPin, removePin, moveStepPin,
  }
}
