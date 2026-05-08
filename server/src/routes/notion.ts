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
  return !!(process.env['NOTION_API_KEY'] && process.env['NOTION_DATABASE_ID'])
}

// Find first property matching any of the given names (case-insensitive) and types
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

// ── Schema ─────────────────────────────────────────────────────────────────────

export interface SchemaOption { id: string; name: string; color: string }

export interface NotionSchema {
  titleKey:         string
  statusKey:        string | null
  statusType:       'status' | 'select' | null
  statusOptions:    SchemaOption[]
  doneStatusNames:  string[]   // options in the Notion "Complete" group (or DONE_NAMES match)
  todoStatusNames:  string[]   // options in the Notion "To-do" group
  priorityKey:      string | null
  priorityOptions:  SchemaOption[]
  dueKey:           string | null
}

let schemaCache: NotionSchema | null = null
let schemaCacheTs = 0
const SCHEMA_TTL   = 5 * 60 * 1000 // 5 min

const DONE_NAMES = new Set(['done', 'completed', 'complete', 'finished', 'closed'])

async function getSchema(force = false): Promise<NotionSchema> {
  if (!force && schemaCache && Date.now() - schemaCacheTs < SCHEMA_TTL) return schemaCache

  const { data } = await axios.get(
    `${NOTION_API}/databases/${process.env['NOTION_DATABASE_ID']}`,
    { headers: notionHeaders() },
  )
  const props = data.properties as Record<string, any>

  // Title
  const titleKey = Object.keys(props).find(k => props[k].type === 'title') ?? 'Name'

  // Status / State
  const statusEntry  = findProp(props, ['status', 'state'], ['status', 'select'])
  const statusKey    = statusEntry?.[0] ?? null
  const statusProp   = statusEntry?.[1]
  const statusType: 'status' | 'select' | null =
    statusProp?.type === 'status' ? 'status' :
    statusProp?.type === 'select' ? 'select' : null

  const statusOptions: SchemaOption[] =
    statusType === 'status' ? (statusProp.status?.options ?? []) :
    statusType === 'select' ? (statusProp.select?.options ?? []) : []

  // Use Notion's own groups to identify done/todo statuses (status type only)
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
  // Fallback: name-based detection
  if (doneStatusNames.length === 0)
    doneStatusNames = statusOptions.filter(o => DONE_NAMES.has(o.name.toLowerCase())).map(o => o.name)
  if (todoStatusNames.length === 0)
    todoStatusNames = statusOptions.filter(o => !DONE_NAMES.has(o.name.toLowerCase())).map(o => o.name)

  // Priority (select)
  const priorityEntry   = findProp(props, ['priority', 'importance'], ['select'])
  const priorityKey     = priorityEntry?.[0] ?? null
  const priorityOptions: SchemaOption[] = priorityEntry?.[1]?.select?.options ?? []

  // Due date
  const dueEntry = findProp(props, ['due', 'deadline', 'date'], ['date'])
  const dueKey   = dueEntry?.[0] ?? null

  schemaCache   = { titleKey, statusKey, statusType, statusOptions, doneStatusNames, todoStatusNames, priorityKey, priorityOptions, dueKey }
  schemaCacheTs = Date.now()
  console.log('[notion] schema cached — statusKey:', statusKey, 'statusType:', statusType, 'done statuses:', doneStatusNames)
  return schemaCache
}

// ── Task extraction ────────────────────────────────────────────────────────────

function extractTask(page: any, schema: NotionSchema) {
  const props = page.properties as Record<string, any>
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

// ── Property builder ───────────────────────────────────────────────────────────

function buildProperties(
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

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/notion/schema
router.get('/schema', async (_req: Request, res: Response) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured — set NOTION_API_KEY and NOTION_DATABASE_ID' }); return }
  try {
    res.json(await getSchema())
  } catch (err: any) {
    console.error('[notion] schema error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to fetch schema' })
  }
})

// GET /api/notion/tasks
router.get('/tasks', async (_req: Request, res: Response) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const schema      = await getSchema()
    const { data }    = await axios.post(
      `${NOTION_API}/databases/${process.env['NOTION_DATABASE_ID']}/query`,
      { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] },
      { headers: notionHeaders() },
    )
    const tasks = (data.results as any[]).filter(p => !p.archived).map(p => extractTask(p, schema))
    console.log(`[notion] fetched ${tasks.length} tasks`)
    res.json(tasks)
  } catch (err: any) {
    console.error('[notion] fetch error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to fetch tasks' })
  }
})

// POST /api/notion/tasks  { title, status?, priority?, due? }
router.post('/tasks', async (req: Request, res: Response) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { title, status, priority, due } = req.body as { title?: string; status?: string; priority?: string; due?: string }
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return }
  try {
    const schema     = await getSchema()
    const properties = buildProperties(schema, { title: title.trim(), status, priority, due: due ?? null })
    const { data }   = await axios.post(
      `${NOTION_API}/pages`,
      { parent: { database_id: process.env['NOTION_DATABASE_ID'] }, properties },
      { headers: notionHeaders() },
    )
    console.log(`[notion] created task "${title.trim()}"`)
    res.status(201).json(extractTask(data, schema))
  } catch (err: any) {
    console.error('[notion] create error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to create task' })
  }
})

// PATCH /api/notion/tasks/:id  { title?, status?, priority?, due? }
router.patch('/tasks/:id', async (req: Request, res: Response) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const fields = req.body as { title?: string; status?: string | null; priority?: string | null; due?: string | null }
  try {
    const schema     = await getSchema()
    const properties = buildProperties(schema, fields)
    if (Object.keys(properties).length > 0)
      await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { properties }, { headers: notionHeaders() })
    console.log(`[notion] updated task ${req.params['id']}`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[notion] patch error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to update task' })
  }
})

// DELETE /api/notion/tasks/:id — archives the Notion page
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { archived: true }, { headers: notionHeaders() })
    console.log(`[notion] archived task ${req.params['id']}`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[notion] archive error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to archive task' })
  }
})

// GET /api/notion/tasks/:id/content — returns plain text of the page body
router.get('/tasks/:id/content', async (req: Request, res: Response) => {
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
  } catch (err: any) {
    console.error('[notion] content error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to fetch content' })
  }
})

export default router
