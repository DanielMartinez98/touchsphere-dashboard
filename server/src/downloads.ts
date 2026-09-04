// Why is this download stuck, and what should be done about it?
//
// The Downloads tab used to show a state word ("stalled") and a percentage,
// which names the symptom and answers nothing. Every genuinely useful answer
// is already somewhere in the stack — qBittorrent knows the tracker replied
// "unregistered torrent", Sonarr knows the import failed because the file was
// already imported, the transfer info knows the VPN has no forwarded port —
// but it is spread over four services and none of them is the one you are
// looking at.
//
// So this module is the join: it takes what every service says about one
// torrent and produces ONE sentence about what is wrong, one about what to do,
// and the specific actions that would do it. The panel renders that; the voice
// tool reads it out. There is no machine learning here and nothing is guessed:
// each rule below fires on facts, and when nothing fires the verdict is "this
// looks fine", which is also an answer.
//
// The rules are ordered by how much they matter — the first that fires wins,
// because a torrent that is both queued and seedless should be reported as
// seedless. Every rule names the evidence it fired on, so a wrong verdict can
// be argued with rather than just disbelieved.

import type { ArrQueueItem, Torrent, TorrentProps, TorrentTracker, StackHealth } from './media-stack'

/** Something the panel can offer to do about a download. */
export type DownloadAction =
  | 'resume' | 'pause'
  | 'recheck'          // verify the pieces on disk
  | 'reannounce'       // ask the trackers again, now
  | 'force-start'      // ignore the queue limits
  | 'top'              // move to the top of the queue
  | 'refresh-import'   // make Sonarr/Radarr re-examine the queue and import
  | 'replace'          // blocklist this release and search for another
  | 'remove'           // out of the client, keep the files
  | 'remove-data'      // out of the client, delete the files

export type DownloadLevel = 'ok' | 'working' | 'info' | 'warn' | 'error'

export interface Advice {
  level: DownloadLevel
  /** What is happening, in one clause: "No seeders". */
  headline: string
  /** Why it is happening and what to do, in a sentence or two. */
  detail: string
  /** What the panel offers, most useful first. */
  actions: DownloadAction[]
  /** The facts this verdict was reached from, so it can be checked. */
  evidence: string[]
}

/** Everything known about one torrent, from every service that knows anything. */
export interface DownloadFacts {
  torrent: Torrent
  arr?: ArrQueueItem | undefined
  props?: TorrentProps | undefined
  trackers?: TorrentTracker[] | undefined
  stack?: StackHealth | undefined
}

const HOUR = 3600_000
const MIN = 60_000

function ageMs(unixSeconds: number): number {
  return unixSeconds > 0 ? Date.now() - unixSeconds * 1000 : 0
}

function humanAge(ms: number): string {
  const h = ms / HOUR
  if (h < 1) return `${Math.max(1, Math.round(ms / MIN))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} days`
}

function pct(n: number): string { return `${Math.round(n * 100)}%` }

/**
 * The real trackers, excluding qBittorrent's three pseudo-entries for DHT,
 * PeX and LSD — which always report status 0 and would otherwise read as
 * "three trackers are disabled".
 */
export function realTrackers(list: TorrentTracker[] | undefined): TorrentTracker[] {
  return (list ?? []).filter(t => !/^\*\*\s*\[/.test(t.url))
}

/** A tracker message worth repeating: it usually says exactly what is wrong. */
function trackerComplaint(list: TorrentTracker[] | undefined): string {
  for (const t of realTrackers(list)) {
    const m = (t.msg ?? '').trim()
    // status 4 is "not working"; a message on any other status is still worth
    // reading ("unregistered torrent" often arrives on a working tracker).
    if (m && (t.status === 4 || /unregistered|not found|not exist|banned|denied|expired/i.test(m))) return m
  }
  return ''
}

/**
 * What the *arr is waiting on, if anything. `trackedDownloadState` is the
 * field that distinguishes "downloading" from "downloaded but not imported",
 * which is the difference between a slow torrent and a stuck one.
 */
function arrStage(arr: ArrQueueItem | undefined): 'importing' | 'blocked' | 'failed' | 'downloading' | null {
  const s = (arr?.trackedState ?? '').toLowerCase()
  if (!s) return null
  if (s.includes('importpending') || s === 'importing') return 'importing'
  if (s.includes('importblocked') || s.includes('warning')) return 'blocked'
  if (s.includes('fail')) return 'failed'
  return 'downloading'
}

/**
 * One verdict for one download. Rules are in order of severity: the first
 * that fires is the answer, so a torrent that is both queued behind others
 * and has no seeders is reported as having no seeders.
 */
export function diagnose(f: DownloadFacts): Advice {
  const t = f.torrent
  const age = ageMs(t.addedOn)
  const trackers = realTrackers(f.trackers)
  const complaint = trackerComplaint(f.trackers)
  const stage = arrStage(f.arr)
  const ev: string[] = [`qBittorrent state "${t.state}"`, `${pct(t.progress)} of ${(t.size / 1e9).toFixed(2)} GB`]
  if (t.addedOn) ev.push(`added ${humanAge(age)} ago`)
  if (trackers.length) ev.push(`${trackers.filter(x => x.status === 2).length}/${trackers.length} trackers working`)
  if (f.arr?.trackedState) ev.push(`${f.arr.kind === 'show' ? 'Sonarr' : 'Radarr'} state "${f.arr.trackedState}"`)

  // ── Broken outright ──────────────────────────────────────────────────────
  if (t.phase === 'error' || /error|missingFiles/i.test(t.state)) {
    const missing = /missingFiles/i.test(t.state)
    return {
      level: 'error',
      headline: missing ? 'The files are missing' : 'qBittorrent reports an error',
      detail: missing
        ? 'The data this torrent was written to is no longer where qBittorrent left it — a moved or unmounted drive, or files deleted by hand. Force a recheck: if the data really is gone it will restart the download, and if the drive simply came back it will pick up where it was.'
        : `qBittorrent could not continue${complaint ? ` — the tracker says "${complaint}"` : ''}. A recheck usually clears a transient one; if it comes straight back, replace the release.`,
      actions: ['recheck', 'replace', 'remove-data'],
      evidence: ev,
    }
  }

  if (f.arr?.note && /already imported|already exists/i.test(f.arr.note)) {
    return {
      level: 'warn',
      headline: 'Already in the library',
      detail: `${f.arr.kind === 'show' ? 'Sonarr' : 'Radarr'} will not import this because the episode or film is already there. Nothing is wrong with the download — it is simply redundant. Remove it and its files; the copy in the library stays.`,
      actions: ['remove-data', 'remove'],
      evidence: [...ev, `import note: ${f.arr.note}`],
    }
  }

  if (stage === 'failed') {
    return {
      level: 'error',
      headline: 'The import failed',
      detail: `${f.arr?.kind === 'show' ? 'Sonarr' : 'Radarr'} downloaded this but could not move it into the library${f.arr?.note ? ` — "${f.arr.note}"` : ''}. Usually a permissions problem on the destination, a full disk, or a release the *arr will not accept. Replace it to blocklist this release and grab another.`,
      actions: ['replace', 'refresh-import', 'remove-data'],
      evidence: ev,
    }
  }

  if (stage === 'blocked') {
    return {
      level: 'warn',
      headline: 'The import is blocked',
      detail: `The file is downloaded, but ${f.arr?.kind === 'show' ? 'Sonarr' : 'Radarr'} is refusing to import it${f.arr?.note ? `: "${f.arr.note}"` : ''}. Common causes are a sample file, a release the quality profile rejects, or an episode it cannot map. "Try importing again" makes it re-examine the queue; if that does nothing, replace the release.`,
      actions: ['refresh-import', 'replace', 'remove-data'],
      evidence: ev,
    }
  }

  // ── Finished downloading, waiting on the *arr ─────────────────────────────
  if (t.progress >= 1 && stage === 'importing') {
    const slow = age > 2 * HOUR
    return {
      level: slow ? 'warn' : 'working',
      headline: slow ? 'Waiting to be imported, for a while now' : 'Waiting to be imported',
      detail: slow
        ? `The download finished but it has been queued for import for ${humanAge(age)}. The *arr normally scans every minute, so this usually means it is waiting for the torrent to stop seeding, or the file is on a path it cannot see. "Try importing again" forces a scan.`
        : 'The download is complete and the *arr is about to move it into the library. Nothing to do.',
      actions: slow ? ['refresh-import', 'replace', 'remove-data'] : ['refresh-import'],
      evidence: ev,
    }
  }

  // ── Not moving ───────────────────────────────────────────────────────────
  if (t.phase === 'paused') {
    return {
      level: 'info',
      headline: 'Paused',
      detail: 'This is stopped, by you or by qBittorrent. Resume it to carry on.',
      actions: ['resume', 'remove-data'],
      evidence: ev,
    }
  }

  if (/^metaDL/i.test(t.state)) {
    const stuck = age > 20 * MIN
    return {
      level: stuck ? 'warn' : 'working',
      headline: stuck ? 'Cannot fetch the torrent details' : 'Fetching the torrent details',
      detail: stuck
        ? `This was added as a magnet link and, ${humanAge(age)} later, no peer has sent the metadata. Either nobody is sharing it or the client cannot reach the swarm at all — if several downloads are in this state at once it is the connection, not the releases. Ask the trackers again; if that does nothing and the rest of the queue is healthy, replace it.`
        : 'A magnet link asks the swarm what the torrent contains before anything downloads. This normally takes seconds.',
      actions: stuck ? ['reannounce', 'replace', 'remove'] : ['reannounce'],
      evidence: ev,
    }
  }

  if (t.phase === 'queued') {
    const max = f.stack?.maxActiveDownloads ?? 0
    return {
      level: 'info',
      headline: 'Waiting its turn',
      detail: max > 0
        ? `qBittorrent runs ${max} download${max === 1 ? '' : 's'} at a time and this one is in the line. Force-start it to skip the queue, or move it to the top so it goes next.`
        : 'qBittorrent has this queued behind others. Force-start it to skip the queue, or move it to the top.',
      actions: ['force-start', 'top', 'remove'],
      evidence: ev,
    }
  }

  if (t.phase === 'checking') {
    return {
      level: 'working',
      headline: 'Checking the files',
      detail: 'qBittorrent is verifying what is already on disk. Leave it; it will carry on by itself.',
      actions: [],
      evidence: ev,
    }
  }

  // ── Downloading, or claiming to be ───────────────────────────────────────
  //
  // `seeds` is how many seeders this client is CONNECTED to; `swarmSeeds` is
  // how many the tracker says exist. Reading the first as "there are no
  // seeders" is the mistake this file was written to stop: a swarm with forty
  // seeders and nothing connected is a connection problem, and telling
  // someone to blocklist forty perfectly good releases would be wrong and
  // expensive. Where the swarm count is unknown (0 from a tracker that never
  // answered) the connected count is all there is, and the wording stays
  // hedged accordingly.
  const seeds = t.seeds
  const swarm = t.swarmSeeds ?? 0
  const reachable = swarm > 0 && seeds === 0
  const dead = trackers.length > 0 && trackers.every(x => x.status === 4)

  if (t.phase === 'stalled' || (t.phase === 'downloading' && t.dlspeed === 0)) {
    if (complaint && /unregistered|not found|not exist/i.test(complaint)) {
      return {
        level: 'error',
        headline: 'The tracker has dropped this torrent',
        detail: `The tracker replies "${complaint}", which means the release has been removed from the site. It will never finish. Replace it: the same episode or film is blocklisted and searched for again.`,
        actions: ['replace', 'remove-data'],
        evidence: ev,
      }
    }
    if (dead) {
      return {
        level: 'error',
        headline: 'No tracker is answering',
        detail: `Every tracker for this torrent is failing${complaint ? ` ("${complaint}")` : ''}. With no tracker and no peers from DHT, nothing can be found to download from. Ask them again in case it is temporary, then replace it.`,
        actions: ['reannounce', 'replace', 'remove-data'],
        evidence: ev,
      }
    }
    if (reachable) {
      return {
        level: 'error',
        headline: 'Cannot reach the seeders',
        detail: `The tracker says ${swarm} seeder${swarm === 1 ? '' : 's'} ${swarm === 1 ? 'has' : 'have'} this file, and none of them is connected. The release is fine — this box cannot open peer connections. Behind a VPN that is a missing forwarded port or a blocked peer port; it is not something replacing the torrent will fix.`,
        actions: ['reannounce', 'pause'],
        evidence: [...ev, `${swarm} seeders in the swarm, ${seeds} connected`],
      }
    }
    if (seeds === 0) {
      const hopeless = age > 24 * HOUR
      return {
        level: hopeless ? 'error' : 'warn',
        headline: 'No seeders',
        detail: hopeless
          ? `Nobody has been sharing this for ${humanAge(age)} and it is ${pct(t.progress)} done, and the tracker lists none in the swarm either. It is not going to finish. Replace it — the release is blocklisted so the *arr picks a different one.`
          : `Nobody in the swarm has the rest of this file right now. It may recover on its own; asking the trackers again sometimes finds peers they had not reported. If it stays at ${pct(t.progress)} for a day, replace it.`,
        actions: hopeless ? ['replace', 'remove-data', 'reannounce'] : ['reannounce', 'replace'],
        evidence: ev,
      }
    }
    if (f.stack?.connection === 'firewalled') {
      return {
        level: 'warn',
        headline: 'Peers cannot reach this box',
        detail: `${seeds} seeder${seeds === 1 ? '' : 's'} exist but nothing is arriving, and qBittorrent reports the connection as firewalled — no forwarded port. Behind a VPN that is normal and usually still works through outgoing connections, but it makes slow torrents much slower. Forwarding a port in the VPN container is the real fix.`,
        actions: ['reannounce', 'replace'],
        evidence: [...ev, 'connection status: firewalled'],
      }
    }
    return {
      level: 'warn',
      headline: 'Stalled',
      detail: `There ${seeds === 1 ? 'is 1 seeder' : `are ${seeds} seeders`} but nothing is downloading. Usually the peers are throttling, or the connection has gone. Ask the trackers again; if it stays like this, replace the release.`,
      actions: ['reannounce', 'replace', 'recheck'],
      evidence: ev,
    }
  }

  if (t.phase === 'downloading') {
    const slow = t.dlspeed > 0 && t.dlspeed < 50_000 && seeds > 0
    if (f.stack?.altSpeed) {
      return {
        level: 'info',
        headline: 'Downloading, speed-limited',
        detail: 'This is moving, but qBittorrent has its alternative (slow) speed limits switched on, which caps every torrent. Turn them off in qBittorrent if you did not mean to leave them on.',
        actions: ['top'],
        evidence: [...ev, 'alternative speed limits are on'],
      }
    }
    if (slow) {
      return {
        level: 'info',
        headline: 'Downloading slowly',
        detail: `${(t.dlspeed / 1000).toFixed(0)} kB/s from ${seeds} seeder${seeds === 1 ? '' : 's'}. Few or distant peers. Moving it to the top of the queue gives it the bandwidth first; otherwise leave it.`,
        actions: ['top', 'reannounce'],
        evidence: ev,
      }
    }
    return {
      level: 'ok',
      headline: 'Downloading',
      detail: 'This is moving as it should.',
      actions: ['pause'],
      evidence: ev,
    }
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  if (t.phase === 'seeding' || t.phase === 'done') {
    const imported = !f.arr
    const ratioOk = t.ratio >= 1
    return {
      level: 'ok',
      headline: t.phase === 'seeding' ? 'Seeding' : 'Finished',
      detail: imported
        ? `This is done and the *arr is no longer tracking it, so it is in the library. ${ratioOk ? `It has given back ${t.ratio.toFixed(2)}×, so removing it costs the swarm nothing.` : `It has only given back ${t.ratio.toFixed(2)}×; leaving it seeding is the polite thing, and on a private tracker often the required thing.`}`
        : 'The download is complete and the *arr still has it in the queue — it should import shortly.',
      actions: imported && ratioOk ? ['remove-data', 'remove'] : ['remove'],
      evidence: ev,
    }
  }

  return {
    level: 'info',
    headline: t.state,
    detail: 'Nothing about this looks wrong, and no rule here recognises the state qBittorrent is reporting.',
    actions: [],
    evidence: ev,
  }
}

/** Whole-stack problems: the ones that explain several stuck rows at once. */
export interface StackAdvice { level: DownloadLevel; headline: string; detail: string }

export function diagnoseStack(h: StackHealth | undefined, torrents: Torrent[]): StackAdvice[] {
  const out: StackAdvice[] = []
  if (!h) return out

  if (h.connection === 'disconnected') {
    out.push({
      level: 'error',
      headline: 'qBittorrent has no connection',
      detail: 'It cannot reach the internet at all. Behind a VPN container this is what a dropped tunnel looks like — restart the VPN container and qBittorrent will follow.',
    })
  } else if (h.connection === 'firewalled') {
    out.push({
      level: 'warn',
      headline: 'No incoming connections',
      detail: 'qBittorrent is firewalled: no peer can start a connection to this box, so only outgoing ones work. Downloads still happen but slowly, and seeding barely at all. Forwarding a port through the VPN is the fix.',
    })
  }

  if (h.altSpeed) {
    const down = h.altDownKB > 0 ? `${h.altDownKB} kB/s down` : 'no download cap'
    const up = h.altUpKB > 0 ? `${h.altUpKB} kB/s up` : 'no upload cap'
    out.push({
      level: h.altDownKB > 0 && h.altDownKB < 500 ? 'error' : 'warn',
      headline: `Alternative speed limits are on (${down}, ${up})`,
      detail: h.altDownKB > 0 && h.altDownKB < 500
        ? `Every torrent is throttled to ${h.altDownKB} kB/s between them, which is why nothing is finishing. Turn the alternative limits off in qBittorrent — the toggle at the bottom of its window, or a schedule that switched them on and never switched them back.`
        : 'Every torrent is capped at the alternative rate, whether by a schedule or by the toggle being left on in qBittorrent.',
    })
  }

  if (h.freeSpaceGB !== null && h.freeSpaceGB < 20) {
    const need = torrents.filter(t => t.progress < 1).reduce((n, t) => n + (t.size - t.downloaded), 0) / 1e9
    out.push({
      level: h.freeSpaceGB < 5 ? 'error' : 'warn',
      headline: `${h.freeSpaceGB.toFixed(0)} GB left on the download disk`,
      detail: need > h.freeSpaceGB
        ? `What is still downloading needs about ${need.toFixed(0)} GB, which is more than there is. Some of these will fail on write. Remove what you do not want, with its files.`
        : 'Space is getting short. Removing finished torrents that have already been imported frees it without losing anything from the library.',
    })
  }

  // The distinction that matters: torrents whose swarm HAS seeders that this
  // box has connected to none of. A handful is bad luck; dozens is one fault.
  const live = torrents.filter(t => t.phase === 'stalled' || t.phase === 'downloading' || /metaDL/i.test(t.state))
  const unreachable = live.filter(t => (t.swarmSeeds ?? 0) > 0 && t.seeds === 0).length
  const seedless = live.filter(t => (t.swarmSeeds ?? 0) === 0 && t.seeds === 0).length

  if (unreachable >= 3) {
    out.push({
      level: 'error',
      headline: `${unreachable} downloads cannot reach their seeders`,
      detail: 'The trackers list seeders for these and not one is connected, which is a single fault in this box rather than that many dead releases. Behind a VPN it is almost always the peer port: forward one in the VPN container and set qBittorrent to use it. Do not replace these — the releases are fine.',
    })
  }
  if (seedless >= 3) {
    out.push({
      level: 'warn',
      headline: `${seedless} downloads have no seeders at all`,
      detail: 'The trackers list nobody sharing these. If the rest of the queue is downloading normally they really are dead and want replacing; if nothing at all is moving, fix the connection first.',
    })
  }
  return out
}

/** A one-line summary of a verdict, for the assistant to read out. */
export function adviceLine(name: string, a: Advice): string {
  return `${name}: ${a.headline}. ${a.detail}`
}
