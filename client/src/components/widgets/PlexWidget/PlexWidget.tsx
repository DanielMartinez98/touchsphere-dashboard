// Top-left collapsed pill for the Plex library.
//
// What it answers at walking distance: is there something to pick back up,
// and is anything on its way. So the second line is the first "continue
// watching" item when there is one, else the download count, else the newest
// arrival — and "Plex offline" when the server can't be reached, said plainly
// here so the tap doesn't open a panel that can't work.

import { useEffect, useState } from 'react'
import { Clapperboard, Download } from 'lucide-react'
import { plexApi, type PlexItem, type PlexStatus } from '../../../hooks/usePlex'

export interface PlexSummary {
  onDeck: PlexItem | null
  recent: PlexItem | null
  downloading: number
}

/**
 * The little the pill needs, on a slow poll: the panel fetches its own, fresher
 * copy when it opens. Only polled while Plex is reachable — a dead server is
 * already being re-probed by usePlexStatus, and two pollers on one outage is
 * one more than needed.
 */
export function usePlexSummary(status: PlexStatus | null): PlexSummary | null {
  const [summary, setSummary] = useState<PlexSummary | null>(null)
  const ok = !!status?.enabled && status.services.plex.ok
  const torrents = !!status?.features.torrents
  useEffect(() => {
    if (!ok) { setSummary(null); return }
    let cancelled = false
    const load = async () => {
      try {
        const [home, dl] = await Promise.all([
          plexApi.home(),
          torrents ? plexApi.torrents().catch(() => null) : Promise.resolve(null),
        ])
        if (cancelled) return
        setSummary({
          onDeck: home.onDeck[0] ?? null,
          recent: home.recent[0] ?? null,
          downloading: dl ? dl.torrents.filter(t => t.phase === 'downloading' || t.phase === 'stalled' || t.phase === 'queued').length : 0,
        })
      } catch { /* keep the last summary */ }
    }
    void load()
    const t = setInterval(() => { void load() }, 2 * 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [ok, torrents])
  return summary
}

function itemLine(i: PlexItem): string {
  if (i.type === 'episode') {
    const se = i.parentIndex !== undefined && i.index !== undefined ? ` S${i.parentIndex}E${i.index}` : ''
    return `${i.grandparentTitle ?? i.title}${se}`
  }
  if (i.type === 'season') return `${i.parentTitle ?? ''} ${i.title}`.trim()
  return i.title
}

export function PlexCollapsed({ status, summary }: { status: PlexStatus | null; summary: PlexSummary | null }) {
  return (
    <>
      <div className="flex items-center gap-2 w-full">
        <Clapperboard size={22} className="text-[#e5a00d]/90 shrink-0" />
        <span className="text-sm font-semibold text-white">Plex</span>
        {summary && summary.downloading > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[13px] text-[#e5a00d] tabular-nums">
            <Download size={14} className="animate-pulse" />{summary.downloading}
          </span>
        )}
      </div>

      {status === null ? (
        <span className="text-[13px] text-ink-dim">…</span>
      ) : !status.enabled ? (
        <span className="text-[13px] text-ink-dim">Not set up</span>
      ) : !status.services.plex.ok ? (
        <span className="text-[13px] text-ink-dim">Plex offline</span>
      ) : summary?.onDeck ? (
        <span className="text-[13px] text-ink-dim leading-tight line-clamp-2 text-left">
          <span className="text-white/60">Continue · </span>{itemLine(summary.onDeck)}
        </span>
      ) : summary?.recent ? (
        <span className="text-[13px] text-ink-dim leading-tight line-clamp-2 text-left">
          <span className="text-white/60">New · </span>{itemLine(summary.recent)}
        </span>
      ) : (
        <span className="text-[13px] text-ink-dim">Tap to browse</span>
      )}
    </>
  )
}
