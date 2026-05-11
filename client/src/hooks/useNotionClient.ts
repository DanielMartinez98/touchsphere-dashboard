import { useState, useCallback, useRef } from 'react'
import type {
  NavView, Workspace, SearchResult, DatabaseSchema, NotionPage, NotionBlock, BlocksPage,
} from '../components/widgets/NotionWidget/notion-types'
import { richTextWrite } from '../components/widgets/NotionWidget/notion-types'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(j.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// Five-minute TTL on workspace + DB schemas (these don't change often).
const TTL = { workspace: 5 * 60 * 1000, schema: 5 * 60 * 1000 }

interface CacheEntry<T> { data: T; ts: number }

export function useNotionClient() {
  // Navigation stack — top of stack is the visible view. A flat array keeps
  // back-button logic dead simple (slice off the last entry).
  const [stack,    setStack]    = useState<NavView[]>([{ kind: 'home' }])
  const [query,    setQuery]    = useState('')

  // Workspace and per-resource caches. A ref keeps these stable across renders
  // and avoids re-triggering effects when we simply want to read.
  const workspaceCache = useRef<CacheEntry<Workspace> | null>(null)
  const schemaCache    = useRef<Map<string, CacheEntry<DatabaseSchema>>>(new Map())
  const pageCache      = useRef<Map<string, CacheEntry<NotionPage>>>(new Map())

  const current = stack[stack.length - 1]!

  // ── Navigation ──────────────────────────────────────────────────────────────

  const navigate = useCallback((view: NavView) => {
    setStack(prev => [...prev, view])
  }, [])
  const back = useCallback(() => {
    setStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev)
  }, [])
  const goHome = useCallback(() => setStack([{ kind: 'home' }]), [])
  const replace = useCallback((view: NavView) => {
    setStack(prev => [...prev.slice(0, -1), view])
  }, [])

  // ── Workspace ───────────────────────────────────────────────────────────────

  const getWorkspace = useCallback(async (force = false): Promise<Workspace> => {
    const c = workspaceCache.current
    if (!force && c && Date.now() - c.ts < TTL.workspace) return c.data
    const data = await api<Workspace>('/api/notion/workspace')
    workspaceCache.current = { data, ts: Date.now() }
    return data
  }, [])

  // ── Search ──────────────────────────────────────────────────────────────────

  const search = useCallback(async (q: string, kind?: 'page' | 'database'): Promise<SearchResult[]> => {
    const url = `/api/notion/search?q=${encodeURIComponent(q)}${kind ? `&type=${kind}` : ''}`
    const { results } = await api<{ results: SearchResult[] }>(url)
    return results
  }, [])

  // ── Database ────────────────────────────────────────────────────────────────

  const getDatabase = useCallback(async (id: string, force = false): Promise<DatabaseSchema> => {
    const c = schemaCache.current.get(id)
    if (!force && c && Date.now() - c.ts < TTL.schema) return c.data
    const data = await api<DatabaseSchema>(`/api/notion/databases/${id}`)
    schemaCache.current.set(id, { data, ts: Date.now() })
    return data
  }, [])

  const queryDatabase = useCallback(async (id: string, body: any = {}) => {
    return api<{ results: any[]; has_more: boolean; next_cursor: string | null }>(
      `/api/notion/databases/${id}/query`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
  }, [])

  // ── Page ────────────────────────────────────────────────────────────────────

  const getPage = useCallback(async (id: string, force = false): Promise<NotionPage> => {
    const c = pageCache.current.get(id)
    if (!force && c && Date.now() - c.ts < 30_000) return c.data  // short TTL — pages are edited
    const data = await api<NotionPage>(`/api/notion/pages/${id}`)
    pageCache.current.set(id, { data, ts: Date.now() })
    return data
  }, [])

  const updatePage = useCallback(async (id: string, body: any) => {
    pageCache.current.delete(id)
    await api(`/api/notion/pages/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }, [])

  const createPage = useCallback(async (body: any): Promise<{ id: string; title: string }> => {
    return api(`/api/notion/pages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }, [])

  const archivePage = useCallback(async (id: string) => {
    pageCache.current.delete(id)
    await api(`/api/notion/pages/${id}`, { method: 'DELETE' })
  }, [])

  // ── Blocks ──────────────────────────────────────────────────────────────────

  const getBlocks = useCallback(async (id: string, cursor?: string): Promise<BlocksPage> => {
    const url = `/api/notion/blocks/${id}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    return api<BlocksPage>(url)
  }, [])

  // Append blocks to a parent. `blocks` is an array of Notion block payloads.
  const appendBlocks = useCallback(async (parentId: string, blocks: any[]) => {
    return api<{ results: NotionBlock[] }>(
      `/api/notion/blocks/${parentId}/children`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ children: blocks }) },
    )
  }, [])

  const updateBlock = useCallback(async (id: string, body: any) => {
    await api(`/api/notion/blocks/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }, [])

  // Convert a block to a different type. Notion accepts a type change via the
  // standard PATCH endpoint — callers pass the full body shape for the target
  // type (e.g. `{ heading_1: { rich_text: [...] } }` or `{ divider: {} }`).
  const convertBlock = useCallback(async (id: string, body: any) => {
    await api(`/api/notion/blocks/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }, [])

  const deleteBlock = useCallback(async (id: string) => {
    await api(`/api/notion/blocks/${id}`, { method: 'DELETE' })
  }, [])

  // Move a block among its siblings. After moving the block's id changes
  // (we clone+archive on the server), so callers should refetch.
  const moveBlock = useCallback(async (id: string, opts: { after?: string; before?: string }) => {
    await api(`/api/notion/blocks/${id}/move`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(opts),
    })
  }, [])

  const indentBlock = useCallback(async (id: string) => {
    await api(`/api/notion/blocks/${id}/indent`, { method: 'POST' })
  }, [])
  const outdentBlock = useCallback(async (id: string) => {
    await api(`/api/notion/blocks/${id}/outdent`, { method: 'POST' })
  }, [])

  // Fetch oembed/og preview for a URL. Used for bookmark + embed creation so
  // the UI can show a title/description before persisting.
  const oembed = useCallback(async (url: string) => {
    return api<{ url: string; title: string; description?: string; image?: string; siteName?: string; type?: string }>(
      `/api/notion/oembed?url=${encodeURIComponent(url)}`,
    )
  }, [])

  // ── Convenience helpers used by the editor ─────────────────────────────────

  // Build a block payload of any text-bearing type. The Notion API uses the same
  // shape for paragraph/heading/list/todo/quote/callout — content lives at the
  // type key with a `rich_text` array.
  const textBlock = useCallback((type: string, text = '', extra: Record<string, any> = {}): any => {
    return {
      object: 'block',
      type,
      [type]: { rich_text: richTextWrite(text), ...extra },
    }
  }, [])

  // ── Comments ────────────────────────────────────────────────────────────────

  const getComments = useCallback(async (blockId: string) => {
    return api<{ comments: { id: string; text: string; createdBy: any; createdAt: string }[] }>(
      `/api/notion/comments?block_id=${blockId}`,
    )
  }, [])

  const postComment = useCallback(async (pageId: string, text: string) => {
    return api<{ id: string }>(
      `/api/notion/comments`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, text }) },
    )
  }, [])

  // ── Page duplicate ──────────────────────────────────────────────────────────

  const duplicatePage = useCallback(async (id: string): Promise<{ id: string; title: string }> => {
    return api(
      `/api/notion/pages/${id}/duplicate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
  }, [])

  // ── Database property addition ──────────────────────────────────────────────

  const addProperty = useCallback(async (
    dbId: string,
    name: string,
    type: string,
    options?: { name: string; color?: string }[],
  ) => {
    schemaCache.current.delete(dbId)
    await api(
      `/api/notion/databases/${dbId}/properties`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type, options }) },
    )
  }, [])

  // Generic database PATCH — body forwarded to Notion. Use this for title,
  // icon, cover, and bulk-property edits.
  const updateDatabase = useCallback(async (dbId: string, body: any) => {
    schemaCache.current.delete(dbId)
    await api(
      `/api/notion/databases/${dbId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
  }, [])

  // Rename / retype / change options for an existing property.
  const editProperty = useCallback(async (
    dbId: string,
    name: string,
    patch: { rename?: string; type?: string; options?: { name: string; color?: string }[] },
  ) => {
    schemaCache.current.delete(dbId)
    await api(
      `/api/notion/databases/${dbId}/properties/${encodeURIComponent(name)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
    )
  }, [])

  const deleteProperty = useCallback(async (dbId: string, name: string) => {
    schemaCache.current.delete(dbId)
    await api(
      `/api/notion/databases/${dbId}/properties/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
  }, [])

  return {
    // navigation
    stack, current, navigate, back, goHome, replace,
    canGoBack: stack.length > 1,
    // search query state lives at top level so the SearchView remembers it
    query, setQuery, search,
    // workspace
    getWorkspace,
    // databases
    getDatabase, queryDatabase, addProperty, updateDatabase, editProperty, deleteProperty,
    // pages
    getPage, updatePage, createPage, archivePage, duplicatePage,
    // blocks
    getBlocks, appendBlocks, updateBlock, deleteBlock, textBlock,
    convertBlock, moveBlock, indentBlock, outdentBlock, oembed,
    // comments
    getComments, postComment,
  }
}

export type NotionClient = ReturnType<typeof useNotionClient>
