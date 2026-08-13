// Game guides — one researched, checkable walkthrough per media-list game.
//
// A guide is organized the way that game's community organizes it (a section
// per dungeon for Majora's Mask, plus masks / items / side quests), every step
// is a checkbox, and each section carries a YouTube walkthrough link for when
// the user would rather watch than read. The generator that fills one in lives
// in guide-generator.ts; this file is only the store.
//
// Kept in its OWN file, keyed by MediaItem.id, deliberately NOT inside
// media.json: that list has two non-atomic writers (routes/state.ts and
// routes/dashboard-tools.ts) and a field-whitelisting normalizer that has
// already silently destroyed a column once (see the warning above `normalize`
// in dashboard-tools.ts). A guide is also an order of magnitude bigger than a
// list row, so folding it in would rewrite the whole playlist on every ticked
// checkbox.

import fs from 'fs'
import path from 'path'

const FILE = 'guides.json'

// Caps. A guide is model-generated, so every array it produces is bounded here
// rather than trusted — one runaway generation should not be able to fill the
// Pi's disk or freeze the kiosk trying to render 4000 checkboxes.
const MAX_GUIDES            = 40
const MAX_SECTIONS          = 16
const MAX_STEPS_PER_SECTION = 60
const MAX_TITLE_CHARS       = 120
const MAX_STEP_CHARS        = 300
const MAX_NOTE_CHARS        = 400
const MAX_SUMMARY_CHARS     = 400
const MAX_SOURCES           = 12

export type GuideStatus  = 'generating' | 'ready' | 'failed'
/** What a section is for. `reference` sections (item tables, controls) never move the 100% bar. */
export type SectionKind  = 'progression' | 'collectible' | 'sidequest' | 'reference'
export type SectionState = 'pending' | 'ready' | 'failed'

export const SECTION_KINDS: readonly SectionKind[] = ['progression', 'collectible', 'sidequest', 'reference']

export interface GuideStep {
  id:      string
  text:    string
  note?:   string
  done:    boolean
  doneAt?: string
}

export interface GuideVideo {
  videoId:  string
  title:    string
  channel?: string
}

export interface GuideSection {
  id:       string
  title:    string
  kind:     SectionKind
  /** Whether this section's steps feed the overall 100% bar. */
  counts:   boolean
  summary?: string
  video?:   GuideVideo
  source?:  { url: string; site: string }
  state:    SectionState
  steps:    GuideStep[]
}

export interface Guide {
  itemId:         string
  title:          string
  /** One line on how the community orders this game, shown under the title. */
  organization:   string
  /** Set when the user asked for a different order than the community default. */
  orderOverride?: string
  status:         GuideStatus
  error?:         string
  createdAt:      string
  updatedAt:      string
  /** Human-readable generation phase, e.g. "Woodfall Temple (3/7)". */
  phase?:         string
  /** Overall 100% walkthrough for the whole game. */
  video?:         GuideVideo
  sections:       GuideSection[]
  sources:        Array<{ url: string; site: string; title: string }>
}

/** Counts behind the bars: `counted` drives the 100% bar, `all` is every checkbox. */
export interface GuideProgress {
  counted: { done: number; total: number }
  all:     { done: number; total: number }
  percent: number
}

/** The light row the media list needs — never the whole document. */
export interface GuideSummary {
  itemId:   string
  title:    string
  status:   GuideStatus
  phase?:   string
  percent:  number
  counted:  { done: number; total: number }
  sections: number
}

type Store = Record<string, Guide>

// ── Disk ─────────────────────────────────────────────────────────────────────

function dir(): string {
  const d = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

function pathFor(): string { return path.join(dir(), FILE) }

function read(): Store {
  const p = pathFor()
  try {
    if (!fs.existsSync(p)) return {}
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [id, g] of Object.entries(parsed as Record<string, unknown>)) {
      const guide = normalize(id, g)
      if (guide) out[id] = guide
    }
    return out
  } catch (err) {
    // Same reasoning as memory.ts: starting fresh in place would let the next
    // write erase hours of ticked-off progress, announced by one console line.
    // Move the damaged file aside so it can be recovered by hand.
    const aside = `${p}.corrupt-${Date.now()}`
    try { fs.renameSync(p, aside); console.error(`[guides] unreadable store moved to ${aside}:`, err) }
    catch { console.error('[guides] store is unreadable and could not be moved aside:', err) }
    return {}
  }
}

function write(store: Store): void {
  const p = pathFor()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    // Write-then-rename: a partial write would be quarantined on the next read,
    // costing every guide. rename is atomic on POSIX and replaces on Windows.
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[guides] write failed:', err)
    throw err
  }
}

// ── Normalization ────────────────────────────────────────────────────────────
// Everything in a guide originates from a language model, so the store validates
// on the way in AND on the way out — a hand-edited or half-generated file should
// degrade to a usable guide, never crash the route that serves it.

const str = (v: unknown, cap: number): string =>
  typeof v === 'string' ? v.trim().slice(0, cap) : ''

function normalizeVideo(v: unknown): GuideVideo | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const videoId = str(o['videoId'], 20)
  if (!/^[\w-]{11}$/.test(videoId)) return undefined
  const channel = str(o['channel'], 80)
  return {
    videoId,
    title: str(o['title'], MAX_TITLE_CHARS) || 'YouTube video',
    ...(channel ? { channel } : {}),
  }
}

function normalizeStep(v: unknown, idx: number): GuideStep | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = str(o['text'], MAX_STEP_CHARS)
  if (!text) return null
  const note   = str(o['note'], MAX_NOTE_CHARS)
  const doneAt = str(o['doneAt'], 40)
  const done   = o['done'] === true
  return {
    id: str(o['id'], 40) || `s${idx}`,
    text,
    ...(note ? { note } : {}),
    done,
    ...(done && doneAt ? { doneAt } : {}),
  }
}

function normalizeSection(v: unknown, idx: number): GuideSection | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const title = str(o['title'], MAX_TITLE_CHARS)
  if (!title) return null
  const kindRaw = str(o['kind'], 20) as SectionKind
  const kind: SectionKind = SECTION_KINDS.includes(kindRaw) ? kindRaw : 'progression'
  const stateRaw = str(o['state'], 20)
  const state: SectionState =
    stateRaw === 'ready' || stateRaw === 'failed' || stateRaw === 'pending' ? stateRaw : 'pending'
  const summary = str(o['summary'], MAX_SUMMARY_CHARS)
  const video   = normalizeVideo(o['video'])
  const srcRaw  = o['source'] as Record<string, unknown> | undefined
  const srcUrl  = str(srcRaw?.['url'], 500)
  const steps = (Array.isArray(o['steps']) ? o['steps'] : [])
    .slice(0, MAX_STEPS_PER_SECTION)
    .map((s, i) => normalizeStep(s, i))
    .filter((s): s is GuideStep => s !== null)
  return {
    id: str(o['id'], 40) || `sec${idx}`,
    title,
    kind,
    // Reference material is never part of a completion percentage; anything else
    // counts unless the generator said otherwise.
    counts: typeof o['counts'] === 'boolean' ? (o['counts'] as boolean) : kind !== 'reference',
    ...(summary ? { summary } : {}),
    ...(video ? { video } : {}),
    ...(srcUrl ? { source: { url: srcUrl, site: str(srcRaw?.['site'], 120) } } : {}),
    state,
    steps,
  }
}

function normalize(itemId: string, v: unknown): Guide | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const statusRaw = str(o['status'], 20)
  const status: GuideStatus =
    statusRaw === 'ready' || statusRaw === 'failed' || statusRaw === 'generating' ? statusRaw : 'ready'
  const now = new Date().toISOString()
  const order = str(o['orderOverride'], 200)
  const phase = str(o['phase'], 120)
  const error = str(o['error'], 400)
  const video = normalizeVideo(o['video'])
  const sections = (Array.isArray(o['sections']) ? o['sections'] : [])
    .slice(0, MAX_SECTIONS)
    .map((s, i) => normalizeSection(s, i))
    .filter((s): s is GuideSection => s !== null)
  const sources = (Array.isArray(o['sources']) ? o['sources'] : [])
    .slice(0, MAX_SOURCES)
    .map(s => {
      const so = (s ?? {}) as Record<string, unknown>
      return { url: str(so['url'], 500), site: str(so['site'], 120), title: str(so['title'], MAX_TITLE_CHARS) }
    })
    .filter(s => s.url.length > 0)
  return {
    itemId,
    title:        str(o['title'], MAX_TITLE_CHARS),
    organization: str(o['organization'], MAX_SUMMARY_CHARS),
    ...(order ? { orderOverride: order } : {}),
    status,
    ...(error ? { error } : {}),
    createdAt: str(o['createdAt'], 40) || now,
    updatedAt: str(o['updatedAt'], 40) || now,
    ...(phase ? { phase } : {}),
    ...(video ? { video } : {}),
    sections,
    sources,
  }
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * The numbers behind both bars. `counted` is the community "100%" definition —
 * only sections the generator marked as counting toward completion — while
 * `all` covers every checkbox including reference material.
 */
export function guideProgress(g: Guide): GuideProgress {
  let cDone = 0, cTotal = 0, aDone = 0, aTotal = 0
  for (const sec of g.sections) {
    for (const step of sec.steps) {
      aTotal++
      if (step.done) aDone++
      if (sec.counts) {
        cTotal++
        if (step.done) cDone++
      }
    }
  }
  return {
    counted: { done: cDone, total: cTotal },
    all:     { done: aDone, total: aTotal },
    percent: cTotal > 0 ? Math.round((cDone / cTotal) * 100) : 0,
  }
}

export function summarize(g: Guide): GuideSummary {
  const p = guideProgress(g)
  return {
    itemId:   g.itemId,
    title:    g.title,
    status:   g.status,
    ...(g.phase ? { phase: g.phase } : {}),
    percent:  p.percent,
    counted:  p.counted,
    sections: g.sections.length,
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function loadGuide(itemId: string): Guide | null {
  return read()[itemId] ?? null
}

export function listGuides(): GuideSummary[] {
  return Object.values(read()).map(summarize)
}

export function saveGuide(g: Guide): Guide {
  const store = read()
  const normalized = normalize(g.itemId, { ...g, updatedAt: new Date().toISOString() })
  if (!normalized) throw new Error('refusing to save an unusable guide')
  store[g.itemId] = normalized

  // Evict the oldest guides once over the cap, but never one that's mid-flight —
  // a generation whose file vanished under it would write a ghost back on its
  // next section and leave a guide nothing points at.
  const ids = Object.keys(store)
  if (ids.length > MAX_GUIDES) {
    const evictable = ids
      .filter(id => id !== g.itemId && store[id]?.status !== 'generating')
      .sort((a, b) => (store[a]?.updatedAt ?? '').localeCompare(store[b]?.updatedAt ?? ''))
    for (const id of evictable.slice(0, ids.length - MAX_GUIDES)) {
      console.log(`[guides] evicting oldest guide "${store[id]?.title}" (cap ${MAX_GUIDES})`)
      delete store[id]
    }
  }
  write(store)
  return normalized
}

/**
 * Read-modify-write one guide under a callback. The generator uses this for
 * every save instead of holding an in-memory copy: a section can take a minute
 * to research, and the user may well be ticking boxes in an earlier section
 * while it does — writing back a stale whole-document snapshot would silently
 * un-tick them.
 */
export function patchGuide(itemId: string, mutate: (g: Guide) => void): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  mutate(guide)
  guide.updatedAt = new Date().toISOString()
  const normalized = normalize(itemId, guide)
  if (!normalized) return null
  store[itemId] = normalized
  write(store)
  return normalized
}

export function deleteGuide(itemId: string): boolean {
  const store = read()
  if (!store[itemId]) return false
  console.log(`[guides] deleted guide for item ${itemId}`)
  delete store[itemId]
  write(store)
  return true
}

/**
 * Tick or untick one step. Returns the updated guide, or null when the guide,
 * section, or step doesn't exist — the caller turns that into a 404 rather than
 * silently reporting success on a stale id.
 */
export function setStepDone(
  itemId: string,
  sectionId: string,
  stepId: string,
  done: boolean,
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const section = guide.sections.find(s => s.id === sectionId)
  if (!section) return null
  const step = section.steps.find(s => s.id === stepId)
  if (!step) return null

  step.done = done
  if (done) step.doneAt = new Date().toISOString()
  else delete step.doneAt

  guide.updatedAt = new Date().toISOString()
  write(store)
  const p = guideProgress(guide)
  console.log(`[guides] ${guide.title}: "${step.text.slice(0, 40)}" → ${done ? 'done' : 'not done'} (${p.percent}%)`)
  return guide
}

/**
 * Drop guides whose media item is gone. Guides are keyed by item id and the
 * playlist is edited from three places (touch UI, voice tools, Settings), so a
 * periodic sweep is cheaper than trusting every delete path to remember.
 */
export function pruneOrphans(validItemIds: Iterable<string>): number {
  const valid = new Set(validItemIds)
  const store = read()
  let dropped = 0
  for (const id of Object.keys(store)) {
    if (!valid.has(id)) { delete store[id]; dropped++ }
  }
  if (dropped > 0) {
    console.log(`[guides] pruned ${dropped} orphaned guide(s)`)
    write(store)
  }
  return dropped
}

/**
 * Called once at startup. Generation is in-memory and fire-and-forget, so a
 * container restart mid-job would otherwise leave a guide stuck on "generating"
 * forever — a spinner with nothing behind it. Fail it loudly instead, so the
 * view can offer Retry.
 */
export function sweepInterrupted(): void {
  const store = read()
  let touched = 0
  for (const g of Object.values(store)) {
    if (g.status !== 'generating') continue
    g.status = 'failed'
    g.error = 'Generation was interrupted by a restart — tap retry.'
    delete g.phase
    g.updatedAt = new Date().toISOString()
    touched++
  }
  if (touched > 0) {
    console.log(`[guides] ${touched} guide(s) were mid-generation at shutdown — marked failed`)
    write(store)
  }
}

export const GUIDE_CAPS = {
  MAX_SECTIONS,
  MAX_STEPS_PER_SECTION,
  MAX_STEP_CHARS,
  MAX_SOURCES,
} as const
