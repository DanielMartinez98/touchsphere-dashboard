// Persistent memory for the chat assistant.
//
// Two tiers:
//   long-term  : facts the assistant has explicitly chosen to remember
//                (user's name, preferences, recurring routines). No expiry.
//   short-term : recent context — either explicitly saved by the assistant
//                (note-to-self), or auto-summarized at the end of each
//                conversation. Auto-prunes after 24h.
//
// Stored as a single JSON file under CACHE_DIR so it survives restarts via
// the Docker volume, matching the pattern used by media.json / mode.json.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const FILE = 'memory.json'
const SHORT_TERM_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours
const MAX_LONG_TERM     = 50
const MAX_SHORT_TERM    = 30

export interface Memory {
  id:        string
  content:   string
  createdAt: string                // ISO timestamp
  expiresAt?: string               // ISO timestamp, short-term only
  source?:   'assistant' | 'auto'  // how it was created (auto = session summary)
}

interface MemoryStore {
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
    console.warn('[memory] failed to read store, starting fresh:', err)
    return emptyStore()
  }
}

function write(store: MemoryStore): void {
  try {
    fs.writeFileSync(pathFor(), JSON.stringify(store, null, 2), 'utf8')
  } catch (err) {
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

export function addMemory(
  content: string,
  scope: 'short' | 'long',
  source: 'assistant' | 'auto' = 'assistant',
): Memory {
  const trimmed = content.trim().slice(0, 500)
  const now = new Date()
  const mem: Memory = {
    id:        crypto.randomUUID(),
    content:   trimmed,
    createdAt: now.toISOString(),
    source,
  }
  if (scope === 'short') {
    mem.expiresAt = new Date(now.getTime() + SHORT_TERM_TTL_MS).toISOString()
  }

  const store = pruneExpired(read())
  if (scope === 'long') {
    // De-dupe: if an existing long-term memory has identical content (case-
    // insensitive, whitespace-normalized), refresh its createdAt instead.
    const norm = trimmed.toLowerCase().replace(/\s+/g, ' ')
    const dupe = store.longTerm.find(m => m.content.toLowerCase().replace(/\s+/g, ' ') === norm)
    if (dupe) {
      dupe.createdAt = mem.createdAt
      write(store)
      console.log(`[memory] long-term refresh "${trimmed.slice(0, 60)}"`)
      return dupe
    }
    store.longTerm.push(mem)
    if (store.longTerm.length > MAX_LONG_TERM) {
      // Drop the oldest first.
      store.longTerm.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      store.longTerm = store.longTerm.slice(-MAX_LONG_TERM)
    }
  } else {
    store.shortTerm.push(mem)
    if (store.shortTerm.length > MAX_SHORT_TERM) {
      store.shortTerm.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      store.shortTerm = store.shortTerm.slice(-MAX_SHORT_TERM)
    }
  }
  write(store)
  console.log(`[memory] +${scope} (${source}) "${trimmed.slice(0, 60)}"`)
  return mem
}

// Remove memories matching by id, or by case-insensitive substring of content.
// Returns the number removed across both tiers.
export function removeMemories(query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const store = pruneExpired(read())
  const matches = (m: Memory) =>
    m.id === query || m.content.toLowerCase().includes(q)
  const beforeL = store.longTerm.length
  const beforeS = store.shortTerm.length
  store.longTerm  = store.longTerm.filter(m => !matches(m))
  store.shortTerm = store.shortTerm.filter(m => !matches(m))
  const removed = (beforeL - store.longTerm.length) + (beforeS - store.shortTerm.length)
  if (removed > 0) {
    write(store)
    console.log(`[memory] forgot ${removed} entries matching "${q.slice(0, 40)}"`)
  }
  return removed
}

// Format the current store as a compact block to inject into the system prompt.
// Returns an empty string when there is nothing to remember, so the caller can
// concatenate unconditionally.
export function formatForPrompt(): string {
  const store = loadMemories()
  if (store.longTerm.length === 0 && store.shortTerm.length === 0) return ''

  const lines: string[] = ['', 'PERSISTENT MEMORY (treat as facts you already know about the user):']
  if (store.longTerm.length > 0) {
    lines.push('Long-term:')
    for (const m of store.longTerm) lines.push(`  - ${m.content}`)
  }
  if (store.shortTerm.length > 0) {
    lines.push('Recent (last 24h):')
    // Newest first so the most relevant context is closer to the user message.
    const recent = store.shortTerm.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const m of recent) lines.push(`  - ${m.content}`)
  }
  lines.push(
    'Use these as background knowledge. If the user asks something covered here, answer directly without looking it up. ' +
    'Use the remember/forget tools to keep this list accurate as facts change.',
  )
  return lines.join('\n')
}
