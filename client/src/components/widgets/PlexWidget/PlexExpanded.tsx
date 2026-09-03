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
  Library, Download, Inbox, Play, Tv, Search, Check, Clock, Languages, Subtitles, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import {
  openPlexPlayer, plexApi, tmdbPoster, usePlexPanelRequest,
  type LanguageSummary, type PlexItem, type PlexItemDetail, type PlexPlayerInfo, type PlexStatus, type PlexStream,
  type PlexTab, type SeerrRequest, type SeerrResult,
} from '../../../hooks/usePlex'
import { ACCENT, itemTitle, itemSubtitle, PlexColumnSlider, PosterGrid, Row } from './items'
import { clientRole } from '../../../hooks/useClientRole'
import { DownloadsTab } from './DownloadsTab'
import {
  BackButton, Backdrop, CastRow, CollectionPage, CrewLine, factsLine, FolderPage, GenreChips, HeaderPoster,
  LibrariesRow, RatingsRow, RelatedShelves, SectionPage, TrailerButton, type Layer,
} from './LibraryBrowse'

// ── Helpers ──────────────────────────────────────────────────────────────────


// ── The panel ────────────────────────────────────────────────────────────────

export default function PlexExpanded({ status }: { status: PlexStatus | null }) {
  const [tab, setTab] = useState<PlexTab>('library')
  // The browse stack: [] = the browse layer, else the pages opened in order —
  // a library, a folder, a collection, or an item, each a place to go back from.
  const [stack, setStack] = useState<Layer[]>([])
  const [query, setQuery] = useState('')
  const req = usePlexPanelRequest()
  const seenReq = useRef(0)

  // A spoken command or a tap elsewhere asked for a tab, an item, or a search.
  useEffect(() => {
    if (!req || req.seq === seenReq.current) return
    seenReq.current = req.seq
    setTab(req.tab)
    if (req.key) setStack([{ kind: 'item', key: req.key }])
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

  const open = useCallback((key: string) => setStack(s => [...s, { kind: 'item', key }]), [])
  const push = useCallback((l: Layer) => setStack(s => [...s, l]), [])
  const back = useCallback(() => setStack(s => s.slice(0, -1)), [])
  const top = stack[stack.length - 1]

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
          !top ? <BrowseLayer query={query} setQuery={setQuery} onOpen={open} onPush={push} />
          : top.kind === 'item' ? <ItemPage key={top.key} itemKey={top.key} depth={stack.length} onOpen={open} onBack={back} subtitlesWanted={!!status?.features.subtitles} />
          : top.kind === 'section' ? <SectionPage key={top.id} id={top.id} title={top.title} onOpen={open} onPush={push} onBack={back} />
          : top.kind === 'folder' ? <FolderPage key={`${top.id}/${top.parent ?? ''}`} id={top.id} parent={top.parent} title={top.title} onOpen={open} onPush={push} onBack={back} />
          : <CollectionPage key={top.key} collectionKey={top.key} title={top.title} onOpen={open} onBack={back} />
        )}
        {tab === 'downloads' && <DownloadsTab canControl={!!status?.features.torrents} />}
        {tab === 'requests' && <RequestsTab />}
      </div>
    </div>
  )
}

// ── Library: browse layer ────────────────────────────────────────────────────

function BrowseLayer({ query, setQuery, onOpen, onPush }: { query: string; setQuery: (q: string) => void; onOpen: (key: string) => void; onPush: (l: Layer) => void }) {
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
    // The field commits every keystroke; wait for a pause before asking Plex.
    const t = setTimeout(() => {
      plexApi.search(q).then(r => { if (!cancelled) setResults(r.items) }).catch(err => { if (!cancelled) setError(err.message) })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
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
          ? (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold">Results</h3>
                <PlexColumnSlider />
              </div>
              <PosterGrid items={results} onOpen={onOpen} />
            </section>
          )
          : <p className="text-ink-dim text-sm">Nothing called “{query.trim()}” in the library.</p>
      ) : (
        <>
          <LibrariesRow onPush={onPush} />
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
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold">Recently added</h3>
                <PlexColumnSlider />
              </div>
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
  const playable = item?.type === 'movie' || item?.type === 'episode' || item?.type === 'clip'
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
    <div className="relative flex flex-col gap-5">
      {/* The agent's backdrop and the poster's own colours, behind the header —
          what turns a metadata card into the page Plex's apps draw. */}
      {item && <Backdrop item={item} />}
      <BackButton onBack={onBack} label={depth > 1 ? 'Back' : 'Library'} />

      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}
      {!detail && !error && <p className="text-ink-dim text-sm">Loading…</p>}

      {item && (
        <>
          <div className="flex gap-4 pt-16">
            <div className="w-28 aspect-[2/3] rounded-xl overflow-hidden border border-hairline shrink-0 bg-white/5 shadow-2xl">
              <HeaderPoster item={item} />
            </div>
            <div className="min-w-0 flex-1 self-end">
              <p className="text-[12px] text-ink-dim">{item.type === 'episode' || item.type === 'season' ? itemSubtitle(item) : item.sectionTitle ?? ''}</p>
              <h2 className="text-xl text-white font-semibold leading-tight">{itemTitle(item)}</h2>
              {item.originalTitle && item.originalTitle !== item.title && (
                <p className="text-[12px] text-white/45 leading-snug">{item.originalTitle}</p>
              )}
              {item.tagline && <p className="text-[13px] text-white/70 italic leading-snug mt-1">{item.tagline}</p>}
              <p className="text-[12px] text-white/50 mt-1">{factsLine(item)}</p>
            </div>
          </div>
          <RatingsRow item={item} />
          <GenreChips item={item} />
          {item.summary && <p className="text-[13px] text-white/70 leading-snug">{item.summary}</p>}
          <CrewLine item={item} />
          <TrailerButton item={item} />

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

          <CastRow item={item} />

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

          <RelatedShelves item={item} onOpen={onOpen} />
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
    try {
      // The kiosk is not a Plex player on the network; it is this app on the
      // wall, reached through the server's remote channel.
      if (p.id === 'kiosk') {
        const r = await plexApi.remote({ action: 'play', key: itemKey })
        if (r.kiosks === 0) throw new Error('The kiosk isn’t connected right now.')
      } else {
        await plexApi.play({ key: itemKey, player: p.id })
      }
      setSent(p.name); setTimeout(() => setOpen(false), 1200)
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  const list = players && clientRole() === 'companion' ? [{ id: 'kiosk', name: 'TouchSphere kiosk', product: 'the wall' }, ...players] : players
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
          {list?.length === 0 && <p className="text-ink-dim text-sm px-2 py-1">No other Plex apps are on the network right now.</p>}
          {list?.map(p => (
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
    const t = setTimeout(() => {
      plexApi.discover(q).then(r => { if (!cancelled) setResults(r.results) }).catch(err => { if (!cancelled) setError(err.message) })
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
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
