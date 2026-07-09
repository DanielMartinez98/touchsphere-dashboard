import { useState, useEffect, useCallback } from 'react'

// Which Notion databases feed the aggregated Home task list. Mirrors the
// server-persisted set (see /api/notion/task-dbs). Kept tiny — a set of ids the
// Browse view toggles via "Show in Tasks". Changing it fires a global
// `ts:task-dbs-changed` event so the task widget refetches.

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(j.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function useTaskDbs() {
  const [ids, setIds] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ ids: string[] }>('/api/notion/task-dbs')
      setIds(data.ids)
    } catch { /* Notion may be unconfigured — leave empty */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const has = useCallback((id: string) => ids.includes(id), [ids])

  const add = useCallback(async (id: string) => {
    setIds(prev => prev.includes(id) ? prev : [...prev, id]) // optimistic
    try {
      const data = await api<{ ids: string[] }>('/api/notion/task-dbs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id }),
      })
      setIds(data.ids)
      window.dispatchEvent(new CustomEvent('ts:task-dbs-changed'))
    } catch { void refresh() }
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    setIds(prev => prev.filter(x => x !== id)) // optimistic
    try {
      const data = await api<{ ids: string[] }>(`/api/notion/task-dbs/${id}`, { method: 'DELETE' })
      setIds(data.ids)
      window.dispatchEvent(new CustomEvent('ts:task-dbs-changed'))
    } catch { void refresh() }
  }, [refresh])

  const toggle = useCallback((id: string) => (ids.includes(id) ? remove(id) : add(id)), [ids, add, remove])

  return { ids, has, add, remove, toggle, refresh }
}
