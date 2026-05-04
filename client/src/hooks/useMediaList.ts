import { useState, useCallback, useEffect } from 'react'
import type { MediaItem, MediaType } from '../types'

const API = '/api/state/media'

export function useMediaList() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load list from server on mount
  useEffect(() => {
    console.log('[MediaList] fetching list from server…')
    fetch(API)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<MediaItem[]>
      })
      .then(data => {
        console.log(`[MediaList] loaded ${data.length} items from server`)
        setItems(data)
      })
      .catch(err => {
        console.error('[MediaList] failed to load from server:', err)
      })
      .finally(() => setIsLoading(false))
  }, [])

  const addItem = useCallback((title: string, type: MediaType) => {
    console.log(`[MediaList] ATTEMPT add — title: "${title}" type: ${type}`)
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, type }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<MediaItem>
      })
      .then(item => {
        setItems(prev => {
          const updated = [...prev, item]
          console.log(`[MediaList] item added id=${item.id} total=${updated.length}`)
          return updated
        })
      })
      .catch(err => console.error('[MediaList] addItem failed:', err))
  }, [])

  const removeItem = useCallback((id: string) => {
    console.log(`[MediaList] DELETE item id=${id}`)
    // Optimistic update
    setItems(prev => prev.filter(i => i.id !== id))
    fetch(`${API}/${id}`, { method: 'DELETE' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log(`[MediaList] item ${id} deleted on server`)
      })
      .catch(err => {
        console.error(`[MediaList] removeItem ${id} failed — restoring:`, err)
        // Re-fetch to restore consistent state
        fetch(API)
          .then(r => r.json() as Promise<MediaItem[]>)
          .then(setItems)
          .catch(() => {})
      })
  }, [])

  const markDone = useCallback((id: string) => {
    // Optimistic update
    setItems(prev => prev.map(i => {
      if (i.id !== id) return i
      console.log(`[MediaList] TOGGLE done id=${id} "${i.title}" → ${!i.done}`)
      return { ...i, done: !i.done }
    }))
    fetch(`${API}/${id}`, { method: 'PATCH' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<MediaItem>
      })
      .then(updated => {
        setItems(prev => prev.map(i => i.id === id ? updated : i))
        console.log(`[MediaList] server confirmed done=${updated.done} for id=${id}`)
      })
      .catch(err => {
        console.error(`[MediaList] markDone ${id} failed — restoring:`, err)
        fetch(API)
          .then(r => r.json() as Promise<MediaItem[]>)
          .then(setItems)
          .catch(() => {})
      })
  }, [])

  const nextItem = items.find(i => !i.done) ?? null

  return { items, nextItem, isLoading, addItem, removeItem, markDone }
}

