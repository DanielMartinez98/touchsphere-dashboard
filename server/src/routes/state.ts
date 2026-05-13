import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const router = Router()

// ── Helpers ───────────────────────────────────────────────────────────────────
function stateDir(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[state] created state directory: ${dir}`)
  }
  return dir
}

function statePath(file: string): string {
  return path.join(stateDir(), file)
}

function readJSON<T>(file: string, fallback: T): T {
  const p = statePath(file)
  try {
    if (!fs.existsSync(p)) {
      console.log(`[state] ${file} not found — using default`)
      return fallback
    }
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as T
    console.log(`[state] read ${file} OK`)
    return parsed
  } catch (err) {
    console.error(`[state] failed to read ${file}:`, err)
    return fallback
  }
}

function writeJSON(file: string, data: unknown): void {
  const p = statePath(file)
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
    console.log(`[state] wrote ${file}`)
  } catch (err) {
    console.error(`[state] failed to write ${file}:`, err)
    throw err
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type AppMode = 'work' | 'rest' | 'locked'

interface Credential {
  hash: string
  salt: string
}

type MediaType   = 'game' | 'show' | 'movie'
type MediaStatus = 'not_started' | 'in_progress' | 'done' | 'dropped'

const STATUSES: readonly MediaStatus[] = ['not_started', 'in_progress', 'done', 'dropped']
const MOVIE_STATUSES: readonly MediaStatus[] = ['not_started', 'done']

function isStatusAllowed(type: MediaType, status: MediaStatus): boolean {
  return type === 'movie' ? MOVIE_STATUSES.includes(status) : STATUSES.includes(status)
}

interface MediaItem {
  id: string
  title: string
  type: MediaType
  done: boolean
  status: MediaStatus
  starred?: boolean
}

// Normalize a raw item (possibly written before `status` existed) so callers
// can rely on status being present and matching `done`.
function normalizeMediaItem(raw: Partial<MediaItem> & { type: MediaType }): MediaItem {
  const done = raw.done === true
  let status = raw.status
  if (!status || !STATUSES.includes(status)) {
    status = done ? 'done' : 'not_started'
  }
  return {
    id:      raw.id ?? crypto.randomUUID(),
    title:   raw.title ?? '',
    type:    raw.type,
    done:    status === 'done',
    status,
    ...(raw.starred ? { starred: true } : {}),
  }
}

// ── App Mode ─────────────────────────────────────────────────────────────────
// GET /api/state/mode
router.get('/mode', (_req: Request, res: Response) => {
  const mode = readJSON<{ mode: AppMode }>('mode.json', { mode: 'work' })
  console.log(`[state] GET mode → ${mode.mode}`)
  res.json(mode)
})

// POST /api/state/mode  { mode: 'work' | 'rest' | 'locked' }
router.post('/mode', (req: Request, res: Response) => {
  const { mode } = req.body as { mode?: string }
  if (!mode || !['work', 'rest', 'locked'].includes(mode)) {
    console.warn(`[state] POST mode — invalid value: ${JSON.stringify(mode)}`)
    res.status(400).json({ error: 'mode must be work | rest | locked' })
    return
  }
  console.log(`[state] POST mode → ${mode}`)
  try {
    writeJSON('mode.json', { mode })
    res.json({ mode })
  } catch {
    res.status(500).json({ error: 'Failed to persist mode' })
  }
})

// ── Lock Credential ───────────────────────────────────────────────────────────
// GET /api/state/cred  — check if a credential exists
router.get('/cred', (_req: Request, res: Response) => {
  const cred = readJSON<Credential | null>('cred.json', null)
  const exists = cred !== null && typeof cred.hash === 'string'
  console.log(`[state] GET cred — exists: ${exists}`)
  res.json({ exists })
})

// POST /api/state/cred  — save { hash, salt } (hashing done client-side)
router.post('/cred', (req: Request, res: Response) => {
  const { hash, salt } = req.body as { hash?: string; salt?: string }
  if (!hash || !salt || typeof hash !== 'string' || typeof salt !== 'string') {
    console.warn('[state] POST cred — missing or invalid hash/salt')
    res.status(400).json({ error: 'hash and salt are required strings' })
    return
  }
  console.log('[state] POST cred — saving new credential')
  try {
    writeJSON('cred.json', { hash, salt })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to persist credential' })
  }
})

// POST /api/state/cred/verify  — { password } → { valid: boolean }
// The server re-derives the hash using the stored salt (matching client digest() algorithm).
// This way the salt is never exposed to the client and the plaintext stays on localhost.
router.post('/cred/verify', (req: Request, res: Response) => {
  const { password } = req.body as { password?: string }
  if (!password || typeof password !== 'string') {
    console.warn('[state] POST cred/verify — missing password')
    res.status(400).json({ error: 'password is required' })
    return
  }
  const cred = readJSON<Credential | null>('cred.json', null)
  if (!cred) {
    console.warn('[state] POST cred/verify — no credential stored')
    res.status(404).json({ error: 'No credential stored' })
    return
  }
  // Re-derive hash matching the client's digest():
  //   input = password + base64(salt)
  //   hash  = base64( SHA-256(input) )
  // cred.salt is already base64-encoded, so we use it directly as the salt portion.
  const input = password + cred.salt
  const hashBuf = crypto.createHash('sha256').update(input, 'utf8').digest()
  const computed = hashBuf.toString('base64')
  // Constant-time comparison to resist timing attacks
  const stored = Buffer.from(cred.hash)
  const provided = Buffer.from(computed)
  const valid = stored.length === provided.length &&
    crypto.timingSafeEqual(stored, provided)
  console.log(`[state] POST cred/verify — result: ${valid}`)
  res.json({ valid })
})

// ── Media List ────────────────────────────────────────────────────────────────
function readMediaList(): MediaItem[] {
  const raw = readJSON<Array<Partial<MediaItem> & { type: MediaType }>>('media.json', [])
  return raw.map(normalizeMediaItem)
}

function saveMediaList(items: MediaItem[]): void {
  writeJSON('media.json', items)
}

// GET /api/state/media
router.get('/media', (_req: Request, res: Response) => {
  const items = readMediaList()
  console.log(`[state] GET media — ${items.length} items`)
  res.json(items)
})

// POST /api/state/media  { title, type }
router.post('/media', (req: Request, res: Response) => {
  const { title, type } = req.body as { title?: string; type?: string }
  if (!title || typeof title !== 'string' || title.trim() === '') {
    console.warn('[state] POST media — missing title')
    res.status(400).json({ error: 'title is required' })
    return
  }
  if (!type || !['game', 'show', 'movie'].includes(type)) {
    console.warn(`[state] POST media — invalid type: ${JSON.stringify(type)}`)
    res.status(400).json({ error: 'type must be game | show | movie' })
    return
  }
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title: title.trim(),
    type: type as MediaType,
    done: false,
    status: 'not_started',
  }
  const items = readMediaList()
  items.push(item)
  try {
    saveMediaList(items)
    console.log(`[state] POST media — added "${item.title}" (${item.type}) id=${item.id} total=${items.length}`)
    res.status(201).json(item)
  } catch {
    res.status(500).json({ error: 'Failed to persist media list' })
  }
})

// PATCH /api/state/media/:id
//   no body                       → toggle done (back-compat)
//   { done?, starred?, status? }  → set explicit values
router.patch('/media/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const items = readMediaList()
  const idx = items.findIndex(i => i.id === id)
  if (idx === -1) {
    console.warn(`[state] PATCH media/${id} — not found`)
    res.status(404).json({ error: 'Item not found' })
    return
  }
  const body = (req.body ?? {}) as { done?: boolean; starred?: boolean; status?: MediaStatus }
  const hasField =
    typeof body.done    === 'boolean' ||
    typeof body.starred === 'boolean' ||
    typeof body.status  === 'string'
  const next = { ...items[idx] }
  if (!hasField) {
    next.status = next.status === 'done' ? 'not_started' : 'done'
    next.done   = next.status === 'done'
  } else {
    if (typeof body.starred === 'boolean') next.starred = body.starred
    if (typeof body.status === 'string') {
      if (!STATUSES.includes(body.status)) {
        res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` })
        return
      }
      if (!isStatusAllowed(next.type, body.status)) {
        res.status(400).json({ error: `status "${body.status}" is not allowed for ${next.type}s` })
        return
      }
      next.status = body.status
      next.done   = body.status === 'done'
    } else if (typeof body.done === 'boolean') {
      next.done   = body.done
      next.status = body.done ? 'done' : (next.status === 'done' ? 'not_started' : next.status)
    }
  }
  items[idx] = normalizeMediaItem(next)
  try {
    saveMediaList(items)
    console.log(`[state] PATCH media/${id} — done toggled to ${items[idx].done} ("${items[idx].title}")`)
    res.json(items[idx])
  } catch {
    res.status(500).json({ error: 'Failed to persist media list' })
  }
})

// DELETE /api/state/media/:id
router.delete('/media/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const items = readMediaList()
  const before = items.length
  const filtered = items.filter(i => i.id !== id)
  if (filtered.length === before) {
    console.warn(`[state] DELETE media/${id} — not found`)
    res.status(404).json({ error: 'Item not found' })
    return
  }
  try {
    saveMediaList(filtered)
    console.log(`[state] DELETE media/${id} — removed, remaining: ${filtered.length}`)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to persist media list' })
  }
})

// ── Notion Groups ─────────────────────────────────────────────────────────────
// User-defined collections of Notion pages/databases. Persisted server-side so
// the same groups appear across browser refreshes and device swaps. Layout is
// dense `order` integers per group and per item — the server rewrites them on
// reorder so the client can treat indices as authoritative.

interface NotionGroupItem {
  refId: string
  kind:  'page' | 'database'
  title: string
  icon:  string | null
  order: number
}

interface NotionGroup {
  id:        string
  name:      string
  icon:      string | null
  color:     string | null
  order:     number
  collapsed: boolean
  items:     NotionGroupItem[]
}

const GROUPS_FILE = 'notion-groups.json'

function readGroups(): NotionGroup[] {
  return readJSON<NotionGroup[]>(GROUPS_FILE, [])
}
function saveGroups(groups: NotionGroup[]): void {
  writeJSON(GROUPS_FILE, groups)
}

// Sort + re-number so callers can rely on `order` being 0..n-1.
function normalize(groups: NotionGroup[]): NotionGroup[] {
  groups.sort((a, b) => a.order - b.order)
  groups.forEach((g, i) => {
    g.order = i
    g.items.sort((a, b) => a.order - b.order)
    g.items.forEach((it, j) => { it.order = j })
  })
  return groups
}

// GET /api/state/notion-groups
router.get('/notion-groups', (_req: Request, res: Response) => {
  const groups = normalize(readGroups())
  console.log(`[state] GET notion-groups — ${groups.length} groups`)
  res.json(groups)
})

// POST /api/state/notion-groups  { name, icon?, color? }
router.post('/notion-groups', (req: Request, res: Response) => {
  const { name, icon, color } = req.body as { name?: string; icon?: string | null; color?: string | null }
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const groups = readGroups()
  const group: NotionGroup = {
    id:        crypto.randomUUID(),
    name:      name.trim(),
    icon:      icon ?? null,
    color:     color ?? null,
    order:     groups.length,
    collapsed: false,
    items:     [],
  }
  groups.push(group)
  try {
    saveGroups(normalize(groups))
    console.log(`[state] POST notion-groups — created "${group.name}" id=${group.id}`)
    res.status(201).json(group)
  } catch {
    res.status(500).json({ error: 'Failed to persist groups' })
  }
})

// PATCH /api/state/notion-groups/:id
//   any of: { name, icon, color, collapsed, order, itemOrder: string[] }
// itemOrder is a reordering of refIds within the group; missing refIds are appended.
router.patch('/notion-groups/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const patch = req.body as {
    name?: string; icon?: string | null; color?: string | null;
    collapsed?: boolean; order?: number; itemOrder?: string[]
  }
  const groups = readGroups()
  const g = groups.find(x => x.id === id)
  if (!g) { res.status(404).json({ error: 'Group not found' }); return }

  if (typeof patch.name      === 'string')  g.name      = patch.name.trim() || g.name
  if ('icon'      in patch)                  g.icon      = patch.icon ?? null
  if ('color'     in patch)                  g.color     = patch.color ?? null
  if (typeof patch.collapsed === 'boolean')  g.collapsed = patch.collapsed

  // Group reorder: move this group to position `order` and shift the rest.
  if (typeof patch.order === 'number') {
    const target = Math.max(0, Math.min(groups.length - 1, patch.order))
    const others = groups.filter(x => x.id !== id).sort((a, b) => a.order - b.order)
    others.splice(target, 0, g)
    others.forEach((x, i) => { x.order = i })
  }

  // Item reorder: apply the provided sequence; unknown ids are appended in their
  // existing relative order so we never lose items by mistake.
  if (Array.isArray(patch.itemOrder)) {
    const byId = new Map(g.items.map(it => [it.refId, it]))
    const ordered: NotionGroupItem[] = []
    for (const refId of patch.itemOrder) {
      const it = byId.get(refId)
      if (it) { ordered.push(it); byId.delete(refId) }
    }
    for (const leftover of byId.values()) ordered.push(leftover)
    g.items = ordered
  }

  try {
    saveGroups(normalize(groups))
    res.json(g)
  } catch {
    res.status(500).json({ error: 'Failed to persist groups' })
  }
})

// DELETE /api/state/notion-groups/:id
router.delete('/notion-groups/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const groups = readGroups()
  const filtered = groups.filter(g => g.id !== id)
  if (filtered.length === groups.length) {
    res.status(404).json({ error: 'Group not found' })
    return
  }
  try {
    saveGroups(normalize(filtered))
    console.log(`[state] DELETE notion-groups/${id}`)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to persist groups' })
  }
})

// POST /api/state/notion-groups/:id/items  { refId, kind, title, icon? }
router.post('/notion-groups/:id/items', (req: Request, res: Response) => {
  const { id } = req.params
  const { refId, kind, title, icon } = req.body as {
    refId?: string; kind?: string; title?: string; icon?: string | null
  }
  if (!refId || !kind || !title) {
    res.status(400).json({ error: 'refId, kind, title are required' })
    return
  }
  if (kind !== 'page' && kind !== 'database') {
    res.status(400).json({ error: 'kind must be page | database' })
    return
  }
  const groups = readGroups()
  const g = groups.find(x => x.id === id)
  if (!g) { res.status(404).json({ error: 'Group not found' }); return }

  // Skip duplicates — adding the same item again is a no-op success.
  if (!g.items.some(it => it.refId === refId)) {
    g.items.push({ refId, kind, title, icon: icon ?? null, order: g.items.length })
  }
  try {
    saveGroups(normalize(groups))
    console.log(`[state] POST notion-groups/${id}/items — "${title}"`)
    res.status(201).json(g)
  } catch {
    res.status(500).json({ error: 'Failed to persist groups' })
  }
})

// DELETE /api/state/notion-groups/:id/items/:refId
router.delete('/notion-groups/:id/items/:refId', (req: Request, res: Response) => {
  const { id, refId } = req.params
  const groups = readGroups()
  const g = groups.find(x => x.id === id)
  if (!g) { res.status(404).json({ error: 'Group not found' }); return }
  const before = g.items.length
  g.items = g.items.filter(it => it.refId !== refId)
  if (g.items.length === before) {
    res.status(404).json({ error: 'Item not found' })
    return
  }
  try {
    saveGroups(normalize(groups))
    console.log(`[state] DELETE notion-groups/${id}/items/${refId}`)
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to persist groups' })
  }
})

export default router
