import { useState, useEffect, useCallback, useRef } from 'react'
import type { NotionColor } from '../components/widgets/NotionWidget/notion-types'

// Server-side mirror of NotionGroup. The server is the source of truth — we
// keep optimistic local state for snappy interactions and reconcile on failure.

export interface NotionGroupItem {
  refId: string
  kind:  'page' | 'database'
  title: string
  icon:  string | null
  order: number
}

export interface NotionGroup {
  id:        string
  name:      string
  icon:      string | null
  color:     NotionColor | null
  order:     number
  collapsed: boolean
  items:     NotionGroupItem[]
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(j.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

const LEGACY_PINNED_KEY = 'notion.pinned'

export function useNotionGroups() {
  const [groups,  setGroups]  = useState<NotionGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  // One-shot migration guard so the localStorage → server move only fires once.
  const migrated = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const data = await api<NotionGroup[]>('/api/state/notion-groups')
      setGroups(data)
      return data
    } catch (e: any) {
      setError(e.message ?? 'Failed to load groups')
      return null
    }
  }, [])

  // First load: fetch groups, then if the server is empty and we have legacy
  // localStorage pins, seed a "Pinned" group from them. Idempotent — once the
  // server has any group, we never re-migrate.
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const data = await refresh()
      if (!alive) return
      if (data && data.length === 0 && !migrated.current) {
        migrated.current = true
        try {
          const raw = localStorage.getItem(LEGACY_PINNED_KEY)
          const legacy = raw ? JSON.parse(raw) as Array<{ id: string; title: string; icon: string | null; kind: 'page' | 'database' }> : []
          if (legacy.length > 0) {
            const created = await api<NotionGroup>('/api/state/notion-groups', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ name: 'Pinned', icon: '⭐', color: 'yellow' }),
            })
            for (const it of legacy) {
              await api(`/api/state/notion-groups/${created.id}/items`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ refId: it.id, kind: it.kind, title: it.title, icon: it.icon }),
              })
            }
            localStorage.removeItem(LEGACY_PINNED_KEY)
            await refresh()
          }
        } catch { /* migration is best-effort */ }
      }
      setLoading(false)
    })()
    return () => { alive = false }
  }, [refresh])

  // ── Group mutations ─────────────────────────────────────────────────────────

  async function createGroup(name: string, icon?: string | null, color?: NotionColor | null): Promise<NotionGroup | null> {
    try {
      const g = await api<NotionGroup>('/api/state/notion-groups', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, icon: icon ?? null, color: color ?? null }),
      })
      setGroups(prev => [...prev, g].sort((a, b) => a.order - b.order))
      return g
    } catch (e: any) {
      setError(e.message ?? 'Failed to create group')
      return null
    }
  }

  async function patchGroup(id: string, patch: Partial<Pick<NotionGroup, 'name' | 'icon' | 'color' | 'collapsed' | 'order'>> & { itemOrder?: string[] }) {
    // Optimistic — apply locally, then send. On failure refetch.
    setGroups(prev => prev.map(g => g.id === id ? { ...g, ...patch } as NotionGroup : g))
    try {
      await api(`/api/state/notion-groups/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      // If reorder happened the server renumbered, so pull authoritative state.
      if ('order' in patch || 'itemOrder' in patch) await refresh()
    } catch {
      await refresh()
    }
  }

  async function renameGroup(id: string, name: string)              { return patchGroup(id, { name }) }
  async function setIcon    (id: string, icon: string | null)       { return patchGroup(id, { icon }) }
  async function setColor   (id: string, color: NotionColor | null) { return patchGroup(id, { color }) }
  async function toggleCollapse(id: string) {
    const g = groups.find(x => x.id === id)
    if (!g) return
    return patchGroup(id, { collapsed: !g.collapsed })
  }

  async function deleteGroup(id: string) {
    setGroups(prev => prev.filter(g => g.id !== id))
    try {
      await api(`/api/state/notion-groups/${id}`, { method: 'DELETE' })
    } catch {
      await refresh()
    }
  }

  async function moveGroup(id: string, newOrder: number) { return patchGroup(id, { order: newOrder }) }

  // ── Item mutations ──────────────────────────────────────────────────────────

  async function addItem(groupId: string, item: Omit<NotionGroupItem, 'order'>) {
    // Optimistic append — skip if already present.
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g
      if (g.items.some(it => it.refId === item.refId)) return g
      return { ...g, items: [...g.items, { ...item, order: g.items.length }] }
    }))
    try {
      await api(`/api/state/notion-groups/${groupId}/items`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item),
      })
    } catch {
      await refresh()
    }
  }

  async function removeItem(groupId: string, refId: string) {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g
      return { ...g, items: g.items.filter(it => it.refId !== refId) }
    }))
    try {
      await api(`/api/state/notion-groups/${groupId}/items/${refId}`, { method: 'DELETE' })
    } catch {
      await refresh()
    }
  }

  async function reorderItems(groupId: string, refIds: string[]) {
    return patchGroup(groupId, { itemOrder: refIds })
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────

  // Which groups contain this refId — used to render checkmarks in AddToGroupSheet.
  const groupsContaining = useCallback(
    (refId: string) => groups.filter(g => g.items.some(it => it.refId === refId)).map(g => g.id),
    [groups],
  )

  return {
    groups, loading, error,
    refresh,
    createGroup, renameGroup, setIcon, setColor, toggleCollapse, deleteGroup, moveGroup,
    addItem, removeItem, reorderItems,
    groupsContaining,
  }
}

export type NotionGroupsApi = ReturnType<typeof useNotionGroups>
