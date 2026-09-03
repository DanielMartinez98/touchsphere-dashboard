// Tools that let the assistant run the media stack by voice.
//
// Same family as the browse, guide-view and image tools: each returns the text
// the model reads back plus an optional `display` payload the client renders —
// here a `plex` kind, which either starts a film on the kiosk or opens the Plex
// corner on a tab. Everything reachable by tapping stays reachable by asking.
//
// Exposed only when MEDIA_PLEX_URL/TOKEN are set, for the reason IMAGE_TOOLS
// is: there is no fallback behind these, and a model that can see `play_media`
// will promise a film no server can serve.
//
// Every tool takes a TITLE, never an id or a path. The model resolves nothing;
// the server searches the library (or TMDB through Seerr) and picks, so the
// only thing a language model can hand this file is a name to look up.

import {
  plexEnabled, plexSearch, plexLeaves, plexChildren, plexLanguages, plexPlayers, plexPlayOn,
  plexOnDeck, plexRecentlyAdded,
  qbitEnabled, torrents, torrentControl, transferInfo, arrQueue,
  seerrEnabled, seerrSearch, seerrRequest, seerrRequests,
  bazarrEnabled, bazarrWanted,
  type PlexItem, type Torrent,
} from '../media-stack'
import { displayTitle } from './plex'
import type { BrowseToolResult, DisplayPayload } from './browse'

export const PLEX_TOOLS = !plexEnabled() ? [] : [
  {
    type: 'function',
    function: {
      name: 'play_media',
      description:
        'Play a film or an episode from the Plex library, full screen on the dashboard (or on ' +
        'another Plex player in the house if one is named). Use for "play Severance", "put on ' +
        'the next episode of The Bear", "play episode 3 of season 2", "continue the film". ' +
        'For a show with no episode given it resumes where they left off, or starts at the ' +
        'first unwatched episode. The library is searched by title — pass the title as said.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: 'Film or show title, e.g. "Severance", "Dune Part Two".' },
          season:  { type: 'integer', description: 'Season number, if they said one.' },
          episode: { type: 'integer', description: 'Episode number, if they said one.' },
          player:  { type: 'string', description: 'Name of another Plex player to play ON ("the TV", "living room"); leave empty to play here on the dashboard.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'whats_on_plex',
      description:
        'What is in the Plex library. With no query: what they are part-way through and what ' +
        'was added recently — for "what\'s new on Plex", "what were we watching", "anything to ' +
        'watch?". With a query: whether a title is in the library — "do we have Dune?". Opens ' +
        'the Plex corner on screen as well.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A title to look for; empty for the overview.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_languages',
      description:
        'Which audio languages and subtitles a film or show in the Plex library has — "does ' +
        'Dark have the German audio?", "is there a Spanish dub of Bluey?", "what subtitles does ' +
        'Shogun have?". Counts across every episode, so a show missing the dub on some episodes ' +
        'is reported as such. Opens the title on screen too.',
      parameters: {
        type: 'object',
        properties: {
          title:  { type: 'string', description: 'Film or show title.' },
          season: { type: 'integer', description: 'Limit to one season, if they said one.' },
        },
        required: ['title'],
      },
    },
  },
  ...(seerrEnabled() ? [
    {
      type: 'function',
      function: {
        name: 'request_media',
        description:
          'Ask for a film or a show to be ADDED to the library — it is searched on TMDB, and ' +
          'requested through Seerr so Sonarr/Radarr download it. Use for "can you add Fallout", ' +
          '"get me the new Dune", "request season 3 of…". Reports if it is already in the library ' +
          'or already requested instead of requesting twice. If the year is unclear and several ' +
          'titles match, the result lists them — read them out and call keep_listening to ask which.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Title to add.' },
            type:  { type: 'string', enum: ['movie', 'tv'], description: 'Film or show, if they said (or it is obvious).' },
            year:  { type: 'integer', description: 'Release year, if they said one.' },
            season: { type: 'integer', description: 'One season only, if they asked for one; otherwise every season is requested.' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'media_requests',
        description:
          'The recent requests and where each stands (pending, approved, downloading, available) ' +
          '— "did Fallout get added yet?", "what have we requested?". Opens the Requests tab.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ] : []),
  {
    type: 'function',
    function: {
      name: 'download_status',
      description:
        'What is downloading right now — the torrents, with progress, speed and time left, and ' +
        'what film or episode each one is. Use for "how are the downloads", "is Severance done ' +
        'downloading?", "how long until the film is ready?". Opens the Downloads tab.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A title to look for among the downloads, if they asked about one in particular.' },
        },
      },
    },
  },
  ...(qbitEnabled() ? [
    {
      type: 'function',
      function: {
        name: 'control_download',
        description:
          'Pause or resume one download, named by title or torrent name. Only pause and resume — ' +
          'nothing here deletes.',
        parameters: {
          type: 'object',
          properties: {
            name:   { type: 'string', description: 'The title or torrent name.' },
            action: { type: 'string', enum: ['pause', 'resume'] },
          },
          required: ['name', 'action'],
        },
      },
    },
  ] : []),
] as const

// ── Resolution ───────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Best library match for a spoken title: exact (ignoring articles) beats prefix beats first hit. */
async function resolveTitle(title: string): Promise<PlexItem | null> {
  const hits = (await plexSearch(title, 12)).filter(h => h.type === 'movie' || h.type === 'show')
  if (!hits.length) return null
  const want = norm(title)
  return hits.find(h => norm(h.title) === want)
    ?? hits.find(h => norm(h.title).startsWith(want))
    ?? hits[0]!
}

/** The episode to play for a show: the named one, else where they left off, else the first unwatched. */
async function pickEpisode(show: PlexItem, season?: number, episode?: number): Promise<PlexItem | null> {
  const leaves = await plexLeaves(show.key)
  if (!leaves.length) return null
  if (season !== undefined && episode !== undefined) {
    return leaves.find(e => e.parentIndex === season && e.index === episode) ?? null
  }
  const pool = season !== undefined ? leaves.filter(e => e.parentIndex === season) : leaves
  return pool.find(e => e.viewOffset) ?? pool.find(e => !e.viewCount) ?? pool[0] ?? null
}

function openPanel(tab: 'library' | 'downloads' | 'requests', title: string, extra: { key?: string; query?: string } = {}): DisplayPayload {
  return { kind: 'plex', action: 'open', tab, title, ...extra }
}

// ── Tools ────────────────────────────────────────────────────────────────────

async function playMedia(title: string, season?: number, episode?: number, playerName?: string): Promise<BrowseToolResult> {
  if (!title.trim()) return { text: 'play_media needs a title.', display: null }
  const hit = await resolveTitle(title)
  if (!hit) return { text: `"${title}" isn't in the Plex library. Offer to request it if that would help.`, display: null }
  let target: PlexItem | null = hit
  if (hit.type === 'show') {
    target = await pickEpisode(hit, season, episode)
    if (!target) {
      return { text: season !== undefined ? `${hit.title} has no season ${season}${episode !== undefined ? ` episode ${episode}` : ''} in the library.` : `${hit.title} has no episodes in the library yet.`, display: null }
    }
  }
  const label = displayTitle(target)
  const resume = target.viewOffset ? ` (resuming at ${Math.round(target.viewOffset / 60000)} min)` : ''

  if (playerName) {
    const players = await plexPlayers()
    const want = norm(playerName)
    const player = players.find(p => norm(p.name) === want) ?? players.find(p => norm(p.name).includes(want) || want.includes(norm(p.name)))
    if (!player) {
      const names = players.map(p => p.name).join(', ')
      return { text: `No Plex player called "${playerName}" is on the network${names ? ` — the ones visible are: ${names}` : ''}. Playing here on the dashboard instead is possible; ask, or call again without a player.`, display: null }
    }
    await plexPlayOn(player.id, target.key, target.viewOffset ?? 0)
    return { text: `Started ${label} on ${player.name}${resume}.`, display: null }
  }
  return {
    text: `Playing ${label} full screen on the dashboard${resume}. Keep the reply to a few words — the film starts as you speak.`,
    display: { kind: 'plex', action: 'play', key: target.key, title: label },
  }
}

function fmtItem(i: PlexItem): string {
  if (i.type === 'episode') return displayTitle(i)
  if (i.type === 'season') return `${i.parentTitle ?? ''} ${i.title}`.trim()
  return i.year ? `${i.title} (${i.year})` : i.title
}

async function whatsOn(query: string): Promise<BrowseToolResult> {
  if (query.trim()) {
    const hits = (await plexSearch(query, 8)).filter(h => h.type !== 'season')
    if (!hits.length) return { text: `Nothing called "${query}" is in the library.${seerrEnabled() ? ' It can be requested with request_media.' : ''}`, display: openPanel('library', query, { query }) }
    const top = hits[0]!
    const progress = top.type === 'show' && top.leafCount ? ` — ${top.viewedLeafCount ?? 0} of ${top.leafCount} episodes watched` : top.viewOffset ? ' — part-watched' : ''
    return {
      text: `In the library: ${hits.slice(0, 5).map(fmtItem).join('; ')}.${progress}`,
      display: openPanel('library', top.title, { key: top.key }),
    }
  }
  const [deck, recent] = await Promise.all([plexOnDeck(6), plexRecentlyAdded(8)])
  const parts: string[] = []
  if (deck.length) parts.push(`Continue watching: ${deck.map(fmtItem).join('; ')}.`)
  if (recent.length) parts.push(`Recently added: ${recent.map(fmtItem).join('; ')}.`)
  return { text: parts.join(' ') || 'The library is empty.', display: openPanel('library', 'Plex') }
}

function listLangs(count: Record<string, number>, files: number): string {
  const entries = Object.entries(count)
  if (!entries.length) return 'none'
  return entries.map(([lang, n]) => n === files ? lang : `${lang} (${n} of ${files})`).join(', ')
}

async function mediaLanguages(title: string, season?: number): Promise<BrowseToolResult> {
  if (!title.trim()) return { text: 'media_languages needs a title.', display: null }
  const hit = await resolveTitle(title)
  if (!hit) return { text: `"${title}" isn't in the Plex library.`, display: null }
  let key = hit.key
  let label = fmtItem(hit)
  if (hit.type === 'show' && season !== undefined) {
    const s = (await plexChildren(hit.key)).find(c => c.index === season)
    if (!s) return { text: `${hit.title} has no season ${season} in the library.`, display: openPanel('library', hit.title, { key: hit.key }) }
    key = s.key; label = `${hit.title} season ${season}`
  }
  const langs = await plexLanguages(key)
  if (!langs) return { text: `Couldn't read ${label}.`, display: null }
  const { summary } = langs
  const unit = hit.type === 'movie' ? 'file' : 'episode'
  const files = summary.files
  let text = `${label} (${files} ${unit}${files === 1 ? '' : 's'}): audio — ${listLangs(summary.audioCount, files)}; subtitles — ${listLangs(summary.subtitleCount, files)}.`
  if (bazarrEnabled() && (hit.type === 'show' || hit.type === 'movie')) {
    try {
      const w = await bazarrWanted(hit.type, hit.title, hit.year)
      if (w?.missing.length) text += ` Still being searched for: ${w.missing.join(', ')}.`
    } catch { /* optional enrichment */ }
  }
  return { text, display: openPanel('library', hit.title, { key: hit.key }) }
}

function fmtEta(sec: number): string {
  if (sec >= 8640000 || sec < 0) return 'unknown time left'
  if (sec < 60) return 'under a minute'
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
}

function fmtSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  if (bps >= 1000) return `${Math.round(bps / 1000)} kB/s`
  return `${bps} B/s`
}

function fmtTorrent(t: Torrent): string {
  const name = t.label ?? t.name
  const pct = Math.round(t.progress * 100)
  switch (t.phase) {
    case 'downloading': return `${name}: ${pct}% at ${fmtSpeed(t.dlspeed)}, ${fmtEta(t.eta)}`
    case 'stalled':     return `${name}: ${pct}%, stalled (no peers)`
    case 'paused':      return `${name}: ${pct}%, paused`
    case 'queued':      return `${name}: queued`
    case 'checking':    return `${name}: checking files`
    case 'error':       return `${name}: error`
    default:            return `${name}: finished${t.phase === 'seeding' ? ', seeding' : ''}`
  }
}

async function downloadStatus(query: string): Promise<BrowseToolResult> {
  const display = openPanel('downloads', 'Downloads')
  if (!qbitEnabled()) {
    const q = [...(await arrQueue()).values()]
    if (!q.length) return { text: 'Nothing is downloading.', display }
    return { text: `Downloading (${q.length}): ${q.map(x => x.title).join('; ')}. Speeds aren\'t available — qBittorrent isn\'t connected to the dashboard.`, display }
  }
  let list: Torrent[]
  let transfer
  try { [list, transfer] = await Promise.all([torrents(), transferInfo()]) }
  catch (err) { return { text: `Couldn't reach qBittorrent: ${err instanceof Error ? err.message : err}`, display } }
  if (query.trim()) {
    const want = norm(query)
    const hits = list.filter(t => norm(t.label ?? '').includes(want) || norm(t.name).includes(want))
    if (!hits.length) return { text: `No download matches "${query}".`, display }
    return { text: hits.slice(0, 5).map(fmtTorrent).join('. ') + '.', display }
  }
  const active = list.filter(t => t.phase !== 'done' && t.phase !== 'seeding')
  if (!active.length) {
    const seeding = list.filter(t => t.phase === 'seeding').length
    return { text: `Nothing is downloading${seeding ? ` (${seeding} seeding)` : ''}.`, display }
  }
  const total = transfer.dlspeed ? ` Total ${fmtSpeed(transfer.dlspeed)} down.` : ''
  return { text: `${active.length} download${active.length === 1 ? '' : 's'}: ${active.slice(0, 6).map(fmtTorrent).join('; ')}.${total}`, display }
}

async function controlDownload(name: string, action: string): Promise<BrowseToolResult> {
  if (action !== 'pause' && action !== 'resume') return { text: 'action must be pause or resume.', display: null }
  const want = norm(name)
  const list = await torrents()
  const hit = list.find(t => norm(t.label ?? '') === want || norm(t.name) === want)
    ?? list.find(t => norm(t.label ?? '').includes(want) || norm(t.name).includes(want))
  if (!hit) return { text: `No download matches "${name}".`, display: openPanel('downloads', 'Downloads') }
  await torrentControl(hit.hash, action)
  return { text: `${action === 'pause' ? 'Paused' : 'Resumed'} ${hit.label ?? hit.name}.`, display: openPanel('downloads', 'Downloads') }
}

const STATUS_WORD: Record<string, string> = {
  unknown: 'not requested', pending: 'requested, waiting for approval', processing: 'approved, downloading',
  partial: 'partly available', available: 'already in the library',
}

async function requestMedia(title: string, type: string, year?: number, season?: number): Promise<BrowseToolResult> {
  if (!title.trim()) return { text: 'request_media needs a title.', display: null }
  const display = openPanel('requests', 'Requests')
  let results = await seerrSearch(title, 10)
  if (type === 'movie' || type === 'tv') results = results.filter(r => r.mediaType === type)
  if (!results.length) return { text: `Nothing called "${title}" on TMDB.`, display }
  const want = norm(title)
  let exact = results.filter(r => norm(r.title) === want)
  if (year !== undefined) exact = exact.filter(r => r.year === year)
  const pick = exact.length === 1 ? exact[0]! : exact.length === 0 ? results[0]! : null
  if (!pick) {
    // Several titles share the name (a film and its remake, a show and its US
    // version): don't guess with someone else's disk space.
    const options = exact.slice(0, 4).map(r => `${r.title} (${r.year ?? '?'}, ${r.mediaType === 'tv' ? 'show' : 'film'}${r.status !== 'unknown' ? `, ${STATUS_WORD[r.status]}` : ''})`)
    return { text: `Several match: ${options.join('; ')}. Ask which one they mean (keep_listening), then call request_media again with the year and type.`, display }
  }
  const label = `${pick.title}${pick.year ? ` (${pick.year})` : ''}`
  if (pick.status === 'available') return { text: `${label} is already in the Plex library — no request needed.`, display }
  if (pick.status === 'pending' || pick.status === 'processing') return { text: `${label} is ${STATUS_WORD[pick.status]} — no need to request it again.`, display }
  try {
    const req = await seerrRequest(pick.mediaType, pick.tmdbId, season !== undefined ? [season] : undefined)
    const what = pick.mediaType === 'tv' ? (season !== undefined ? `season ${season} of ${label}` : `every season of ${label}`) : label
    const state = req.requestStatus === 'approved' ? 'approved automatically and sent to download' : 'waiting for approval'
    return { text: `Requested ${what} — ${state}.`, display }
  } catch (err) {
    const detail = (err as { response?: { data?: { message?: string } } }).response?.data?.message
    return { text: `Couldn't request ${label}: ${detail ?? (err instanceof Error ? err.message : err)}`, display }
  }
}

async function mediaRequests(): Promise<BrowseToolResult> {
  const display = openPanel('requests', 'Requests')
  const list = await seerrRequests(10)
  if (!list.length) return { text: 'No requests on record.', display }
  const line = (r: typeof list[number]) => {
    const where = r.requestStatus === 'declined' ? 'declined' : r.status === 'unknown' ? STATUS_WORD[r.requestStatus === 'pending' ? 'pending' : 'processing'] : STATUS_WORD[r.status]
    return `${r.title}${r.year ? ` (${r.year})` : ''}: ${where}`
  }
  return { text: `Recent requests: ${list.map(line).join('; ')}.`, display }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function runPlexTool(name: string, args: Record<string, unknown>): Promise<BrowseToolResult | null> {
  if (!plexEnabled()) return null
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const int = (k: string) => {
    const v = args[k]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isInteger(n) && n >= 0 ? n : undefined
  }
  try {
    switch (name) {
      case 'play_media':       return await playMedia(str('title'), int('season'), int('episode'), str('player') || undefined)
      case 'whats_on_plex':    return await whatsOn(str('query'))
      case 'media_languages':  return await mediaLanguages(str('title'), int('season'))
      case 'download_status':  return await downloadStatus(str('query'))
      case 'control_download': return await controlDownload(str('name'), str('action'))
      case 'request_media':    return await requestMedia(str('title'), str('type'), int('year'), int('season'))
      case 'media_requests':   return await mediaRequests()
      default: return null
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    console.warn(`[plex:tool] ${name} failed:`, m)
    return { text: `That didn't work: ${m}`, display: null }
  }
}
