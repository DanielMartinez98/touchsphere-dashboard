import { useState, useEffect, useCallback } from 'react'
import type { FilterModel } from '../components/widgets/NotionWidget/FilterTree'
import type { SortKey }     from '../components/widgets/NotionWidget/MultiSort'

// Per-database view presets — name + filter + sort + grouping + view mode.
// Persisted to localStorage keyed by database id so each DB has its own list.

export type ViewMode = 'list' | 'board' | 'calendar' | 'gallery' | 'timeline'

export interface SavedView {
  id:        string
  name:      string
  view:      ViewMode
  filter:    FilterModel
  sorts:     SortKey[]
  // group-by property name for list view; null = no grouping
  groupBy:   string | null
}

function storageKey(dbId: string) { return `notion.dbViews.${dbId}` }

function load(dbId: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(dbId))
    return raw ? JSON.parse(raw) as SavedView[] : []
  } catch { return [] }
}
function save(dbId: string, views: SavedView[]) {
  try { localStorage.setItem(storageKey(dbId), JSON.stringify(views)) }
  catch { /* quota — ignore */ }
}

export function useDatabaseViews(dbId: string) {
  const [views, setViews] = useState<SavedView[]>(() => load(dbId))

  // Refresh when the db id changes (navigating between DBs).
  useEffect(() => { setViews(load(dbId)) }, [dbId])

  const createView = useCallback((v: Omit<SavedView, 'id'>): SavedView => {
    const created: SavedView = { ...v, id: crypto.randomUUID() }
    setViews(prev => {
      const next = [...prev, created]
      save(dbId, next)
      return next
    })
    return created
  }, [dbId])

  const updateView = useCallback((id: string, patch: Partial<SavedView>) => {
    setViews(prev => {
      const next = prev.map(v => v.id === id ? { ...v, ...patch } : v)
      save(dbId, next)
      return next
    })
  }, [dbId])

  const deleteView = useCallback((id: string) => {
    setViews(prev => {
      const next = prev.filter(v => v.id !== id)
      save(dbId, next)
      return next
    })
  }, [dbId])

  return { views, createView, updateView, deleteView }
}
