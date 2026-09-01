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
import { note } from './guide-activity'
import { pruneGuideImages } from './guide-media'

const FILE = 'guides.json'

// Caps. A guide is model-generated, so every array it produces is bounded here
// rather than trusted — one runaway generation should not be able to fill the
// Pi's disk or freeze the kiosk trying to render 4000 checkboxes.
const MAX_GUIDES            = 40
const MAX_SECTIONS          = 16
// A full collectible list is the reason this is generous: Majora's Mask has 24
// masks and 52 heart pieces, and a list that stops short of the real count is
// worse than no list, because the bar then reads 100% on an unfinished game.
const MAX_STEPS_PER_SECTION = 80
const MAX_TITLE_CHARS       = 120
const MAX_STEP_CHARS        = 300
// The note is where "how do I actually get this" lives — for a collectible it
// carries the whole method, so it has room for a couple of sentences.
const MAX_NOTE_CHARS        = 700
/** Sub-chapter headings are a few words — "Getting there", "Boss: Odolwa". */
const MAX_GROUP_CHARS       = 80
const MAX_SUMMARY_CHARS     = 400
const MAX_SOURCES           = 12
/**
 * Sub-steps per step. Small on purpose: a step that breaks into nine things is
 * not a step, it is a sub-chapter that the step-list pass should have split.
 */
const MAX_SUBS_PER_STEP     = 8
const MAX_SUB_CHARS         = 200
/** Pins the user drops on a chapter's map. Their own, so generous but bounded. */
const MAX_PINS_PER_SECTION  = 60
const MAX_PIN_LABEL_CHARS   = 100

export type GuideStatus  = 'generating' | 'ready' | 'failed'
/** What a section is for. `reference` sections (item tables, controls) never move the 100% bar. */
export type SectionKind  = 'progression' | 'collectible' | 'sidequest' | 'reference'
export type SectionState = 'pending' | 'ready' | 'failed'

export const SECTION_KINDS: readonly SectionKind[] = ['progression', 'collectible', 'sidequest', 'reference']

/**
 * A cached picture: a wiki screenshot, a piece of item art, or a map.
 *
 * The bytes live on the volume rather than being hotlinked, exactly as
 * routes/artwork.ts caches cover art and for the same two reasons: the kiosk has
 * to render offline, and a wiki CDN is not something to hammer on every scroll.
 * `file` is the cached name; `source` is kept for attribution and so a broken
 * cache can be refetched.
 */
export interface GuideImage {
  /** Cached filename on the volume. Serve via GET /api/guides/image/:file. */
  file:    string
  /** Absolute URL it was fetched from. */
  source:  string
  /** The wiki's own caption/filename, for the alt text and attribution line. */
  title?:  string
  width?:  number
  height?: number
}

/**
 * One concrete action inside a step.
 *
 * THIS IS A DEPARTURE from the flat-list rule below, and a deliberately narrow
 * one. The reasoning that forbade nesting was that `section.steps` is the spine
 * every other part of the system walks — the 1..n numbering the detail pass keys
 * notes to, both progress bars, tick-a-chapter, and carryTicks across a rewrite.
 * All of that is still true, and all of it still walks `section.steps` unchanged:
 * a sub-step lives strictly INSIDE one step, never renumbers it, and never
 * appears in the spine. So the property that mattered is preserved.
 *
 * Sub-steps are also NOT counted in progress — see guideProgress(). The step
 * stays the unit of completion, which is what keeps a guide written before this
 * existed at exactly the same percentage it was at yesterday.
 */
export interface GuideSubStep {
  id:      string
  text:    string
  done:    boolean
  doneAt?: string
}

export interface GuideStep {
  id:      string
  text:    string
  note?:   string
  /**
   * The concrete actions this step breaks into, each with its own checkbox.
   *
   * Ticking every sub ticks the step; ticking the step ticks every sub. That
   * cascade lives in setStepDone/setSubStepDone rather than being derived on
   * read, so the stored document is always self-consistent — a half-ticked step
   * with all its subs done would otherwise appear differently depending on which
   * code path rendered it.
   */
  subs?:   GuideSubStep[]
  /** A picture of the place or thing this step is about. */
  image?:  GuideImage
  /**
   * Seconds into the chapter's walkthrough video where this step happens, so a
   * step that is easier watched than read is one tap from the moment it shows.
   * Undefined when nothing located it — never guessed.
   */
  at?:     number
  /**
   * Where this step happens on the chapter's map, as a fraction of the image's
   * width and height (0..1), so it survives the image being served at any size.
   *
   * `approx` marks a pin the GENERATOR placed. The model never sees the map, so
   * the best it can do is name a compass position from the research notes, which
   * lands the pin in roughly the right ninth. The UI says so and lets the pin be
   * dragged; a pin the user has moved or dropped is exact and loses the flag.
   */
  pin?:    { x: number; y: number; approx?: boolean }
  /**
   * The sub-chapter this step belongs to ("Getting there", "Boss: Odolwa").
   * Consecutive steps sharing a group ARE that sub-chapter — there is no
   * separate nested array.
   *
   * A label rather than a tree because a chapter's steps are, and must stay, one
   * flat ordered list: the 1..n numbering the detail pass keys its notes to, the
   * counting behind both progress bars, tick-one-step, tick-a-whole-chapter and
   * carryTicks across a rewrite all walk `section.steps` and all of them are
   * verified working. Nesting would fork every one of those into a two-shape
   * traversal to gain nothing the UI can't derive by grouping consecutive runs —
   * which is how the chapter page draws its sub-chapter headings and per-part
   * counts. Steps with no group are simply an unlabelled run.
   */
  group?:  string
  done:    boolean
  doneAt?: string
}

export interface GuideVideo {
  videoId:  string
  title:    string
  channel?: string
}

/** A pin the user dropped themselves. Exact, labelled, and theirs to delete. */
export interface GuideMapPin {
  id:        string
  x:         number
  y:         number
  label:     string
  createdAt: string
}

/**
 * A chapter's map, and what is marked on it.
 *
 * Two populations of pin, kept apart on purpose. The generator's pins live on
 * the STEPS (`GuideStep.pin`), so a pin is always attached to the thing it
 * marks and tapping it can jump to that step — and so re-researching a chapter
 * replaces them along with the steps they belong to. The user's own pins live
 * here, because they are notes about the map itself ("bomb wall", "the shop
 * that buys these") and must survive a chapter being rewritten underneath them.
 */
export interface GuideMap {
  image: GuideImage
  pins:  GuideMapPin[]
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
  /** A picture of this place or subject, shown at the top of the chapter. */
  image?:   GuideImage
  /** The map for this chapter, when the wiki had one worth showing. */
  map?:     GuideMap
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
  /** Bare hostname the user asked the guide to be built from, e.g. "zeldadungeon.net". */
  sourceSite?:    string
  status:         GuideStatus
  error?:         string
  createdAt:      string
  updatedAt:      string
  /** Human-readable generation phase, e.g. "Woodfall Temple (3/7)". */
  phase?:         string
  /** Overall 100% walkthrough for the whole game. */
  video?:         GuideVideo
  /**
   * The whole-game map, used by any chapter that has no map of its own.
   *
   * Most chapters are places ON the world map rather than places WITH a map —
   * a collectible list spans the entire game — so without this fallback the map
   * tool would only ever appear for dungeons.
   */
  map?:           GuideMap
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

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** A cached image, or undefined. A record missing its file is not an image. */
function normalizeImage(v: unknown): GuideImage | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  // The filename is generated by guide-media.ts as a hash + extension. Anything
  // else in this field is either corruption or an attempt to walk out of the
  // cache directory, and the serving route would reject it anyway — refuse it
  // here too so a bad name can never even reach the client.
  const file = str(o['file'], 80)
  if (!/^[a-f0-9]{40}\.(png|jpe?g|webp|gif)$/i.test(file)) return undefined
  const title = str(o['title'], MAX_TITLE_CHARS)
  const w = num(o['width']), h = num(o['height'])
  return {
    file,
    source: str(o['source'], 500),
    ...(title ? { title } : {}),
    ...(w && w > 0 ? { width: Math.round(w) } : {}),
    ...(h && h > 0 ? { height: Math.round(h) } : {}),
  }
}

/** A 0..1 position, or null for anything outside the image. */
function normalizePoint(v: unknown): { x: number; y: number } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const x = num(o['x']), y = num(o['y'])
  if (x === null || y === null) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  // Three decimals is sub-pixel on any map this will ever show, and keeps the
  // stored document from filling with float noise on every drag.
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }
}

function normalizeSub(v: unknown, idx: number): GuideSubStep | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = str(o['text'], MAX_SUB_CHARS)
  if (!text) return null
  const done = o['done'] === true
  const doneAt = str(o['doneAt'], 40)
  return {
    id: str(o['id'], 40) || `u${idx}`,
    text,
    done,
    ...(done && doneAt ? { doneAt } : {}),
  }
}

function normalizeStep(v: unknown, idx: number): GuideStep | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = str(o['text'], MAX_STEP_CHARS)
  if (!text) return null
  const note   = str(o['note'], MAX_NOTE_CHARS)
  const group  = str(o['group'], MAX_GROUP_CHARS)
  const doneAt = str(o['doneAt'], 40)
  const subs = (Array.isArray(o['subs']) ? o['subs'] : [])
    .slice(0, MAX_SUBS_PER_STEP)
    .map((x, i) => normalizeSub(x, i))
    .filter((x): x is GuideSubStep => x !== null)
  // A step with exactly one sub-step is noise: it says the same thing twice and
  // gives the player two boxes for one action. Dropped rather than rendered.
  const keptSubs = subs.length >= 2 ? subs : []
  // The cascade, enforced on the way in as well as in the setters — a
  // hand-edited or half-written document should not be able to show a step
  // ticked with unticked children under it.
  const done = keptSubs.length > 0
    ? keptSubs.every(x => x.done)
    : o['done'] === true
  const image = normalizeImage(o['image'])
  const at = num(o['at'])
  const pinPt = normalizePoint(o['pin'])
  const pinApprox = (o['pin'] as Record<string, unknown> | null)?.['approx'] === true
  return {
    id: str(o['id'], 40) || `s${idx}`,
    text,
    ...(note ? { note } : {}),
    ...(group ? { group } : {}),
    ...(keptSubs.length > 0 ? { subs: keptSubs } : {}),
    ...(image ? { image } : {}),
    // A negative or absurd timestamp is a model slip, not a moment in a video.
    ...(at !== null && at >= 0 && at < 24 * 3600 ? { at: Math.round(at) } : {}),
    ...(pinPt ? { pin: { ...pinPt, ...(pinApprox ? { approx: true } : {}) } } : {}),
    done,
    ...(done && doneAt ? { doneAt } : {}),
  }
}

function normalizeMap(v: unknown): GuideMap | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const image = normalizeImage(o['image'])
  if (!image) return undefined      // a map is its picture; without one there is nothing to pin to
  const pins = (Array.isArray(o['pins']) ? o['pins'] : [])
    .slice(0, MAX_PINS_PER_SECTION)
    .map((raw, i) => {
      const po = (raw ?? {}) as Record<string, unknown>
      const pt = normalizePoint(po)
      if (!pt) return null
      return {
        id: str(po['id'], 40) || `p${i}`,
        ...pt,
        label: str(po['label'], MAX_PIN_LABEL_CHARS),
        createdAt: str(po['createdAt'], 40) || new Date().toISOString(),
      }
    })
    .filter((p): p is GuideMapPin => p !== null)
  return { image, pins }
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
  const map     = normalizeMap(o['map'])
  const secImage = normalizeImage(o['image'])
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
    ...(secImage ? { image: secImage } : {}),
    ...(map ? { map } : {}),
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
  const sourceSite = str(o['sourceSite'], 120)
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
    ...(sourceSite ? { sourceSite } : {}),
    status,
    ...(error ? { error } : {}),
    createdAt: str(o['createdAt'], 40) || now,
    updatedAt: str(o['updatedAt'], 40) || now,
    ...(phase ? { phase } : {}),
    ...(video ? { video } : {}),
    ...(normalizeMap(o['map']) ? { map: normalizeMap(o['map'])! } : {}),
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

  const now = new Date().toISOString()
  step.done = done
  if (done) step.doneAt = now
  else delete step.doneAt

  // Cascade down. Ticking a step means "I did this", and leaving its sub-steps
  // unticked underneath would reopen it the moment the document is re-normalized
  // (normalizeStep derives a step's done from its subs). Unticking clears them
  // for the same reason — otherwise a step you un-ticked to redo would snap
  // straight back to done.
  for (const sub of step.subs ?? []) {
    sub.done = done
    if (done) sub.doneAt = now
    else delete sub.doneAt
  }

  guide.updatedAt = now
  write(store)
  const p = guideProgress(guide)
  console.log(`[guides] ${guide.title}: "${step.text.slice(0, 40)}" → ${done ? 'done' : 'not done'} (${p.percent}%)`)
  return guide
}

/**
 * Tick or untick one sub-step, and reconcile the step above it.
 *
 * A step is not stored independently of its children: a step with sub-steps is
 * done exactly when all of them are. Deriving that on read instead would let one
 * document render two ways depending on which path drew it, so the parent is
 * settled here, at the one place a sub-step can change.
 */
export function setSubStepDone(
  itemId: string,
  sectionId: string,
  stepId: string,
  subId: string,
  done: boolean,
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const section = guide.sections.find(s => s.id === sectionId)
  if (!section) return null
  const step = section.steps.find(s => s.id === stepId)
  if (!step?.subs?.length) return null
  const sub = step.subs.find(x => x.id === subId)
  if (!sub) return null

  const now = new Date().toISOString()
  sub.done = done
  if (done) sub.doneAt = now
  else delete sub.doneAt

  // Up, not down: the last sub ticked completes the step, and unticking any one
  // of them reopens it. This is the whole reason sub-steps are worth having —
  // the step's own checkbox becomes something you earn rather than something you
  // have to remember to tick.
  const all = step.subs.every(x => x.done)
  step.done = all
  if (all) step.doneAt = now
  else delete step.doneAt

  guide.updatedAt = now
  write(store)
  const p = guideProgress(guide)
  console.log(
    `[guides] ${guide.title}: "${sub.text.slice(0, 30)}" -> ${done ? 'done' : 'not done'} ` +
    `(step "${step.text.slice(0, 30)}" ${step.done ? 'complete' : 'open'}, ${p.percent}%)`,
  )
  return guide
}

/**
 * Tick or untick one SUB-CHAPTER — the run of consecutive steps sharing a group
 * that starts at `fromIndex`.
 *
 * Addressed by starting index rather than by group name because a heading can
 * legitimately recur later in a chapter, and the client derives its parts from
 * runs for exactly that reason. Walking forward from the index while the group
 * matches reproduces the client's own grouping precisely, so what gets ticked is
 * always the part whose button was pressed.
 */
export function setPartDone(
  itemId: string,
  sectionId: string,
  fromIndex: number,
  done: boolean,
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const section = guide.sections.find(s => s.id === sectionId)
  if (!section) return null
  const first = section.steps[fromIndex]
  if (!first) return null

  const group = first.group ?? ''
  const now = new Date().toISOString()
  let changed = 0
  for (let i = fromIndex; i < section.steps.length; i++) {
    const step = section.steps[i]!
    if ((step.group ?? '') !== group) break
    if (step.done !== done) changed++
    step.done = done
    if (done) step.doneAt = now
    else delete step.doneAt
    for (const sub of step.subs ?? []) {
      sub.done = done
      if (done) sub.doneAt = now
      else delete sub.doneAt
    }
  }

  guide.updatedAt = now
  write(store)
  const p = guideProgress(guide)
  console.log(
    `[guides] ${guide.title}: part "${group || '(untitled)'}" of "${section.title}" -> ` +
    `all ${done ? 'done' : 'not done'} (${changed} changed, ${p.percent}%)`,
  )
  return guide
}

// ── The map ──────────────────────────────────────────────────────────────────
//
// A chapter uses its own map when it has one and the guide's whole-game map
// otherwise, so `sectionId` addresses a chapter and null addresses the game.
// Both resolve through here rather than in the route, so the two callers cannot
// come to different conclusions about which map a pin belongs to.

function mapFor(guide: Guide, sectionId: string | null): GuideMap | undefined {
  if (sectionId === null) return guide.map
  const section = guide.sections.find(s => s.id === sectionId)
  return section?.map ?? guide.map
}

/** Where a pin actually gets stored, which is not always where it was asked for. */
function mapOwner(guide: Guide, sectionId: string | null): GuideMap | null {
  if (sectionId === null) return guide.map ?? null
  const section = guide.sections.find(s => s.id === sectionId)
  if (!section) return null
  // A chapter with no map of its own is looking at the game map, so that is
  // where its pins belong — pinning to a chapter-shaped hole would drop them.
  return section.map ?? guide.map ?? null
}

export function addMapPin(
  itemId: string, sectionId: string | null, x: number, y: number, label: string,
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const map = mapOwner(guide, sectionId)
  if (!map) return null
  if (map.pins.length >= MAX_PINS_PER_SECTION) return null
  map.pins.push({
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    x, y,
    label: label.slice(0, MAX_PIN_LABEL_CHARS),
    createdAt: new Date().toISOString(),
  })
  guide.updatedAt = new Date().toISOString()
  write(store)
  console.log(`[guides] ${guide.title}: pinned "${label.slice(0, 40)}" at ${x.toFixed(2)},${y.toFixed(2)}`)
  return guide
}

export function updateMapPin(
  itemId: string, sectionId: string | null, pinId: string,
  patch: { x?: number; y?: number; label?: string },
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const pin = mapFor(guide, sectionId)?.pins.find(p => p.id === pinId)
  if (!pin) return null
  if (typeof patch.x === 'number') pin.x = patch.x
  if (typeof patch.y === 'number') pin.y = patch.y
  if (typeof patch.label === 'string') pin.label = patch.label.slice(0, MAX_PIN_LABEL_CHARS)
  guide.updatedAt = new Date().toISOString()
  write(store)
  return guide
}

export function removeMapPin(itemId: string, sectionId: string | null, pinId: string): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const map = mapFor(guide, sectionId)
  if (!map) return null
  const before = map.pins.length
  map.pins = map.pins.filter(p => p.id !== pinId)
  if (map.pins.length === before) return null
  guide.updatedAt = new Date().toISOString()
  write(store)
  return guide
}

/**
 * Move (or clear) a step's own pin.
 *
 * The generator placed it from a compass direction in the research notes, so the
 * first thing anyone does with a wrong one is drag it. Dragging clears `approx`:
 * the pin has now been placed by someone who can actually see the map, which is
 * the one thing the generator could not do.
 */
export function setStepPin(
  itemId: string, sectionId: string, stepId: string, at: { x: number; y: number } | null,
): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const step = guide.sections.find(s => s.id === sectionId)?.steps.find(s => s.id === stepId)
  if (!step) return null
  if (at === null) delete step.pin
  else step.pin = { x: at.x, y: at.y }
  guide.updatedAt = new Date().toISOString()
  write(store)
  return guide
}

/**
 * Tick or untick every step in one section at once — the "I already finished
 * this dungeon" shortcut, from a tap or from a spoken sentence.
 *
 * One read-modify-write for the lot rather than a setStepDone per step: that
 * would be sixty atomic file rewrites and sixty SSE frames for one gesture.
 * Returns null when the guide or section is gone, so the caller can 404 instead
 * of reporting success against a stale id.
 */
export function setSectionDone(itemId: string, sectionId: string, done: boolean): Guide | null {
  const store = read()
  const guide = store[itemId]
  if (!guide) return null
  const section = guide.sections.find(s => s.id === sectionId)
  if (!section) return null

  const now = new Date().toISOString()
  let changed = 0
  for (const step of section.steps) {
    if (step.done !== done) changed++
    step.done = done
    if (done) step.doneAt = now
    else delete step.doneAt
  }

  guide.updatedAt = now
  write(store)
  const p = guideProgress(guide)
  console.log(
    `[guides] ${guide.title}: "${section.title}" → all ${done ? 'done' : 'not done'} ` +
    `(${changed} of ${section.steps.length} changed, ${p.percent}%)`,
  )
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
  // Cached pictures follow their guides out. Nothing else knows which files are
  // still referenced, and without this the media directory only ever grows — on
  // the same Pi volume the generated images live on, and for the same reason
  // (guides are evicted at MAX_GUIDES and chapters are rewritten in place).
  pruneGuideImages(referencedImages(store))
  return dropped
}

/** Every cached image filename any guide still points at. */
function referencedImages(store: Store): Set<string> {
  const files = new Set<string>()
  const add = (img?: GuideImage) => { if (img) files.add(img.file) }
  for (const g of Object.values(store)) {
    add(g.map?.image)
    for (const sec of g.sections) {
      add(sec.image)
      add(sec.map?.image)
      for (const step of sec.steps) add(step.image)
    }
  }
  return files
}

/**
 * Called once at startup. Generation is in-memory and fire-and-forget, so a
 * container restart mid-job would otherwise leave a guide stuck on "generating"
 * forever — a spinner with nothing behind it.
 *
 * How it's resolved depends on what survived. A guide with finished chapters is
 * marked ready with only the unfinished chapters flagged, because failing the
 * whole document would point the user at "Try again" — which rebuilds from
 * scratch and destroys every chapter that was fine and every box they had
 * ticked, to recover the two that weren't. Per-chapter rewrite handles those.
 * Only a guide with nothing in it at all is failed outright.
 */
export function sweepInterrupted(): void {
  const store = read()
  let touched = 0
  for (const g of Object.values(store)) {
    if (g.status !== 'generating') continue
    const salvageable = g.sections.some(s => s.steps.length > 0)
    for (const s of g.sections) {
      if (s.state === 'pending') s.state = s.steps.length > 0 ? 'ready' : 'failed'
    }
    g.status = salvageable ? 'ready' : 'failed'
    if (salvageable) delete g.error
    else g.error = 'Generation was interrupted by a restart — tap retry.'
    delete g.phase
    g.updatedAt = new Date().toISOString()
    touched++
    note({
      itemId: g.itemId, title: g.title, stage: 'interrupted', level: 'warn',
      message: salvageable
        ? `Generation was cut short by a restart. The finished chapters were kept; ` +
          `${g.sections.filter(s => s.steps.length === 0).length} empty one(s) can be redone individually`
        : 'Generation was cut short by a restart with nothing finished — marked failed',
    })
  }
  if (touched > 0) {
    console.log(`[guides] ${touched} guide(s) were mid-generation at shutdown — marked failed`)
    write(store)
  }
  // Boot is the one moment this is guaranteed to run — pruneOrphans() is only
  // reached when the playlist is edited, and a cache that is only swept then can
  // sit for months holding pictures of guides that are long gone.
  pruneGuideImages(referencedImages(store))
}

export const GUIDE_CAPS = {
  MAX_SECTIONS,
  MAX_STEPS_PER_SECTION,
  MAX_STEP_CHARS,
  MAX_SOURCES,
} as const
