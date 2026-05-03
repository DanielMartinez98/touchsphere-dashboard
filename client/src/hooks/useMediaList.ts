import { useState, useCallback } from 'react'
import type { MediaItem, MediaType } from '../types'

const STORAGE_KEY = 'touchsphere_media_list'

function loadList(): MediaItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveList(items: MediaItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function useMediaList() {
  const [items, setItems] = useState<MediaItem[]>(loadList)

  const addItem = useCallback((title: string, type: MediaType) => {
    const next: MediaItem = { id: crypto.randomUUID(), title, type, done: false }
    setItems(prev => {
      const updated = [...prev, next]
      saveList(updated)
      return updated
    })
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems(prev => {
      const updated = prev.filter(i => i.id !== id)
      saveList(updated)
      return updated
    })
  }, [])

  const markDone = useCallback((id: string) => {
    setItems(prev => {
      const updated = prev.map(i => i.id === id ? { ...i, done: !i.done } : i)
      saveList(updated)
      return updated
    })
  }, [])

  const nextItem = items.find(i => !i.done) ?? null

  return { items, nextItem, addItem, removeItem, markDone }
}
