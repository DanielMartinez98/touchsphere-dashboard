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
  // Relation property pointing at projects (e.g. "Project", "Projects", "Area")
  // and the id of the related DB so the client can navigate or fetch titles.
  projectKey:       string | null
  projectDbId:      string | null
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

  // Project relation — prefer name match ("project", "projects", "area",
  // "epic") then fall back to the first relation property of any name. The
  // related DB id lets us resolve project titles in a batch.
  let projectKey: string | null = null
  let projectDbId: string | null = null
  const relationEntry = findProp(props, ['project', 'projects', 'area', 'epic'], ['relation'])
                     ?? Object.entries(props).find(([, p]) => p.type === 'relation') as [string, any] | undefined ?? null
  if (relationEntry) {
    projectKey  = relationEntry[0]
    projectDbId = relationEntry[1]?.relation?.database_id ?? null
  }

  schemaCache   = { titleKey, statusKey, statusType, statusOptions, doneStatusNames, todoStatusNames, priorityKey, priorityOptions, dueKey, projectKey, projectDbId }
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

  // Pull related project ids; titles are resolved in /tasks after the main
  // query so we avoid an N+1 round-trip per task.
  const projectIds: string[] = schema.projectKey
    ? ((props[schema.projectKey]?.relation ?? []) as any[]).map(r => r.id)
    : []

  return { id: page.id, title, status, priority, due, done, createdAt: page.created_time, projectIds }
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
    const schema = await getSchema()

    // Walk every page of the task DB. Cap at 10 pages (~1000 tasks) to avoid
    // hammering the API on pathological DBs — well above any realistic
    // personal task list. Older Phase-1 code stopped at the first page.
    const all: any[] = []
    let cursor: string | undefined
    let safety = 0
    do {
      const { data } = await axios.post(
        `${NOTION_API}/databases/${process.env['NOTION_DATABASE_ID']}/query`,
        {
          page_size: 100,
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        { headers: notionHeaders() },
      )
      for (const r of data.results as any[]) if (!r.archived) all.push(r)
      cursor = data.has_more ? data.next_cursor : undefined
      safety++
    } while (cursor && safety < 10)

    const tasks = all.map(p => extractTask(p, schema))

    // Resolve project titles once per unique id so the client can label rows
    // without an N+1 round-trip. Tolerant of failures (a stale relation just
    // produces a missing title).
    const projects: Record<string, { id: string; title: string; icon: string | null }> = {}
    const uniqueIds = Array.from(new Set(tasks.flatMap(t => t.projectIds)))
    await Promise.all(uniqueIds.map(async id => {
      try {
        const { data } = await axios.get(`${NOTION_API}/pages/${id}`, { headers: notionHeaders() })
        projects[id] = { id, title: pageTitle(data), icon: iconOf(data)?.value ?? null }
      } catch { /* tolerate */ }
    }))

    res.json({ tasks, projects })
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

// ── Comments ────────────────────────────────────────────────────────────────
// Notion's comment API only supports listing top-level page comments and
// posting new ones; thread replies and editing existing comments aren't part
// of the public API.

router.get('/comments', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const blockId = req.query['block_id'] as string | undefined
  if (!blockId) { res.status(400).json({ error: 'block_id is required' }); return }
  try {
    const { data } = await axios.get(
      `${NOTION_API}/comments?block_id=${blockId}`,
      { headers: notionHeaders() },
    )
    res.json({
      comments: (data.results as any[]).map(c => ({
        id:        c.id,
        text:      (c.rich_text ?? []).map((t: any) => t.plain_text).join(''),
        createdBy: c.created_by,
        createdAt: c.created_time,
      })),
    })
  } catch (err) { notionError(res, err, 'Failed to fetch comments') }
})

router.post('/comments', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { pageId, text } = req.body as { pageId?: string; text?: string }
  if (!pageId || !text?.trim()) { res.status(400).json({ error: 'pageId and text are required' }); return }
  try {
    const { data } = await axios.post(
      `${NOTION_API}/comments`,
      {
        parent:    { page_id: pageId },
        rich_text: [{ type: 'text', text: { content: text.trim() } }],
      },
      { headers: notionHeaders() },
    )
    res.status(201).json({ id: data.id })
  } catch (err) { notionError(res, err, 'Failed to post comment') }
})

// ── Page duplicate ──────────────────────────────────────────────────────────
// Notion has no native duplicate endpoint, so we create a new page and copy
// the source's blocks (top level only). Properties are forwarded as-is.

router.post('/pages/:id/duplicate', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const sourceId = req.params['id']!
    const { data: src } = await axios.get(`${NOTION_API}/pages/${sourceId}`, { headers: notionHeaders() })

    // Strip computed properties — only writable types may appear in the create
    // payload, and the title needs a copy suffix.
    const writable: Record<string, any> = {}
    for (const [name, prop] of Object.entries(src.properties as Record<string, any>)) {
      switch (prop.type) {
        case 'title':
          writable[name] = { title: [{ type: 'text', text: { content: pageTitle(src) + ' (copy)' } }] }
          break
        case 'rich_text':    writable[name] = { rich_text:    prop.rich_text };    break
        case 'number':       writable[name] = { number:       prop.number };        break
        case 'select':       writable[name] = prop.select       ? { select:       { name: prop.select.name } } : { select: null };           break
        case 'multi_select': writable[name] = { multi_select: (prop.multi_select ?? []).map((o: any) => ({ name: o.name })) };               break
        case 'status':       writable[name] = prop.status       ? { status:       { name: prop.status.name } } : { status: null };           break
        case 'date':         writable[name] = { date:         prop.date };         break
        case 'checkbox':     writable[name] = { checkbox:     prop.checkbox };     break
        case 'url':          writable[name] = { url:          prop.url };          break
        case 'email':        writable[name] = { email:        prop.email };        break
        case 'phone_number': writable[name] = { phone_number: prop.phone_number }; break
      }
    }

    // Pull the source's blocks (top level) and forward each as a creation
    // payload. Nested children aren't copied — we'd need recursive walk.
    const { data: blockPage } = await axios.get(
      `${NOTION_API}/blocks/${sourceId}/children?page_size=100`,
      { headers: notionHeaders() },
    )
    const children = (blockPage.results as any[])
      .filter(b => !b.archived)
      .map(b => {
        const t = b.type
        // Notion's create-block payload mirrors the read shape minus id/parent.
        return { object: 'block', type: t, [t]: b[t] }
      })

    const { data: created } = await axios.post(
      `${NOTION_API}/pages`,
      {
        parent:     src.parent,
        icon:       src.icon ?? undefined,
        cover:      src.cover ?? undefined,
        properties: writable,
        children,
      },
      { headers: notionHeaders() },
    )
    res.status(201).json({ id: created.id, title: pageTitle(created) })
  } catch (err) { notionError(res, err, 'Failed to duplicate page') }
})

// ── Block move ──────────────────────────────────────────────────────────────
// Notion lacks a native move endpoint. We re-create the block at a target
// position by appending a clone after the chosen sibling and archiving the
// original. The block id changes — clients should refetch the parent's
// children after this call.
router.post('/blocks/:id/move', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { after, before } = req.body as { after?: string; before?: string }
  const id = req.params['id']!
  try {
    // Resolve the block and its parent. The parent might be a page or another
    // block; both expose children via /blocks/:parent/children.
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    const parentType = block.parent?.type as string
    const parentId   = block.parent?.page_id ?? block.parent?.block_id
    if (!parentId) { res.status(400).json({ error: 'Could not resolve block parent' }); return }

    const { data: page } = await axios.get(
      `${NOTION_API}/blocks/${parentId}/children?page_size=100`,
      { headers: notionHeaders() },
    )
    const siblings = (page.results as any[]).filter(b => !b.archived)
    const myIdx     = siblings.findIndex(b => b.id === id)
    if (myIdx === -1) { res.status(404).json({ error: 'Block not found among siblings' }); return }

    // Clone payload — strip read-only fields. For blocks with children we'd
    // need to recursively copy; this top-level clone covers paragraph/heading/
    // list/todo/quote/callout/code/divider/image/etc.
    const t = block.type
    const cloned: any = { object: 'block', type: t, [t]: block[t] }

    let targetIdx: number
    if (after) {
      const i = siblings.findIndex(b => b.id === after)
      if (i === -1) { res.status(400).json({ error: 'after sibling not found' }); return }
      targetIdx = i + 1
    } else if (before) {
      const i = siblings.findIndex(b => b.id === before)
      if (i === -1) { res.status(400).json({ error: 'before sibling not found' }); return }
      targetIdx = i
    } else {
      res.status(400).json({ error: 'after or before is required' }); return
    }
    // Account for the original we'll archive — if moving down past self, the
    // index does not need adjusting because Notion's `after` is by id.
    void targetIdx

    // Notion's append-children supports an `after` parameter pointing at the
    // sibling id this block should follow. If `before`, point at the previous
    // sibling instead (or omit to append at top — handled by appending at index 0).
    let afterId: string | undefined
    if (after) afterId = after
    else if (before) {
      const idx = siblings.findIndex(b => b.id === before)
      if (idx === 0) afterId = undefined  // moving to position 0 — special case
      else           afterId = siblings[idx - 1]?.id
    }

    await axios.patch(
      `${NOTION_API}/blocks/${parentId}/children`,
      afterId ? { children: [cloned], after: afterId } : { children: [cloned] },
      { headers: notionHeaders() },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to move block') }
})

// ── Indent / outdent ────────────────────────────────────────────────────────
// Indent = move this block into its previous sibling as a child.
// Outdent = move this block out of its parent into the grandparent's children.
// Both rely on the same clone+archive pattern (Notion can't reparent in place).

router.post('/blocks/:id/indent', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const id = req.params['id']!
  try {
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    const parentId = block.parent?.page_id ?? block.parent?.block_id
    if (!parentId) { res.status(400).json({ error: 'No parent' }); return }
    const { data: page } = await axios.get(
      `${NOTION_API}/blocks/${parentId}/children?page_size=100`,
      { headers: notionHeaders() },
    )
    const siblings = (page.results as any[]).filter(b => !b.archived)
    const myIdx    = siblings.findIndex(b => b.id === id)
    if (myIdx <= 0) { res.status(400).json({ error: 'No previous sibling to indent under' }); return }
    const prev = siblings[myIdx - 1]
    const t = block.type
    const cloned: any = { object: 'block', type: t, [t]: block[t] }
    await axios.patch(
      `${NOTION_API}/blocks/${prev.id}/children`,
      { children: [cloned] },
      { headers: notionHeaders() },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to indent block') }
})

router.post('/blocks/:id/outdent', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const id = req.params['id']!
  try {
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    // We need the parent block (so we can move into its parent) — only works
    // when the parent is a block (not a top-level page).
    if (block.parent?.type !== 'block_id') {
      res.status(400).json({ error: 'Already at top level' }); return
    }
    const parentBlockId = block.parent.block_id as string
    const { data: parentBlock } = await axios.get(`${NOTION_API}/blocks/${parentBlockId}`, { headers: notionHeaders() })
    const grandparentId = parentBlock.parent?.page_id ?? parentBlock.parent?.block_id
    if (!grandparentId) { res.status(400).json({ error: 'No grandparent' }); return }
    const t = block.type
    const cloned: any = { object: 'block', type: t, [t]: block[t] }
    await axios.patch(
      `${NOTION_API}/blocks/${grandparentId}/children`,
      { children: [cloned], after: parentBlockId },
      { headers: notionHeaders() },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: notionHeaders() })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to outdent block') }
})

// ── oEmbed / OpenGraph preview ──────────────────────────────────────────────
// Server-side fetch for bookmark/embed metadata. We do a HEAD-style GET, parse
// <meta og:*> tags out of the HTML head, and return { title, description,
// image, siteName, type }. Keeps secrets and CORS issues server-side.

router.get('/oembed', async (req, res) => {
  const url = req.query['url'] as string | undefined
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'url is required and must start with http(s)' }); return
  }
  try {
    const { data: html } = await axios.get<string>(url, {
      timeout:         5000,
      maxContentLength: 1_000_000,
      // Pretend to be a browser — many sites block non-browser UAs from HTML.
      headers: { 'User-Agent': 'Mozilla/5.0 (TouchSphere) AppleWebKit/537.36' },
      // Get the body as text so we can scrape og:* meta tags.
      responseType: 'text',
    })
    function og(prop: string): string | undefined {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
      return html.match(re)?.[1] ?? html.match(re2)?.[1]
    }
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
    res.json({
      url,
      title:       og('og:title')        ?? titleTag       ?? url,
      description: og('og:description')  ?? og('description'),
      image:       og('og:image'),
      siteName:    og('og:site_name'),
      type:        og('og:type'),
    })
  } catch (err) {
    // Fall back to a minimal record so the client can still create a bookmark
    // block with just the URL when the target is unreachable / 403.
    res.json({ url, title: url, description: null, image: null })
    void err
  }
})

// ── Database property addition ──────────────────────────────────────────────
// Adds a single property to an existing database. The body is the property
// definition (e.g. { name: 'Notes', type: 'rich_text' }).

// ── Database update (title / icon / cover / property edits) ─────────────────
// Forwards the body to Notion's PATCH /v1/databases/:id. Useful for renaming,
// changing icon/cover, and editing existing properties (rename via { oldName:
// { name: 'newName' } }, retype, change select options, or delete via
// { propName: null }).
router.patch('/databases/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(
      `${NOTION_API}/databases/${req.params['id']}`,
      req.body,
      { headers: notionHeaders() },
    )
    // Invalidate the legacy schema cache in case the task DB was edited.
    schemaCache = null
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update database') }
})

// Convenience endpoint: rename or delete a single property without the caller
// having to know Notion's PATCH-database body shape. Body: `{ rename }` or
// nothing (DELETE method = remove).
router.patch('/databases/:id/properties/:name', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { rename, options, type } = req.body as {
    rename?: string
    options?: { name: string; color?: string }[]
    type?:   string
  }
  const propBody: any = {}
  if (rename)             propBody.name = rename
  if (type)               propBody.type = type
  if (options && options.length > 0) {
    // Only select/multi_select/status accept options. We assume the caller is
    // applying to a compatible property; Notion will reject otherwise.
    propBody.select       = { options }
    propBody.multi_select = { options }
  }
  try {
    await axios.patch(
      `${NOTION_API}/databases/${req.params['id']}`,
      { properties: { [req.params['name']!]: propBody } },
      { headers: notionHeaders() },
    )
    schemaCache = null
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to edit property') }
})

router.delete('/databases/:id/properties/:name', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(
      `${NOTION_API}/databases/${req.params['id']}`,
      { properties: { [req.params['name']!]: null } },
      { headers: notionHeaders() },
    )
    schemaCache = null
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to delete property') }
})

router.post('/databases/:id/properties', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { name, type, options } = req.body as {
    name?: string; type?: string; options?: { name: string; color?: string }[]
  }
  if (!name?.trim() || !type) { res.status(400).json({ error: 'name and type are required' }); return }
  try {
    // Build a minimal property definition. For select/multi_select we forward
    // any user-supplied options.
    const propDef: any = {}
    if (type === 'select' || type === 'multi_select') {
      propDef[type] = { options: options ?? [] }
    } else if (type === 'number') {
      propDef[type] = { format: 'number' }
    } else {
      propDef[type] = {}
    }
    await axios.patch(
      `${NOTION_API}/databases/${req.params['id']}`,
      { properties: { [name.trim()]: propDef } },
      { headers: notionHeaders() },
    )
    schemaCache = null  // legacy cache invalidate
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to add property') }
})

export default router
