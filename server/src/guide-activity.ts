// What the guide system is doing right now, in words, for the Guides settings tab.
//
// Generating a guide is a dozen model calls and twice as many page fetches
// spread over several minutes, and until now the only account of it was the
// `phase` string (one line, overwritten constantly) and the server's stdout —
// which on the Pi means SSHing in to watch a container log. When a chapter comes
// back empty the useful question is *why*: no wiki page, a throttled search, the
// model returning nothing twice. All of that was being logged and thrown away.
//
// So every step of a run also lands here: a ring buffer in memory, broadcast to
// any open dashboard as it happens, and readable in one GET for a tab that was
// opened after the fact.
//
// Deliberately NOT persisted. It's a window onto work in progress, not a record
// worth keeping — and guides.json already has a writer per section without
// adding a second file being appended to on the same schedule. A restart clears
// it, which is also when sweepInterrupted() explains itself in the same feed.

import { broadcast } from './routes/system'

export type ActivityLevel = 'info' | 'good' | 'warn' | 'error'

export interface GuideActivity {
  /** Monotonic id — the client keys off it and drops anything it has already seen. */
  id:       number
  at:       string
  itemId:   string
  /** The game, so the feed reads as sentences without the client joining on ids. */
  title:    string
  /** Short stage label: queued, research, outline, steps, video, done… */
  stage:    string
  message:  string
  level:    ActivityLevel
  /** The chapter this line is about, when it's about one. */
  section?: string
}

// Enough to cover a whole generation (a 12-chapter guide logs roughly 60 lines)
// plus whatever came before it, and small enough to be free.
const MAX_ENTRIES = 300

const entries: GuideActivity[] = []
let nextId = 1

/**
 * Record one thing that happened, broadcast it, and log it. This is the only
 * place guide progress is written to stdout — the console line and the feed
 * line are the same sentence, so they can't drift apart.
 */
export function note(entry: Omit<GuideActivity, 'id' | 'at'>): void {
  const full: GuideActivity = { ...entry, id: nextId++, at: new Date().toISOString() }
  entries.push(full)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)

  const where = entry.section ? ` § ${entry.section}` : ''
  const line = `[guides] "${entry.title}"${where}: ${entry.message}`
  if (entry.level === 'error') console.error(line)
  else if (entry.level === 'warn') console.warn(line)
  else console.log(line)

  broadcast('guide-activity', full)
}

/** The buffer, oldest first. The tab renders it newest first. */
export function recentActivity(limit = MAX_ENTRIES): GuideActivity[] {
  return entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)))
}
