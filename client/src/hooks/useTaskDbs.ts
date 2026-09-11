import { useState, useEffect, useCallback } from 'react'
import { useServerEvent } from './useServerEvents'

// Which Notion databases ("boards") feed the corner. Mirrors the
// server-persisted set (see /api/notion/task-dbs): the boards in effect in
// the order that decides where a new task goes, each with its role (a to-do
// list or a calendar), the hidden ones, and the default. Settings → Notion is
// the full editor; the Browse view's "Show in Tasks" toggle uses the same
// `has`/`toggle`. Every change fires a global `ts:task-dbs-changed` event so
// the corner refetches.

export type BoardRole = 'tasks' | 'calendar'
export interface DateKey { key: string; kind: 'due' | 'publish' | 'film' | 'date' }

export interface TaskBoard {
  id:          string
  title:       string
  icon:        string | null
  /** A task can be created here: the database has a Status (or done checkbox). */
  hasStatus:   boolean
  /** The role in effect: the override, else detected. null when it is neither a list nor a calendar. */
  role:        BoardRole | null
  /** What detection alone says. */
  detectedRole: BoardRole | null
  dueKey:      string | null
  dateKeys:    DateKey[]
  source:      'env' | 'added' | 'discovered'
  /** New tasks land here. */
  isDefault:   boolean
  unavailable: boolean
  /** The Notion workspace (connection) it belongs to, once the server knows. */
  conn:        { id: string; name: string } | null
}

export interface HiddenBoard { id: string; title: string; icon: string | null }

interface View {
  ids:             string[]
  dbs:             TaskBoard[]
  hidden:          HiddenBoard[]
  defaultId:       string
  defaultExplicit: boolean
}

export type TaskDbsErrorKind = 'unconfigured' | 'other'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string }
    const err = new Error(j.error ?? `HTTP ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

const EMPTY: View = { ids: [], dbs: [], hidden: [], defaultId: '', defaultExplicit: false }

export function useTaskDbs() {
  const [view,    setView]    = useState<View>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<{ kind: TaskDbsErrorKind; message: string } | null>(null)

  const apply = useCallback((v: Partial<View>) => {
    setView({ ...EMPTY, ...v, ids: v.ids ?? [] })
    setError(null)
  }, [])

  // 503 is the server saying Notion has no key; anything else is a real
  // failure worth showing. Either way the last good list stays.
  const fail = useCallback((err: unknown) => {
    const e = err as Error & { status?: number }
    setError({ kind: e.status === 503 ? 'unconfigured' : 'other', message: e.message })
  }, [])

  const refresh = useCallback(async () => {
    try { apply(await api<View>('/api/notion/task-dbs')) }
    catch (err) { fail(err) }
    finally { setLoading(false) }
  }, [apply, fail])

  // The initial load, inlined with a cancelled guard like the other hooks'
  // first fetches, so an unmount mid-flight sets nothing.
  useEffect(() => {
    let cancelled = false
    api<View>('/api/notion/task-dbs')
      .then(v => { if (!cancelled) apply(v) })
      .catch(err => { if (!cancelled) fail(err) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apply, fail])

  // Another device changed the set: the server broadcasts `notion
  // {kind:'task-dbs'}` after every change, the same frame every task edit
  // sends (which is why the kind is checked — a ticked task is not a reason
  // to re-list the boards).
  useServerEvent('notion', useCallback((data: unknown) => {
    if ((data as { kind?: string } | null)?.kind === 'task-dbs') void refresh()
  }, [refresh]))

  // This device changed it, from the Browse view's toggle or Settings → Notion.
  useEffect(() => {
    const onChange = () => { void refresh() }
    window.addEventListener('ts:task-dbs-changed', onChange)
    return () => window.removeEventListener('ts:task-dbs-changed', onChange)
  }, [refresh])

  const has = useCallback((id: string) => view.ids.includes(id), [view.ids])

  const announce = () => window.dispatchEvent(new CustomEvent('ts:task-dbs-changed'))

  /** Add a board by id — or by a pasted Notion link; the server takes the id out of it. */
  const add = useCallback(async (id: string, makeDefault = false) => {
    setView(prev => prev.ids.includes(id) ? prev : { ...prev, ids: [...prev.ids, id] }) // optimistic
    try {
      apply(await api<View>('/api/notion/task-dbs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id, makeDefault }),
      }))
      announce()
    } catch (err) {
      void refresh()
      throw err
    }
  }, [apply, refresh])

  const remove = useCallback(async (id: string) => {
    setView(prev => ({ ...prev, ids: prev.ids.filter(x => x !== id), dbs: prev.dbs.filter(d => d.id !== id) })) // optimistic
    try {
      apply(await api<View>(`/api/notion/task-dbs/${id}`, { method: 'DELETE' }))
      announce()
    } catch { void refresh() }
  }, [apply, refresh])

  const toggle = useCallback((id: string) => (view.ids.includes(id) ? remove(id) : add(id).catch(() => {})), [view.ids, add, remove])

  /** The board new tasks land in. '' goes back to "the first one". */
  const setDefault = useCallback(async (id: string) => {
    setView(prev => ({ ...prev, defaultId: id, dbs: prev.dbs.map(d => ({ ...d, isDefault: d.id === id })) })) // optimistic
    try {
      apply(await api<View>('/api/notion/task-dbs/default', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id }),
      }))
      announce()
    } catch { void refresh() }
  }, [apply, refresh])

  /** A board's role: 'tasks', 'calendar', or '' to let detection decide again. */
  const setRole = useCallback(async (id: string, role: BoardRole | '') => {
    setView(prev => ({ ...prev, dbs: prev.dbs.map(d => d.id === id ? { ...d, role: role || d.detectedRole } : d) })) // optimistic
    try {
      apply(await api<View>('/api/notion/task-dbs/role', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id, role }),
      }))
      announce()
    } catch { void refresh() }
  }, [apply, refresh])

  return {
    ids: view.ids, boards: view.dbs, hidden: view.hidden,
    defaultId: view.defaultId, defaultExplicit: view.defaultExplicit,
    loading, error,
    has, add, remove, toggle, setDefault, setRole, refresh,
  }
}
