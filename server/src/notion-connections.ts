// Notion CONNECTIONS — one integration token per workspace (or per team,
// when each team runs its own workspace), all feeding the same app.
//
// Until 2026-09-11 the whole Notion layer read one token from NOTION_API_KEY.
// A second team's workspace could not be added without replacing the first,
// because a Notion integration lives inside one workspace and its token sees
// nothing outside it. So the token is now a LIST: the env one, if set, comes
// first and is called "From .env"; the rest are added on screen in Settings →
// Notion and kept here on the cache volume, mode 0600, never sent back to a
// browser (the list routes strip them).
//
// The other half of the problem is that every route in routes/notion.ts takes
// a page, database or block id and has to know WHICH token can read it. Ids
// are globally unique, so the answer is a memory: every listing (workspace,
// search, discovery, a database query, a block's children) records which
// connection produced each id, the memory is persisted so a restart does not
// forget it, and an id nobody has listed yet — a pin from months ago — is
// probed against each connection once and then remembered. With one
// connection none of that runs: the answer is the one connection.

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export interface NotionConn {
  id:        string
  name:      string
  token:     string
  source:    'env' | 'added'
  /** Notion's own name for the workspace, learned from /users/me when the token was added. */
  workspace: string
  addedAt:   string
  /** The team's colour — the one visual key that says which team a row belongs to, everywhere. */
  color:     string
}

interface StoredConn { id: string; name: string; token: string; workspace: string; addedAt: string }

/** Per-connection preferences: a display name and a colour, for the env connection too (its token stays in .env). */
export interface ConnPrefs { name?: string; color?: string; workspace?: string }

// The team palette. Fixed and small on purpose: a colour has to be told apart
// at arm's length on a 7" screen, and the one it must never be confused with
// is the corner's own green — so green is not in it.
export const TEAM_PALETTE = ['#3b82f6', '#f59e0b', '#ec4899', '#a855f7', '#14b8a6', '#f97316', '#ef4444', '#eab308']

const CONNS_FILE = 'notion-connections.json'
const MAP_FILE   = 'notion-resource-conns.json'
/** The env token's fixed connection id, so "me" and the resource memory can refer to it. */
export const ENV_CONN_ID = 'env'

function cacheDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

interface StoredFile { connections: StoredConn[]; prefs: Record<string, ConnPrefs> }

function readFile(): StoredFile {
  const p = path.join(cacheDir(), CONNS_FILE)
  try {
    if (!fs.existsSync(p)) return { connections: [], prefs: {} }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { connections?: unknown; prefs?: unknown }
    const connections = Array.isArray(parsed.connections)
      ? parsed.connections
        .filter((c): c is StoredConn => !!c && typeof c === 'object' && typeof (c as StoredConn).id === 'string' && typeof (c as StoredConn).token === 'string')
        .map(c => ({ id: c.id, name: String(c.name ?? ''), token: c.token, workspace: String(c.workspace ?? ''), addedAt: String(c.addedAt ?? '') }))
      : []
    const prefs: Record<string, ConnPrefs> = {}
    if (parsed.prefs && typeof parsed.prefs === 'object') {
      for (const [k, v] of Object.entries(parsed.prefs as Record<string, Partial<ConnPrefs>>)) {
        if (!v || typeof v !== 'object') continue
        const out: ConnPrefs = {}
        if (typeof v.name === 'string' && v.name.trim()) out.name = v.name.trim()
        if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) out.color = v.color.toLowerCase()
        if (typeof v.workspace === 'string' && v.workspace.trim()) out.workspace = v.workspace.trim()
        prefs[k] = out
      }
    }
    return { connections, prefs }
  } catch (err) {
    console.error('[notion] failed to read the connections store:', err)
    return { connections: [], prefs: {} }
  }
}

function readStored(): StoredConn[] {
  return readFile().connections
}

function readPrefs(): Record<string, ConnPrefs> {
  return readFile().prefs
}

function writeStored(list: StoredConn[], prefs: Record<string, ConnPrefs> = readPrefs()): void {
  const p = path.join(cacheDir(), CONNS_FILE)
  const tmp = `${p}.tmp-${process.pid}`
  try {
    // 0600: the file holds tokens that can read and edit whole workspaces.
    fs.writeFileSync(tmp, JSON.stringify({ connections: list, prefs }, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, 0o600) } catch { /* not every filesystem cares */ }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[notion] failed to write the connections store:', err)
    throw err
  }
}

/** Every connection, env first. Tokens included — for the server's own use only. */
export function listConnections(): NotionConn[] {
  const { connections, prefs } = readFile()
  const out: NotionConn[] = []
  const env = (process.env['NOTION_API_KEY'] ?? '').trim()
  if (env) {
    const p = prefs[ENV_CONN_ID] ?? {}
    // The env connection is named after its workspace once that is known
    // (connectionsView learns it from /users/me and keeps it here), because
    // "From .env" is no name for a team on a chip.
    out.push({ id: ENV_CONN_ID, name: p.name || p.workspace || 'From .env', token: env, source: 'env', workspace: p.workspace ?? '', addedAt: '', color: '' })
  }
  for (const c of connections) {
    const p = prefs[c.id] ?? {}
    out.push({ ...c, name: p.name || c.name, source: 'added', color: p.color ?? '' })
  }
  // A colour each: the chosen one, else the next of the palette in list
  // order, skipping colours already chosen so two teams never share one by
  // default.
  const taken = new Set(out.map(c => c.color).filter(Boolean))
  let i = 0
  for (const c of out) {
    if (c.color) continue
    while (i < TEAM_PALETTE.length && taken.has(TEAM_PALETTE[i]!)) i++
    c.color = TEAM_PALETTE[i % TEAM_PALETTE.length]!
    taken.add(c.color)
    i++
  }
  return out
}

/** Set a connection's display name, colour or learned workspace name. Works for the env connection too. */
export function setConnPrefs(id: string, patch: ConnPrefs): boolean {
  const file = readFile()
  if (id !== ENV_CONN_ID && !file.connections.some(c => c.id === id)) return false
  const cur = file.prefs[id] ?? {}
  if (patch.name !== undefined)      { if (patch.name.trim()) cur.name = patch.name.trim(); else delete cur.name }
  if (patch.color !== undefined)     { if (/^#[0-9a-f]{6}$/i.test(patch.color)) cur.color = patch.color.toLowerCase(); else delete cur.color }
  if (patch.workspace !== undefined) { if (patch.workspace.trim()) cur.workspace = patch.workspace.trim(); else delete cur.workspace }
  file.prefs[id] = cur
  writeStored(file.connections, file.prefs)
  return true
}

export function connById(id: string): NotionConn | undefined {
  return listConnections().find(c => c.id === id)
}

export function headersFor(conn: NotionConn): Record<string, string> {
  return {
    Authorization:    `Bearer ${conn.token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

/** Add a connection whose token has already been proven against Notion. Returns it. */
export function addConnection(input: { name: string; token: string; workspace: string }): NotionConn {
  const list = readStored()
  // The same token twice would be the same workspace listed twice, and every
  // search would come back doubled.
  const dup = list.find(c => c.token === input.token)
  if (dup) return connById(dup.id)!
  const c: StoredConn = {
    id: randomUUID(), name: input.name.trim() || input.workspace || 'Workspace',
    token: input.token, workspace: input.workspace, addedAt: new Date().toISOString(),
  }
  list.push(c)
  writeStored(list)
  console.log(`[notion] connection added: "${c.name}" (${c.workspace || 'workspace unnamed'}, token …${c.token.slice(-4)})`)
  return connById(c.id)!
}

export function renameConnection(id: string, name: string): boolean {
  return setConnPrefs(id, { name })
}

/** Remove an added connection (the env one cannot be removed from here) and forget what it could see. */
export function removeConnection(id: string): boolean {
  const list = readStored()
  const next = list.filter(c => c.id !== id)
  if (next.length === list.length) return false
  const prefs = readPrefs()
  delete prefs[id]
  writeStored(next, prefs)
  forgetConnection(id)
  console.log(`[notion] connection removed: ${id}`)
  return true
}

// ── Which connection can see which id ────────────────────────────────────────

const MAX_MAP = 5000
let map: Map<string, string> | null = null
let saveTimer: NodeJS.Timeout | null = null

function loadMap(): Map<string, string> {
  if (map) return map
  map = new Map()
  const p = path.join(cacheDir(), MAP_FILE)
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') map.set(k, v)
    }
  } catch (err) {
    console.error('[notion] failed to read the resource map:', err)
  }
  return map
}

function saveMapSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const m = loadMap()
    const p = path.join(cacheDir(), MAP_FILE)
    const tmp = `${p}.tmp-${process.pid}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), 'utf8')
      fs.renameSync(tmp, p)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* nothing */ }
      console.error('[notion] failed to write the resource map:', err)
    }
  }, 2000)
}

const norm = (id: string) => id.trim().toLowerCase()

/** Record that `id` (a page, database or block) was seen through `connId`. */
export function remember(id: string, connId: string): void {
  if (!id) return
  const m = loadMap()
  const k = norm(id)
  if (m.get(k) === connId) return
  // Re-insert so the entry moves to the end: the map is trimmed from the
  // front, so what was used recently survives.
  m.delete(k)
  m.set(k, connId)
  while (m.size > MAX_MAP) { const first = m.keys().next().value; if (first === undefined) break; m.delete(first) }
  saveMapSoon()
}

export function rememberMany(ids: Iterable<string>, connId: string): void {
  for (const id of ids) remember(id, connId)
}

export function connIdFor(id: string): string | undefined {
  return loadMap().get(norm(id))
}

/** Drop everything remembered for one connection — after it is removed. */
export function forgetConnection(connId: string): void {
  const m = loadMap()
  for (const [k, v] of m) if (v === connId) m.delete(k)
  saveMapSoon()
}
