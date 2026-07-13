import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ASSISTANT_PROFILES, DEFAULT_ASSISTANT_ID, type AssistantId } from '../config/assistant'
import { autoCover, cacheCover, findCover } from './artwork'

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
  // Filename of a poster cached under $CACHE_DIR/covers, served by
  // GET /api/artwork/cover/:file. Absent when no artwork was found — the
  // client falls back to a gradient tile generated from the title.
  cover?: string
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
    ...(raw.cover ? { cover: raw.cover } : {}),
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

// ── Assistant profile ─────────────────────────────────────────────────────────
// Which assistant (name + personality + voice) is active. The id is the single
// piece of state; the profile tables live in config/assistant.ts (server) and
// client/src/config/assistant.ts (client).
// GET /api/state/assistant → { id }
router.get('/assistant', (_req: Request, res: Response) => {
  const stored = readJSON<{ id?: string }>('assistant.json', { id: DEFAULT_ASSISTANT_ID })
  const id = stored.id && stored.id in ASSISTANT_PROFILES ? stored.id : DEFAULT_ASSISTANT_ID
  console.log(`[state] GET assistant → ${id}`)
  res.json({ id })
})

// POST /api/state/assistant  { id: AssistantId }
router.post('/assistant', (req: Request, res: Response) => {
  const { id } = req.body as { id?: string }
  if (!id || !(id in ASSISTANT_PROFILES)) {
    console.warn(`[state] POST assistant — invalid id: ${JSON.stringify(id)}`)
    res.status(400).json({ error: `id must be one of ${Object.keys(ASSISTANT_PROFILES).join(' | ')}` })
    return
  }
  console.log(`[state] POST assistant → ${id}`)
  try {
    writeJSON('assistant.json', { id: id as AssistantId })
    res.json({ id })
  } catch {
    res.status(500).json({ error: 'Failed to persist assistant' })
  }
})

// ── Avatar framing ────────────────────────────────────────────────────────────
// How each avatar model sits in frame: zoom + vertical position. Keyed by MODEL
// id (not assistant) because it describes the model — two assistants wearing the
// same face want the same framing.
//
// Persisted server-side rather than in localStorage so the framing you dial in
// on a laptop is the framing the Pi kiosk uses. Same reasoning as the assistant
// selection: the server is the source of truth across devices.
//
// Values are clamped to the same ranges the client's sliders use — a bad write
// (or a hand-edited file) shouldn't be able to push the avatar off screen.
interface Framing { zoom: number; offsetY: number }
const FRAMING_FILE = 'avatar-framing.json'
const ZOOM_MIN = 0.6
const ZOOM_MAX = 3.5
const OFFSET_MIN = -1
const OFFSET_MAX = 1

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// GET /api/state/avatar-framing → { [modelId]: { zoom, offsetY } }
router.get('/avatar-framing', (_req: Request, res: Response) => {
  const all = readJSON<Record<string, Framing>>(FRAMING_FILE, {})
  res.json(all)
})

// POST /api/state/avatar-framing  { modelId, zoom, offsetY }
router.post('/avatar-framing', (req: Request, res: Response) => {
  const { modelId, zoom, offsetY } = req.body as Partial<Framing> & { modelId?: string }

  // Model ids come from the client's catalogue, which the server has no copy of,
  // so validate the shape rather than a whitelist: a short slug, nothing exotic.
  if (!modelId || typeof modelId !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(modelId)) {
    res.status(400).json({ error: 'modelId must be a short alphanumeric id' })
    return
  }
  if (!Number.isFinite(zoom) || !Number.isFinite(offsetY)) {
    res.status(400).json({ error: 'zoom and offsetY must be numbers' })
    return
  }

  const entry: Framing = {
    zoom:    clamp(zoom as number,    ZOOM_MIN,   ZOOM_MAX),
    offsetY: clamp(offsetY as number, OFFSET_MIN, OFFSET_MAX),
  }

  try {
    const all = readJSON<Record<string, Framing>>(FRAMING_FILE, {})
    all[modelId] = entry
    writeJSON(FRAMING_FILE, all)
    console.log(`[state] POST avatar-framing ${modelId} → zoom=${entry.zoom} offsetY=${entry.offsetY}`)
    res.json({ modelId, ...entry })
  } catch {
    res.status(500).json({ error: 'Failed to persist avatar framing' })
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
// The poster lookup is awaited so the item comes back with its cover already
// pinned to disk — one add is a deliberate tap, and a second of latency beats
// a tile that pops in later. A failed or unconfigured lookup just yields no
// cover; it never blocks the add.
router.post('/media', async (req: Request, res: Response) => {
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
  const cover = await autoCover(item.type, item.title)
  if (cover) item.cover = cover
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

// POST /api/state/media/backfill-covers
// One-shot pass over items added before artwork existed (or whose lookup failed
// while offline). Serialized with a small delay — IGDB allows only 4 req/s.
router.post('/media/backfill-covers', async (_req: Request, res: Response) => {
  const items = readMediaList()
  const missing = items.filter(i => !i.cover)
  console.log(`[state] backfill-covers — ${missing.length} of ${items.length} item(s) without a cover`)

  let found = 0
  for (const item of missing) {
    const cover = await autoCover(item.type, item.title)
    if (cover) {
      item.cover = cover
      found++
    }
    await new Promise(r => setTimeout(r, 300))
  }

  try {
    saveMediaList(items)
    console.log(`[state] backfill-covers — resolved ${found}/${missing.length}`)
    res.json({ scanned: missing.length, found, items })
  } catch {
    res.status(500).json({ error: 'Failed to persist media list' })
  }
})

// PATCH /api/state/media/:id
//   no body                                 → toggle done (back-compat)
//   { done?, starred?, status?, coverUrl? } → set explicit values
// coverUrl is a remote poster picked in the cover sheet; it's downloaded into
// the cache volume here and stored as a filename.
router.patch('/media/:id', async (req: Request, res: Response) => {
  const { id } = req.params
  const items = readMediaList()
  const idx = items.findIndex(i => i.id === id)
  if (idx === -1) {
    console.warn(`[state] PATCH media/${id} — not found`)
    res.status(404).json({ error: 'Item not found' })
    return
  }
  const body = (req.body ?? {}) as {
    done?: boolean; starred?: boolean; status?: MediaStatus; coverUrl?: string; title?: string
  }
  const hasField =
    typeof body.done     === 'boolean' ||
    typeof body.starred  === 'boolean' ||
    typeof body.status   === 'string'  ||
    typeof body.coverUrl === 'string'  ||
    typeof body.title    === 'string'
  const next = { ...items[idx] }

  // Rename. A title is usually corrected *because* the artwork lookup failed on
  // the misspelling, so re-run it. A failed re-lookup leaves the existing cover
  // alone rather than blanking a poster the user may have picked by hand.
  if (typeof body.title === 'string') {
    const title = body.title.trim()
    if (!title) {
      res.status(400).json({ error: 'title cannot be empty' })
      return
    }
    if (title !== next.title) {
      next.title = title
      const { cover } = await findCover(next.type, title)
      if (cover) next.cover = cover
    }
  }

  if (typeof body.coverUrl === 'string') {
    const cover = await cacheCover(body.coverUrl)
    if (!cover) {
      res.status(502).json({ error: 'Failed to fetch cover image' })
      return
    }
    next.cover = cover
  }
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
