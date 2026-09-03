// The expanded top-left corner: the Plex library, the downloads, the requests.
//
// Three tabs on the same sticky bar TimeExpanded uses, because the corner is
// asked three different questions — "what can I watch", "is it here yet", and
// "can we get X" — and each is answered by a different service (Plex,
// qBittorrent via the *arr pair, Seerr). Tabs whose service isn't configured
// are simply not drawn: an empty Requests tab is a permanent reminder of a
// feature nobody set up.
//
// The Library tab is two layers, the way the guide is: the browse layer
// (search, continue watching, recently added) and, on tapping anything, that
// item's own page — poster, summary, LANGUAGES, and the play buttons. A show's
// page lists its seasons and a season's its episodes, each a further page.
// The languages block is the reason this panel exists as much as playback is:
// "does this have the Japanese audio" is a question Plex's own apps answer
// only by starting the file and opening a menu.
//
// Playing here hands the item to the full-screen PlexPlayer through the
// module store, exactly as a spoken `play_media` does, so a tapped film and an
// asked-for film go through one code path. "Play on…" lists the other Plex
// apps on the network and sends the item there instead.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Library, Download, Inbox, ChevronLeft, Play, Tv, Pause, Search, Check, Clock, Languages, Subtitles, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import {
  openPlexPlayer, plexApi, plexImg, tmdbPoster, usePlexPanelRequest,
  type LanguageSummary, type PlexItem, type PlexItemDetail, type PlexPlayerInfo, type PlexStatus, type PlexStream,
  type PlexTab, type SeerrRequest, type SeerrResult, type Torrent,
} from '../../../hooks/usePlex'

const ACCENT = '#e5a00d'

// ── Helpers ──────────────────────────────────────────────────────────────────

function itemTitle(i: PlexItem): string {
  if (i.type === 'episode') {
    const se = i.parentIndex !== undefined && i.index !== undefined ? `S${i.parentIndex}E${i.index} · ` : ''
    return `${se}${i.title}`
  }
  return i.title
}

function itemSubtitle(i: PlexItem): string {
  if (i.type === 'episode') return i.grandparentTitle ?? ''
  if (i.type === 'season') return i.parentTitle ?? ''
  const bits: string[] = []
  if (i.year) bits.push(String(i.year))
  if (i.type === 'show' && i.leafCount) bits.push(`${i.leafCount} episodes`)
  if (i.type === 'movie' && i.duration) bits.push(`${Math.round(i.duration / 60000)} min`)
  return bits.join(' · ')
}

function progressOf(i: PlexItem): number {
  if (i.type === 'show' || i.type === 'season') return i.leafCount ? (i.viewedLeafCount ?? 0) / i.leafCount : 0
  if (i.viewOffset && i.duration) return i.viewOffset / i.duration
  return i.viewCount ? 1 : 0
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`
  return `${Math.round(b / 1e3)} kB`
}
function fmtSpeed(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kB/s`
  return bps ? `${bps} B/s` : '—'
}
function fmtEta(sec: number): string {
  if (sec >= 8640000 || sec < 0) return '∞'
  if (sec < 60) return '<1m'
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  return h >= 48 ? `${Math.round(h / 24)}d` : `${h}h ${Math.round((sec % 3600) / 60)}m`
}

// ── The panel ────────────────────────────────────────────────────────────────

export default function PlexExpanded({ status }: { status: PlexStatus | null }) {
  const [tab, setTab] = useState<PlexTab>('library')
  // The browse stack: [] = the browse layer, else the item pages opened in order.
  const [stack, setStack] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const req = usePlexPanelRequest()
  const seenReq = useRef(0)

  // A spoken command or a tap elsewhere asked for a tab, an item, or a search.
  useEffect(() => {
    if (!req || req.seq === seenReq.current) return
    seenReq.current = req.seq
    setTab(req.tab)
    if (req.key) setStack([req.key])
    else if (req.query !== undefined) { setStack([]); setQuery(req.query) }
    else setStack([])
  }, [req])

  const showDownloads = !!status && (status.features.torrents || status.services.sonarr.configured || status.services.radarr.configured)
  const showRequests = !!status?.features.requests
  const TABS: { id: PlexTab; label: string; icon: React.ReactElement }[] = [
    { id: 'library', label: 'Library', icon: <Library size={18} /> },
    ...(showDownloads ? [{ id: 'downloads' as const, label: 'Downloads', icon: <Download size={18} /> }] : []),
    ...(showRequests ? [{ id: 'requests' as const, label: 'Requests', icon: <Inbox size={18} /> }] : []),
  ]

  const open = useCallback((key: string) => setStack(s => [...s, key]), [])
  const back = useCallback(() => setStack(s => s.slice(0, -1)), [])

  if (status && !status.enabled) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-8 text-center pt-16">
        <Tv size={40} className="text-white/30" />
        <p className="text-white/80 text-base font-semibold">Plex isn't set up</p>
        <p className="text-ink-dim text-sm">Set MEDIA_PLEX_URL and MEDIA_PLEX_TOKEN on the server — <code>scripts/collect-media-env.py</code> fills them in from the running stack.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div
        className="sticky top-0 z-10 flex gap-2 pt-16 pb-3 bg-black/95"
        style={{ paddingLeft: 'max(1.5rem, env(safe-area-inset-left))', paddingRight: 'max(1.5rem, env(safe-area-inset-right))' }}
      >
        {TABS.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`flex-1 h-14 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold transition-colors active:scale-95 ${
              tab === t.id ? 'bg-white/20 text-white border border-white/25' : 'bg-white/5 text-white/50 border border-transparent'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      <div className="px-6" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
        {status && !status.services.plex.ok && tab === 'library' && (
          <div className="mb-4 flex items-center gap-2 text-amber-300 text-sm">
            <AlertTriangle size={16} /> Plex isn't answering{status.services.plex.detail ? ` — ${status.services.plex.detail}` : ''}
          </div>
        )}
        {tab === 'library' && (
          stack.length
            ? <ItemPage key={stack[stack.length - 1]} itemKey={stack[stack.length - 1]!} depth={stack.length} onOpen={open} onBack={back} subtitlesWanted={!!status?.features.subtitles} />
            : <BrowseLayer query={query} setQuery={setQuery} onOpen={open} />
        )}
        {tab === 'downloads' && <DownloadsTab canControl={!!status?.features.torrents} />}
        {tab === 'requests' && <RequestsTab />}
      </div>
    </div>
  )
}

// ── Library: browse layer ────────────────────────────────────────────────────

function BrowseLayer({ query, setQuery, onOpen }: { query: string; setQuery: (q: string) => void; onOpen: (key: string) => void }) {
  const [home, setHome] = useState<{ onDeck: PlexItem[]; recent: PlexItem[] } | null>(null)
  const [results, setResults] = useState<PlexItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    plexApi.home().then(h => { if (!cancelled) setHome(h) }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); return }
    let cancelled = false
    plexApi.search(q).then(r => { if (!cancelled) setResults(r.items) }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [query])

  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <TouchInput value={query} onChange={setQuery} placeholder="Search the library…" ariaLabel="Search the Plex library"
          className="w-full bg-white/10 text-white rounded-2xl pl-11 pr-4 py-3.5 text-base placeholder:text-white/30 border border-hairline" />
      </div>
      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}

      {results ? (
        results.length
          ? <PosterGrid items={results} onOpen={onOpen} />
          : <p className="text-ink-dim text-sm">Nothing called “{query.trim()}” in the library.</p>
      ) : (
        <>
          {home?.onDeck.length ? (
            <section>
              <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Continue watching</h3>
              <div className="flex flex-col gap-2">
                {home.onDeck.map(i => <Row key={i.key} item={i} onOpen={onOpen} />)}
              </div>
            </section>
          ) : null}
          {home?.recent.length ? (
            <section>
              <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Recently added</h3>
              <PosterGrid items={home.recent} onOpen={onOpen} />
            </section>
          ) : null}
          {home && !home.onDeck.length && !home.recent.length && <p className="text-ink-dim text-sm">The library is empty.</p>}
          {!home && !error && <p className="text-ink-dim text-sm">Loading…</p>}
        </>
      )}
    </div>
  )
}

function Poster({ item, w = 120 }: { item: PlexItem; w?: number }) {
  const src = plexImg(item.thumb ?? item.art, w * 2)
  return src
    ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
    : <div className="w-full h-full bg-gradient-to-br from-white/15 to-white/5 flex items-center justify-center"><Tv size={28} className="text-white/30" /></div>
}

function PosterGrid({ items, onOpen }: { items: PlexItem[]; onOpen: (key: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map(i => {
        const p = progressOf(i)
        return (
          <button key={i.key} type="button" onClick={() => onOpen(i.key)} className="text-left active:scale-95 transition-transform">
            <div className="relative aspect-[2/3] rounded-xl overflow-hidden border border-hairline bg-white/5">
              <Poster item={i} />
              {p > 0 && p < 1 && <div className="absolute bottom-0 left-0 h-1 bg-[#e5a00d]" style={{ width: `${p * 100}%` }} />}
              {p >= 1 && <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center"><Check size={14} className="text-white" /></span>}
            </div>
            <p className="mt-1.5 text-[13px] text-white leading-tight line-clamp-2">{itemTitle(i)}</p>
            <p className="text-[12px] text-ink-dim leading-tight line-clamp-1">{itemSubtitle(i)}</p>
          </button>
        )
      })}
    </div>
  )
}

/** A landscape row: for episodes and continue-watching, where the title carries more than the art. */
function Row({ item, onOpen, trailing }: { item: PlexItem; onOpen: (key: string) => void; trailing?: React.ReactNode }) {
  const p = progressOf(item)
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/5 border border-hairline overflow-hidden">
      <button type="button" onClick={() => onOpen(item.key)} className="flex items-center gap-3 flex-1 min-w-0 text-left p-2 active:bg-white/10">
        <div className="relative w-14 h-[84px] rounded-lg overflow-hidden shrink-0 bg-white/5">
          <Poster item={item} w={56} />
          {p > 0 && p < 1 && <div className="absolute bottom-0 left-0 h-1 bg-[#e5a00d]" style={{ width: `${p * 100}%` }} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink-dim line-clamp-1">{itemSubtitle(item)}</p>
          <p className="text-sm text-white font-semibold leading-snug line-clamp-2">{itemTitle(item)}</p>
          {item.viewOffset && item.duration ? (
            <p className="text-[12px] text-white/50 mt-0.5">{Math.round((item.duration - item.viewOffset) / 60000)} min left</p>
          ) : null}
        </div>
      </button>
      {trailing}
    </div>
  )
}

// ── Library: one item's page ─────────────────────────────────────────────────

function ItemPage({ itemKey, depth, onOpen, onBack, subtitlesWanted }: {
  itemKey: string; depth: number; onOpen: (key: string) => void; onBack: () => void; subtitlesWanted: boolean
}) {
  const [detail, setDetail] = useState<PlexItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [audio, setAudio] = useState<number | undefined>(undefined)
  const [subs, setSubs] = useState<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setDetail(null); setError(null)
    plexApi.item(itemKey).then(d => {
      if (cancelled) return
      setDetail(d)
      const streams = d.item.media?.[0]?.parts[0]?.streams ?? []
      setAudio(streams.find(s => s.streamType === 2 && s.selected)?.id)
      setSubs(streams.find(s => s.streamType === 3 && s.selected)?.id ?? 0)
    }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [itemKey])

  const item = detail?.item
  const playable = item?.type === 'movie' || item?.type === 'episode'
  const part = item?.media?.[0]?.parts[0]
  const streams = part?.streams ?? []
  const audioStreams = streams.filter(s => s.streamType === 2)
  const subStreams = streams.filter(s => s.streamType === 3)

  const play = (offsetMs?: number) => {
    if (!item) return
    openPlexPlayer({
      key: item.key, title: item.type === 'episode' ? `${item.grandparentTitle ?? ''} ${itemTitle(item)}`.trim() : item.title,
      ...(playable && part ? { partId: part.id, audioStreamId: audio, subtitleStreamId: subs } : {}),
      ...(offsetMs !== undefined ? { offsetMs } : {}),
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onBack}
        className="self-start h-11 px-4 -ml-1 rounded-full bg-glass-2 border border-hairline flex items-center gap-1.5 text-sm text-white/80 active:bg-white/25">
        <ChevronLeft size={18} />{depth > 1 ? 'Back' : 'Library'}
      </button>

      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}
      {!detail && !error && <p className="text-ink-dim text-sm">Loading…</p>}

      {item && (
        <>
          <div className="flex gap-4">
            <div className="w-28 aspect-[2/3] rounded-xl overflow-hidden border border-hairline shrink-0 bg-white/5">
              <Poster item={item} w={112} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink-dim">{itemSubtitle(item)}</p>
              <h2 className="text-lg text-white font-semibold leading-snug">{itemTitle(item)}</h2>
              <p className="text-[12px] text-white/50 mt-1">
                {[item.contentRating, item.rating ? `★ ${item.rating.toFixed(1)}` : null, item.media?.[0]?.videoResolution ? `${item.media[0].videoResolution}p` : null].filter(Boolean).join(' · ')}
              </p>
              {item.summary && <p className="text-[13px] text-white/70 leading-snug mt-2 line-clamp-4">{item.summary}</p>}
            </div>
          </div>

          {/* Play */}
          <div className="flex gap-2">
            <button type="button" onClick={() => play()}
              className="flex-1 h-14 rounded-2xl flex items-center justify-center gap-2 text-base font-semibold text-black active:scale-95"
              style={{ background: ACCENT }}>
              <Play size={22} fill="currentColor" />
              {playable && item.viewOffset ? `Resume · ${Math.round(item.viewOffset / 60000)} min` : item.type === 'show' || item.type === 'season' ? 'Play next' : 'Play'}
            </button>
            {playable && item.viewOffset ? (
              <button type="button" onClick={() => play(0)} aria-label="Play from the start"
                className="h-14 w-14 rounded-2xl bg-glass-2 border border-hairline flex items-center justify-center text-white active:bg-white/25">
                <RefreshCw size={20} />
              </button>
            ) : null}
            <PlayOn itemKey={item.key} />
          </div>

          {/* Stream choice, for the file about to be played */}
          {playable && (audioStreams.length > 1 || subStreams.length > 0) && (
            <section className="flex flex-col gap-3">
              {audioStreams.length > 1 && (
                <div>
                  <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2 flex items-center gap-1.5"><Languages size={14} />Audio</h3>
                  <Chips options={audioStreams.map(s => ({ id: s.id, label: streamName(s) }))} value={audio} onChange={setAudio} />
                </div>
              )}
              {subStreams.length > 0 && (
                <div>
                  <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2 flex items-center gap-1.5"><Subtitles size={14} />Subtitles</h3>
                  <Chips options={[{ id: 0, label: 'Off' }, ...subStreams.map(s => ({ id: s.id, label: streamName(s) }))]} value={subs} onChange={setSubs} />
                </div>
              )}
            </section>
          )}

          {/* Languages across the whole thing */}
          {!playable && <LanguageBlock summary={detail!.languages} unit={item.type === 'show' || item.type === 'season' ? 'episode' : 'file'} />}
          {detail?.subtitles && subtitlesWanted && (
            <div className="rounded-2xl bg-white/5 border border-hairline p-3 text-[13px]">
              <p className="text-white/50 text-[11px] uppercase tracking-widest font-semibold mb-1">Subtitle search</p>
              {detail.subtitles.missing.length
                ? <p className="text-amber-200">Still looking for: {detail.subtitles.missing.join(', ')}</p>
                : <p className="text-white/70">Every wanted language is here{detail.subtitles.wanted.length ? ` (${detail.subtitles.wanted.join(', ')})` : ''}.</p>}
            </div>
          )}

          {/* Children */}
          {detail!.children.length > 0 && (
            <section>
              <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">
                {item.type === 'show' ? 'Seasons' : 'Episodes'}
              </h3>
              <div className="flex flex-col gap-2">
                {detail!.children.map(c => {
                  const langs = detail!.perEpisode.find(e => e.key === c.key)
                  return (
                    <Row key={c.key} item={c} onOpen={onOpen}
                      trailing={
                        <div className="flex items-center gap-2 pr-2 shrink-0">
                          {langs && (
                            <div className="text-right text-[11px] text-white/45 leading-tight max-w-[96px]">
                              <p className="line-clamp-1">{langs.audio.join(', ') || '—'}</p>
                              <p className="line-clamp-1"><span className="text-white/30">CC </span>{langs.subtitles.join(', ') || 'none'}</p>
                            </div>
                          )}
                          <button type="button" aria-label={`Play ${itemTitle(c)}`}
                            onClick={() => openPlexPlayer({ key: c.key, title: c.type === 'episode' ? `${c.grandparentTitle ?? item.title} ${itemTitle(c)}` : `${item.title} ${c.title}` })}
                            className="w-12 h-12 rounded-full bg-white/10 border border-hairline flex items-center justify-center text-white active:bg-white/25">
                            <Play size={20} fill="currentColor" className="ml-0.5" />
                          </button>
                        </div>
                      } />
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function streamName(s: PlexStream): string {
  const base = s.language ?? s.languageCode?.toUpperCase() ?? s.displayTitle ?? 'Unknown'
  const extra: string[] = []
  if (s.streamType === 2 && s.channels) extra.push(s.channels >= 6 ? '5.1' : s.channels === 2 ? 'stereo' : `${s.channels}ch`)
  if (s.forced) extra.push('forced')
  if (s.hearingImpaired) extra.push('SDH')
  if (s.title && !/^(english|.*\d\.\d.*|stereo|surround)$/i.test(s.title) && s.title !== s.language) extra.push(s.title)
  return extra.length ? `${base} (${extra.join(', ')})` : base
}

function Chips<T extends number>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T | undefined; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {options.map(o => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={`shrink-0 h-11 px-4 rounded-full text-sm border whitespace-nowrap active:scale-95 ${
            value === o.id ? 'bg-white/20 text-white border-white/30' : 'bg-white/5 text-white/60 border-transparent'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function LanguageBlock({ summary, unit }: { summary: LanguageSummary; unit: string }) {
  const line = (count: Record<string, number>) => {
    const entries = Object.entries(count)
    if (!entries.length) return <span className="text-white/40">none</span>
    return entries.map(([lang, n]) => (
      <span key={lang} className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-white/10 text-[13px] text-white mr-2 mb-2">
        {lang}{n < summary.files && <span className="text-white/45">{n}/{summary.files}</span>}
      </span>
    ))
  }
  return (
    <section className="rounded-2xl bg-white/5 border border-hairline p-3">
      <p className="text-white/50 text-[11px] uppercase tracking-widest font-semibold mb-2">
        Languages · {summary.files} {unit}{summary.files === 1 ? '' : 's'}
      </p>
      <div className="flex items-start gap-2 mb-1"><Languages size={16} className="text-white/50 mt-2 shrink-0" /><div className="flex flex-wrap">{line(summary.audioCount)}</div></div>
      <div className="flex items-start gap-2"><Subtitles size={16} className="text-white/50 mt-2 shrink-0" /><div className="flex flex-wrap">{line(summary.subtitleCount)}</div></div>
    </section>
  )
}

/** "Play on…" — the other Plex apps on the network, fetched when tapped. */
function PlayOn({ itemKey }: { itemKey: string }) {
  const [open, setOpen] = useState(false)
  const [players, setPlayers] = useState<PlexPlayerInfo[] | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setPlayers(null); setError(null)
    plexApi.players().then(p => setPlayers(p.players)).catch(err => setError(err.message))
  }, [open])
  const send = async (p: PlexPlayerInfo) => {
    try { await plexApi.play({ key: itemKey, player: p.id }); setSent(p.name); setTimeout(() => setOpen(false), 1200) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="Play on another device"
        className={`h-14 w-14 rounded-2xl border border-hairline flex items-center justify-center text-white active:bg-white/25 ${open ? 'bg-white/20' : 'bg-glass-2'}`}>
        <Tv size={22} />
      </button>
      {open && (
        <div className="absolute right-0 top-16 z-20 w-64 rounded-2xl bg-black/95 border border-hairline p-2 shadow-2xl">
          <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold px-2 py-1">Play on</p>
          {error && <p className="text-amber-300 text-sm px-2 py-1">{error}</p>}
          {players === null && !error && <p className="text-ink-dim text-sm px-2 py-1">Looking…</p>}
          {players?.length === 0 && <p className="text-ink-dim text-sm px-2 py-1">No other Plex apps are on the network right now.</p>}
          {players?.map(p => (
            <button key={p.id} type="button" onClick={() => void send(p)}
              className="w-full h-12 px-3 rounded-xl flex items-center gap-2 text-left text-sm text-white active:bg-white/15">
              {sent === p.name ? <Check size={16} className="text-green-400" /> : <Tv size={16} className="text-white/50" />}
              <span className="flex-1 min-w-0 truncate">{p.name}</span>
              {p.product && <span className="text-[11px] text-white/40 truncate max-w-[80px]">{p.product}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Downloads ────────────────────────────────────────────────────────────────

function DownloadsTab({ canControl }: { canControl: boolean }) {
  const [data, setData] = useState<{ source: 'qbit' | 'arr'; warning?: string; torrents: Torrent[]; transfer: { dlspeed: number; upspeed: number; connected: boolean } | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await plexApi.torrents()); setError(null) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 8_000)
    return () => clearInterval(t)
  }, [load])

  const control = async (t: Torrent) => {
    setBusy(t.hash)
    try { await plexApi.torrent(t.hash, t.phase === 'paused' ? 'resume' : 'pause'); await load() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  const list = data?.torrents ?? []
  const active = list.filter(t => t.phase !== 'done' && t.phase !== 'seeding')
  const finished = list.filter(t => t.phase === 'done' || t.phase === 'seeding')

  return (
    <div className="flex flex-col gap-4">
      {data?.transfer && (
        <p className="text-[13px] text-white/60 tabular-nums flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${data.transfer.connected ? 'bg-green-400' : 'bg-amber-400'}`} />
          ↓ {fmtSpeed(data.transfer.dlspeed)} <span className="text-white/30">·</span> ↑ {fmtSpeed(data.transfer.upspeed)}
        </p>
      )}
      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}
      {data?.warning && <p className="text-amber-300/80 text-[13px] flex items-center gap-2"><AlertTriangle size={14} />{data.warning} — showing Sonarr/Radarr's queue instead.</p>}
      {!data && !error && <p className="text-ink-dim text-sm">Loading…</p>}
      {data && !list.length && <p className="text-ink-dim text-sm">Nothing is downloading.</p>}

      {active.length > 0 && (
        <section className="flex flex-col gap-2">
          {active.map(t => <TorrentRow key={t.hash} t={t} busy={busy === t.hash} onControl={canControl && data?.source === 'qbit' ? () => void control(t) : undefined} />)}
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Finished</h3>
          <div className="flex flex-col gap-2">
            {finished.slice(0, 12).map(t => <TorrentRow key={t.hash} t={t} busy={false} />)}
          </div>
        </section>
      )}
    </div>
  )
}

const PHASE_LABEL: Record<Torrent['phase'], string> = {
  downloading: 'Downloading', seeding: 'Seeding', paused: 'Paused', stalled: 'Stalled', queued: 'Queued', checking: 'Checking', done: 'Finished', error: 'Error',
}

function TorrentRow({ t, busy, onControl }: { t: Torrent; busy: boolean; onControl?: () => void }) {
  const pct = Math.round(t.progress * 100)
  const live = t.phase === 'downloading'
  return (
    <div className="rounded-2xl bg-white/5 border border-hairline p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white font-semibold leading-snug line-clamp-2">{t.label ?? t.name}</p>
          {t.label && <p className="text-[11px] text-white/35 line-clamp-1 mt-0.5">{t.name}</p>}
          <p className={`text-[12px] mt-1 tabular-nums ${t.phase === 'error' ? 'text-red-300' : t.phase === 'stalled' ? 'text-amber-300' : 'text-white/55'}`}>
            {PHASE_LABEL[t.phase]}
            {t.phase !== 'done' && t.phase !== 'seeding' && ` · ${pct}%`}
            {live && ` · ${fmtSpeed(t.dlspeed)} · ${fmtEta(t.eta)} left`}
            {t.phase === 'seeding' && ` · ↑ ${fmtSpeed(t.upspeed)} · ratio ${t.ratio.toFixed(1)}`}
            {(t.phase === 'stalled' || live) && ` · ${t.seeds} seeds`}
            {` · ${fmtBytes(t.size)}`}
          </p>
        </div>
        {onControl && (t.phase === 'downloading' || t.phase === 'stalled' || t.phase === 'queued' || t.phase === 'paused') && (
          <button type="button" onClick={onControl} disabled={busy} aria-label={t.phase === 'paused' ? 'Resume' : 'Pause'}
            className="w-12 h-12 shrink-0 rounded-full bg-white/10 border border-hairline flex items-center justify-center text-white active:bg-white/25 disabled:opacity-50">
            {t.phase === 'paused' ? <Play size={18} fill="currentColor" className="ml-0.5" /> : <Pause size={18} fill="currentColor" />}
          </button>
        )}
      </div>
      {t.phase !== 'done' && t.phase !== 'seeding' && (
        <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className={`h-full ${t.phase === 'paused' ? 'bg-white/40' : t.phase === 'stalled' ? 'bg-amber-400' : 'bg-[#e5a00d]'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

// ── Requests ─────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<SeerrResult['status'], string> = {
  unknown: '', pending: 'Requested', processing: 'Downloading', partial: 'Partly here', available: 'In the library',
}

function RequestsTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SeerrResult[] | null>(null)
  const [requests, setRequests] = useState<SeerrRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [done, setDone] = useState<Record<number, string>>({})

  const loadRequests = useCallback(async () => {
    try { setRequests((await plexApi.requests()).requests) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { void loadRequests() }, [loadRequests])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); return }
    let cancelled = false
    plexApi.discover(q).then(r => { if (!cancelled) setResults(r.results) }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [query])

  const request = async (r: SeerrResult) => {
    setBusy(r.tmdbId); setError(null)
    try {
      const { request } = await plexApi.request(r.mediaType, r.tmdbId)
      setDone(d => ({ ...d, [r.tmdbId]: request.requestStatus === 'approved' ? 'Requested — downloading' : 'Requested — awaiting approval' }))
      void loadRequests()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <TouchInput value={query} onChange={setQuery} placeholder="Ask for a film or show…" ariaLabel="Search for something to request"
          className="w-full bg-white/10 text-white rounded-2xl pl-11 pr-4 py-3.5 text-base placeholder:text-white/30 border border-hairline" />
      </div>
      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}

      {results && (
        <section className="flex flex-col gap-2">
          {!results.length && <p className="text-ink-dim text-sm">Nothing called “{query.trim()}” on TMDB.</p>}
          {results.map(r => {
            const poster = tmdbPoster(r.poster)
            const state = done[r.tmdbId] ?? STATUS_LABEL[r.status]
            const requestable = !done[r.tmdbId] && (r.status === 'unknown' || r.status === 'partial')
            return (
              <div key={`${r.mediaType}-${r.tmdbId}`} className="flex items-center gap-3 rounded-2xl bg-white/5 border border-hairline p-2">
                <div className="w-14 h-[84px] rounded-lg overflow-hidden shrink-0 bg-white/5">
                  {poster ? <img src={poster} alt="" loading="lazy" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><Tv size={20} className="text-white/30" /></div>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-ink-dim">{r.mediaType === 'tv' ? 'Show' : 'Film'}{r.year ? ` · ${r.year}` : ''}</p>
                  <p className="text-sm text-white font-semibold leading-snug line-clamp-2">{r.title}</p>
                  {state && <p className={`text-[12px] mt-0.5 ${r.status === 'available' ? 'text-green-300' : 'text-[#e5a00d]'}`}>{state}</p>}
                </div>
                {requestable && (
                  <button type="button" onClick={() => void request(r)} disabled={busy === r.tmdbId}
                    className="h-11 px-4 shrink-0 rounded-full text-sm font-semibold text-black active:scale-95 disabled:opacity-50" style={{ background: ACCENT }}>
                    {busy === r.tmdbId ? '…' : r.mediaType === 'tv' ? 'Request all' : 'Request'}
                  </button>
                )}
                {r.status === 'available' && <Check size={20} className="text-green-400 shrink-0 mr-2" />}
              </div>
            )
          })}
        </section>
      )}

      <section>
        <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Recent requests</h3>
        {requests === null && !error && <p className="text-ink-dim text-sm">Loading…</p>}
        {requests?.length === 0 && <p className="text-ink-dim text-sm">Nothing requested yet.</p>}
        <div className="flex flex-col gap-2">
          {requests?.map(r => {
            const poster = tmdbPoster(r.poster)
            const where = r.requestStatus === 'declined' ? 'Declined'
              : r.status === 'available' ? 'In the library'
              : r.status === 'partial' ? 'Partly here'
              : r.status === 'processing' || r.requestStatus === 'approved' ? 'Downloading'
              : 'Awaiting approval'
            const tone = where === 'In the library' ? 'text-green-300' : where === 'Declined' ? 'text-red-300' : where === 'Downloading' ? 'text-[#e5a00d]' : 'text-white/55'
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-2xl bg-white/5 border border-hairline p-2">
                <div className="w-11 h-16 rounded-lg overflow-hidden shrink-0 bg-white/5">
                  {poster ? <img src={poster} alt="" loading="lazy" className="w-full h-full object-cover" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white font-semibold leading-snug line-clamp-1">{r.title}{r.year ? <span className="text-white/40 font-normal"> {r.year}</span> : null}</p>
                  <p className="text-[12px] text-ink-dim">{r.mediaType === 'tv' ? (r.seasons?.length ? `Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}` : 'Show') : 'Film'}</p>
                  <p className={`text-[12px] mt-0.5 flex items-center gap-1 ${tone}`}>
                    {where === 'In the library' ? <Check size={12} /> : where === 'Downloading' ? <Download size={12} /> : <Clock size={12} />}{where}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
