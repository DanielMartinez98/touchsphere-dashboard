// Persistent memory for the chat assistant.
//
// Three kinds of thing live here, in two tiers:
//
//   long-term  : facts the assistant (or the user, via Settings) has chosen to
//                keep. No expiry. Two kinds:
//                  fact       — "The user's name is Daniel."
//                  preference — how the user likes to be answered, e.g. "When
//                               the user asks how to do something in a game,
//                               they usually want a video." Kept apart from
//                               facts because they're applied differently: a
//                               fact is stated, a preference is OFFERED.
//   short-term : recent context — explicitly saved by the assistant, or
//                auto-summarized at the end of each conversation. 24h TTL.
//
// The conversation *transcript* is a separate store with its own 12h window —
// see session.ts. This file holds distilled knowledge; that one holds the last
// thing you were actually talking about.
//
// Stored as a single JSON file under CACHE_DIR so it survives restarts via the
// Docker volume, matching the pattern used by media.json / mode.json.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const FILE = 'memory.json'
const SHORT_TERM_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours
const MAX_LONG_TERM     = 50
const MAX_SHORT_TERM    = 30
const MAX_CONTENT_CHARS = 500

/** A plain fact vs. a learned answer-shape preference. Absent = 'fact' (older records). */
export type MemoryKind   = 'fact' | 'preference'
/** 'auto' = end-of-conversation summary, 'user' = typed into Settings by hand. */
export type MemorySource = 'assistant' | 'auto' | 'user'

/** What a fact is about. The Memory tab groups by these; the prompt does too. */
export const TOPICS = ['people', 'food', 'home', 'media', 'games', 'work', 'schedule', 'health', 'other'] as const
export type MemoryTopic = typeof TOPICS[number]

export interface Memory {
  id:        string
  content:   string
  createdAt: string                // ISO timestamp
  expiresAt?: string               // ISO timestamp, short-term only
  source?:   MemorySource
  kind?:     MemoryKind
  /** Absent on older records — guessed on read, see topicOf(). */
  topic?:    MemoryTopic
  /** Never evicted by the cap, listed first. The user's "this one matters". */
  pinned?:   boolean
}

const TOPIC_WORDS: Record<MemoryTopic, RegExp> = {
  people:   /\b(wife|husband|partner|girlfriend|boyfriend|mum|mom|dad|mother|father|sister|brother|son|daughter|kid|child|friend|colleague|boss|name is|birthday|anniversary)\b/i,
  food:     /\b(allerg|vegan|vegetarian|eat|food|coffee|tea|drink|recipe|cook|dinner|lunch|breakfast|pizza|sushi|restaurant|dislike.*(taste|flavour))\b/i,
  home:     /\b(house|home|flat|apartment|room|kitchen|garden|thermostat|light|lamp|plant|pet|dog|cat|car|address|lives? in)\b/i,
  media:    /\b(film|movie|show|series|episode|anime|watch|plex|music|song|band|album|podcast|book|read)\b/i,
  games:    /\b(game|gaming|play(s|ed|ing)?|boss|level|switch|playstation|xbox|steam|pc build|guide|walkthrough)\b/i,
  work:     /\b(work|job|office|project|deadline|meeting|client|study|studies|university|school|exam|course)\b/i,
  schedule: /\b(every (day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|routine|wake|bed ?time|sleep|appointment|schedule|calendar|weekend|mornings?|evenings?)\b/i,
  health:   /\b(health|doctor|dentist|medic|pill|medication|gym|run|exercise|diet|weight|sleep apnea|migraine|pain)\b/i,
  other:    /$^/,
}

/** The stored topic, else a guess from the words — good enough to group a list. */
export function topicOf(m: Memory): MemoryTopic {
  if (m.topic && (TOPICS as readonly string[]).includes(m.topic)) return m.topic
  for (const t of TOPICS) if (t !== 'other' && TOPIC_WORDS[t].test(m.content)) return t
  return 'other'
}

export function isTopic(v: unknown): v is MemoryTopic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v)
}

export interface MemoryStore {
  longTerm:  Memory[]
  shortTerm: Memory[]
}

function dir(): string {
  const d = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

function pathFor(): string { return path.join(dir(), FILE) }

function emptyStore(): MemoryStore { return { longTerm: [], shortTerm: [] } }

function read(): MemoryStore {
  const p = pathFor()
  try {
    if (!fs.existsSync(p)) return emptyStore()
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryStore>
    return {
      longTerm:  Array.isArray(parsed.longTerm)  ? parsed.longTerm  : [],
      shortTerm: Array.isArray(parsed.shortTerm) ? parsed.shortTerm : [],
    }
  } catch (err) {
    // Don't start fresh in place — the next write would overwrite the damaged
    // file and every memory would be gone for good, announced by one console
    // warning. Move it aside so it can be recovered by hand.
    const aside = `${p}.corrupt-${Date.now()}`
    try { fs.renameSync(p, aside); console.error(`[memory] unreadable store moved to ${aside}:`, err) }
    catch { console.error('[memory] store is unreadable and could not be moved aside:', err) }
    return emptyStore()
  }
}

function write(store: MemoryStore): void {
  const p = pathFor()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    // Write-then-rename. A plain writeFileSync that dies halfway leaves
    // truncated JSON, which read() would then quarantine — losing everything.
    // rename is atomic on POSIX and replaces the target on Windows.
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[memory] write failed:', err)
    throw err
  }
}

// Drop expired short-term entries. Always called on read so callers don't
// have to remember to prune. Mutates and returns the same store.
function pruneExpired(store: MemoryStore): MemoryStore {
  const now = Date.now()
  const before = store.shortTerm.length
  store.shortTerm = store.shortTerm.filter(m => {
    if (!m.expiresAt) return true
    return new Date(m.expiresAt).getTime() > now
  })
  if (store.shortTerm.length !== before) {
    console.log(`[memory] pruned ${before - store.shortTerm.length} expired short-term entries`)
  }
  return store
}

export function loadMemories(): MemoryStore {
  return pruneExpired(read())
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function addMemory(
  content: string,
  scope: 'short' | 'long',
  source: MemorySource = 'assistant',
  kind: MemoryKind = 'fact',
  topic?: MemoryTopic,
): Memory {
  const trimmed = content.trim().slice(0, MAX_CONTENT_CHARS)
  const now = new Date()
  const mem: Memory = {
    id:        crypto.randomUUID(),
    content:   trimmed,
    createdAt: now.toISOString(),
    source,
    kind,
    ...(topic ? { topic } : {}),
  }
  if (scope === 'short') {
    mem.expiresAt = new Date(now.getTime() + SHORT_TERM_TTL_MS).toISOString()
  }

  const store = pruneExpired(read())
  const bucket = scope === 'long' ? store.longTerm : store.shortTerm

  // De-dupe both tiers, not just long-term: the end-of-conversation summarizer
  // writes short-term unattended, and a day of similar chats otherwise fills
  // the bucket with near-identical notes that evict the useful ones.
  const dupe = bucket.find(m => norm(m.content) === norm(trimmed))
  if (dupe) {
    dupe.createdAt = mem.createdAt
    if (mem.expiresAt) dupe.expiresAt = mem.expiresAt   // refresh the TTL too
    write(store)
    console.log(`[memory] ${scope}-term refresh "${trimmed.slice(0, 60)}"`)
    return dupe
  }

  bucket.push(mem)
  const cap = scope === 'long' ? MAX_LONG_TERM : MAX_SHORT_TERM
  if (bucket.length > cap) {
    // Oldest first, but a pinned entry is never the one to go: pinning is
    // the user saying this one matters more than the cap does.
    bucket.sort((a, b) => Number(!!a.pinned) - Number(!!b.pinned) || a.createdAt.localeCompare(b.createdAt))
    const dropped = bucket.splice(0, bucket.length - cap)
    console.log(`[memory] evicted ${dropped.length} oldest ${scope}-term entries (cap ${cap})`)
  }
  write(store)
  console.log(`[memory] +${scope} ${kind} (${source}) "${trimmed.slice(0, 60)}"`)
  return mem
}

/** Longest match wins nothing here — this is a blunt substring sweep. See guards below. */
export interface ForgetResult { removed: Memory[]; refused?: string }

// Remove memories matching by exact id, or by case-insensitive substring of
// content. Two guards, because this is called by a language model and an
// over-broad query used to be able to empty the entire store in one call:
//   • the query must be specific enough to mean something (3+ chars)
//   • it must not match more than MAX_FORGET_MATCHES entries at once
// A refusal comes back with the matches listed so the caller can narrow down.
const MIN_FORGET_QUERY   = 3
const MAX_FORGET_MATCHES = 3

export function removeMemories(query: string): ForgetResult {
  const q = query.trim()
  if (q.length < MIN_FORGET_QUERY) {
    return { removed: [], refused: `"${q}" is too broad — use at least ${MIN_FORGET_QUERY} characters.` }
  }
  const store = pruneExpired(read())
  const lower = q.toLowerCase()
  const matches = (m: Memory) => m.id === q || m.content.toLowerCase().includes(lower)

  const hits = [...store.longTerm, ...store.shortTerm].filter(matches)
  if (hits.length === 0) return { removed: [] }
  if (hits.length > MAX_FORGET_MATCHES) {
    return {
      removed: [],
      refused:
        `"${q}" matches ${hits.length} memories — too many to delete at once. ` +
        `Matches: ${hits.slice(0, 6).map(m => `"${m.content.slice(0, 60)}"`).join('; ')}. ` +
        `Use a more specific phrase.`,
    }
  }

  store.longTerm  = store.longTerm.filter(m => !matches(m))
  store.shortTerm = store.shortTerm.filter(m => !matches(m))
  write(store)
  console.log(`[memory] forgot ${hits.length} entries matching "${q.slice(0, 40)}"`)
  return { removed: hits }
}

/** Edit one entry in place: its wording, its topic, whether it is pinned. */
export function updateMemory(id: string, patch: { content?: string; topic?: MemoryTopic; pinned?: boolean }): Memory | null {
  const store = pruneExpired(read())
  const mem = store.longTerm.find(m => m.id === id) ?? store.shortTerm.find(m => m.id === id)
  if (!mem) return null
  if (typeof patch.content === 'string' && patch.content.trim()) mem.content = patch.content.trim().slice(0, MAX_CONTENT_CHARS)
  if (patch.topic) mem.topic = patch.topic
  if (typeof patch.pinned === 'boolean') { if (patch.pinned) mem.pinned = true; else delete mem.pinned }
  write(store)
  console.log(`[memory] edited ${id}`)
  return mem
}

/** Exact-id delete, for the Settings UI where the user picked a specific row. */
export function removeMemoryById(id: string): boolean {
  const store = pruneExpired(read())
  const before = store.longTerm.length + store.shortTerm.length
  store.longTerm  = store.longTerm.filter(m => m.id !== id)
  store.shortTerm = store.shortTerm.filter(m => m.id !== id)
  const after = store.longTerm.length + store.shortTerm.length
  if (after === before) return false
  write(store)
  console.log(`[memory] deleted ${id}`)
  return true
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// Format the current store as a compact block to inject into the system prompt.
// Returns an empty string when there is nothing to remember, so the caller can
// concatenate unconditionally.
export function formatForPrompt(): string {
  const store = loadMemories()
  const prefs = store.longTerm.filter(m => m.kind === 'preference')
  const facts = store.longTerm.filter(m => m.kind !== 'preference')
  if (facts.length === 0 && prefs.length === 0 && store.shortTerm.length === 0) return ''

  const lines: string[] = ['', 'PERSISTENT MEMORY (treat as things you already know about the user):']
  if (facts.length > 0) {
    // Grouped by topic, pinned first within each: a model reading "Food:"
    // above the allergy is likelier to connect it to a recipe question than
    // one reading it from the middle of a flat list.
    lines.push('Facts:')
    for (const t of TOPICS) {
      const group = facts.filter(m => topicOf(m) === t).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
      if (!group.length) continue
      lines.push(`  ${t[0]!.toUpperCase()}${t.slice(1)}:`)
      for (const m of group) lines.push(`    - ${m.content}`)
    }
  }
  if (store.shortTerm.length > 0) {
    lines.push('Recent context (last 24h):')
    // Newest first so the most relevant context is closer to the user message,
    // and stamped with an age — an undated "going to the dentist tomorrow" from
    // three days ago otherwise reads as still true.
    const recent = store.shortTerm.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const m of recent) lines.push(`  - (${ageLabel(m.createdAt)}) ${m.content}`)
  }
  if (prefs.length > 0) {
    lines.push(
      'Learned preferences — how this user likes to be answered. These are patterns, not orders:',
    )
    for (const m of prefs) lines.push(`  - ${m.content}`)
    lines.push(
      '  When a preference applies to what the user just asked, do NOT silently assume it. ' +
      'Offer it in your reply and call keep_listening so they can say no — ' +
      '"Want me to pull up a video for that?" — unless they already said which form they want, ' +
      'in which case follow what they said and ignore the preference.',
    )
  }
  lines.push(
    'Use these as background knowledge. If the user asks something covered here, answer directly without looking it up. ' +
    'Use the remember/remember_preference/forget tools to keep this list accurate as things change.',
  )
  return lines.join('\n')
}
