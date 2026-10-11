// "Is the dashboard on this screen the newest one, and if not, why not?"
//
// Asked of GET /api/system/version/check, which compares the commit this image
// was built from with the tip of main on GitHub, and — when it is behind —
// asks whether CI has published the image for that tip yet. That last part is
// the whole reason this is its own hook: a merge is on GitHub at once, but its
// image is ~10 minutes of building behind it, and in those minutes "behind"
// with nothing to install looked exactly like the dashboard not seeing the
// merge. The Debug tab and Settings → Server both show it, so it lives here.

import { useCallback, useEffect, useRef, useState } from 'react'

const API = (import.meta.env.VITE_AUDIO_API as string | undefined) ?? ''

export interface ImageBuild {
  state:      'published' | 'building' | 'failed' | 'none' | 'unknown'
  startedAt:  string | null
  finishedAt: string | null
  conclusion: string | null
  url:        string | null
}

export interface UpdateCheck {
  status: 'up-to-date' | 'behind' | 'unknown'
  // Which comparison produced `status` — an exact commit match, or the weaker
  // "was this built before the newest commit landed?". Worth showing, because
  // the two justify different amounts of confidence.
  basis: 'sha' | 'build-time' | 'none'
  behindBy: number | null
  // Only when behind; absent on servers older than this field.
  image?: ImageBuild | null
  current: { sha: string | null; shortSha: string | null; builtAt: string | null }
  latest: { sha: string; shortSha: string; date: string | null; message: string }
  repo: string
  branch: string
}

export interface UpdateState {
  state: 'idle' | 'checking' | 'done' | 'fail'
  data?: UpdateCheck
  error?: string
}

// While the image is building, look again on our own so the line turns into
// "published" without anyone tapping — once a minute, and for no longer than a
// build is allowed to run (the workflow times out at an hour). The server asks
// GitHub at most every 30 s for a build in progress, so this stays well inside
// the unauthenticated hourly budget.
const POLL_MS  = 60_000
const MAX_POLLS = 60

export function useUpdateCheck() {
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' })
  const polls = useRef(0)

  // `fresh` is for a tap: the server otherwise answers from a five-minute cache.
  const check = useCallback(async (fresh = false) => {
    if (fresh) polls.current = 0
    setUpdate(prev => ({ ...prev, state: 'checking' }))
    try {
      const res = await fetch(`${API}/api/system/version/check${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) {
        // A 404 isn't a failed check so much as the answer to it: this server
        // is old enough to predate the endpoint, so it is definitely behind.
        if (res.status === 404) throw new Error('This server predates the update check — it is out of date. Rebuild the container.')
        const j = await res.json().catch(() => ({})) as { detail?: string; error?: string }
        throw new Error(j.detail ?? j.error ?? `HTTP ${res.status}`)
      }
      setUpdate({ state: 'done', data: await res.json() as UpdateCheck })
    } catch (err) {
      setUpdate({ state: 'fail', error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const building = update.state === 'done' && update.data?.image?.state === 'building'
  useEffect(() => {
    if (!building || polls.current >= MAX_POLLS) return
    const t = window.setTimeout(() => { polls.current++; void check() }, POLL_MS)
    return () => window.clearTimeout(t)
  }, [building, update.data, check])

  return { update, check }
}

function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null
}

function agoText(mins: number | null): string {
  if (mins === null) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

// Watchtower's poll interval in docker-compose.yml (WATCHTOWER_POLL_INTERVAL).
// An image published longer ago than twice this, still not running here, means
// Watchtower is not doing its job — the one case worth saying so plainly.
const WATCHTOWER_MINUTES = 5
const STUCK_MINUTES = 20

/** One sentence on the newest commit's image, for a dashboard that is behind.
 *  Null when there is nothing worth saying (up to date, or GitHub didn't say). */
export function describeImage(check: UpdateCheck | undefined, now = Date.now()): { tone: 'info' | 'warn' | 'bad'; text: string; url: string | null } | null {
  const img = check?.status === 'behind' ? check.image : null
  if (!img) return null
  const started  = minutesSince(img.startedAt, now)
  const finished = minutesSince(img.finishedAt, now)
  switch (img.state) {
    case 'building':
      // A good build is 3–8 minutes. One that has run three times that is
      // almost certainly hung in the emulated arm64 stage, and GitHub only
      // stops it at the workflow's one-hour timeout.
      if (started !== null && started >= STUCK_MINUTES) {
        return {
          tone: 'warn', url: img.url,
          text: `Its image has been building for ${started} minutes — a good build takes 3 to 8, so this one is probably stuck. GitHub stops it at an hour; cancelling and re-running it on GitHub is quicker.`,
        }
      }
      return {
        tone: 'info', url: img.url,
        text: `Its image is still being built (started ${agoText(started)}; usually about 8 minutes). There is nothing to install until it finishes — Watchtower picks it up within ${WATCHTOWER_MINUTES} minutes after that.`,
      }
    case 'published':
      if (finished !== null && finished > WATCHTOWER_MINUTES * 2) {
        return {
          tone: 'bad', url: img.url,
          text: `Its image was published ${agoText(finished)} and still isn't running here, so Watchtower isn't updating this container. Use "Update the dashboard" in Settings → Server, and check \`docker logs watchtower\` on the server.`,
        }
      }
      return {
        tone: 'info', url: img.url,
        text: `Its image is published (${agoText(finished)}). Watchtower installs it on its next look, every ${WATCHTOWER_MINUTES} minutes — or "Update the dashboard" in Settings → Server does it now.`,
      }
    case 'failed':
      return {
        tone: 'bad', url: img.url,
        text: `Its image build ${img.conclusion === 'cancelled' || img.conclusion === 'timed_out' ? 'was stopped' : 'failed'}${img.conclusion ? ` (${img.conclusion.replace('_', ' ')})` : ''}, so there is no image to install. Re-run it on GitHub, or the next push builds a new one.`,
      }
    case 'none':
      return {
        tone: 'warn', url: null,
        text: 'No image build ran for this commit, so there is no image for it to install.',
      }
    default:
      return null
  }
}

// ── History: when this server last changed build, and the last update ────────
//
// From GET /api/system/version/history (server/src/update-history.ts): the
// server notes each new build it boots on and each "Update the dashboard" it
// starts, so "last upgraded" and "what did the last update do" are answers
// rather than guesses. The host script's own record of the run (status →
// dashboard.selfUpdate) adds why it ended the way it did, when it has one.

export interface UpdateHistory {
  current: { sha: string | null; shortSha: string | null; builtAt: string | null }
  lastUpgrade: { sha: string | null; shortSha: string | null; builtAt: string | null; at: string; firstSeen?: boolean } | null
  lastAttempt: {
    at: string
    from: { sha: string | null; builtAt: string | null }
    outcome: 'upgraded' | 'pending' | 'unchanged'
    to: { sha: string | null; shortSha: string | null } | null
  } | null
}

/** The host script's account of the last self-update (absent from older scripts). */
export interface SelfUpdateLog {
  startedAt: string
  endedAt: string
  /** 'ok' | 'fail', or '' when the run left no result line (still going, or killed). */
  result: string
  detail: string
  tail: string[]
}

export function useUpdateHistory() {
  const [history, setHistory] = useState<UpdateHistory | null>(null)
  // A 404 is a server older than the history: say nothing rather than guess.
  const load = useCallback(() => fetch(`${API}/api/system/version/history`, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() as Promise<UpdateHistory> : null))
    .catch(() => null)
    .then(setHistory), [])
  useEffect(() => { void load() }, [load])
  return { history, reload: load }
}

export interface AttemptSummary {
  at: string
  tone: 'good' | 'info' | 'warn' | 'bad'
  text: string
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : null)

/** One sentence on how the last update ended, from the server's record and the
 *  host's log together. Null when neither has ever seen one. */
export function describeLastAttempt(
  history: UpdateHistory | null,
  log: SelfUpdateLog | undefined,
  check: UpdateCheck | undefined,
): AttemptSummary | null {
  const attempt = history?.lastAttempt ?? null
  const running = history?.current.shortSha ?? check?.current.shortSha ?? null
  const hostAt = log ? (log.startedAt || log.endedAt) : ''
  // The host's log belongs to the server's attempt when they started within a
  // few minutes of each other; otherwise whichever is newer is "the last one".
  const hostMs = hostAt ? Date.parse(hostAt) : NaN
  const attMs = attempt ? Date.parse(attempt.at) : NaN
  const sameRun = Number.isFinite(hostMs) && Number.isFinite(attMs) && Math.abs(hostMs - attMs) < 5 * 60_000
  const hostNewer = Number.isFinite(hostMs) && (!Number.isFinite(attMs) || hostMs - attMs > 5 * 60_000)

  // Why nothing new arrived, when the update check can tell.
  const why = (): string => {
    if (!check) return ''
    if (check.status === 'up-to-date') return ` It was already the newest on ${check.branch}.`
    if (check.status === 'behind') {
      const img = check.image?.state
      if (img === 'building') return ` The image for ${check.latest.shortSha} is still being built on GitHub, so there was nothing new to install.`
      if (img === 'failed' || img === 'none') return ` The image for ${check.latest.shortSha} was never published, so there was nothing new to install.`
    }
    return ''
  }

  if (hostNewer && log) {
    // Only the host knows about this run (started before this server kept a record).
    if (log.result === 'fail') return { at: hostAt, tone: 'bad', text: `Failed: ${log.detail || 'see the log on the server'}.` }
    if (log.result === 'ok') {
      const to = short(log.detail)
      return to && to === running
        ? { at: hostAt, tone: 'good', text: `Finished and installed ${to}.` }
        : { at: hostAt, tone: 'warn', text: `Finished${to ? ` (installed ${to})` : ''}, but this server is running ${running ?? 'an unstamped build'}.${why()}` }
    }
    return { at: hostAt, tone: 'info', text: `Result not recorded${log.tail.length ? ` — last line: “${log.tail[log.tail.length - 1]}”` : ''}.` }
  }
  if (!attempt) return null

  if (attempt.outcome === 'upgraded') {
    return { at: attempt.at, tone: 'good', text: `Upgraded ${short(attempt.from.sha) ?? 'the old build'} → ${attempt.to?.shortSha ?? 'a new build'}.` }
  }
  if (sameRun && log?.result === 'fail') {
    return { at: attempt.at, tone: 'bad', text: `Failed: ${log.detail || 'see the log on the server'}.` }
  }
  if (attempt.outcome === 'pending' && !(sameRun && log?.result === 'ok')) {
    const last = sameRun && log?.tail.length ? ` Now: “${log.tail[log.tail.length - 1]}”` : ''
    return { at: attempt.at, tone: 'info', text: `Still going — it can wait up to 20 minutes for GitHub's image.${last}` }
  }
  return { at: attempt.at, tone: 'warn', text: `Finished without installing anything new — still on ${running ?? 'the same build'}.${why()}` }
}
