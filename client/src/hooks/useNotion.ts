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
  // Which task database this row came from — used to resolve the correct schema
  // for toggle-done and to badge the row when several DBs are aggregated.
  dbId:       string
}

export interface ProjectRef {
  id:    string
  title: string
  icon:  string | null
}

// A task database feeding the aggregated Home list.
export interface TaskDbRef {
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
  // Per-database schemas keyed by db id (for DB-specific actions), the source
  // DBs (for the picker/badges), and a merged schema for the generic UI.
  schemas:  Record<string, NotionSchema>
  dbs:      TaskDbRef[]
  merged:   NotionSchema
}

export function useNotion() {
  const [schema,   setSchema]   = useState<NotionSchema | null>(null)
  const [schemas,  setSchemas]  = useState<Record<string, NotionSchema>>({})
  const [taskDbs,  setTaskDbs]  = useState<TaskDbRef[]>([])
  const [tasks,    setTasks]    = useState<NotionTask[]>([])
  const [projects, setProjects] = useState<Record<string, ProjectRef>>({})
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // A single /tasks call now returns everything: aggregated tasks, per-DB and
  // merged schemas, and the source DB list. Applied together on load & refresh.
  const applyTasks = useCallback((t: TasksResponse) => {
    setTasks(t.tasks)
    setProjects(t.projects)
    setSchemas(t.schemas)
    setTaskDbs(t.dbs)
    setSchema(t.merged)
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      applyTasks(await apiFetch<TasksResponse>('/api/notion/tasks'))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [applyTasks])

  const refreshTasks = useCallback(async () => {
    try {
      applyTasks(await apiFetch<TasksResponse>('/api/notion/tasks'))
    } catch { /* silent background refresh */ }
  }, [applyTasks])

  useEffect(() => { void loadAll() }, [loadAll])

  // Refetch when the set of task databases changes (Browse → "Show in Tasks").
  useEffect(() => {
    const onChange = () => { void refreshTasks() }
    window.addEventListener('ts:task-dbs-changed', onChange)
    return () => window.removeEventListener('ts:task-dbs-changed', onChange)
  }, [refreshTasks])

  // Compute done flag client-side (mirrors server logic) for optimistic updates.
  // Uses the task's own DB schema so a status valid in one DB isn't mis-scored
  // against another's done set.
  function computeDone(status: string | null, dbId: string): boolean {
    const sch = schemas[dbId]
    if (!status || !sch) return false
    const doneSet = new Set(sch.doneStatusNames.map(n => n.toLowerCase()))
    return doneSet.has(status.toLowerCase())
  }

  async function createTask(fields: { title: string; status?: string; priority?: string; due?: string; dbId?: string }) {
    const task = await apiFetch<NotionTask>('/api/notion/tasks', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(fields),
    })
    setTasks(prev => [task, ...prev])
    void refreshTasks()
  }

  async function updateTask(id: string, fields: TaskFields) {
    // Optimistic update. Also send the task's dbId so the server builds
    // properties against the right database's schema.
    const target = tasks.find(t => t.id === id)
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t
      const next = { ...t, ...fields }
      if ('status' in fields) next.done = computeDone(fields.status ?? null, t.dbId)
      return next
    }))
    try {
      await apiFetch(`/api/notion/tasks/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...fields, dbId: target?.dbId }),
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
    schemas,
    taskDbs,
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
