import { useState, useCallback, useEffect } from 'react'
import type { MediaItem, MediaStatus, MediaType } from '../types'

const API = '/api/state/media'

export function useMediaList() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load list from server on mount, and re-load whenever a chat tool mutates
  // it (the voice hook dispatches `ts:state-changed` with `slices: ['media']`).
  useEffect(() => {
    let cancelled = false
    const load = (reason: string) => {
      console.log(`[MediaList] fetching list from server (${reason})…`)
      fetch(API)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<MediaItem[]>
        })
        .then(data => {
          if (cancelled) return
          console.log(`[MediaList] loaded ${data.length} items from server`)
          setItems(data)
        })
        .catch(err => {
          console.error('[MediaList] failed to load from server:', err)
        })
        .finally(() => { if (!cancelled) setIsLoading(false) })
    }
    load('mount')
    const onChange = (e: Event) => {
      const slices = (e as CustomEvent<{ slices?: string[] }>).detail?.slices
      if (!slices || slices.includes('media')) load('chat-tool')
    }
    window.addEventListener('ts:state-changed', onChange)
    return () => {
      cancelled = true
      window.removeEventListener('ts:state-changed', onChange)
    }
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

  const setStatus = useCallback((id: string, status: MediaStatus) => {
    // Optimistic update — also keep `done` in sync so legacy consumers stay coherent.
    setItems(prev => prev.map(i => {
      if (i.id !== id) return i
      console.log(`[MediaList] SET status id=${id} "${i.title}" → ${status}`)
      return { ...i, status, done: status === 'done' }
    }))
    fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<MediaItem>
      })
      .then(updated => {
        setItems(prev => prev.map(i => i.id === id ? updated : i))
      })
      .catch(err => {
        console.error(`[MediaList] setStatus ${id} failed — restoring:`, err)
        fetch(API)
          .then(r => r.json() as Promise<MediaItem[]>)
          .then(setItems)
          .catch(() => {})
      })
  }, [])

  const toggleStar = useCallback((id: string) => {
    let nextStarred = false
    setItems(prev => prev.map(i => {
      if (i.id !== id) return i
      nextStarred = !i.starred
      console.log(`[MediaList] TOGGLE star id=${id} "${i.title}" → ${nextStarred}`)
      return { ...i, starred: nextStarred }
    }))
    fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nextStarred }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<MediaItem>
      })
      .then(updated => {
        setItems(prev => prev.map(i => i.id === id ? updated : i))
      })
      .catch(err => {
        console.error(`[MediaList] toggleStar ${id} failed — restoring:`, err)
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

  // Prefer starred items so pinned picks surface in the collapsed "Up Next" tile.
  // Skip both done and dropped — neither is a candidate for "up next".
  const isActive = (i: MediaItem) => i.status !== 'done' && i.status !== 'dropped'
  const nextItem =
    items.find(i => isActive(i) && i.starred) ??
    items.find(isActive) ??
    null

  return { items, nextItem, isLoading, addItem, removeItem, markDone, toggleStar, setStatus }
}

