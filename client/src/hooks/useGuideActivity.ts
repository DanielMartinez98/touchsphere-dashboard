// The live feed of what the guide system is doing, for Settings → Guides.
//
// Two halves that have to agree: one GET for what already happened (the tab is
// usually opened mid-run, or after one finished), then the `guide-activity` SSE
// event for everything after that. Entries carry a monotonic id from the server,
// so a line that arrives over SSE while the fetch is still in flight can't end
// up in the list twice.

import { useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export type ActivityLevel = 'info' | 'good' | 'warn' | 'error'

export interface GuideActivity {
  id:       number
  at:       string
  itemId:   string
  title:    string
  stage:    string
  message:  string
  level:    ActivityLevel
  section?: string
}

function isActivity(raw: unknown): raw is GuideActivity {
  const o = raw as GuideActivity | null
  return !!o && typeof o === 'object' && typeof o.id === 'number' && typeof o.message === 'string'
}

/** Recent activity, newest first. `live` is false until the first load lands. */
export function useGuideActivity(): { entries: GuideActivity[]; live: boolean } {
  const [entries, setEntries] = useState<GuideActivity[]>([])
  const [live, setLive] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Merge rather than replace, so anything that streamed in during the fetch
    // survives it. Newest first, capped at what the server keeps anyway.
    const merge = (incoming: GuideActivity[]) => {
      if (cancelled) return
      setEntries(prev => {
        const seen = new Map(prev.map(e => [e.id, e]))
        for (const e of incoming) seen.set(e.id, e)
        return [...seen.values()].sort((a, b) => b.id - a.id).slice(0, 300)
      })
    }

    fetch('/api/guides/activity')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<unknown[]>
      })
      .then(list => {
        merge(list.filter(isActivity))
        if (!cancelled) setLive(true)
      })
      .catch(err => console.error('[Guides] failed to load activity:', err))

    const off = onServerEvent('guide-activity', raw => {
      if (isActivity(raw)) merge([raw])
    })
    return () => { cancelled = true; off() }
  }, [])

  return { entries, live }
}
