// Doing one thing to many downloads at once.
//
// The verdicts in downloads.ts turn a queue into a handful of groups — 78 with
// no seeders, 17 that never fetched their metadata, 11 waiting to be imported
// — and once a group has one answer, acting on it a row at a time is just
// typing. So the panel offers the answer per GROUP, and this is what carries
// it out.
//
// It is a background job for the same reason guide generation and image
// rendering are: replacing 78 releases is 78 calls to Sonarr and 78 to
// qBittorrent, which is minutes, and nobody should have to hold a panel open
// for it. One job at a time (the *arr queue is a shared thing and two passes
// over it would interleave badly), progress over the existing SSE channel,
// and a per-item result so a partial failure names which rows failed instead
// of failing the lot.
//
// Deliberately NOT parallel. Sonarr and Radarr are single-user boxes behind an
// API that serialises anyway, and a burst of 78 concurrent deletes is how you
// get a timeout storm and a half-applied blocklist.

import {
  arrQueue, arrQueueRemove, arrRefreshImports, torrentCommand, torrentControl, torrentRemove,
} from './media-stack'
import { broadcast } from './routes/system'

/** What can be done to a whole group. A subset of the per-row actions. */
export const BULK_ACTIONS = [
  'reannounce', 'recheck', 'force-start', 'resume', 'pause',
  'refresh-import', 'replace', 'remove', 'remove-data',
] as const
export type BulkAction = typeof BULK_ACTIONS[number]

export function isBulkAction(v: unknown): v is BulkAction {
  return typeof v === 'string' && (BULK_ACTIONS as readonly string[]).includes(v)
}

export interface BulkResult { hash: string; name: string; ok: boolean; error?: string }

export interface BulkState {
  running: boolean
  action: BulkAction | null
  /** What the group was called on screen, so the progress strip can say it. */
  label: string
  total: number
  done: number
  ok: number
  failed: number
  /** The row being worked on right now. */
  current: string
  startedAt: string | null
  endedAt: string | null
  /** Only the failures are kept: 78 successes is not a list anyone reads. */
  errors: BulkResult[]
  summary: string
}

const idle: BulkState = {
  running: false, action: null, label: '', total: 0, done: 0, ok: 0, failed: 0,
  current: '', startedAt: null, endedAt: null, errors: [], summary: '',
}

let state: BulkState = { ...idle }
let cancelled = false

export function bulkState(): BulkState {
  return { ...state, errors: state.errors.slice(0, 12) }
}

function push(): void {
  broadcast('downloads-bulk', bulkState())
}

export function cancelBulk(): boolean {
  if (!state.running) return false
  cancelled = true
  return true
}

/** How the action reads in the summary sentence. */
const VERB: Record<BulkAction, string> = {
  reannounce: 'asked the trackers again for',
  recheck: 'started a recheck on',
  'force-start': 'force-started',
  resume: 'resumed',
  pause: 'paused',
  'refresh-import': 'asked for an import of',
  replace: 'replaced',
  remove: 'removed',
  'remove-data': 'removed, with their files,',
}

/**
 * Start a bulk run. Returns why it was refused, or null if it started.
 *
 * The hashes come from the CLIENT rather than being re-derived from a group
 * name here, on purpose: the user acted on the rows they were looking at, and
 * a verdict that changed between the render and the tap should not silently
 * widen what gets deleted.
 */
export function startBulk(action: BulkAction, hashes: string[], label: string): string | null {
  if (state.running) return `${state.action} is still running on ${state.total} downloads`
  const list = [...new Set(hashes.filter(h => /^[0-9a-f]{40}$/.test(h)))]
  if (!list.length) return 'no valid torrent hashes were given'
  if (list.length > 500) return 'that is more than 500 downloads at once'

  cancelled = false
  state = {
    ...idle,
    running: true, action, label, total: list.length,
    startedAt: new Date().toISOString(), errors: [],
  }
  push()
  console.log(`[downloads] bulk ${action} on ${list.length} torrents (${label})`)
  void run(action, list, label)
  return null
}

async function run(action: BulkAction, hashes: string[], label: string): Promise<void> {
  try {
    // One global call covers every row: the *arr re-examines its whole queue,
    // so asking once per torrent would be 78 identical commands.
    if (action === 'refresh-import') {
      const names = await arrRefreshImports()
      state.done = state.total
      state.ok = state.total
      finish(names.length ? `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} re-checking the queue for all ${state.total}.` : 'No *arr is configured to import these.')
      return
    }

    // Fetched once rather than per row: it is one call to each *arr and the
    // queue does not change meaningfully over the run.
    const arr = (action === 'replace' || action === 'remove' || action === 'remove-data')
      ? await arrQueue().catch(() => new Map())
      : new Map()

    for (const hash of hashes) {
      if (cancelled) break
      state.current = hash.slice(0, 8)
      try {
        switch (action) {
          case 'resume':
          case 'pause':
            await torrentControl(hash, action)
            break
          case 'reannounce':
          case 'recheck':
          case 'force-start':
            await torrentCommand(hash, action)
            break
          case 'replace':
          case 'remove':
          case 'remove-data': {
            const item = arr.get(hash)
            // The *arr row goes first, or it is left complaining about a
            // download that no longer exists. `replace` blocklists and
            // re-searches; a plain remove does neither.
            if (item) {
              await arrQueueRemove(item, {
                blocklist: action === 'replace',
                search: action === 'replace',
                removeFromClient: false,
              })
            }
            await torrentRemove(hash, action !== 'remove')
            break
          }
        }
        state.ok++
      } catch (err) {
        state.failed++
        state.errors.push({ hash, name: hash.slice(0, 8), ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      state.done++
      // Broadcast every row for a short run and every fifth for a long one:
      // 78 frames is fine, 500 is a stream nobody reads.
      if (state.total <= 100 || state.done % 5 === 0 || state.done === state.total) push()
      // Sonarr and Radarr are single boxes; a burst is how you get timeouts.
      if (action === 'replace' || action === 'remove' || action === 'remove-data') {
        await new Promise(r => setTimeout(r, 250))
      }
    }

    const stopped = cancelled ? ' (stopped early)' : ''
    finish(
      `${VERB[action]} ${state.ok} of ${state.total} — ${label}${stopped}.` +
      (state.failed ? ` ${state.failed} failed.` : ''),
    )
  } catch (err) {
    finish(`The run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function finish(summary: string): void {
  state.running = false
  state.current = ''
  state.endedAt = new Date().toISOString()
  state.summary = summary
  console.log(`[downloads] bulk done — ${summary}`)
  push()
}
