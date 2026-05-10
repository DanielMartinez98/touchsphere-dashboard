import { useState, useEffect, useCallback } from 'react'

// Persisted in localStorage so the kiosk remembers across reboots. The two
// lists are intentionally tiny — 10 entries each — to keep the Home screen
// scannable.

export interface PinnedItem {
  id:     string
  title:  string
  icon:   string | null
  kind:   'page' | 'database'
  ts:     number   // last touched / pinned-at timestamp
}

const RECENT_KEY = 'notion.recents'
const PINNED_KEY = 'notion.pinned'
const MAX_RECENT = 10
const MAX_PINNED = 10

function load(key: string): PinnedItem[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function save(key: string, items: PinnedItem[]) {
  try { localStorage.setItem(key, JSON.stringify(items)) }
  catch { /* quota / private mode — ignore */ }
}

export function useNotionPins() {
  const [recents, setRecents] = useState<PinnedItem[]>(() => load(RECENT_KEY))
  const [pinned,  setPinned]  = useState<PinnedItem[]>(() => load(PINNED_KEY))

  // Sync to other widget instances / tabs that share localStorage.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === RECENT_KEY) setRecents(load(RECENT_KEY))
      if (e.key === PINNED_KEY) setPinned(load(PINNED_KEY))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Record a visit. Bumps existing entries to the top.
  const recordVisit = useCallback((item: Omit<PinnedItem, 'ts'>) => {
    setRecents(prev => {
      const next = [{ ...item, ts: Date.now() }, ...prev.filter(r => r.id !== item.id)].slice(0, MAX_RECENT)
      save(RECENT_KEY, next)
      return next
    })
  }, [])

  const isPinned = useCallback((id: string) => pinned.some(p => p.id === id), [pinned])

  const togglePin = useCallback((item: Omit<PinnedItem, 'ts'>) => {
    setPinned(prev => {
      const exists = prev.some(p => p.id === item.id)
      const next = exists
        ? prev.filter(p => p.id !== item.id)
        : [{ ...item, ts: Date.now() }, ...prev].slice(0, MAX_PINNED)
      save(PINNED_KEY, next)
      return next
    })
  }, [])

  const removeRecent = useCallback((id: string) => {
    setRecents(prev => {
      const next = prev.filter(r => r.id !== id)
      save(RECENT_KEY, next)
      return next
    })
  }, [])

  return { recents, pinned, recordVisit, isPinned, togglePin, removeRecent }
}
