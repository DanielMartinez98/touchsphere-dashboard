import { Router, Request, Response } from 'express'
import axiosLib from 'axios'
import fs from 'fs'
import path from 'path'
import { broadcast } from './system'
import { isPublicHttpUrl } from './browse'
import {
  ENV_CONN_ID, addConnection, connById, connIdFor, forgetConnection, headersFor,
  listConnections, remember, rememberMany, removeConnection, setConnPrefs, type NotionConn,
} from '../notion-connections'

const router = Router()

// Every call to Notion goes through this instance so every one of them has a
// deadline. There are forty-odd call sites and none of them set one, which
// meant a hung request left the widget's spinner up until the socket died —
// and since nothing polls, nothing retried it. Ten seconds is generous for an
// API that answers in under one; the embed proxy sets its own, shorter.
const axios = axiosLib.create({ timeout: 10_000 })

const NOTION_API = 'https://api.notion.com/v1'

// ── Connections ───────────────────────────────────────────────────────────────
// One token per workspace, kept in notion-connections.ts. Every route below
// resolves the connection for the id it is given (`connFor`) and uses that
// connection's headers (`hdr`); the aggregate routes (workspace, search,
// users, discovery) walk every connection and tag what each one returned.

function configured(): boolean {
  return listConnections().length > 0
}

/** The error the resolver throws when no connection can see an id — shaped like Notion's own 404 so classifyNotionError() calls it "access". */
function unseen(id: string): Error {
  const err = new Error('None of the connected Notion workspaces can see this') as Error & { response?: { status: number; data: { message: string } } }
  err.response = { status: 404, data: { message: `None of the connected Notion workspaces can see ${id} — share it with one of their integrations` } }
  return err
}

/**
 * Which connection can see this page, database or block.
 *
 * Remembered from the listing that produced the id, nearly always. One
 * connection means no question. Otherwise the id is probed as a page, a
 * database and a block against each connection in turn — a 401 disqualifies
 * that connection outright (its token is bad), anything else moves on — and
 * the first hit is remembered so it is never asked again.
 */
async function connFor(id: string): Promise<NotionConn> {
  const conns = listConnections()
  if (conns.length === 0) throw unseen(id)
  const known = connIdFor(id)
  if (known) {
    const c = conns.find(x => x.id === known)
    if (c) return c
  }
  if (conns.length === 1) { remember(id, conns[0]!.id); return conns[0]! }
  for (const c of conns) {
    for (const kind of ['pages', 'databases', 'blocks'] as const) {
      try {
        await axios.get(`${NOTION_API}/${kind}/${id}`, { headers: headersFor(c) })
        remember(id, c.id)
        return c
      } catch (err: any) {
        if (err?.response?.status === 401) break   // this token is dead; do not try it twice more
      }
    }
  }
  throw unseen(id)
}

/** Headers for the connection that can see `id`. */
async function hdr(id: string): Promise<Record<string, string>> {
  return headersFor(await connFor(id))
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

// Notion ids come in two spellings — dashed (what search and the API return)
// and bare 32-hex (what the URL bar shows and what people paste) — and the
// same database under both spellings was two entries in the set. Everything
// is normalised to the dashed form on the way in; Notion accepts either.
function normId(raw: string): string {
  const s = raw.trim()
  const hex = s.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase()
  }
  return s
}

// A pasted Notion link → the database id in it. The id is the last 32-hex
// run in the PATH ("…/Tasks-<id>"); the `?v=` in the query is a view id and
// must not win. Anything that is not a link goes through normId() as an id.
function idFromLink(raw: string): string {
  const s = raw.trim()
  if (!/^https?:\/\//i.test(s)) return normId(s)
  try {
    const runs = new URL(s).pathname.match(/[0-9a-f]{32}/gi) ?? []
    return runs.length ? normId(runs[runs.length - 1]!) : s
  } catch {
    return normId(s)
  }
}

const clean = (arr: unknown): string[] =>
  Array.isArray(arr) ? Array.from(new Set(arr.map(String).map(s => normId(s)).filter(Boolean))) : []

// ── "Me" — whose work the corner shows ────────────────────────────────────────
// Task databases are shared, so a row has to be told apart as mine or someone
// else's. The user picks themselves once (Settings → Notion, or the picker
// inside the corner) and the identity is kept here: ONE person, with the
// Notion user id and, when the integration can read it, the email.
//
// One, not one per workspace (as it was until 2026-09-11), because a person's
// Notion user id is the same in every workspace they belong to — the same id
// is the Assignee on all three teams' boards here — and the email catches
// the case where it is not. A per-workspace override remains for someone who
// is a different account in one workspace; it is consulted first.
const ME_FILE = 'notion-me.json'

interface NotionMe { id: string; name: string; email?: string }
interface MeStore { global: NotionMe | null; byConn: Record<string, NotionMe> }

function parseMe(v: unknown): NotionMe | null {
  const o = v as { id?: unknown; name?: unknown; email?: unknown } | null
  if (!o || typeof o !== 'object' || !o.id) return null
  const me: NotionMe = { id: String(o.id), name: String(o.name ?? '') }
  if (typeof o.email === 'string' && o.email.trim()) me.email = o.email.trim().toLowerCase()
  return me
}

let meCache: MeStore | null = null

function readMeStore(): MeStore {
  if (meCache) return meCache
  const p = path.join(cacheDir(), ME_FILE)
  let store: MeStore = { global: null, byConn: {} }
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { global?: unknown; byConn?: Record<string, unknown> }
      if (parsed.byConn && typeof parsed.byConn === 'object') {
        for (const [conn, v] of Object.entries(parsed.byConn)) { const me = parseMe(v); if (me) store.byConn[conn] = me }
      }
      // Three shapes have lived in this file: { id, name } (one token), {
      // byConn } (one per workspace) and now { global, byConn }. The first
      // reads as the one person; the second promotes its first entry to the
      // one person — right far more often than "nobody", see above — and
      // keeps the entry as the override it also is.
      store.global = parseMe(parsed.global) ?? (parsed.byConn ? null : parseMe(parsed))
      if (!store.global) {
        const first = Object.values(store.byConn)[0]
        if (first) { store.global = first; writeMeStore(store); console.log(`[notion] identity promoted from a per-workspace pick: ${first.name} (${first.id})`) }
      }
    }
  } catch (err) {
    console.error('[notion] failed to read me store:', err)
    store = { global: null, byConn: {} }
  }
  meCache = store
  return store
}

function writeMeStore(store: MeStore): void {
  const p = path.join(cacheDir(), ME_FILE)
  try {
    fs.writeFileSync(p, JSON.stringify({ global: store.global, byConn: store.byConn }, null, 2), 'utf8')
    meCache = store
  } catch (err) {
    console.error('[notion] failed to write me store:', err)
    throw err
  }
}

/** The identity in effect for a workspace: its override, else the one person. */
function meFor(connId: string): NotionMe | null {
  const s = readMeStore()
  return s.byConn[connId] ?? s.global
}

/** Which of a row's people are the user — by id, or by email when the integration hands emails over. */
function isMine(people: any[], me: NotionMe | null): boolean {
  if (!me) return false
  return people.some(p => p?.id === me.id
    || (!!me.email && typeof p?.person?.email === 'string' && p.person.email.toLowerCase() === me.email))
}

// People seen on rows, per workspace: the "who are you" picker's second
// source. The member list (/users) can be empty for an integration whose
// workspace has not granted it user information, yet every row still names
// its assignee — so whoever shows up on a board is offered as a candidate.
interface SeenPerson { id: string; name: string; avatarUrl: string | null; email: string | null }
const peopleSeen = new Map<string, Map<string, SeenPerson>>()

function notePeople(connId: string, people: any[]): void {
  let m = peopleSeen.get(connId)
  if (!m) { m = new Map(); peopleSeen.set(connId, m) }
  for (const p of people) {
    if (!p?.id || (p.type && p.type !== 'person')) continue
    const cur = m.get(p.id)
    m.set(p.id, {
      id: p.id,
      name: (typeof p.name === 'string' && p.name) || cur?.name || '',
      avatarUrl: (typeof p.avatar_url === 'string' && p.avatar_url) || cur?.avatarUrl || null,
      email: (typeof p.person?.email === 'string' && p.person.email) || cur?.email || null,
    })
  }
}

/** Every people value of a row, across all of its people properties. */
function peopleOf(props: Record<string, any>, keys: string[]): any[] {
  const out: any[] = []
  for (const k of keys) for (const p of (props[k]?.people ?? []) as any[]) out.push(p)
  return out
}

function envTaskDbIds(): string[] {
  return clean((process.env['NOTION_DATABASE_ID'] ?? '').split(','))
}

// The effective task-DB set is auto-discovered (every task-like database the
// integration can see) plus the env seed, minus anything the user has hidden
// via the Browse "Show in Tasks" toggle, plus anything they've explicitly added
// that discovery didn't catch. Only these two overrides are persisted.
// `defaultId` is the board new tasks land in (Settings → Notion). '' means
// "whichever comes first" — the env-named one, as it always was.
// A board's ROLE (2026-09-11): a to-do list or a calendar. The three Content
// Calendars have a Status like any to-do list, so until roles existed their
// rows (Idea → Filming → Published, with a film date and a publish date) sat
// in the task list between the to-dos, and a spoken "add a task" landed in
// one of them. The role is detected from the schema and title (detectRole)
// and can be overridden here per board.
export type BoardRole = 'tasks' | 'calendar'

interface TaskDbStore { included: string[]; excluded: string[]; defaultId: string; roles: Record<string, BoardRole> }

function cleanRoles(v: unknown): Record<string, BoardRole> {
  const out: Record<string, BoardRole> = {}
  if (v && typeof v === 'object') {
    for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
      if (r === 'tasks' || r === 'calendar') out[normId(k)] = r
    }
  }
  return out
}

function readStore(): TaskDbStore {
  const p = path.join(cacheDir(), TASK_DBS_FILE)
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { included?: unknown; excluded?: unknown; ids?: unknown; defaultId?: unknown; roles?: unknown }
      // Migrate the earlier `{ ids }` shape → explicit includes.
      return {
        included:  clean(parsed.included ?? parsed.ids),
        excluded:  clean(parsed.excluded),
        defaultId: typeof parsed.defaultId === 'string' ? normId(parsed.defaultId) : '',
        roles:     cleanRoles(parsed.roles),
      }
    }
  } catch (err) {
    console.error('[notion] failed to read task-db store:', err)
  }
  return { included: [], excluded: [], defaultId: '', roles: {} }
}

function writeStore(store: TaskDbStore): void {
  try {
    fs.writeFileSync(
      path.join(cacheDir(), TASK_DBS_FILE),
      JSON.stringify({ included: clean(store.included), excluded: clean(store.excluded), defaultId: normId(store.defaultId), roles: cleanRoles(store.roles) }, null, 2),
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
  // Every connection is searched; one whose token has died is skipped with a
  // line in the log rather than taking the other workspaces' boards with it.
  for (const conn of listConnections()) {
    let cursor: string | undefined
    let safety = 0
    try {
      do {
        const { data } = await axios.post(
          `${NOTION_API}/search`,
          { page_size: 100, filter: { property: 'object', value: 'database' }, ...(cursor ? { start_cursor: cursor } : {}) },
          { headers: headersFor(conn) },
        )
        for (const r of data.results as any[]) {
          remember(r.id, conn.id)
          if (!r.archived && isTaskDb(r.properties ?? {})) ids.push(r.id)
        }
        cursor = data.has_more ? data.next_cursor : undefined
        safety++
      } while (cursor && safety < 10)
    } catch (err: any) {
      console.error(`[notion] discovery failed for connection "${conn.name}":`, err?.response?.data?.message ?? err?.message)
      if (listConnections().length === 1) throw err
    }
  }
  discoverCache = { ids, ts: Date.now() }
  return ids
}

// The resolved list of databases whose rows appear in the Home task section.
// Order is load-bearing: a task created with no database named lands in the
// FIRST of these. The env-named databases come first, then the ones the user
// added by hand, then whatever discovery found — discovery is a Notion search
// whose order follows recent edits, and a voice-added task must not change
// databases because a meeting note was edited this morning.
async function getTaskDbIds(): Promise<string[]> {
  const store = readStore()
  const auto  = await discoverTaskDbIds().catch(() => [])   // tolerate search failure
  const set   = new Set<string>([...envTaskDbIds(), ...store.included, ...auto])
  for (const ex of store.excluded) set.delete(ex)
  const out = Array.from(set)
  // The board picked as default in Settings → Notion goes first, because
  // "first" is what resolveTaskDb() and the create sheet both mean by default.
  const d = store.defaultId
  if (d && out.includes(d)) { out.splice(out.indexOf(d), 1); out.unshift(d) }
  return out
}

function tasksConfigured(): boolean {
  return configured()
}

// Centralised error response. Notion's API errors carry useful messages we surface.
/**
 * What kind of failure this was, in words the screen can act on. The pill
 * used to say "Not configured" for all of them — an expired token, a rate
 * limit, Notion being down, the box being offline — and the panel told the
 * user to add keys to the env file. Each of those wants a different response
 * from the person reading it, so each gets its own sentence and a `kind` the
 * client can branch on.
 */
type NotionErrorKind = 'auth' | 'access' | 'rate' | 'timeout' | 'network' | 'notion'

function classifyNotionError(err: any): { kind: NotionErrorKind; message: string; status: number } {
  const status = err?.response?.status as number | undefined
  const data   = err?.response?.data
  const code   = err?.code as string | undefined
  if (status === 401) return { kind: 'auth',    status, message: 'Notion rejected the integration token — it may have been revoked or rotated' }
  if (status === 403) return { kind: 'access',  status, message: 'The integration is not allowed to see this — share the page or database with it in Notion' }
  if (status === 404) return { kind: 'access',  status, message: 'Notion has no such page or database, or the integration cannot see it' }
  if (status === 429) return { kind: 'rate',    status, message: 'Notion is rate-limiting this integration — it will recover in a minute' }
  if (code === 'ECONNABORTED' || /timeout/i.test(String(err?.message))) {
    return { kind: 'timeout', status: 504, message: 'Notion did not answer within 10 seconds' }
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
    return { kind: 'network', status: 502, message: 'Notion could not be reached — is the server online?' }
  }
  const message = data?.message ?? err?.message ?? 'Notion returned an error'
  return { kind: 'notion', status: status && status >= 400 && status < 600 ? status : 502, message }
}

function notionError(res: Response, err: any, fallback: string) {
  const { kind, message, status } = classifyNotionError(err)
  console.error(`[notion] ${fallback} (${kind}${err?.response?.status ? ` ${err.response.status}` : ''}): ${message}`)
  res.status(status).json({ error: message, kind })
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
  // Every people property, for the "is this mine" test — a row is the user's
  // if they are on any of them, not only the one called Assignee.
  peopleKeys:       string[]
  // Every date property with what it means (due / film / publish / plain
  // date), for the agenda and for telling a calendar board from a to-do list.
  dateKeys:         DateKey[]
  // A done-style checkbox, when the database marks completion that way.
  doneCheckKey:     string | null
}

export type DateKind = 'due' | 'publish' | 'film' | 'date'
export interface DateKey { key: string; kind: DateKind }

// What a date property means, from its name. "Due date", "Deadline" are due
// dates; "Publish date", "Post date", "Release", "Go live" are when a piece of
// content goes out; "Film date", "Shoot", "Recording" are when it is made.
// Anything else ("Date", "When", "Timeline", "Meeting date") is a plain date.
// Contains-matching, not equality: findProp's exact names missed "Due date"
// on both teams' Todo Lists, which is why their tasks never went overdue.
function dateKind(name: string): DateKind {
  const n = name.toLowerCase()
  if (/due|deadline/.test(n)) return 'due'
  if (/publish|post date|release|go.?live|\bair/.test(n)) return 'publish'
  if (/film|shoot|record/.test(n)) return 'film'
  return 'date'
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
    { headers: await hdr(dbId) },
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

  const dateKeys: DateKey[] = Object.entries(props)
    .filter(([, p]) => p?.type === 'date')
    .map(([k]) => ({ key: k, kind: dateKind(k) }))
  // The due date: the one called due, else a plain date. A film or publish
  // date is never a due date — it is what the agenda shows instead.
  const dueKey = dateKeys.find(d => d.kind === 'due')?.key ?? dateKeys.find(d => d.kind === 'date')?.key ?? null
  const doneCheckKey = findProp(props, ['done', 'complete', 'completed', 'finished'], ['checkbox'])?.[0] ?? null

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
  const peopleKeys = Object.entries(props).filter(([, p]) => p?.type === 'people').map(([k]) => k)

  return { titleKey, statusKey, statusType, statusOptions, doneStatusNames, todoStatusNames, priorityKey, priorityOptions, dueKey, projectKey, projectDbId, peopleKey, peopleKeys, dateKeys, doneCheckKey }
}

// A board's role from what it is: a calendar when it has a film or publish
// date or is called one (Content Calendar, Meetings, Editorial schedule…),
// else a to-do list when it has a Status or a done checkbox, else a calendar
// when it has any date at all (Projects with its Timeline), else nothing —
// such a database is for Browse, not a board.
const CALENDAR_TITLE = /calendar|schedule|meeting|editorial|\bcontent\b|\bevents?\b/i

function detectRole(title: string, schema: NotionSchema): BoardRole | null {
  const kinds = new Set(schema.dateKeys.map(d => d.kind))
  if (schema.dateKeys.length > 0 && (kinds.has('publish') || kinds.has('film') || CALENDAR_TITLE.test(title))) return 'calendar'
  if (schema.statusKey || schema.doneCheckKey) return 'tasks'
  if (schema.dateKeys.length > 0) return 'calendar'
  return null
}

/** The role in effect: the override from Settings, else the detected one. */
function roleFor(dbId: string, entry: DbEntry, store: TaskDbStore = readStore()): BoardRole | null {
  return store.roles[dbId] ?? detectRole(entry.title, entry.schema)
}

// Fold several task-DB schemas into one for the generic Home UI (status/priority
// filter chips, colour lookups, create-form field gating). Options are unioned
// by name (first colour wins); done/todo name sets and the boolean-ish keys are
// unioned too. Per-DB actions that must use a specific DB's valid options
// (toggle-done, create) resolve the individual schema instead of this merge.
const EMPTY_SCHEMA: NotionSchema = {
  titleKey: 'Name', statusKey: null, statusType: null, statusOptions: [],
  doneStatusNames: [], todoStatusNames: [], priorityKey: null, priorityOptions: [],
  dueKey: null, projectKey: null, projectDbId: null, peopleKey: null, peopleKeys: [], dateKeys: [], doneCheckKey: null,
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
    peopleKeys:      uniq(list.flatMap(s => s.peopleKeys)),
    dateKeys:        (() => { const seen = new Map<string, DateKey>(); for (const s of list) for (const d of s.dateKeys) if (!seen.has(d.key)) seen.set(d.key, d); return Array.from(seen.values()) })(),
    doneCheckKey:    first(s => s.doneCheckKey),
  }
}

// Who the row is for, worked out here rather than by a Notion-side filter:
// every row comes down and is marked mine or not, so the screen can put mine
// first and still reach the rest (a team's unassigned tasks, what a teammate
// has). No identity in effect means every row is "mine" — there is no way to
// tell, and an empty list would be the wrong answer — and the response's
// `me` being null is what tells the screen to say so.
interface RowCtx { me: NotionMe | null; connId: string }

function ownership(props: Record<string, any>, schema: NotionSchema, ctx: RowCtx | undefined) {
  const people = peopleOf(props, schema.peopleKeys)
  if (ctx) notePeople(ctx.connId, people)
  const assignees = ((schema.peopleKey ? props[schema.peopleKey]?.people : null) ?? [] as any[])
    .map((p: any) => ({ id: String(p.id), name: typeof p.name === 'string' ? p.name : '' }))
  const mine = schema.peopleKeys.length === 0 || !ctx?.me ? true : isMine(people, ctx.me)
  const unassigned = !!schema.peopleKey && assignees.length === 0
  return { mine, unassigned, assignees, conn: ctx?.connId ?? null }
}

function extractTask(page: any, schema: NotionSchema, dbId: string, ctx?: RowCtx) {
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

  return { id: page.id, title, status, priority, due, done, createdAt: page.created_time, projectIds, dbId, ...ownership(props, schema, ctx) }
}

// One row of a calendar board: a content piece, a meeting, a project — with
// every date it carries, each an entry on the agenda ("🎬 Film · Product
// launch" and "📣 Publish · Product launch" are the same row twice).
export interface CalendarItem {
  id: string; title: string; boardId: string; conn: string | null
  status: string | null; done: boolean; mine: boolean; unassigned: boolean
  assignees: { id: string; name: string }[]
  dates: { key: string; kind: DateKind; start: string; end: string | null }[]
  url: string | null
}

function extractItem(page: any, schema: NotionSchema, dbId: string, ctx?: RowCtx): CalendarItem {
  const props   = page.properties as Record<string, any>
  const doneSet = new Set(schema.doneStatusNames.map(n => n.toLowerCase()))
  const title: string = props[schema.titleKey]?.title?.map((t: any) => t.plain_text).join('') || 'Untitled'
  const statusProp = schema.statusKey ? props[schema.statusKey] : null
  const status: string | null =
    schema.statusType === 'status' ? (statusProp?.status?.name ?? null) :
    schema.statusType === 'select' ? (statusProp?.select?.name  ?? null) : null
  const doneViaBox = schema.doneCheckKey ? !!props[schema.doneCheckKey]?.checkbox : false
  const done = doneViaBox || (status != null && doneSet.has(status.toLowerCase()))
  const dates = schema.dateKeys.flatMap(d => {
    const v = props[d.key]?.date
    return v?.start ? [{ key: d.key, kind: d.kind, start: String(v.start), end: v.end ? String(v.end) : null }] : []
  })
  const own = ownership(props, schema, ctx)
  return { id: page.id, title, boardId: dbId, conn: own.conn, status, done, mine: own.mine, unassigned: own.unassigned, assignees: own.assignees, dates, url: typeof page.url === 'string' ? page.url : null }
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

// Query one database's pages (paginated, newest first, non-archived) — every
// row, whoever it belongs to; "mine" is decided here (see ownership()).
// Until 2026-09-11 the assignee filter was pushed down to Notion, which was
// cheaper but left the screen unable to show a team's unassigned tasks or
// what a teammate has, and "prioritise mine" is not "hide the rest".
async function queryAllPages(dbId: string, filter?: any, maxPages = 10): Promise<any[]> {
  const conn = await connFor(dbId)
  const pages: any[] = []
  let cursor: string | undefined
  let safety = 0
  // Cap at 10 pages (~1000 rows) per DB to avoid hammering the API on
  // pathological databases — well above any realistic personal task list.
  do {
    const { data } = await axios.post(
      `${NOTION_API}/databases/${dbId}/query`,
      {
        page_size: 100,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      { headers: headersFor(conn) },
    )
    for (const r of data.results as any[]) { remember(r.id, conn.id); if (!r.archived) pages.push(r) }
    cursor = data.has_more ? data.next_cursor : undefined
    safety++
  } while (cursor && safety < maxPages)
  return pages
}

// A calendar board's rows inside a date window: any of its date properties
// between `from` and `to`, so a long content archive does not come down
// every minute — only what is on the agenda.
const ITEMS_PAST_DAYS = 30
const ITEMS_AHEAD_DAYS = 90

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function queryWindowPages(dbId: string, schema: NotionSchema): Promise<any[]> {
  if (schema.dateKeys.length === 0) return []
  const from = new Date(); from.setDate(from.getDate() - ITEMS_PAST_DAYS)
  const to   = new Date(); to.setDate(to.getDate() + ITEMS_AHEAD_DAYS)
  const clauses = schema.dateKeys.map(d => ({
    and: [
      { property: d.key, date: { on_or_after:  ymd(from) } },
      { property: d.key, date: { on_or_before: ymd(to) } },
    ],
  }))
  return queryAllPages(dbId, clauses.length === 1 ? clauses[0] : { or: clauses }, 5)
}

// ── The whole picture, in one answer ─────────────────────────────────────────
// GET /tasks is the one call the corner makes every minute, and what the
// voice tools read. It answers with everything the screens need: the identity
// in effect, the teams, every board with its role and counts, the tasks (from
// `tasks` boards, each marked mine / unassigned), the agenda items (from
// `calendar` boards, inside the window), the projects and the schemas.
//
// Memoised for 20 s: three screens polling on the minute do not triple the
// Notion traffic, and every change made through this app drops the memo so
// the next poll is fresh. `?fresh=1` bypasses it.
const TASKS_MEMO_MS = 20_000
let tasksMemo: { at: number; body: unknown } | null = null
function invalidateTasks(): void { tasksMemo = null }

interface TeamOut {
  id: string; name: string; workspace: string; color: string; source: 'env' | 'added'
  ok: boolean; error: string | null
}

interface BoardOut {
  id: string; title: string; icon: string | null
  conn: { id: string; name: string; color: string } | null
  role: BoardRole
  hasStatus: boolean
  dueKey: string | null
  dateKeys: DateKey[]
  /** New tasks land here (tasks boards only). */
  isDefault: boolean
  unavailable: boolean
  error: string | null
  openCount: number
  mineCount: number
  unassignedCount: number
}

async function buildTasksResponse() {
  const store  = readStore()
  const dbIds  = await getTaskDbIds()
  const conns  = listConnections()
  const connOf = (id: string) => { const k = connIdFor(id); return k ? conns.find(c => c.id === k) ?? null : null }

  const schemas: Record<string, NotionSchema> = {}
  const boards: BoardOut[] = []
  const teamErr = new Map<string, string>()

  type Fetched = { tasks: ReturnType<typeof extractTask>[]; items: CalendarItem[] }
  const perDb = await Promise.all(dbIds.map(async (dbId): Promise<Fetched> => {
    let entry: DbEntry
    try { entry = await getDb(dbId) }
    catch (err: any) {
      const c = classifyNotionError(err)
      console.error(`[notion] board ${dbId} failed, skipping: ${c.message}`)
      const conn = connOf(dbId)
      if (conn && (c.kind === 'auth' || c.kind === 'network' || c.kind === 'timeout' || c.kind === 'rate')) teamErr.set(conn.id, c.message)
      boards.push({ id: dbId, title: 'Unavailable', icon: null, conn: conn ? { id: conn.id, name: conn.name, color: conn.color } : null, role: 'tasks', hasStatus: false, dueKey: null, dateKeys: [], isDefault: false, unavailable: true, error: c.message, openCount: 0, mineCount: 0, unassignedCount: 0 })
      return { tasks: [], items: [] }
    }
    const role = roleFor(dbId, entry, store)
    if (!role) return { tasks: [], items: [] }   // no status, no dates: not a board
    schemas[dbId] = entry.schema
    const conn = connOf(dbId) ?? (await connFor(dbId).catch(() => null))
    const ctx: RowCtx | undefined = conn ? { me: meFor(conn.id), connId: conn.id } : undefined
    const board: BoardOut = {
      id: dbId, title: entry.title, icon: entry.icon,
      conn: conn ? { id: conn.id, name: conn.name, color: conn.color } : null,
      role, hasStatus: !!entry.schema.statusKey, dueKey: entry.schema.dueKey, dateKeys: entry.schema.dateKeys,
      isDefault: false, unavailable: false, error: null, openCount: 0, mineCount: 0, unassignedCount: 0,
    }
    boards.push(board)
    try {
      if (role === 'tasks') {
        const tasks = (await queryAllPages(dbId)).map(p => extractTask(p, entry.schema, dbId, ctx))
        for (const t of tasks) if (!t.done) { board.openCount++; if (t.mine) board.mineCount++; if (t.unassigned) board.unassignedCount++ }
        return { tasks, items: [] }
      }
      const items = (await queryWindowPages(dbId, entry.schema)).map(p => extractItem(p, entry.schema, dbId, ctx))
      for (const it of items) if (!it.done) { board.openCount++; if (it.mine) board.mineCount++; if (it.unassigned) board.unassignedCount++ }
      return { tasks: [], items }
    } catch (err: any) {
      const c = classifyNotionError(err)
      console.error(`[notion] board "${entry.title}" query failed, skipping: ${c.message}`)
      board.unavailable = true
      board.error = c.message
      if (conn && (c.kind === 'auth' || c.kind === 'network' || c.kind === 'timeout' || c.kind === 'rate')) teamErr.set(conn.id, c.message)
      return { tasks: [], items: [] }
    }
  }))
  const tasks = perDb.flatMap(x => x.tasks)
  const items = perDb.flatMap(x => x.items)

  // Boards in the set's order (the order that decides where a new task goes),
  // and the default: the starred board if it is a tasks board with a Status,
  // else the first such board.
  boards.sort((a, b) => dbIds.indexOf(a.id) - dbIds.indexOf(b.id))
  const canTake = (b: BoardOut) => b.role === 'tasks' && b.hasStatus && !b.unavailable
  const explicit = store.defaultId ? boards.find(b => b.id === store.defaultId && canTake(b)) : undefined
  const effective = explicit ?? boards.find(canTake)
  if (effective) effective.isDefault = true

  // Resolve project titles once per unique id so the client can label rows
  // without an N+1 round-trip. Tolerant of failures (a stale relation just
  // produces a missing title). A project page lives in the same workspace as
  // the task that points at it, so it is remembered under that task's
  // connection before the fetch rather than probed.
  const projects: Record<string, { id: string; title: string; icon: string | null }> = {}
  for (const t of tasks) { const cid = connIdFor(t.dbId); if (cid) rememberMany(t.projectIds, cid) }
  const uniqueIds = Array.from(new Set(tasks.flatMap(t => t.projectIds)))
  await Promise.all(uniqueIds.map(async id => {
    try {
      const { data } = await axios.get(`${NOTION_API}/pages/${id}`, { headers: await hdr(id) })
      projects[id] = { id, title: pageTitle(data), icon: iconOf(data)?.value ?? null }
    } catch { /* tolerate */ }
  }))

  // The teams: every connection, with what its token check said (cached five
  // minutes in connectionsView) and whatever a board fetch just found out.
  const views = await connectionsView().catch(() => [] as Awaited<ReturnType<typeof connectionsView>>)
  const teams: TeamOut[] = conns.map(c => {
    const v = views.find(x => x.id === c.id)
    const err = teamErr.get(c.id) ?? v?.error ?? null
    return { id: c.id, name: c.name, workspace: v?.workspace || c.workspace, color: c.color, source: c.source, ok: !err, error: err }
  })

  const me = readMeStore().global
  return {
    me,
    teams,
    boards,
    tasks,
    items,
    projects,
    schemas,
    // The tasks boards alone, default first — what the create sheet offers.
    dbs: boards.filter(b => b.role === 'tasks' && !b.unavailable).map(b => ({ id: b.id, title: b.title, icon: b.icon })),
    merged: mergeSchemas(boards.filter(b => b.role === 'tasks').map(b => schemas[b.id]).filter((x): x is NotionSchema => !!x)),
    generatedAt: new Date().toISOString(),
  }
}

router.get('/tasks', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  if (!req.query['fresh'] && tasksMemo && Date.now() - tasksMemo.at < TASKS_MEMO_MS) { res.json(tasksMemo.body); return }
  try {
    const body = await buildTasksResponse()
    tasksMemo = { at: Date.now(), body }
    res.json(body)
  } catch (err) { notionError(res, err, 'Failed to fetch tasks') }
})

// Pick the database a mutation targets. Callers pass `dbId`; if it's missing or
// not a known task DB we fall back to the first configured one.
// A task needs a database with a Status (or done checkbox) to land in. The
// aggregated set can legitimately contain a database with neither — the env
// var on this server pointed at a Meetings database for months — and a task
// created there has nowhere to be ticked and a due date that is dropped
// without a word. So the first database WITH a status wins, in the order above,
// and if none has one the caller gets null and says so.
// And only ever in a `tasks` board: a calendar board has a Status too, but a
// spoken "add a task" must not become a content idea on a team's calendar.
async function resolveTaskDb(dbId?: string): Promise<string | null> {
  const ids = await getTaskDbIds()
  const store = readStore()
  const takes = async (id: string) => {
    try { const e = await getDb(id); return roleFor(id, e, store) === 'tasks' && !!e.schema.statusKey }
    catch { return false }   // an unreachable database is not a candidate
  }
  if (dbId && ids.includes(dbId) && await takes(dbId)) return dbId
  for (const id of ids) if (await takes(id)) return id
  console.warn(`[notion] no tasks board with a Status property among ${ids.length} candidate(s)`)
  return null
}

router.post('/tasks', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const { title, status, priority, due, dbId } = req.body as { title?: string; status?: string; priority?: string; due?: string; dbId?: string }
  if (!title?.trim()) { res.status(400).json({ error: 'title is required' }); return }
  const targetDb = await resolveTaskDb(dbId)
  if (!targetDb) { res.status(400).json({ error: 'none of the task databases has a Status property to file a task under', kind: 'notion' }); return }
  try {
    const schema     = await getSchema(targetDb)
    const properties = buildTaskProperties(schema, { title: title.trim(), status, priority, due: due ?? null })
    // Assign new tasks to the user. Without this the row comes back unassigned
    // and would sit under "unassigned" rather than in "my tasks" the moment
    // the list refreshes — the task would look like it failed to save.
    const conn = await connFor(targetDb)
    const me = meFor(conn.id)
    if (me && schema.peopleKey) properties[schema.peopleKey] = { people: [{ object: 'user', id: me.id }] }
    const { data }   = await axios.post(
      `${NOTION_API}/pages`,
      { parent: { database_id: targetDb }, properties },
      { headers: headersFor(conn) },
    )
    remember(data.id, conn.id)
    invalidateTasks()
    console.log(`[notion] created task "${title.trim().slice(0, 60)}" in ${schema.titleKey ? (await getDb(targetDb)).title : targetDb}${due ? ` due ${due}` : ''}`)
    broadcast('notion', { kind: 'task', op: 'create', id: data.id })
    res.status(201).json(extractTask(data, schema, targetDb, { me, connId: conn.id }))
  } catch (err) { notionError(res, err, 'Failed to create task') }
})

// `assignee: 'me'` puts the user on the row ("Take it"), `assignee: null`
// takes everyone off it ("Hand back") — the two moves a person managing a
// team's unassigned pile needs, and nothing more.
router.patch('/tasks/:id', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  const { dbId, assignee, ...fields } = req.body as { dbId?: string; assignee?: 'me' | null; title?: string; status?: string | null; priority?: string | null; due?: string | null }
  try {
    // Resolve which DB's schema to build properties against: prefer the dbId the
    // client sends (it has it on the task), else look up the page's parent DB.
    let schemaDbId = dbId
    if (!schemaDbId) {
      const { data: page } = await axios.get(`${NOTION_API}/pages/${req.params['id']}`, { headers: await hdr(req.params['id']!) })
      schemaDbId = page.parent?.database_id
    }
    if (!schemaDbId) { res.status(400).json({ error: 'could not resolve task database' }); return }
    const schema     = await getSchema(schemaDbId)
    const properties = buildTaskProperties(schema, fields)
    if (assignee !== undefined) {
      if (!schema.peopleKey) { res.status(400).json({ error: 'This board has no assignee field' }); return }
      if (assignee === 'me') {
        const me = meFor((await connFor(schemaDbId)).id)
        if (!me) { res.status(400).json({ error: 'Pick who you are first (Settings → Notion)' }); return }
        properties[schema.peopleKey] = { people: [{ object: 'user', id: me.id }] }
      } else {
        properties[schema.peopleKey] = { people: [] }
      }
    }
    if (Object.keys(properties).length > 0)
      await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { properties }, { headers: await hdr(req.params['id']!) })
    invalidateTasks()
    broadcast('notion', { kind: 'task', op: 'update', id: req.params['id'] })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update task') }
})

router.delete('/tasks/:id', async (req, res) => {
  if (!tasksConfigured()) { res.status(503).json({ error: 'Notion task DB not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { archived: true }, { headers: await hdr(req.params['id']!) })
    invalidateTasks()
    broadcast('notion', { kind: 'task', op: 'archive', id: req.params['id'] })
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
      { headers: await hdr(req.params['id']!) },
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
// Which databases ("boards") feed the aggregated task widget. Editable from
// Settings → Notion and from the Browse view ("Show in Tasks"), persisted
// server-side, shared by every device.

interface TaskDbView {
  id: string; title: string; icon: string | null
  /** A task can be created here: the database has a Status (or done checkbox). */
  hasStatus: boolean
  /** To-do list or calendar — the override from Settings, else detected. */
  role: BoardRole | null
  /** What detection alone says, so the Settings row can show when an override is in force. */
  detectedRole: BoardRole | null
  dueKey: string | null
  dateKeys: DateKey[]
  /** Where this board came from — the env var, the user, or discovery. */
  source: 'env' | 'added' | 'discovered'
  /** New tasks land here. Explicit when set in Settings, else the first board with a Status. */
  isDefault: boolean
  /** Notion would not hand it over (deleted, or unshared from the integration). */
  unavailable: boolean
  /** The workspace (connection) it belongs to, once known. */
  conn: { id: string; name: string } | null
}

// The whole picture for the Settings tab in one answer: the boards in effect
// (in the order that decides where a new task goes), the ones hidden, and
// which is the default. Every mutation below answers with the same shape so
// the screen never has to guess what a change did.
async function taskDbsView() {
  const store = readStore()
  const ids   = await getTaskDbIds()
  const env   = new Set(envTaskDbIds())
  const dbs: TaskDbView[] = await Promise.all(ids.map(async id => {
    const source: TaskDbView['source'] = env.has(id) ? 'env' : store.included.includes(id) ? 'added' : 'discovered'
    // Which workspace the board is in, for the label beside it — known after
    // getDb() at the latest, since fetching it resolves the connection.
    const connOf = () => { const k = connIdFor(id); const c = k ? connById(k) : undefined; return c ? { id: c.id, name: c.name } : null }
    try {
      const e = await getDb(id)
      return { id, title: e.title, icon: e.icon, hasStatus: !!e.schema.statusKey, role: roleFor(id, e, store), detectedRole: detectRole(e.title, e.schema), dueKey: e.schema.dueKey, dateKeys: e.schema.dateKeys, source, isDefault: false, unavailable: false, conn: connOf() }
    } catch {
      return { id, title: 'Unavailable', icon: null, hasStatus: false, role: store.roles[id] ?? null, detectedRole: null, dueKey: null, dateKeys: [], source, isDefault: false, unavailable: true, conn: connOf() }
    }
  }))
  // The effective default is what resolveTaskDb() would choose: the explicit
  // pick if it is a tasks board that can take a task, else the first such.
  const canTake = (d: TaskDbView) => d.role === 'tasks' && d.hasStatus
  const explicit = store.defaultId && dbs.find(d => d.id === store.defaultId && canTake(d))
  const effective = explicit || dbs.find(canTake)
  if (effective) effective.isDefault = true
  const hidden = await Promise.all(store.excluded.map(async id => {
    try { const e = await getDb(id); return { id, title: e.title, icon: e.icon } }
    catch { return { id, title: 'Unavailable', icon: null } }
  }))
  return { ids, dbs, hidden, defaultId: effective?.id ?? '', defaultExplicit: !!explicit }
}

// Other devices' task lists and settings tabs follow this frame (useNotion
// listens on `notion`), the same one every task edit through this app sends.
function announceTaskDbs(): void {
  invalidateTasks()
  broadcast('notion', { kind: 'task-dbs' })
}

// POST /task-dbs/role { id, role } → override a board's role ('tasks' |
// 'calendar'); '' removes the override and detection decides again.
router.post('/task-dbs/role', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const body = req.body as { id?: unknown; role?: unknown }
  const target = typeof body?.id === 'string' ? idFromLink(body.id) : ''
  const role = body?.role
  if (!target) { res.status(400).json({ error: 'id is required' }); return }
  if (role !== 'tasks' && role !== 'calendar' && role !== '' && role !== null && role !== undefined) {
    res.status(400).json({ error: 'role must be "tasks", "calendar" or empty' }); return
  }
  try {
    if (!(await getTaskDbIds()).includes(target)) { res.status(400).json({ error: 'That database is not one of the boards' }); return }
    const store = readStore()
    if (role === 'tasks' || role === 'calendar') store.roles[target] = role
    else delete store.roles[target]
    writeStore(store)
    console.log(`[notion] board ${target} role → ${role || '(detected)'}`)
    announceTaskDbs()
    res.json(await taskDbsView())
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
})

// GET → the effective task databases (auto-discovered + overrides) with fresh
// title/icon for the UI, plus the hidden ones and the default.
router.get('/task-dbs', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    res.json(await taskDbsView())
  } catch (err) { notionError(res, err, 'Failed to list task databases') }
})

// POST { id, makeDefault? } → force a database into the task set (un-exclude /
// include). `id` may be a pasted Notion link; the database id is taken from it.
router.post('/task-dbs', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const body = req.body as { id?: unknown; makeDefault?: unknown }
  const target = typeof body?.id === 'string' ? idFromLink(body.id) : ''
  if (!target) { res.status(400).json({ error: 'id is required' }); return }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target)) {
    res.status(400).json({ error: 'That is not a Notion database link or id' }); return
  }
  // Prove the integration can see it before remembering it: a typo, or a
  // database never shared with the integration, would otherwise sit in the
  // list as "Unavailable" with nothing saying which of the two it is.
  try { dbCache.delete(target); await getDb(target, true) }
  catch (err) { notionError(res, err, 'Cannot add that database'); return }
  try {
    const store = readStore()
    store.excluded = store.excluded.filter(x => x !== target)
    if (!store.included.includes(target)) store.included.push(target)
    if (body.makeDefault === true) store.defaultId = target
    writeStore(store)
    announceTaskDbs()
    res.status(201).json(await taskDbsView())
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
})

// POST /task-dbs/default { id } → the board new tasks land in. '' clears the
// choice (back to "the first one"). Must be a board currently in the set.
router.post('/task-dbs/default', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const raw = (req.body as { id?: unknown })?.id
  const target = typeof raw === 'string' ? idFromLink(raw) : ''
  try {
    if (target && !(await getTaskDbIds()).includes(target)) {
      res.status(400).json({ error: 'That database is not one of the task boards' }); return
    }
    const store = readStore()
    store.defaultId = target
    writeStore(store)
    console.log(`[notion] default task board → ${target || '(first)'}`)
    announceTaskDbs()
    res.json(await taskDbsView())
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
})

// DELETE :id → hide a database from the task set (exclude, even if discovery
// would otherwise auto-include it).
router.delete('/task-dbs/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const target = normId(req.params['id']!)
  try {
    const store = readStore()
    store.included = store.included.filter(x => x !== target)
    if (!store.excluded.includes(target)) store.excluded.push(target)
    if (store.defaultId === target) store.defaultId = ''
    writeStore(store)
    announceTaskDbs()
    res.json(await taskDbsView())
  } catch { res.status(500).json({ error: 'Failed to persist task databases' }) }
})

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL LAYER — full Notion client surface
// ─────────────────────────────────────────────────────────────────────────────

// Workspace discovery — uses the search endpoint with empty query to enumerate
// every database and page the integration has access to. We split into two
// lists for the UI and add lightweight metadata (title, icon, parent kind).
router.get('/workspace', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured — add a workspace in Settings → Notion or set NOTION_API_KEY' }); return }
  try {
    const databases: any[] = []
    const pages:     any[] = []
    const conns = listConnections()
    const failures: string[] = []

    // Every workspace, one after the other; each result carries which one it
    // came from, and is remembered under it so every later call on that id
    // goes straight to the right token.
    for (const conn of conns) {
      let cursor: string | undefined
      let safety = 0
      try {
        // Walk pagination — capped to avoid abusing the API on giant workspaces.
        do {
          const { data } = await axios.post(
            `${NOTION_API}/search`,
            { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
            { headers: headersFor(conn) },
          )
          for (const r of data.results as any[]) {
            remember(r.id, conn.id)
            if (r.archived) continue
            r.__conn = { id: conn.id, name: conn.name }
            if (r.object === 'database') databases.push(r)
            else if (r.object === 'page') pages.push(r)
          }
          cursor = data.has_more ? data.next_cursor : undefined
          safety++
        } while (cursor && safety < 10)
      } catch (err) {
        // One dead token must not blank the other workspaces. With a single
        // connection the error is the answer, as before.
        if (conns.length === 1) throw err
        failures.push(conn.name)
        console.error(`[notion] workspace listing failed for "${conn.name}":`, classifyNotionError(err).message)
      }
    }

    res.json({
      databases: databases.map(d => ({
        id:    d.id,
        title: dbTitle(d),
        icon:  iconOf(d),
        url:   d.url,
        parent: d.parent,
        // Whether it looks like a task list (Status or done checkbox) — the
        // Settings tab says so beside each board it offers to add.
        taskLike: isTaskDb(d.properties ?? {}),
        conn:  d.__conn,
      })),
      pages: pages.map(p => ({
        id:     p.id,
        title:  pageTitle(p),
        icon:   iconOf(p),
        url:    p.url,
        parent: p.parent,
        conn:   p.__conn,
      })),
      // Workspaces that did not answer, by name, so the screen can say so.
      failed: failures,
    })
  } catch (err) { notionError(res, err, 'Failed to fetch workspace') }
})

// Search — q is the user query, optional filter narrows to databases or pages.
router.get('/search', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const q    = (req.query['q']    as string | undefined) ?? ''
  const kind = req.query['type']  as 'page' | 'database' | undefined

  try {
    // All workspaces at once; a workspace that fails drops out of this one
    // answer rather than failing the search (unless it is the only one).
    const conns = listConnections()
    const perConn = await Promise.all(conns.map(async conn => {
      try {
        const { data } = await axios.post(
          `${NOTION_API}/search`,
          {
            query: q,
            page_size: 30,
            ...(kind ? { filter: { property: 'object', value: kind } } : {}),
          },
          { headers: headersFor(conn) },
        )
        return (data.results as any[]).map(r => { remember(r.id, conn.id); return { r, conn } })
      } catch (err) {
        if (conns.length === 1) throw err
        console.error(`[notion] search failed for "${conn.name}":`, classifyNotionError(err).message)
        return []
      }
    }))
    res.json({
      results: perConn.flat()
        .filter(({ r }) => !r.archived)
        .map(({ r, conn }) => ({
          id:     r.id,
          object: r.object,
          title:  r.object === 'database' ? dbTitle(r) : pageTitle(r),
          icon:   iconOf(r),
          parent: r.parent,
          url:    r.url,
          conn:   { id: conn.id, name: conn.name },
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
      { headers: await hdr(req.params['id']!) },
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
    const conn = await connFor(req.params['id']!)
    const { data } = await axios.post(
      `${NOTION_API}/databases/${req.params['id']}/query`,
      { page_size: 100, ...req.body },
      { headers: headersFor(conn) },
    )
    // Rows of a database are in its workspace; remembered so opening one is
    // never a probe.
    rememberMany((data.results as any[]).map(p => p.id), conn.id)
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
      { headers: await hdr(req.params['id']!) },
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
    // A page is created in its parent's workspace, whichever kind of parent.
    const parent = (req.body as { parent?: { database_id?: string; page_id?: string } })?.parent
    const parentId = parent?.database_id ?? parent?.page_id
    if (!parentId) { res.status(400).json({ error: 'parent.database_id or parent.page_id is required' }); return }
    const conn = await connFor(parentId)
    const { data } = await axios.post(
      `${NOTION_API}/pages`,
      req.body,
      { headers: headersFor(conn) },
    )
    remember(data.id, conn.id)
    invalidateTasks()
    broadcast('notion', { kind: 'page', op: 'create', id: data.id })
    res.status(201).json({ id: data.id, title: pageTitle(data) })
  } catch (err) { notionError(res, err, 'Failed to create page') }
})

// Update page properties (or icon/cover/archived). Body forwarded to Notion.
router.patch('/pages/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, req.body, { headers: await hdr(req.params['id']!) })
    invalidateTasks()
    broadcast('notion', { kind: 'page', op: 'update', id: req.params['id'] })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update page') }
})

router.delete('/pages/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/pages/${req.params['id']}`, { archived: true }, { headers: await hdr(req.params['id']!) })
    invalidateTasks()
    broadcast('notion', { kind: 'page', op: 'archive', id: req.params['id'] })
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
    const conn = await connFor(req.params['id']!)
    const { data } = await axios.get(
      `${NOTION_API}/blocks/${req.params['id']}/children?${params}`,
      { headers: headersFor(conn) },
    )
    // Children are in their parent's workspace: remembered, so editing one
    // later is never a probe.
    rememberMany((data.results as any[]).map(b => b.id), conn.id)
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
    const conn = await connFor(req.params['id']!)
    const { data } = await axios.patch(
      `${NOTION_API}/blocks/${req.params['id']}/children`,
      req.body,
      { headers: headersFor(conn) },
    )
    rememberMany(((data.results ?? []) as any[]).map(b => b.id), conn.id)
    res.status(201).json({ results: data.results ?? [] })
  } catch (err) { notionError(res, err, 'Failed to append blocks') }
})

// Update a block — body is a Notion block-update payload, e.g.
//   { paragraph: { rich_text: [{ type:'text', text:{ content:'…' } }] } }
//   { to_do: { checked: true } }
router.patch('/blocks/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.patch(`${NOTION_API}/blocks/${req.params['id']}`, req.body, { headers: await hdr(req.params['id']!) })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to update block') }
})

router.delete('/blocks/:id', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    await axios.delete(`${NOTION_API}/blocks/${req.params['id']}`, { headers: await hdr(req.params['id']!) })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to delete block') }
})

// ── Who am I ──────────────────────────────────────────────────────────────────
// GET  /api/notion/me → { me: { id, name } | null }
// POST /api/notion/me { id, name } → pin the user; { id: null } → clear it.
// Notion's own /users/me returns the *integration bot*, not the human, so the
// user has to tell us which workspace member they are.
// `me` is the one person; `byConn` the per-workspace overrides; `effective`
// what each workspace's boards are filtered by.
function meView() {
  const store = readMeStore()
  const effective: Record<string, NotionMe | null> = {}
  for (const c of listConnections()) effective[c.id] = store.byConn[c.id] ?? store.global
  return { me: store.global, byConn: store.byConn, effective }
}

router.get('/me', (_req: Request, res: Response) => {
  res.json(meView())
})

// POST { id, name, email?, conn? } — without `conn` this sets the one
// person; with it, the override for that workspace. `id: null` clears either.
router.post('/me', (req: Request, res: Response) => {
  const { id, name, email, conn } = (req.body ?? {}) as { id?: string | null; name?: string; email?: string; conn?: string }
  const connId = typeof conn === 'string' && conn ? conn : null
  if (connId && !connById(connId)) { res.status(400).json({ error: 'no such Notion connection' }); return }
  try {
    const store = readMeStore()
    if (id === null || id === '') {
      if (connId) delete store.byConn[connId]
      else store.global = null
      writeMeStore({ global: store.global, byConn: { ...store.byConn } })
      console.log(`[notion] cleared "me"${connId ? ` for ${connId}` : ''}`)
    } else {
      if (!id || typeof id !== 'string') { res.status(400).json({ error: 'id is required (or null to clear)' }); return }
      const me: NotionMe = { id, name: typeof name === 'string' ? name : '' }
      if (typeof email === 'string' && email.trim()) me.email = email.trim().toLowerCase()
      if (connId) store.byConn[connId] = me
      else store.global = me
      writeMeStore({ global: store.global, byConn: { ...store.byConn } })
      console.log(`[notion] set "me"${connId ? ` for ${connId}` : ''} → ${me.name} (${me.id}${me.email ? `, ${me.email}` : ''})`)
    }
    announceTaskDbs()
    res.json(meView())
  } catch {
    res.status(500).json({ error: 'Failed to persist Notion user' })
  }
})

// List workspace users — needed for people-property pickers. Every
// connection's members, each tagged with the connection, because a user id
// only means something inside its own workspace.
router.get('/users', async (_req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  try {
    const conns = listConnections()
    const perConn = await Promise.all(conns.map(async conn => {
      try {
        const { data } = await axios.get(`${NOTION_API}/users?page_size=100`, { headers: headersFor(conn) })
        return (data.results as any[]).map(u => ({
          id:        u.id,
          name:      u.name,
          type:      u.type,
          avatarUrl: u.avatar_url,
          email:     typeof u.person?.email === 'string' ? u.person.email : null,
          conn:      { id: conn.id, name: conn.name, color: conn.color },
        }))
      } catch (err) {
        if (conns.length === 1) throw err
        console.error(`[notion] users failed for "${conn.name}":`, classifyNotionError(err).message)
        return []
      }
    }))
    // The people seen on each workspace's boards, for the picker when the
    // member list above is empty (see notePeople).
    const seen: Record<string, (SeenPerson & { conn: { id: string; name: string; color: string } })[]> = {}
    for (const conn of conns) {
      seen[conn.id] = Array.from(peopleSeen.get(conn.id)?.values() ?? []).map(p => ({ ...p, conn: { id: conn.id, name: conn.name, color: conn.color } }))
    }
    res.json({ users: perConn.flat(), seen })
  } catch (err) { notionError(res, err, 'Failed to fetch users') }
})

// ── Connections (workspaces) ─────────────────────────────────────────────────
// GET    /connections            → every connection, tokens stripped, with what Notion says about each.
// POST   /connections {token,name?} → prove the token against /users/me, then keep it.
// PATCH  /connections/:id {name} → rename.
// DELETE /connections/:id        → forget it (not the env one — that lives in .env).

interface BotInfo { workspace: string; bot: string }
const botCache = new Map<string, { info: BotInfo | null; error: string | null; ts: number }>()

/** What a token is: the workspace it belongs to and the integration's name, from Notion's /users/me. */
async function describeToken(token: string): Promise<BotInfo> {
  const { data } = await axios.get(`${NOTION_API}/users/me`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  })
  return { workspace: String(data?.bot?.workspace_name ?? ''), bot: String(data?.name ?? '') }
}

async function connectionsView() {
  return Promise.all(listConnections().map(async c => {
    const hit = botCache.get(c.id)
    let info = hit?.info ?? null
    let error = hit?.error ?? null
    if (!hit || Date.now() - hit.ts > 5 * 60_000) {
      try { info = await describeToken(c.token); error = null }
      catch (err) { info = null; error = classifyNotionError(err).message }
      botCache.set(c.id, { info, error, ts: Date.now() })
      // The env connection learns its workspace's name here and keeps it, so
      // its chip reads "Dolce Piquant" rather than "From .env".
      if (c.source === 'env' && info?.workspace && info.workspace !== c.workspace) setConnPrefs(ENV_CONN_ID, { workspace: info.workspace })
    }
    return {
      id: c.id, name: c.name, source: c.source, color: c.color,
      workspace: info?.workspace || c.workspace, bot: info?.bot ?? '',
      // The token's last four characters, so two connections can be told
      // apart by someone holding the real thing — never more than that.
      tokenTail: c.token.slice(-4),
      ok: !error, error,
      me: meFor(c.id),
    }
  }))
}

router.get('/connections', async (_req, res) => {
  try { res.json({ connections: await connectionsView() }) }
  catch (err) { notionError(res, err, 'Failed to list connections') }
})

router.post('/connections', async (req, res) => {
  const body = req.body as { token?: unknown; name?: unknown }
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  const name  = typeof body?.name  === 'string' ? body.name.trim()  : ''
  if (!token) { res.status(400).json({ error: 'token is required' }); return }
  if (!/^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(token)) {
    res.status(400).json({ error: 'That is not a Notion integration token (they start with ntn_ or secret_)' }); return
  }
  let info: BotInfo
  try { info = await describeToken(token) }
  catch (err) { notionError(res, err, 'Notion rejected that token'); return }
  try {
    const c = addConnection({ name: name || info.workspace || info.bot, token, workspace: info.workspace })
    botCache.set(c.id, { info, error: null, ts: Date.now() })
    discoverCache = null
    announceTaskDbs()
    res.status(201).json({ connections: await connectionsView(), added: c.id })
  } catch { res.status(500).json({ error: 'Failed to save the connection' }) }
})

// PATCH { name?, color? } — the team's name and colour, for the env
// connection too (only its token lives in .env).
router.patch('/connections/:id', async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; color?: unknown }
  const patch: { name?: string; color?: string } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) { res.status(400).json({ error: 'name must be a non-empty string' }); return }
    patch.name = body.name.trim().slice(0, 40)
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) { res.status(400).json({ error: 'color must be a #rrggbb value' }); return }
    patch.color = body.color
  }
  if (!('name' in patch) && !('color' in patch)) { res.status(400).json({ error: 'nothing to change' }); return }
  if (!setConnPrefs(req.params['id']!, patch)) { res.status(404).json({ error: 'no such connection' }); return }
  announceTaskDbs()
  res.json({ connections: await connectionsView() })
})

router.delete('/connections/:id', async (req, res) => {
  const id = req.params['id']!
  if (id === ENV_CONN_ID) { res.status(400).json({ error: 'The .env connection is removed by clearing NOTION_API_KEY in .env' }); return }
  if (!removeConnection(id)) { res.status(404).json({ error: 'no such connection' }); return }
  try { const s = readMeStore(); if (s.byConn[id]) { delete s.byConn[id]; writeMeStore({ global: s.global, byConn: { ...s.byConn } }) } } catch { /* nothing to clear */ }
  botCache.delete(id)
  forgetConnection(id)
  discoverCache = null
  dbCache.clear()
  announceTaskDbs()
  res.json({ connections: await connectionsView() })
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
      { headers: await hdr(blockId) },
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
      { headers: await hdr(pageId) },
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
    const conn = await connFor(sourceId)
    const { data: src } = await axios.get(`${NOTION_API}/pages/${sourceId}`, { headers: headersFor(conn) })

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
      { headers: headersFor(conn) },
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
      { headers: headersFor(conn) },
    )
    remember(created.id, conn.id)
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
    const conn = await connFor(id)
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
    const parentType = block.parent?.type as string
    const parentId   = block.parent?.page_id ?? block.parent?.block_id
    if (!parentId) { res.status(400).json({ error: 'Could not resolve block parent' }); return }

    const { data: page } = await axios.get(
      `${NOTION_API}/blocks/${parentId}/children?page_size=100`,
      { headers: headersFor(conn) },
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
      { headers: headersFor(conn) },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
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
    const conn = await connFor(id)
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
    const parentId = block.parent?.page_id ?? block.parent?.block_id
    if (!parentId) { res.status(400).json({ error: 'No parent' }); return }
    const { data: page } = await axios.get(
      `${NOTION_API}/blocks/${parentId}/children?page_size=100`,
      { headers: headersFor(conn) },
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
      { headers: headersFor(conn) },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to indent block') }
})

router.post('/blocks/:id/outdent', async (req, res) => {
  if (!configured()) { res.status(503).json({ error: 'Notion not configured' }); return }
  const id = req.params['id']!
  try {
    const conn = await connFor(id)
    const { data: block } = await axios.get(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
    // We need the parent block (so we can move into its parent) — only works
    // when the parent is a block (not a top-level page).
    if (block.parent?.type !== 'block_id') {
      res.status(400).json({ error: 'Already at top level' }); return
    }
    const parentBlockId = block.parent.block_id as string
    const { data: parentBlock } = await axios.get(`${NOTION_API}/blocks/${parentBlockId}`, { headers: headersFor(conn) })
    const grandparentId = parentBlock.parent?.page_id ?? parentBlock.parent?.block_id
    if (!grandparentId) { res.status(400).json({ error: 'No grandparent' }); return }
    const t = block.type
    const cloned: any = { object: 'block', type: t, [t]: block[t] }
    await axios.patch(
      `${NOTION_API}/blocks/${grandparentId}/children`,
      { children: [cloned], after: parentBlockId },
      { headers: headersFor(conn) },
    )
    await axios.delete(`${NOTION_API}/blocks/${id}`, { headers: headersFor(conn) })
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
  // The same guard every other user-typed URL in this app passes through:
  // this route fetches whatever it is given, server-side, and without it a
  // bookmark block could read the title of anything on the LAN.
  let parsed: URL
  try { parsed = new URL(url) } catch { res.status(400).json({ error: 'not a valid URL' }); return }
  if (!isPublicHttpUrl(parsed)) {
    res.status(400).json({ error: 'only public web addresses can be embedded' }); return
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
      { headers: await hdr(req.params['id']!) },
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
      { headers: await hdr(req.params['id']!) },
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
      { headers: await hdr(req.params['id']!) },
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
      { headers: await hdr(req.params['id']!) },
    )
    dbCache.clear()  // task-schema cache invalidate
    res.json({ ok: true })
  } catch (err) { notionError(res, err, 'Failed to add property') }
})

export default router
