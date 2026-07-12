import { Router, Request, Response } from 'express'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

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

// ── Task database list ────────────────────────────────────────────────────────
// The task widget aggregates one *or more* Notion databases. The set of task
// databases is persisted server-side (a JSON file in CACHE_DIR) so it survives
// restarts and is shared across devices. It's seeded once from the
// NOTION_DATABASE_ID env var — which now accepts a comma-separated list — and
// thereafter the persisted file is authoritative (so a DB added or removed from
// the on-screen picker sticks even if the env var never changes).
const TASK_DBS_FILE = 'notion-task-dbs.json'

function cacheDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

const clean = (arr: unknown): string[] =>
  Array.isArray(arr) ? Array.from(new Set(arr.map(String).map(s => s.trim()).filter(Boolean))) : []

// ── "Me" — whose tasks the widget shows ───────────────────────────────────────
// Task databases are often shared, so an unfiltered query returns the whole
// team's rows. The user picks themselves once in Settings (from /users) and we
// persist the Notion user id here; /tasks then filters every DB that has a
// people property down to rows assigned to them. With nobody picked the widget
// behaves as before (everyone's tasks) rather than showing an empty list.
const ME_FILE = 'notion-me.json'

interface NotionMe { id: string; name: string }

function readMe(): NotionMe | null {
  const p = path.join(cacheDir(), ME_FILE)
  try {
    if (!fs.existsSync(p)) return null
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<NotionMe>
    if (!parsed.id) return null
    return { id: String(parsed.id), name: String(parsed.name ?? '') }
  } catch (err) {
    console.error('[notion] failed to read me store:', err)
    return null
  }
}

function writeMe(me: NotionMe | null): void {
  const p = path.join(cacheDir(), ME_FILE)
  try {
    if (me === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p)
      console.log('[notion] cleared "me" — task widget will show everyone\'s tasks')
      return
    }
    fs.writeFileSync(p, JSON.stringify(me, null, 2), 'utf8')
    console.log(`[notion] set "me" → ${me.name} (${me.id})`)
  } catch (err) {
    console.error('[notion] failed to write me store:', err)
    throw err
  }
}

function envTaskDbIds(): string[] {
  return clean((process.env['NOTION_DATABASE_ID'] ?? '').split(','))
}

// The effective task-DB set is auto-discovered (every task-like database the
// integration can see) plus the env seed, minus anything the user has hidden
// via the Browse "Show in Tasks" toggle, plus anything they've explicitly added
// that discovery didn't catch. Only these two overrides are persisted.
interface TaskDbStore { included: string[]; excluded: string[] }

function readStore(): TaskDbStore {
  const p = path.join(cacheDir(), TASK_DBS_FILE)
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { included?: unknown; excluded?: unknown; ids?: unknown }
      // Migrate the earlier `{ ids }` shape → explicit includes.
      return { included: clean(parsed.included ?? parsed.ids), excluded: clean(parsed.excluded) }
    }
  } catch (err) {
    console.error('[notion] failed to read task-db store:', err)
  }
  return { included: [], excluded: [] }
}

function writeStore(store: TaskDbStore): void {
  try {
    fs.writeFileSync(
      path.join(cacheDir(), TASK_DBS_FILE),
      JSON.stringify({ included: clean(store.included), excluded: clean(store.excluded) }, null, 2),
      'utf8',
    )
  } catch (err) {
    console.error('[notion] failed to write task-db store:', err)
    throw err
  }
}

// A database looks like a task list if it has a status/state property or a
// done-style checkbox. Cheap enough to run over search results (which already
// carry each DB's properties) — no per-DB fetch needed.
function isTaskDb(props: Record<string, any>): boolean {
  return findProp(props, ['status', 'state'], ['status', 'select']) != null
      || findProp(props, ['done', 'complete', 'completed', 'finished'], ['checkbox']) != null
}

// Enumerate every task-like database the integration can access. Cached briefly
// so a burst of /tasks + /schema calls doesn't re-search the workspace.
let discoverCache: { ids: string[]; ts: number } | null = null
async function discoverTaskDbIds(force = false): Promise<string[]> {
  if (!force && discoverCache && Date.now() - discoverCache.ts < SCHEMA_TTL) return discoverCache.ids
  const ids: string[] = []
  let cursor: string | undefined
  let safety = 0
  do {
    const { data } = await axios.post(
      `${NOTION_API}/search`,
      { page_size: 100, filter: { property: 'object', value: 'database' }, ...(cursor ? { start_cursor: cursor } : {}) },
      { headers: notionHeaders() },
    )
    for (const r of data.results as any[]) {
      if (!r.archived && isTaskDb(r.properties ?? {})) ids.push(r.id)
    }
    cursor = data.has_more ? data.next_cursor : undefined
    safety++
  } while (cursor && safety < 10)
  discoverCache = { ids, ts: Date.now() }
  return ids
}

// The resolved list of databases whose rows appear in the Home task section.
async function getTaskDbIds(): Promise<string[]> {
  const store = readStore()
  const auto  = await discoverTaskDbIds().catch(() => [])   // tolerate search failure
  const set   = new Set<string>([...auto, ...envTaskDbIds(), ...store.included])
  for (const ex of store.excluded) set.delete(ex)
  return Array.from(set)
}

function tasksConfigured(): boolean {
  return !!process.env['NOTION_API_KEY']
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
  // Workspace custom emoji — an uploaded image referenced by shortcode. Render
  // it as a URL icon like external/file icons (otherwise it falls back to 📄).
  if (i.type === 'custom_emoji') return { type: 'url', value: i.custom_emoji.url }
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
  // People property used to decide whose task a row is. null when the DB has no
  // people property at all — such a DB can't express ownership, so every row in
  // it counts as the user's.
  peopleKey:        string | null
}

// Per-database cache. Each entry holds the derived task schema plus the DB's
// display title/icon (so the aggregated /tasks response can label each source
// without an extra round-trip). Keyed by database id.
interface DbEntry { schema: NotionSchema; title: string; icon: string | null; ts: number }
const dbCache = new Map<string, DbEntry>()
const SCHEMA_TTL = 5 * 60 * 1000

const DONE_NAMES = new Set(['done', 'completed', 'complete', 'finished', 'closed'])

// Fetch + cache a single task database's schema and metadata.
async function getDb(dbId: string, force = false): Promise<DbEntry> {
  const hit = dbCache.get(dbId)
  if (!force && hit && Date.now() - hit.ts < SCHEMA_TTL) return hit
  const { data } = await axios.get(
    `${NOTION_API}/databases/${dbId}`,
    { headers: notionHeaders() },
  )
  const entry: DbEntry = {
    schema: buildSchema(data.properties as Record<string, any>),
    title:  dbTitle(data),
    icon:   iconOf(data)?.value ?? null,
    ts:     Date.now(),
  }
  dbCache.set(dbId, entry)
  return entry
}

async function getSchema(dbId: string, force = false): Promise<NotionSchema> {
  return (await getDb(dbId, force)).schema
}

// Derive our task schema from a database's raw property definitions.
function buildSchema(props: Record<string, any>): NotionSchema {
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

  // Assignee — prefer the conventional names, else fall back to the first people
  // property whatever it's called.
  const peopleEntry = findProp(props, ['assignee', 'assignees', 'owner', 'assigned to', 'person', 'people'], ['people'])
                   ?? Object.entries(props).find(([, p]) => p.type === 'people') as [string, any] | undefined ?? null
  const peopleKey = peopleEntry?.[0] ?? null

  return { titleKey, statusKey, statusType, statusOptions, doneStatusNames, todoStatusNames, priorityKey, priorityOptions, dueKey, projectKey, projectDbId, peopleKey }
}

// Fold several task-DB schemas into one for the generic Home UI (status/priority
// filter chips, colour lookups, create-form field gating). Options are unioned
// by name (first colour wins); done/todo name sets and the boolean-ish keys are
// unioned too. Per-DB actions that must use a specific DB's valid options
// (toggle-done, create) resolve the individual schema instead of this merge.
const EMPTY_SCHEMA: NotionSchema = {
  titleKey: 'Name', statusKey: null, statusType: null, statusOptions: [],
  doneStatusNames: [], todoStatusNames: [], priorityKey: null, priorityOptions: [],
  dueKey: null, projectKey: null, projectDbId: null, peopleKey: null,
}

function mergeSchemas(list: NotionSchema[]): NotionSchema {
  if (list.length === 0) return EMPTY_SCHEMA
  if (list.length === 1) return list[0]!
  const mergeOpts = (pick: (s: NotionSchema) => SchemaOption[]): SchemaOption[] => {
    const byName = new Map<string, SchemaOption>()
    for (const s of list) for (const o of pick(s)) if (!byName.has(o.name)) byName.set(o.name, o)
    return Array.from(byName.values())
  }
  const uniq = (arr: string[]) => Array.from(new Set(arr))
  const first = <T>(pick: (s: NotionSchema) => T | null): T | null =>
    list.map(pick).find(v => v != null) ?? null

  return {
    titleKey:        list[0]!.titleKey,
    statusKey:       first(s => s.statusKey),
    statusType:      first(s => s.statusType),
    statusOptions:   mergeOpts(s => s.statusOptions),
    doneStatusNames: uniq(list.flatMap(s => s.doneStatusNames)),
    todoStatusNames: uniq(list.flatMap(s => s.todoStatusNames)),
    priorityKey:     first(s => s.priorityKey),
    priorityOptions: mergeOpts(s => s.priorityOptions),
    dueKey:          first(s => s.dueKey),
    projectKey:      first(s => s.projectKey),
    projectDbId:     first(s => s.projectDbId),
    peopleKey:       first(s => s.peopleKey),
  }
}

function extractTask(page: any, schema: NotionSchema, dbId: string) {
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

  return { id: page.id, title, status, priority, due, done, createdAt: page.created_time, projectIds, dbId }
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
  try {
    const ids = await getTaskDbIds()
    const schemas = await Promise.all(ids.map(id => getSchema(id)))
    res.json(mergeSchemas(schemas))
  } catch (err) { notionError(res, err, 'Failed to fetch schema') }
})

// Query one task database's pages (paginated, newest first, non-archived).
// When the user has identified themselves and this DB has a people property, the
// filter is pushed down to Notion so a shared board only ever returns their
// rows — cheaper than fetching the team's tasks and discarding them here.
async function queryTaskPages(dbId: string, schema: NotionSchema): Promise<any[]> {
  const me = readMe()
  const mineOnly = me && schema.peopleKey
    ? { filter: { property: schema.peopleKey, people: { contains: me.id } } }
    : {}

  const pages: any[] = []
  let cursor: string | undefined
  let safety = 0
  // Cap at 10 pages (~1000 tasks) per DB to avoid hammering the API on
  // pathological databases — well above any realistic personal task list.
  do {
    const { data } = await axios.post(
      `${NOTION_API}/databases/${dbId}/query`,
      {
        page_size: 100,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        ...mineOnly,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      { headers: notionHeaders() },
    )
    for (const r of data.results as any[]) if (!r.archived) pages.push(r)
    cursor = data.has_more ? data.next_cursor : undefined
    safety++
  } while (cursor && safety < 10)
  return pages
}

router.get('/tasks', async (_req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  try {
    const dbIds = await getTaskDbIds()

    // Fetch every task database in parallel, tagging each row with its source
    // DB. A single failing DB (deleted, unshared) is skipped rather than
    // failing the whole list. Each DB's derived schema is returned so the
    // client can toggle-done / create with that DB's valid options.
    const schemas: Record<string, NotionSchema> = {}
    const dbs: { id: string; title: string; icon: string | null }[] = []
    const perDb = await Promise.all(dbIds.map(async dbId => {
      try {
        const entry = await getDb(dbId)
        schemas[dbId] = entry.schema
        dbs.push({ id: dbId, title: entry.title, icon: entry.icon })
        const pages = await queryTaskPages(dbId, entry.schema)
        return pages.map(p => extractTask(p, entry.schema, dbId))
      } catch (err: any) {
        console.error(`[notion] task DB ${dbId} failed, skipping:`, err?.response?.data ?? err?.message)
        return []
      }
    }))
    const tasks = perDb.flat()

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

    res.json({ tasks, projects, schemas, dbs, merged: mergeSchemas(Object.values(schemas)) })
  } catch (err) { notionError(res, err, 'Failed to fetch tasks') }
})

// Pick the database a mutation targets. Callers pass `dbId`; if it's missing or
// not a known task DB we fall back to the first configured one.
async function resolveTaskDb(dbId?: string): Promise<string | null> {
  const ids = await getTaskDbIds()
  if (dbId && ids.includes(dbId)) return dbId
  return ids[0] ?? null
}

router.post('/tasks', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const { title, status, priority, due, dbId } = req.body as { title?: string; status?: string; priority?: string; due?: string; dbId?: string }
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return }
  const targetDb = await resolveTaskDb(dbId)
  if (!targetDb) { res.status(400).json({ error: 'no task database configured' }); return }
  try {
    const schema     = await getSchema(targetDb)
    const properties = buildTaskProperties(schema, { title: title.trim(), status, priority, due: due ?? null })
    // Assign new tasks to the user. Without this the row comes back unassigned
    // and the "only my tasks" filter would hide it the moment the list refreshes
    // — the task would look like it failed to save.
    const me = readMe()
    if (me && schema.peopleKey) properties[schema.peopleKey] = { people: [{ object: 'user', id: me.id }] }
    const { data }   = await axios.post(
      `${NOTION_API}/pages`,
      { parent: { database_id: targetDb }, properties },
      { headers: notionHeaders() },
    )
    res.status(201).json(extractTask(data, schema, targetDb))
  } catch (err) { notionError(res, err, 'Failed to create task') }
})

router.patch('/tasks/:id', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const { dbId, ...fields } = req.body as { dbId?: string; title?: string; status?: string | null; priority?: string | null; due?: string | null }
  try {
    // Resolve which DB's schema to build properties against: prefer the dbId the
    // client sends (it has it on the task), else look up the page's parent DB.
    let schemaDbId = dbId
    if (!schemaDbId) {
      const { data: page } = await axios.get(`${NOTION_API}/pages/${req.params['id']}`, { headers: notionHeaders() })
      schemaDbId = page.parent?.database_id
    }
    if (!schemaDbId) { res.status(400).json({ error: 'could not resolve task database' }); return }
    const schema     = await getSchema(schemaDbId)
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

// ── Task database management ──────────────────────────────────────────────────
// Which databases feed the aggregated task widget. The list is user-editable
// from the Browse view ("Show in Tasks") and persisted server-side.

// GET → the effective task databases (auto-discovered + overrides) with fresh
// title/icon for the UI.
router.get('/task-dbs', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const ids = await getTaskDbIds()
    const dbs = await Promise.all(ids.map(async id => {
      try { const e = await getDb(id); return { id, title: e.title, icon: e.icon } }
      catch { return { id, title: 'Unavailable', icon: null } }
    }))
    res.json({ ids, dbs })
  } catch (err) { notionError(res, err, 'Failed to list task databases') }
})

// POST { id } → force a database into the task set (un-exclude / include).
router.post('/task-dbs', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const { id } = req.body as { id?: string }
  const target = id?.trim()
  if (!target) { res.status(400).json({ error: 'id is required' }); return }
  try {
    const store = readStore()
    store.excluded = store.excluded.filter(x => x !== target)
    if (!store.included.includes(target)) store.included.push(target)
    writeStore(store)
    dbCache.delete(target)
    res.status(201).json({ ids: await getTaskDbIds() })
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
})

// DELETE :id → hide a database from the task set (exclude, even if discovery
// would otherwise auto-include it).
router.delete('/task-dbs/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const target = req.params['id']!
  try {
    const store = readStore()
    store.included = store.included.filter(x => x !== target)
    if (!store.excluded.includes(target)) store.excluded.push(target)
    writeStore(store)
    res.json({ ids: await getTaskDbIds() })
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
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

// ── Who am I ──────────────────────────────────────────────────────────────────
// GET  /api/notion/me → { me: { id, name } | null }
// POST /api/notion/me { id, name } → pin the user; { id: null } → clear it.
// Notion's own /users/me returns the *integration bot*, not the human, so the
// user has to tell us which workspace member they are.
router.get('/me', (_req: Request, res: Response) => {
  const me = readMe()
  console.log(`[notion] GET me → ${me ? `${me.name} (${me.id})` : 'not set'}`)
  res.json({ me })
})

router.post('/me', (req: Request, res: Response) => {
  const { id, name } = (req.body ?? {}) as { id?: string | null; name?: string }
  try {
    if (id === null || id === '') {
      writeMe(null)
      res.json({ me: null })
      return
    }
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'id is required (or null to clear)' })
      return
    }
    const me: NotionMe = { id, name: typeof name === 'string' ? name : '' }
    writeMe(me)
    // Task rows are filtered per-DB using the cached schema; the schema itself
    // is unaffected by who "me" is, so there's no cache to bust here.
    res.json({ me })
  } catch {
    res.status(500).json({ error: 'Failed to persist Notion user' })
  }
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
    dbCache.clear()
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
    dbCache.clear()
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
    dbCache.clear()
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
    dbCache.clear()  // task-schema cache invalidate
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to add property') }
})

export default router
