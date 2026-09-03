import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { elevenLabsKeyState } from '../config/keys'

const router = Router()

// ── Version / update check ──────────────────────────────────────────────────
// Watchtower replaces the image out from under the device, and the kiosk has no
// shell, so "what am I running and is it current?" can only be answered by the
// app itself. Identity is stamped into the image at build time (see Dockerfile)
// and compared here against the repo's HEAD on GitHub.

// Read lazily, never at module scope: index.ts calls dotenv.config() *after*
// its imports have been evaluated, so anything captured at import time misses
// everything in server/.env. Harmless under Docker (env_file puts it all in the
// real process env) and silently wrong under `npm run dev`.
const gitSha       = () => (process.env['GIT_SHA'] ?? '').trim()
const githubRepo   = () => process.env['GITHUB_REPO']   ?? 'DanielMartinez98/touchsphere-dashboard'
const githubBranch = () => process.env['GITHUB_BRANCH'] ?? 'main'
// Optional. Unauthenticated GitHub API calls are limited to 60/hour per IP,
// which the 5-minute cache below keeps us far beneath — a token is only worth
// setting if this server shares an outbound IP with other API consumers.
const githubToken  = () => process.env['GITHUB_TOKEN'] ?? ''

// Written by the final Dockerfile layer. The env var takes precedence so a
// non-Docker deployment can supply it too; absent both (npm run dev) it stays
// null, where "when was this built" isn't a meaningful question anyway.
function buildTime(): string | null {
  const fromEnv = (process.env['BUILD_TIME'] ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    return fs.readFileSync(path.join('/app', '.build-time'), 'utf8').trim() || null
  } catch {
    return null
  }
}

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
  if (githubToken()) headers['authorization'] = `Bearer ${githubToken()}`
  return headers
}

async function fetchLatestCommit(): Promise<GitHubCommit> {
  if (remoteCache && Date.now() - remoteCache.at < REMOTE_TTL_MS) return remoteCache.commit
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const url = `https://api.github.com/repos/${githubRepo()}/commits/${encodeURIComponent(githubBranch())}`
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
    const url = `https://api.github.com/repos/${githubRepo()}/compare/${base}...${head}`
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
  const sha = gitSha()
  res.json({
    sha:      sha || null,
    shortSha: sha ? sha.slice(0, 7) : null,
    builtAt:  buildTime(),
    repo:     githubRepo(),
    branch:   githubBranch(),
  })
})

// GET /api/system/version/check — compare against the repo's HEAD.
//
// Two ways to be sure, in order of confidence:
//   1. gitSha() is stamped in  → compare commits directly (exact, gives a count)
//   2. only buildTime() exists → a build predating the newest commit is behind
// Neither available (dev server) → 'unknown', reported honestly rather than
// guessed at.
router.get('/version/check', async (_req: Request, res: Response) => {
  const sha   = gitSha()
  const built = buildTime()
  try {
    const latest = await fetchLatestCommit()

    let status: 'up-to-date' | 'behind' | 'unknown' = 'unknown'
    let behindBy: number | null = null
    let basis: 'sha' | 'build-time' | 'none' = 'none'

    if (sha && latest.sha) {
      basis  = 'sha'
      status = sha === latest.sha ? 'up-to-date' : 'behind'
      if (status === 'behind') behindBy = await fetchBehindBy(sha, latest.sha)
    } else if (built && latest.date) {
      basis  = 'build-time'
      const builtMs     = Date.parse(built)
      const committedMs = Date.parse(latest.date)
      status = Number.isFinite(builtMs) && Number.isFinite(committedMs)
        ? (builtMs >= committedMs ? 'up-to-date' : 'behind')
        : 'unknown'
    }

    console.log(`[system] version check: ${status} (basis=${basis}${behindBy !== null ? `, behind ${behindBy}` : ''})`)
    res.json({
      status,
      basis,
      behindBy,
      current: { sha: sha || null, shortSha: sha ? sha.slice(0, 7) : null, builtAt: built },
      latest:  { ...latest, shortSha: latest.sha.slice(0, 7) },
      repo:    githubRepo(),
      branch:  githubBranch(),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[system] version check failed:', detail)
    res.status(502).json({ error: 'update check failed', detail })
  }
})

// GET /api/system/check/elevenlabs — is the key actually accepted?
//
// The shape check in config/keys.ts only catches a key pasted from the wrong
// place. Revoked keys, deleted accounts and exhausted quota all look perfectly
// well-formed and fail identically at request time — and because TTS silently
// falls through to espeak while STT has no fallback at all, the first symptom
// is "she stopped hearing me" with nothing anywhere saying why. So this asks
// ElevenLabs directly. /v1/user is the cheapest authenticated endpoint they
// expose: no synthesis, no quota consumed, no audio required.
router.get('/check/elevenlabs', async (_req: Request, res: Response) => {
  const key = (process.env['ELEVENLABS_API_KEY'] ?? '').trim()
  if (!key) {
    return res.status(502).json({ error: 'ELEVENLABS_API_KEY not set — voice input is disabled' })
  }
  if (elevenLabsKeyState() === 'malformed') {
    return res.status(502).json({ error: `malformed key (starts with "${key.slice(0, 3)}…", expected "sk_")` })
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const upstream = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key },
      signal: ctrl.signal,
    })
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '')
      // ElevenLabs nests the useful bit; surface it rather than a bare status.
      let reason = `HTTP ${upstream.status}`
      try {
        const j = JSON.parse(body) as { detail?: { message?: string } | string }
        const msg = typeof j.detail === 'string' ? j.detail : j.detail?.message
        if (msg) reason += ` — ${msg}`
      } catch { /* non-JSON body */ }
      console.warn(`[system] elevenlabs check failed: ${reason}`)
      return res.status(502).json({ error: reason })
    }
    const json = await upstream.json() as {
      subscription?: { tier?: string; character_count?: number; character_limit?: number }
    }
    const sub = json.subscription
    const used = sub?.character_count
    const cap  = sub?.character_limit
    // Quota is reported, not judged: a key at 100% is authentic but will still
    // fail every synthesis, and that distinction matters when reading this.
    res.json({
      ok: true,
      tier: sub?.tier ?? null,
      charactersUsed: used ?? null,
      characterLimit: cap ?? null,
      quotaExhausted: typeof used === 'number' && typeof cap === 'number' && used >= cap,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[system] elevenlabs check error:', detail)
    res.status(502).json({ error: `unreachable — ${detail}` })
  } finally {
    clearTimeout(timer)
  }
})

// All active SSE clients waiting for server events.
/**
 * Every open dashboard, with what kind of screen it is. `kiosk` is the wall
 * (or any full dashboard); `companion` is a phone acting as its remote. The
 * role rides on the connection URL (see client useServerEvents) so a frame
 * meant for the wall — "play this", "pause" — never reaches the phone that
 * asked for it.
 */
export type ClientRole = 'kiosk' | 'companion'
const sseClients = new Map<Response, ClientRole>()

/** How many kiosks are listening — the phone shows "no kiosk online" from this. */
export function kioskCount(): number {
  let n = 0
  for (const role of sseClients.values()) if (role === 'kiosk') n++
  return n
}

// GET /api/system/events?role=  — SSE stream for real-time server → client signals.
router.get('/events', (req: Request, res: Response) => {
  const role: ClientRole = req.query['role'] === 'companion' ? 'companion' : 'kiosk'
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Heartbeat every 25 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

  sseClients.set(res, role)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
  })
})

/**
 * Push a named event to every connected dashboard. Used for anything the server
 * finishes on its own schedule and the client can't know to ask about — the
 * restart signal below, and guide generation progress (see guide-generator.ts).
 * Silently drops clients whose socket has already gone away.
 */
export function broadcast(event: string, data: unknown = {}, only?: ClientRole): void {
  if (sseClients.size === 0) return
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const [client, role] of sseClients) {
    if (only && role !== only) continue
    try { client.write(frame) } catch { sseClients.delete(client) }
  }
}

// GET /api/system/debug — runtime + config summary for the in-app Debug panel.
// Secrets are reported as booleans only; never echo key material.
router.get('/debug', (_req: Request, res: Response) => {
  const env = process.env

  // Config problems a presence check can't see. A green "set" chip next to a
  // key the upstream rejects is worse than no chip at all — it actively steers
  // debugging away from the actual fault.
  const warnings: string[] = []
  if (elevenLabsKeyState() === 'malformed') {
    warnings.push('ELEVENLABS_API_KEY is set but malformed — ElevenLabs keys start with "sk_". Voice input (STT) will fail on every utterance; TTS falls back to espeak-ng.')
  }

  res.json({
    warnings,
    uptimeSec: Math.floor(process.uptime()),
    node:      process.version,
    platform:  `${process.platform}/${process.arch}`,
    nodeEnv:   env['NODE_ENV'] ?? 'development',
    cacheDir:  env['CACHE_DIR'] ?? '(default)',
    config: {
      OPENWEATHER_API_KEY: !!env['OPENWEATHER_API_KEY'],
      CALENDAR_ICAL_URL:   !!env['CALENDAR_ICAL_URL'],
      // Deliberately validity, not presence — a malformed key is not "set" in
      // any sense the reader of this panel cares about.
      ELEVENLABS_API_KEY:  elevenLabsKeyState() === 'ok',
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
    broadcast('reload')
  }, 100)
})

export default router
