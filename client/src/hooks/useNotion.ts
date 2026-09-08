import { useState, useEffect, useCallback } from 'react'
import { useServerEvent } from './useServerEvents'

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
  // A people property ("Assignee"), when the database has one — what the
  // "only my tasks" filter keys on once somebody is picked in Settings.
  peopleKey?:       string | null
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

/** What kind of failure the server reported — see classifyNotionError() on the server. */
export type NotionErrorKind = 'unconfigured' | 'auth' | 'access' | 'rate' | 'timeout' | 'network' | 'notion' | 'offline'

export class NotionApiError extends Error {
  kind: NotionErrorKind
  constructor(message: string, kind: NotionErrorKind) { super(message); this.kind = kind }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try { res = await fetch(url, init) }
  catch { throw new NotionApiError('The dashboard server could not be reached', 'offline') }
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { error?: string; kind?: NotionErrorKind }
    const kind: NotionErrorKind = res.status === 503 ? 'unconfigured' : (json.kind ?? 'notion')
    throw new NotionApiError(json.error ?? `HTTP ${res.status}`, kind)
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
  // Who the list is filtered to, or null for everyone's tasks.
  me?:      { id: string; name: string } | null
}

/**
 * The task list, kept current.
 *
 * `active` is whether the Tasks corner exists right now (work mode). While it
 * does, the list is refetched every minute, when the tab comes back into
 * view, and whenever the server announces a change on the `notion` SSE
 * event — which it does after every task or page edit made through this app,
 * from any device. Before this the list was fetched once at page load and
 * then only when a voice command or the refresh button touched it, so a task
 * ticked in Notion on a phone stayed unticked on the wall for hours. The
 * minute is for edits made in Notion itself, which nothing announces.
 */
export function useNotion(active = true) {
  const [schema,   setSchema]   = useState<NotionSchema | null>(null)
  const [schemas,  setSchemas]  = useState<Record<string, NotionSchema>>({})
  const [taskDbs,  setTaskDbs]  = useState<TaskDbRef[]>([])
  const [tasks,    setTasks]    = useState<NotionTask[]>([])
  const [projects, setProjects] = useState<Record<string, ProjectRef>>({})
  const [me,       setMe]       = useState<{ id: string; name: string } | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<NotionErrorKind | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // A single /tasks call now returns everything: aggregated tasks, per-DB and
  // merged schemas, and the source DB list. Applied together on load & refresh.
  const applyTasks = useCallback((t: TasksResponse) => {
    setTasks(t.tasks)
    setProjects(t.projects)
    setSchemas(t.schemas)
    setTaskDbs(t.dbs)
    setSchema(t.merged)
    setMe(t.me ?? null)
    setUpdatedAt(Date.now())
    setError(null)
    setErrorKind(null)
  }, [])

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : 'Failed to load')
    setErrorKind(err instanceof NotionApiError ? err.kind : 'notion')
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      applyTasks(await apiFetch<TasksResponse>('/api/notion/tasks'))
    } catch (err: unknown) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }, [applyTasks, fail])

  // The quiet refetch: no spinner, and a failure keeps the last good list on
  // screen but records why, so a corner that has been showing stale tasks
  // for ten minutes can say so instead of looking current.
  const refreshTasks = useCallback(async () => {
    try {
      applyTasks(await apiFetch<TasksResponse>('/api/notion/tasks'))
    } catch (err: unknown) {
      fail(err)
    }
  }, [applyTasks, fail])

  useEffect(() => {
    if (!active) return
    // Deferred a tick rather than called straight out of the effect — the
    // same shape useMail uses, for the same lint reason.
    const first = setTimeout(() => { void loadAll() }, 0)
    const t = setInterval(() => { void refreshTasks() }, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshTasks() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [active, loadAll, refreshTasks])

  // A task ticked on the phone is ticked on the wall at once: the server
  // announces every edit made through this app, on every device.
  useServerEvent('notion', useCallback(() => { if (active) void refreshTasks() }, [active, refreshTasks]))

  // Refetch when the set of task databases changes (Browse → "Show in Tasks").
  useEffect(() => {
    const onChange = () => { void refreshTasks() }
    window.addEventListener('ts:task-dbs-changed', onChange)
    return () => window.removeEventListener('ts:task-dbs-changed', onChange)
  }, [refreshTasks])

  // Refetch when a voice/chat tool creates or edits a task. The chat route tags
  // its reply with the touched state slices and the voice hook fans them out as
  // a ts:state-changed event; we only care about the 'notion' slice (but a
  // missing slice list is treated as "refresh to be safe").
  useEffect(() => {
    const onChange = (e: Event) => {
      const slices = (e as CustomEvent<{ slices?: string[] }>).detail?.slices
      if (!slices || slices.includes('notion')) void refreshTasks()
    }
    window.addEventListener('ts:state-changed', onChange)
    return () => window.removeEventListener('ts:state-changed', onChange)
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
    me,
    loading,
    error,
    errorKind,
    updatedAt,
    refresh: loadAll,
    refreshSilent: refreshTasks,
    createTask,
    updateTask,
    archiveTask,
    getTaskContent,
  }
}
