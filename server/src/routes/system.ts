import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'

const router = Router()

// ── Version / update check ──────────────────────────────────────────────────
// Watchtower replaces the image out from under the device, and the kiosk has no
// shell, so "what am I running and is it current?" can only be answered by the
// app itself. Identity is stamped into the image at build time (see Dockerfile)
// and compared here against the repo's HEAD on GitHub.

const GIT_SHA       = (process.env['GIT_SHA'] ?? '').trim()
const GITHUB_REPO   = process.env['GITHUB_REPO']   ?? 'DanielMartinez98/touchsphere-dashboard'
const GITHUB_BRANCH = process.env['GITHUB_BRANCH'] ?? 'main'
// Optional. Unauthenticated GitHub API calls are limited to 60/hour per IP,
// which the 5-minute cache below keeps us far beneath — a token is only worth
// setting if this server shares an outbound IP with other API consumers.
const GITHUB_TOKEN  = process.env['GITHUB_TOKEN'] ?? ''

// Written by the final Dockerfile layer. The env var takes precedence so a
// non-Docker deployment can supply it too; absent both (npm run dev) it stays
// null, where "when was this built" isn't a meaningful question anyway.
const BUILD_TIME = (() => {
  const fromEnv = (process.env['BUILD_TIME'] ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    return fs.readFileSync(path.join('/app', '.build-time'), 'utf8').trim() || null
  } catch {
    return null
  }
})()

interface GitHubCommit { sha: string; date: string | null; message: string }

// The update check is behind a button, but a kiosk left on the Debug tab and a
// user tapping it repeatedly would both burn the hourly GitHub budget for no
// new information — commits don't land that fast.
const REMOTE_TTL_MS = 5 * 60 * 1000
let remoteCache: { at: number; commit: GitHubCommit } | null = null

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'touchsphere-dashboard',
  }
  if (GITHUB_TOKEN) headers['authorization'] = `Bearer ${GITHUB_TOKEN}`
  return headers
}

async function fetchLatestCommit(): Promise<GitHubCommit> {
  if (remoteCache && Date.now() - remoteCache.at < REMOTE_TTL_MS) return remoteCache.commit
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/${encodeURIComponent(GITHUB_BRANCH)}`
    const res = await fetch(url, { headers: githubHeaders(), signal: ctrl.signal })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`GitHub ${res.status}${res.status === 403 ? ' (rate limited)' : ''}: ${detail.slice(0, 160)}`)
    }
    const json = await res.json() as {
      sha?: string
      commit?: { message?: string; committer?: { date?: string } }
    }
    const commit: GitHubCommit = {
      sha:     json.sha ?? '',
      date:    json.commit?.committer?.date ?? null,
      // Commit bodies are irrelevant on a 7" screen; the subject line is not.
      message: (json.commit?.message ?? '').split('\n')[0]!.slice(0, 120),
    }
    remoteCache = { at: Date.now(), commit }
    return commit
  } finally {
    clearTimeout(timer)
  }
}

// How far behind, when both ends are real commits GitHub knows about. Best
// effort: a locally-built image can be running a commit that was never pushed,
// and GitHub answers 404 for it — that's a "behind, count unknown", not an error.
async function fetchBehindBy(base: string, head: string): Promise<number | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/compare/${base}...${head}`
    const res = await fetch(url, { headers: githubHeaders(), signal: ctrl.signal })
    if (!res.ok) return null
    const json = await res.json() as { ahead_by?: number }
    // base=running, head=branch tip → ahead_by counts commits the tip has that
    // the running build doesn't. That is what "behind" means from here.
    return typeof json.ahead_by === 'number' ? json.ahead_by : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// GET /api/system/version — what this container is, no network required.
router.get('/version', (_req: Request, res: Response) => {
  res.json({
    sha:      GIT_SHA || null,
    shortSha: GIT_SHA ? GIT_SHA.slice(0, 7) : null,
    builtAt:  BUILD_TIME,
    repo:     GITHUB_REPO,
    branch:   GITHUB_BRANCH,
  })
})

// GET /api/system/version/check — compare against the repo's HEAD.
//
// Two ways to be sure, in order of confidence:
//   1. GIT_SHA is stamped in  → compare commits directly (exact, gives a count)
//   2. only BUILD_TIME exists → a build predating the newest commit is behind
// Neither available (dev server) → 'unknown', reported honestly rather than
// guessed at.
router.get('/version/check', async (_req: Request, res: Response) => {
  try {
    const latest = await fetchLatestCommit()

    let status: 'up-to-date' | 'behind' | 'unknown' = 'unknown'
    let behindBy: number | null = null
    let basis: 'sha' | 'build-time' | 'none' = 'none'

    if (GIT_SHA && latest.sha) {
      basis  = 'sha'
      status = GIT_SHA === latest.sha ? 'up-to-date' : 'behind'
      if (status === 'behind') behindBy = await fetchBehindBy(GIT_SHA, latest.sha)
    } else if (BUILD_TIME && latest.date) {
      basis  = 'build-time'
      const built     = Date.parse(BUILD_TIME)
      const committed = Date.parse(latest.date)
      status = Number.isFinite(built) && Number.isFinite(committed)
        ? (built >= committed ? 'up-to-date' : 'behind')
        : 'unknown'
    }

    console.log(`[system] version check: ${status} (basis=${basis}${behindBy !== null ? `, behind ${behindBy}` : ''})`)
    res.json({
      status,
      basis,
      behindBy,
      current: { sha: GIT_SHA || null, shortSha: GIT_SHA ? GIT_SHA.slice(0, 7) : null, builtAt: BUILD_TIME },
      latest:  { ...latest, shortSha: latest.sha.slice(0, 7) },
      repo:    GITHUB_REPO,
      branch:  GITHUB_BRANCH,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[system] version check failed:', detail)
    res.status(502).json({ error: 'update check failed', detail })
  }
})

// All active SSE clients waiting for server events.
const sseClients = new Set<Response>()

// GET /api/system/events  — SSE stream for real-time server → client signals.
router.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Heartbeat every 25 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

  sseClients.add(res)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
  })
})

// GET /api/system/debug — runtime + config summary for the in-app Debug panel.
// Secrets are reported as booleans only; never echo key material.
router.get('/debug', (_req: Request, res: Response) => {
  const env = process.env
  res.json({
    uptimeSec: Math.floor(process.uptime()),
    node:      process.version,
    platform:  `${process.platform}/${process.arch}`,
    nodeEnv:   env['NODE_ENV'] ?? 'development',
    cacheDir:  env['CACHE_DIR'] ?? '(default)',
    config: {
      OPENWEATHER_API_KEY: !!env['OPENWEATHER_API_KEY'],
      CALENDAR_ICAL_URL:   !!env['CALENDAR_ICAL_URL'],
      ELEVENLABS_API_KEY:  !!env['ELEVENLABS_API_KEY'],
      NOTION_API_KEY:      !!env['NOTION_API_KEY'],
      NOTION_DATABASE_ID:  !!env['NOTION_DATABASE_ID'],
      OLLAMA_API_KEY:      !!env['OLLAMA_API_KEY'],
      DEFAULT_LAT_LON:     !!(env['DEFAULT_LAT'] && env['DEFAULT_LON']),
      // Cover art. TMDB drives movies/shows; IGDB (which needs BOTH the Twitch
      // client id and secret) drives games. A missing IGDB secret is invisible
      // otherwise: films still get posters, games silently get none.
      TMDB_API_KEY:        !!env['TMDB_API_KEY'],
      IGDB_CREDENTIALS:    !!(env['IGDB_CLIENT_ID'] && env['IGDB_CLIENT_SECRET']),
    },
    ollama: {
      url:   env['OLLAMA_URL']   ?? 'http://host.docker.internal:11434 (default)',
      model: env['OLLAMA_MODEL'] ?? 'gemma3 (default)',
    },
  })
})

// POST /api/system/restart  — broadcast reload event to all connected clients.
// The server itself keeps running; each browser tab reloads itself.
router.post('/restart', (_req: Request, res: Response) => {
  res.json({ ok: true })
  setTimeout(() => {
    console.log('[system] restart requested via API — broadcasting reload to clients')
    for (const client of sseClients) {
      client.write('event: reload\ndata: {}\n\n')
    }
  }, 100)
})

export default router
