// When was this dashboard last upgraded, and what happened the last time
// someone asked it to update?
//
// Neither is knowable from the running image alone. The image knows which
// commit it was built from and when CI built it, not when it started running
// HERE — and an update that changed nothing leaves no trace in the image at
// all, which is exactly the case that read as "I press Update and it stays on
// the same version". So the server keeps a small history on the volume:
//
//   installs — one entry each time the server boots on a build it has not
//              booted on before (a self-update, Watchtower, a manual rebuild).
//              The newest is "last upgraded".
//   attempts — one entry each time "Update the dashboard" is started from
//              Settings → Server, with the build that was running at the time.
//
// An attempt's outcome is then a comparison rather than a guess: an install
// newer than the attempt means it upgraded; none after long enough means it
// finished without changing what runs. The host script's own log (status →
// dashboard.selfUpdate) adds the why when it has it; this file works without it.

import fs from 'fs'
import path from 'path'

// Read lazily, never at module scope: index.ts calls dotenv.config() after its
// imports are evaluated (see the same note in routes/system.ts).
export const gitSha = () => (process.env['GIT_SHA'] ?? '').trim()

/** When CI (or a local build) built this image. Null under `npm run dev`. */
export function buildTime(): string | null {
  const fromEnv = (process.env['BUILD_TIME'] ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    return fs.readFileSync(path.join('/app', '.build-time'), 'utf8').trim() || null
  } catch {
    return null
  }
}

export interface InstallEntry {
  sha:     string | null
  builtAt: string | null
  /** When this server first booted on that build. */
  at:      string
  /** True for the first entry ever written: the build was already running when
   *  history began, so `at` is "running since at least", not "installed at". */
  firstSeen?: boolean
}

export interface AttemptEntry {
  at:   string
  /** The build running when the update was asked for. */
  from: { sha: string | null; builtAt: string | null }
}

interface History { installs: InstallEntry[]; attempts: AttemptEntry[] }

const MAX = 20
// A self-update waits up to 20 minutes for CI's image and then may build here;
// past this, an attempt with no new install is not still going.
const PENDING_MS = 45 * 60_000

function file(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'update-history.json')
}

function read(): History {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<History>
    const installs = Array.isArray(j.installs) ? j.installs.filter(e => e && typeof e.at === 'string') : []
    const attempts = Array.isArray(j.attempts) ? j.attempts.filter(e => e && typeof e.at === 'string') : []
    return { installs, attempts }
  } catch {
    return { installs: [], attempts: [] }
  }
}

function write(h: History): void {
  const f = file()
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ installs: h.installs.slice(-MAX), attempts: h.attempts.slice(-MAX) }, null, 2))
    fs.renameSync(tmp, f)
  } catch (err) {
    console.warn('[update-history] could not save:', err instanceof Error ? err.message : err)
  }
}

function sameBuild(a: { sha: string | null; builtAt: string | null }, b: { sha: string | null; builtAt: string | null }): boolean {
  // The commit identifies a build when both carry one; a rebuild of the same
  // commit is not an upgrade. Without it, the build time is all there is.
  if (a.sha && b.sha) return a.sha === b.sha
  return a.builtAt === b.builtAt && a.sha === b.sha
}

function current(): { sha: string | null; builtAt: string | null } {
  return { sha: gitSha() || null, builtAt: buildTime() }
}

/** Call once at boot: notes the build if it is new to this server. */
export function recordBoot(): void {
  const h = read()
  const now = current()
  const last = h.installs[h.installs.length - 1]
  if (last && sameBuild(last, now)) return
  const entry: InstallEntry = { ...now, at: new Date().toISOString() }
  if (!last) entry.firstSeen = true
  h.installs.push(entry)
  write(h)
  console.log(`[update-history] ${last ? 'upgraded' : 'first boot recorded'}: ${now.sha?.slice(0, 7) ?? now.builtAt ?? 'unstamped build'}`)
}

/** Call when "Update the dashboard" starts. */
export function recordAttempt(): void {
  const h = read()
  h.attempts.push({ at: new Date().toISOString(), from: current() })
  write(h)
}

export type AttemptOutcome = 'upgraded' | 'pending' | 'unchanged'

export interface UpdateHistoryView {
  current:     { sha: string | null; shortSha: string | null; builtAt: string | null }
  lastUpgrade: (InstallEntry & { shortSha: string | null }) | null
  lastAttempt: (AttemptEntry & {
    outcome: AttemptOutcome
    /** The build it upgraded to, when it did. */
    to: { sha: string | null; shortSha: string | null } | null
  }) | null
}

export function updateHistory(): UpdateHistoryView {
  const h = read()
  const cur = current()
  const short = (s: string | null) => (s ? s.slice(0, 7) : null)
  const last = h.installs[h.installs.length - 1] ?? null
  const attempt = h.attempts[h.attempts.length - 1] ?? null
  let lastAttempt: UpdateHistoryView['lastAttempt'] = null
  if (attempt) {
    const t = Date.parse(attempt.at)
    const after = h.installs.find(i => !i.firstSeen && Date.parse(i.at) > t && !sameBuild(i, attempt.from))
    const outcome: AttemptOutcome = after ? 'upgraded'
      : Date.now() - t < PENDING_MS ? 'pending'
      : 'unchanged'
    lastAttempt = { ...attempt, outcome, to: after ? { sha: after.sha, shortSha: short(after.sha) } : null }
  }
  return {
    current: { ...cur, shortSha: short(cur.sha) },
    lastUpgrade: last ? { ...last, shortSha: short(last.sha) } : null,
    lastAttempt,
  }
}
