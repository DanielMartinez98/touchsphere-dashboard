import { useState, useEffect, useCallback } from 'react'

export interface NotionTask {
  id:         string
  title:      string
  status:     string | null
  statusType: 'status' | 'select' | null
  statusKey:  string
  priority:   string | null
  due:        string | null  // YYYY-MM-DD
  done:       boolean
}

export function useNotion() {
  const [tasks,   setTasks]   = useState<NotionTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/notion/tasks')
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as NotionTask[]
      setTasks(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function markDone(task: NotionTask) {
    if (!task.statusType || !task.statusKey) return

    const doneValue = 'Done'
    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, done: true, status: doneValue } : t,
    ))

    try {
      const res = await fetch(`/api/notion/tasks/${task.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statusName: doneValue,
          statusType: task.statusType,
          statusKey:  task.statusKey,
        }),
      })
      if (!res.ok) throw new Error('update failed')
    } catch {
      // Revert on failure
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, done: false, status: task.status } : t,
      ))
    }
  }

  return { tasks, loading, error, refresh, markDone }
}
