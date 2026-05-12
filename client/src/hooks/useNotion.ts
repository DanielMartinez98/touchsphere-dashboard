import { useState, useEffect, useCallback } from 'react'

export interface SchemaOption { id: string; name: string; color: string }

export interface NotionSchema {
  titleKey:         string
  statusKey:        string | null
  statusType:       'status' | 'select' | null
  statusOptions:    SchemaOption[]
  doneStatusNames:  string[]   // from Notion's "Complete" group
  todoStatusNames:  string[]   // from Notion's "To-do" group
  priorityKey:      string | null
  priorityOptions:  SchemaOption[]
  dueKey:           string | null
  // Optional relation property pointing to a projects DB. When present we can
  // filter/group tasks by project on the Home view.
  projectKey:       string | null
  projectDbId:      string | null
}

export interface NotionTask {
  id:         string
  title:      string
  status:     string | null
  priority:   string | null
  due:        string | null  // YYYY-MM-DD
  done:       boolean
  createdAt:  string
  // Ids of related project pages (length matches the Notion relation property).
  projectIds: string[]
}

export interface ProjectRef {
  id:    string
  title: string
  icon:  string | null
}

export type TaskFields = Partial<{
  title:    string
  status:   string | null
  priority: string | null
  due:      string | null
}>

// ─────────────────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(json.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ─────────────────────────────────────────────────────────────────────────────

interface TasksResponse {
  tasks:    NotionTask[]
  projects: Record<string, ProjectRef>
}

export function useNotion() {
  const [schema,   setSchema]   = useState<NotionSchema | null>(null)
  const [tasks,    setTasks]    = useState<NotionTask[]>([])
  const [projects, setProjects] = useState<Record<string, ProjectRef>>({})
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, t] = await Promise.all([
        apiFetch<NotionSchema>('/api/notion/schema'),
        apiFetch<TasksResponse>('/api/notion/tasks'),
      ])
      setSchema(s)
      setTasks(t.tasks)
      setProjects(t.projects)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshTasks = useCallback(async () => {
    try {
      const t = await apiFetch<TasksResponse>('/api/notion/tasks')
      setTasks(t.tasks)
      setProjects(t.projects)
    } catch { /* silent background refresh */ }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  // Compute done flag client-side (mirrors server logic) for optimistic updates
  function computeDone(status: string | null): boolean {
    if (!status || !schema) return false
    const doneSet = new Set(schema.doneStatusNames.map(n => n.toLowerCase()))
    return doneSet.has(status.toLowerCase())
  }

  async function createTask(fields: { title: string; status?: string; priority?: string; due?: string }) {
    const task = await apiFetch<NotionTask>('/api/notion/tasks', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(fields),
    })
    setTasks(prev => [task, ...prev])
    void refreshTasks()
  }

  async function updateTask(id: string, fields: TaskFields) {
    // Optimistic update
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t
      const next = { ...t, ...fields }
      if ('status' in fields) next.done = computeDone(fields.status ?? null)
      return next
    }))
    try {
      await apiFetch(`/api/notion/tasks/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      })
    } catch {
      void refreshTasks() // revert via server state
    }
  }

  async function archiveTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id)) // optimistic removal
    try {
      await apiFetch(`/api/notion/tasks/${id}`, { method: 'DELETE' })
    } catch {
      void refreshTasks()
    }
  }

  async function getTaskContent(id: string): Promise<string> {
    try {
      const data = await apiFetch<{ text: string }>(`/api/notion/tasks/${id}/content`)
      return data.text
    } catch {
      return ''
    }
  }

  return {
    schema,
    tasks,
    projects,
    loading,
    error,
    refresh: loadAll,
    createTask,
    updateTask,
    archiveTask,
    getTaskContent,
  }
}
