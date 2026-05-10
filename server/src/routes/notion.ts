import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

const NOTION_API     = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

function notionHeaders() {
  return {
    Authorization:    `Bearer ${process.env['NOTION_API_KEY']}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json',
  }
}

function configured(): boolean {
  return !!process.env['NOTION_API_KEY']
}

function tasksConfigured(): boolean {
  return !!(process.env['NOTION_API_KEY'] && process.env['NOTION_DATABASE_ID'])
}

// Centralised error response. Notion's API errors carry useful messages we surface.
function notionError(res: Response, err: any, fallback: string) {
  const data    = err?.response?.data
  const status  = err?.response?.status ?? 502
  const message = data?.message ?? err?.message ?? fallback
  console.error(`[notion] ${fallback}:`, data ?? err.message)
  res.status(status >= 400 && status < 600 ? status : 502).json({ error: message })
}

// ── Helpers shared by tasks (legacy) and universal layer ──────────────────────

function findProp(
  props: Record<string, any>,
  names: string[],
  types: string[],
): [string, any] | null {
  for (const name of names) {
    const key = Object.keys(props).find(
      k => k.toLowerCase() === name.toLowerCase() && types.includes(props[k].type),
    )
    if (key) return [key, props[key]]
  }
  return null
}

// Pull plain title text out of a page object regardless of which property is the title.
function pageTitle(page: any): string {
  if (page.properties) {
    for (const p of Object.values(page.properties) as any[]) {
      if (p?.type === 'title') return (p.title ?? []).map((t: any) => t.plain_text).join('') || 'Untitled'
    }
  }
  if (page.title) return (page.title as any[]).map(t => t.plain_text).join('') || 'Untitled'
  return 'Untitled'
}

function dbTitle(db: any): string {
  return (db.title ?? []).map((t: any) => t.plain_text).join('') || 'Untitled'
}

function iconOf(obj: any): { type: 'emoji' | 'url'; value: string } | null {
  const i = obj?.icon
  if (!i) return null
  if (i.type === 'emoji') return { type: 'emoji', value: i.emoji }
  if (i.type === 'external') return { type: 'url', value: i.external.url }
  if (i.type === 'file')     return { type: 'url', value: i.file.url }
  return null
}

// ── Schema cache (legacy task widget) ─────────────────────────────────────────

export interface SchemaOption { id: string; name: string; color: string }

export interface NotionSchema {
  titleKey:         string
  statusKey:        string | null
  statusType:       'status' | 'select' | null
  statusOptions:    SchemaOption[]
  doneStatusNames:  string[]
  todoStatusNames:  string[]
  priorityKey:      string | null
  priorityOptions:  SchemaOption[]
  dueKey:           string | null
}

let schemaCache: NotionSchema | null = null
let schemaCacheTs = 0
const SCHEMA_TTL = 5 * 60 * 1000

const DONE_NAMES = new Set(['done', 'completed', 'complete', 'finished', 'closed'])

async function getSchema(force = false): Promise<NotionSchema> {
  if (!force && schemaCache && Date.now() - schemaCacheTs < SCHEMA_TTL) return schemaCache

  const { data } = await axios.get(
    `${NOTION_API}/databases/${process.env['NOTION_DATABASE_ID']}`,
    { headers: notionHeaders() },
  )
  const props = data.properties as Record<string, any>

  const titleKey    = Object.keys(props).find(k => props[k].type === 'title') ?? 'Name'
  const statusEntry = findProp(props, ['status', 'state'], ['status', 'select'])
  const statusKey   = statusEntry?.[0] ?? null
  const statusProp  = statusEntry?.[1]
  const statusType: 'status' | 'select' | null =
    statusProp?.type === 'status' ? 'status' :
    statusProp?.type === 'select' ? 'select' : null

  const statusOptions: SchemaOption[] =
    statusType === 'status' ? (statusProp.status?.options ?? []) :
    statusType === 'select' ? (statusProp.select?.options ?? []) : []

  let doneStatusNames: string[] = []
  let todoStatusNames: string[] = []
  if (statusType === 'status') {
    const groups: any[] = statusProp.status?.groups ?? []
    const doneGroup = groups.find((g: any) => g.name === 'Complete')
    const todoGroup = groups.find((g: any) => g.name === 'To-do')
    const doneIds   = new Set<string>(doneGroup?.option_ids ?? [])
    const todoIds   = new Set<string>(todoGroup?.option_ids ?? [])
    doneStatusNames = statusOptions.filter(o => doneIds.has(o.id)).map(o => o.name)
    todoStatusNames = statusOptions.filter(o => todoIds.has(o.id)).map(o => o.name)
  }
  if (doneStatusNames.length === 0)
    doneStatusNames = statusOptions.filter(o => DONE_NAMES.has(o.name.toLowerCase())).map(o => o.name)
  if (todoStatusNames.length === 0)
    todoStatusNames = statusOptions.filter(o => !DONE_NAMES.has(o.name.toLowerCase())).map(o => o.name)

  const priorityEntry   = findProp(props, ['priority', 'importance'], ['select'])
  const priorityKey     = priorityEntry?.[0] ?? null
  const priorityOptions: SchemaOption[] = priorityEntry?.[1]?.select?.options ?? []

  const dueEntry = findProp(props, ['due', 'deadline', 'date'], ['date'])
  const dueKey   = dueEntry?.[0] ?? null

  schemaCache   = { titleKey, statusKey, statusType, statusOptions, doneStatusNames, todoStatusNames, priorityKey, priorityOptions, dueKey }
  schemaCacheTs = Date.now()
  return schemaCache
}

function extractTask(page: any, schema: NotionSchema) {
  const props   = page.properties as Record<string, any>
  const doneSet = new Set(schema.doneStatusNames.map(n => n.toLowerCase()))

  const title: string = props[schema.titleKey]?.title?.[0]?.plain_text ?? 'Untitled'

  const statusProp = schema.statusKey ? props[schema.statusKey] : null
  const status: string | null =
    schema.statusType === 'status' ? (statusProp?.status?.name ?? null) :
    schema.statusType === 'select' ? (statusProp?.select?.name  ?? null) : null

  const priority: string | null = (schema.priorityKey ? props[schema.priorityKey] : null)?.select?.name ?? null
  const due: string | null      = (schema.dueKey ? props[schema.dueKey] : null)?.date?.start ?? null

  const checkEntry  = findProp(props, ['done', 'complete', 'completed', 'finished'], ['checkbox'])
  const doneViaBox  = checkEntry ? (checkEntry[1].checkbox ?? false) : false
  const done        = doneViaBox || (status != null && doneSet.has(status.toLowerCase()))

  return { id: page.id, title, status, priority, due, done, createdAt: page.created_time }
}

function buildTaskProperties(
  schema: NotionSchema,
  fields: { title?: string; status?: string | null; priority?: string | null; due?: string | null },
): Record<string, any> {
  const props: Record<string, any> = {}
  if (fields.title !== undefined)
    props[schema.titleKey] = { title: [{ text: { content: fields.title } }] }
  if ('status' in fields && schema.statusKey && schema.statusType) {
    props[schema.statusKey] = schema.statusType === 'status'
      ? { status: fields.status ? { name: fields.status } : null }
      : { select: fields.status ? { name: fields.status } : null }
  }
  if ('priority' in fields && schema.priorityKey)
    props[schema.priorityKey] = { select: fields.priority ? { name: fields.priority } : null }
  if ('due' in fields && schema.dueKey)
    props[schema.dueKey] = { date: fields.due ? { start: fields.due } : null }
  return props
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY TASK ENDPOINTS (preserved for the home/collapsed view of the widget)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/schema', async (_req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured — set NOTION_API_KEY and NOTION_DATABASE_ID' }); return }
  try { res.json(await getSchema()) }
  catch (err) { notionError(res, err, 'Failed to fetch schema') }
})

router.get('/tasks', async (_req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  try {
    const schema   = await getSchema()
    const { data } = await axios.post(
      `${NOTION_API}/databases/${process.env['NOTION_DATABASE_ID']}/query`,
      { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] },
      { headers: notionHeaders() },
    )
    res.json((data.results as any[]).filter(p => !p.archived).map(p => extractTask(p, schema)))
  } catch (err) { notionError(res, err, 'Failed to fetch tasks') }
})

router.post('/tasks', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const { title, status, priority, due } = req.body as { title?: string; status?: string; priority?: string; due?: string }
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return }
  try {
    const schema     = await getSchema()
    const properties = buildTaskProperties(schema, { title: title.trim(), status, priority, due: due ?? null })
    const { data }   = await axios.post(
      `${NOTION_API}/pages`,
      { parent: { database_id: process.env['NOTION_DATABASE_ID'] }, properties },
      { headers: notionHeaders() },
    )
    res.status(201).json(extractTask(data, schema))
  } catch (err) { notionError(res, err, 'Failed to create task') }
})

router.patch('/tasks/:id', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const fields = req.body as { title?: string; status?: string | null; priority?: string | null; due?: string | null }
  try {
    const schema     = await getSchema()
    const properties = buildTaskProperties(schema, fields)
    if (Object.keys(properties).length > 0)
      await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { properties }, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update task') }
})

router.delete('/tasks/:id', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { archived: true }, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to archive task') }
})

// Legacy: returns plain-text rendering of a page body. Kept for backward-compat
// with the old task detail sheet. New code should use /blocks/:id/children.
router.get('/tasks/:id/content', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.get(
      `${NOTION_API}/blocks/${req.params['id']}/children?page_size=100`,
      { headers: notionHeaders() },
    )
    const lines = (data.results as any[]).map((block: any) => {
      const type = block.type as string
      const rt   = (block[type]?.rich_text ?? []) as any[]
      const text = rt.map((t: any) => t.plain_text as string).join('')
      if (!text) return null
      switch (type) {
        case 'heading_1':           return `# ${text}`
        case 'heading_2':           return `## ${text}`
        case 'heading_3':           return `### ${text}`
        case 'bulleted_list_item':  return `• ${text}`
        case 'numbered_list_item':  return `• ${text}`
        case 'to_do':               return `${block.to_do?.checked ? '✓' : '○'} ${text}`
        case 'quote':               return `" ${text}`
        case 'callout':             return `💡 ${text}`
        default:                    return text
      }
    }).filter(Boolean)
    res.json({ text: lines.join('\n') })
  } catch (err) { notionError(res, err, 'Failed to fetch content') }
})

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL LAYER — full Notion client surface
// ─────────────────────────────────────────────────────────────────────────────

// Workspace discovery — uses the search endpoint with empty query to enumerate
// every database and page the integration has access to. We split into two
// lists for the UI and add lightweight metadata (title, icon, parent kind).
router.get('/workspace', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured — set NOTION_API_KEY' }); return }
  try {
    const databases: any[] = []
    const pages:     any[] = []
    let cursor: string | undefined
    let safety = 0

    // Walk pagination — capped to avoid abusing the API on giant workspaces.
    do {
      const { data } = await axios.post(
        `${NOTION_API}/search`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        { headers: notionHeaders() },
      )
      for (const r of data.results as any[]) {
        if (r.archived) continue
        if (r.object === 'database') databases.push(r)
        else if (r.object === 'page') pages.push(r)
      }
      cursor = data.has_more ? data.next_cursor : undefined
      safety++
    } while (cursor && safety < 10)

    res.json({
      databases: databases.map(d => ({
        id:    d.id,
        title: dbTitle(d),
        icon:  iconOf(d),
        url:   d.url,
        parent: d.parent,
      })),
      pages: pages.map(p => ({
        id:     p.id,
        title:  pageTitle(p),
        icon:   iconOf(p),
        url:    p.url,
        parent: p.parent,
      })),
    })
  } catch (err) { notionError(res, err, 'Failed to fetch workspace') }
})

// Search — q is the user query, optional filter narrows to databases or pages.
router.get('/search', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const q    = (req.query['q']    as string | undefined) ?? ''
  const kind = req.query['type']  as 'page' | 'database' | undefined

  try {
    const { data } = await axios.post(
      `${NOTION_API}/search`,
      {
        query: q,
        page_size: 30,
        ...(kind ? { filter: { property: 'object', value: kind } } : {}),
      },
      { headers: notionHeaders() },
    )
    res.json({
      results: (data.results as any[])
        .filter(r => !r.archived)
        .map(r => ({
          id:     r.id,
          object: r.object,
          title:  r.object === 'database' ? dbTitle(r) : pageTitle(r),
          icon:   iconOf(r),
          parent: r.parent,
          url:    r.url,
        })),
    })
  } catch (err) { notionError(res, err, 'Search failed') }
})

// Database schema — full property definitions. Used by both DB browse view and
// the property editor when rendering a row.
router.get('/databases/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.get(
      `${NOTION_API}/databases/${req.params['id']}`,
      { headers: notionHeaders() },
    )
    res.json({
      id:          data.id,
      title:       dbTitle(data),
      description: (data.description ?? []).map((t: any) => t.plain_text).join(''),
      icon:        iconOf(data),
      properties:  data.properties,
      url:         data.url,
    })
  } catch (err) { notionError(res, err, 'Failed to fetch database') }
})

// Query a database — body forwards filter/sort/page_size to Notion as-is so
// callers can build any view (kanban groupings, calendar windows, etc.).
router.post('/databases/:id/query', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.post(
      `${NOTION_API}/databases/${req.params['id']}/query`,
      { page_size: 100, ...req.body },
      { headers: notionHeaders() },
    )
    res.json({
      results: (data.results as any[]).filter(p => !p.archived),
      has_more:    data.has_more,
      next_cursor: data.next_cursor,
    })
  } catch (err) { notionError(res, err, 'Database query failed') }
})

// Single page — properties + parent for breadcrumb. Body blocks are fetched
// separately via /blocks/:id/children so the page header can render fast.
router.get('/pages/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.get(
      `${NOTION_API}/pages/${req.params['id']}`,
      { headers: notionHeaders() },
    )
    res.json({
      id:           data.id,
      title:        pageTitle(data),
      icon:         iconOf(data),
      cover:        data.cover,
      parent:       data.parent,
      properties:   data.properties,
      url:          data.url,
      created_time: data.created_time,
      last_edited_time: data.last_edited_time,
      archived:     data.archived,
    })
  } catch (err) { notionError(res, err, 'Failed to fetch page') }
})

// Create a page — either as a child of another page (parent.type='page_id')
// or as a row in a database (parent.type='database_id'). Properties, icon, and
// initial children are all forwarded.
router.post('/pages', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.post(
      `${NOTION_API}/pages`,
      req.body,
      { headers: notionHeaders() },
    )
    res.status(201).json({ id: data.id, title: pageTitle(data) })
  } catch (err) { notionError(res, err, 'Failed to create page') }
})

// Update page properties (or icon/cover/archived). Body forwarded to Notion.
router.patch('/pages/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, req.body, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update page') }
})

router.delete('/pages/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { archived: true }, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to archive page') }
})

// List a block's children. Used both for top-level page bodies and for nested
// blocks (toggle children, column children, synced blocks etc.). Cursor is
// forwarded so the UI can paginate long pages on demand.
router.get('/blocks/:id/children', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const cursor   = req.query['cursor']   as string | undefined
  const pageSize = Number(req.query['page_size'] ?? 100)
  try {
    const params = new URLSearchParams({ page_size: String(pageSize) })
    if (cursor) params.set('start_cursor', cursor)
    const { data } = await axios.get(
      `${NOTION_API}/blocks/${req.params['id']}/children?${params}`,
      { headers: notionHeaders() },
    )
    res.json({
      results:     (data.results as any[]).filter(b => !b.archived),
      has_more:    data.has_more,
      next_cursor: data.next_cursor,
    })
  } catch (err) { notionError(res, err, 'Failed to fetch blocks') }
})

// Append child blocks to a page or container. Body must contain { children: [...] }.
router.post('/blocks/:id/children', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.patch(
      `${NOTION_API}/blocks/${req.params['id']}/children`,
      req.body,
      { headers: notionHeaders() },
    )
    res.status(201).json({ results: data.results ?? [] })
  } catch (err) { notionError(res, err, 'Failed to append blocks') }
})

// Update a block — body is a Notion block-update payload, e.g.
//   { paragraph: { rich_text: [{ type:'text', text:{ content:'…' } }] } }
//   { to_do: { checked: true } }
router.patch('/blocks/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/blocks/${req.params['id']}`, req.body, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update block') }
})

router.delete('/blocks/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.delete(`${NOTION_API}/blocks/${req.params['id']}`, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to delete block') }
})

// List workspace users — needed for people-property pickers.
router.get('/users', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const { data } = await axios.get(
      `${NOTION_API}/users?page_size=100`,
      { headers: notionHeaders() },
    )
    res.json({
      users: (data.results as any[]).map(u => ({
        id:        u.id,
        name:      u.name,
        type:      u.type,
        avatarUrl: u.avatar_url,
      })),
    })
  } catch (err) { notionError(res, err, 'Failed to fetch users') }
})

export default router
