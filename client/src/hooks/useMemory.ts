// What the assistant knows about you, and the controls to change it.
//
// Backed by /api/memory (server/src/routes/memory.ts). Refetches when the chat
// tools touch the 'memory' slice, so saying "remember I'm vegetarian" shows up
// in the Settings list without a reload.

import { useCallback, useEffect, useState } from 'react'

const API = ''

export type MemoryKind   = 'fact' | 'preference'
export type MemorySource = 'assistant' | 'auto' | 'user'

export interface MemoryItem {
  id:        string
  content:   string
  createdAt: string
  expiresAt?: string
  source?:   MemorySource
  kind?:     MemoryKind
}

/** The last conversation, if one is still inside its 12h window. */
export interface SessionInfo {
  endedAt:    string
  ageMinutes: number
  turns:      number
  summary:    string | null
  keywords:   string[]
  opener:     string | null
}

export interface MemorySnapshot {
  facts:       MemoryItem[]
  preferences: MemoryItem[]
  shortTerm:   MemoryItem[]
  session:     SessionInfo | null
}

const EMPTY: MemorySnapshot = { facts: [], preferences: [], shortTerm: [], session: null }

export function useMemory() {
  const [data,    setData]    = useState<MemorySnapshot>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Promise chain rather than async/await so the setState calls sit in a
  // callback — same shape as useTimers, and it keeps the effect body free of
  // synchronous state updates. Still awaitable by the mutators below.
  const load = useCallback((): Promise<void> => {
    return fetch(`${API}/api/memory`)
      .then(res => {
        if (!res.ok) throw new Error(`http ${res.status}`)
        return res.json() as Promise<Partial<MemorySnapshot>>
      })
      .then(json => {
        setData({
          facts:       json.facts       ?? [],
          preferences: json.preferences ?? [],
          shortTerm:   json.shortTerm   ?? [],
          session:     json.session     ?? null,
        })
        setError(null)
        setLoading(false)
      })
      .catch(err => {
        console.warn('[memory] load failed:', err)
        setError('Could not load memory.')
        setLoading(false)
      })
  }, [])

  // Initial load + refetch on voice-driven changes. Same pattern as useTimers:
  // the chat route reports which slices its tools touched, and only the
  // matching hooks refetch.
  useEffect(() => {
    void load()
    const onChange = (e: Event) => {
      const slices = (e as CustomEvent<{ slices?: string[] }>).detail?.slices
      if (!slices || slices.includes('memory')) void load()
    }
    window.addEventListener('ts:state-changed', onChange)
    return () => window.removeEventListener('ts:state-changed', onChange)
  }, [load])

  const add = useCallback(async (content: string, kind: MemoryKind) => {
    const body = JSON.stringify({ content, kind, scope: 'long' })
    const res = await fetch(`${API}/api/memory`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    if (!res.ok) throw new Error(`http ${res.status}`)
    await load()
  }, [load])

  const remove = useCallback(async (id: string) => {
    const res = await fetch(`${API}/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`http ${res.status}`)
    await load()
  }, [load])

  const forgetSession = useCallback(async () => {
    await fetch(`${API}/api/memory/session`, { method: 'DELETE' })
    await load()
  }, [load])

  return { ...data, loading, error, reload: load, add, remove, forgetSession }
}
