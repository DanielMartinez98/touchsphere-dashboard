/* eslint-disable react-refresh/only-export-components -- helpers live beside the components that use them */
// The library, organised the way Plex organises it.
//
// A Plex server is a set of LIBRARIES (Movies, Anime, TV Shows…), each a
// folder on disk that a scanner reads and an agent decorates with metadata
// and artwork. Plex's own apps open on a library and offer, inside it: the
// shelves it computes (continue watching, recently added, start watching, top
// rated), the whole list sorted six ways and filtered by genre or unwatched,
// the collections, and the disk folders themselves. The panel used to skip
// all of that and go straight from a search box to an item; these are the
// pages in between, plus the parts of an item page that the agent's metadata
// makes possible — backdrop, tagline, ratings by source, cast with headshots,
// crew, trailer, and the "related" shelves.
//
// Navigation is a stack of LAYERS rather than of item keys, because a library
// page, a folder and a collection are each a place you can be and go back
// from, exactly as an item is.

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Folder, Film, Eye, Play, Shuffle, Library as LibraryIcon } from 'lucide-react'
import {
  openPlexPlayer, plexApi, plexArt, plexImg,
  type PlexCollection, type PlexFolderEntry, type PlexHub, type PlexItem, type PlexSectionInfo, type SectionSort,
} from '../../../hooks/usePlex'
import { ACCENT, itemTitle, Poster, PosterCell, PosterGrid, Row } from './items'

export type Layer =
  | { kind: 'item'; key: string }
  | { kind: 'section'; id: string; title: string }
  | { kind: 'folder'; id: string; parent?: string; title: string }
  | { kind: 'collection'; key: string; title: string }

export function BackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button type="button" onClick={onBack}
      className="self-start h-11 px-4 -ml-1 rounded-full bg-glass-2 border border-hairline flex items-center gap-1.5 text-sm text-white/80 active:bg-white/25">
      <ChevronLeft size={18} />{label}
    </button>
  )
}

// ── Libraries ────────────────────────────────────────────────────────────────

/** The libraries, as tiles. A library has no artwork of its own, so the tile is four recent posters. */
export function LibrariesRow({ onPush }: { onPush: (l: Layer) => void }) {
  const [sections, setSections] = useState<PlexSectionInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    plexApi.sections().then(s => { if (!cancelled) setSections(s.sections) }).catch(() => { if (!cancelled) setSections([]) })
    return () => { cancelled = true }
  }, [])
  if (!sections?.length) return null
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Libraries</h3>
      <div className="flex gap-3 overflow-x-auto -mx-6 px-6 pb-1">
        {sections.map(s => (
          <button key={s.key} type="button" onClick={() => onPush({ kind: 'section', id: s.key, title: s.title })}
            className="shrink-0 w-36 text-left active:scale-95 transition-transform">
            <div className="grid grid-cols-2 gap-0.5 rounded-xl overflow-hidden border border-hairline bg-white/5 aspect-[4/3]">
              {[0, 1, 2, 3].map(i => {
                const src = plexImg(s.posters[i], 120)
                return src
                  ? <img key={i} src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
                  : <div key={i} className="w-full h-full bg-white/5 flex items-center justify-center">{i === 0 && <LibraryIcon size={18} className="text-white/25" />}</div>
              })}
            </div>
            <p className="mt-1.5 text-[13px] text-white font-semibold leading-tight line-clamp-1">{s.title}</p>
            <p className="text-[12px] text-ink-dim">{s.count} {s.type === 'movie' ? (s.count === 1 ? 'film' : 'films') : (s.count === 1 ? 'show' : 'shows')}</p>
          </button>
        ))}
      </div>
    </section>
  )
}

// ── Shelves ──────────────────────────────────────────────────────────────────

/** A horizontal shelf of posters — the shape Plex draws every hub in. */
export function HubStrip({ hub, onOpen }: { hub: PlexHub; onOpen: (key: string) => void }) {
  if (!hub.items.length) return null
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">{hub.title}</h3>
      <div className="flex gap-3 overflow-x-auto -mx-6 px-6 pb-1">
        {hub.items.map(i => <PosterCell key={i.key} item={i} onOpen={onOpen} className="shrink-0 w-[104px]" />)}
      </div>
    </section>
  )
}

// ── One library ──────────────────────────────────────────────────────────────

const SORTS: { id: SectionSort; label: string }[] = [
  { id: 'title', label: 'A–Z' },
  { id: 'added', label: 'Recently added' },
  { id: 'released', label: 'Release date' },
  { id: 'rating', label: 'Top rated' },
  { id: 'watched', label: 'Last watched' },
  { id: 'random', label: 'Shuffle' },
]

const PAGE = 30

export function SectionPage({ id, title, onOpen, onPush, onBack }: {
  id: string; title: string; onOpen: (key: string) => void; onPush: (l: Layer) => void; onBack: () => void
}) {
  const [hubs, setHubs] = useState<PlexHub[] | null>(null)
  const [genres, setGenres] = useState<{ id: string; title: string }[]>([])
  const [collections, setCollections] = useState<PlexCollection[]>([])
  const [sort, setSort] = useState<SectionSort>('title')
  const [genre, setGenre] = useState('')
  const [unwatched, setUnwatched] = useState(false)
  const [items, setItems] = useState<PlexItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A filter change is a new list; "more" extends the one on screen.
  const filtered = !!genre || unwatched || sort !== 'title'

  useEffect(() => {
    let cancelled = false
    plexApi.sectionHubs(id).then(h => { if (!cancelled) setHubs(h.hubs) }).catch(() => { if (!cancelled) setHubs([]) })
    plexApi.sectionGenres(id).then(g => { if (!cancelled) setGenres(g.genres) }).catch(() => {})
    plexApi.sectionCollections(id).then(c => { if (!cancelled) setCollections(c.collections) }).catch(() => {})
    return () => { cancelled = true }
  }, [id])

  const load = useCallback(async (offset: number) => {
    setLoading(true); setError(null)
    try {
      const page = await plexApi.section(id, { sort, genre, unwatched, offset, limit: PAGE })
      setTotal(page.total)
      setItems(prev => (offset === 0 ? page.items : [...prev, ...page.items]))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [id, sort, genre, unwatched])

  // Deferred a tick: `load` writes state, and an effect must not set state
  // synchronously. The key on the page remounts it per library anyway.
  useEffect(() => { const t = setTimeout(() => { void load(0) }, 0); return () => clearTimeout(t) }, [load])

  return (
    <div className="flex flex-col gap-5">
      <BackButton onBack={onBack} label="Library" />
      <div>
        <h2 className="text-xl text-white font-semibold leading-tight">{title}</h2>
        <p className="text-[12px] text-ink-dim mt-0.5">{total ? `${total} ${filtered ? 'matching' : 'in the library'}` : ''}</p>
      </div>

      {/* Plex's own shelves for this library, only while nothing is filtered:
          a shelf of "recently added" above a list sorted by "recently added"
          says the same thing twice. */}
      {!filtered && hubs?.map(h => <HubStrip key={h.id} hub={h} onOpen={onOpen} />)}

      {collections.length > 0 && !filtered && (
        <section>
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Collections</h3>
          <div className="flex gap-3 overflow-x-auto -mx-6 px-6 pb-1">
            {collections.map(c => {
              const src = plexImg(c.thumb ?? c.art, 200)
              return (
                <button key={c.key} type="button" onClick={() => onPush({ kind: 'collection', key: c.key, title: c.title })}
                  className="shrink-0 w-[104px] text-left active:scale-95 transition-transform">
                  <div className="aspect-[2/3] rounded-xl overflow-hidden border border-hairline bg-white/5">
                    {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><Film size={24} className="text-white/25" /></div>}
                  </div>
                  <p className="mt-1.5 text-[13px] text-white leading-tight line-clamp-2">{c.title}</p>
                  <p className="text-[12px] text-ink-dim">{c.count} items</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* The whole list: sort, unwatched, genre, and the disk folders. */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold">Everything</h3>
          <button type="button" onClick={() => onPush({ kind: 'folder', id, title })}
            className="h-9 px-3 rounded-full bg-white/5 border border-hairline flex items-center gap-1.5 text-[12px] text-white/70 active:bg-white/20">
            <Folder size={14} />Browse folders
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto -mx-6 px-6 pb-1">
          {SORTS.map(s => (
            <button key={s.id} type="button" onClick={() => setSort(s.id)}
              className={`shrink-0 h-10 px-4 rounded-full text-[13px] border whitespace-nowrap active:scale-95 flex items-center gap-1.5 ${
                sort === s.id ? 'bg-white/20 text-white border-white/30' : 'bg-white/5 text-white/60 border-transparent'}`}>
              {s.id === 'random' && <Shuffle size={13} />}{s.label}
            </button>
          ))}
          <button type="button" onClick={() => setUnwatched(u => !u)}
            className={`shrink-0 h-10 px-4 rounded-full text-[13px] border whitespace-nowrap active:scale-95 flex items-center gap-1.5 ${
              unwatched ? 'bg-[#e5a00d]/20 text-[#e5a00d] border-[#e5a00d]/40' : 'bg-white/5 text-white/60 border-transparent'}`}>
            <Eye size={13} />Unwatched
          </button>
        </div>
        {genres.length > 0 && (
          <div className="flex gap-2 overflow-x-auto -mx-6 px-6 pb-1">
            <button type="button" onClick={() => setGenre('')}
              className={`shrink-0 h-9 px-3 rounded-full text-[12px] border whitespace-nowrap active:scale-95 ${
                !genre ? 'bg-white/20 text-white border-white/30' : 'bg-white/5 text-white/60 border-transparent'}`}>
              All genres
            </button>
            {genres.map(g => (
              <button key={g.id} type="button" onClick={() => setGenre(genre === g.id ? '' : g.id)}
                className={`shrink-0 h-9 px-3 rounded-full text-[12px] border whitespace-nowrap active:scale-95 ${
                  genre === g.id ? 'bg-white/20 text-white border-white/30' : 'bg-white/5 text-white/60 border-transparent'}`}>
                {g.title}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-amber-300 text-sm">{error}</p>}
        {items.length > 0 && <PosterGrid items={items} onOpen={onOpen} />}
        {!loading && !error && items.length === 0 && <p className="text-ink-dim text-sm">Nothing matches.</p>}
        {items.length < total && (
          <button type="button" disabled={loading} onClick={() => void load(items.length)}
            className="h-12 rounded-2xl bg-white/10 border border-hairline text-sm text-white/80 font-semibold active:bg-white/20 disabled:opacity-50">
            {loading ? 'Loading…' : `Show more · ${total - items.length} left`}
          </button>
        )}
        {loading && items.length === 0 && <p className="text-ink-dim text-sm">Loading…</p>}
      </section>
    </div>
  )
}

// ── Folders ──────────────────────────────────────────────────────────────────

/**
 * The library as it is on disk. Plex keeps this tree beside the metadata
 * tree, and it is the one view that shows what the agent did NOT match — a
 * season folder that landed under the wrong show is only visible from here.
 */
export function FolderPage({ id, parent, title, onOpen, onPush, onBack }: {
  id: string; parent?: string; title: string; onOpen: (key: string) => void; onPush: (l: Layer) => void; onBack: () => void
}) {
  const [data, setData] = useState<{ title: string; folders: PlexFolderEntry[]; items: PlexItem[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    plexApi.sectionFolder(id, parent).then(d => { if (!cancelled) setData(d) }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [id, parent])
  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="Back" />
      <div className="flex items-center gap-2">
        <Folder size={20} className="text-[#e5a00d]" />
        <h2 className="text-lg text-white font-semibold leading-tight line-clamp-1">{title}</h2>
      </div>
      {error && <p className="text-amber-300 text-sm">{error}</p>}
      {!data && !error && <p className="text-ink-dim text-sm">Loading…</p>}
      {data && (
        <div className="flex flex-col gap-2">
          {data.folders.map(f => (
            <button key={f.parent} type="button" onClick={() => onPush({ kind: 'folder', id, parent: f.parent, title: f.title })}
              className="h-14 px-4 rounded-2xl bg-white/5 border border-hairline flex items-center gap-3 text-left active:bg-white/15">
              <Folder size={18} className="text-white/50 shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-white truncate">{f.title}</span>
              <ChevronRight size={16} className="text-white/30 shrink-0" />
            </button>
          ))}
          {data.items.map(i => (
            <Row key={i.key} item={i} onOpen={onOpen}
              trailing={(i.type === 'movie' || i.type === 'episode') ? (
                <button type="button" aria-label={`Play ${itemTitle(i)}`}
                  onClick={() => openPlexPlayer({ key: i.key, title: i.type === 'episode' ? `${i.grandparentTitle ?? ''} ${itemTitle(i)}`.trim() : i.title })}
                  className="w-12 h-12 mr-2 rounded-full bg-white/10 border border-hairline flex items-center justify-center text-white active:bg-white/25 shrink-0">
                  <Play size={20} fill="currentColor" className="ml-0.5" />
                </button>
              ) : undefined} />
          ))}
          {!data.folders.length && !data.items.length && <p className="text-ink-dim text-sm">This folder is empty.</p>}
        </div>
      )}
    </div>
  )
}

// ── Collections ──────────────────────────────────────────────────────────────

export function CollectionPage({ collectionKey, title, onOpen, onBack }: { collectionKey: string; title: string; onOpen: (key: string) => void; onBack: () => void }) {
  const [items, setItems] = useState<PlexItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    plexApi.collection(collectionKey).then(d => { if (!cancelled) setItems(d.items) }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [collectionKey])
  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="Back" />
      <h2 className="text-lg text-white font-semibold leading-tight">{title}</h2>
      {error && <p className="text-amber-300 text-sm">{error}</p>}
      {!items && !error && <p className="text-ink-dim text-sm">Loading…</p>}
      {items && <PosterGrid items={items} onOpen={onOpen} />}
    </div>
  )
}

// ── Item page pieces ─────────────────────────────────────────────────────────

/**
 * The backdrop behind an item's header, the way Plex's apps draw it: the
 * agent's `art` fading into the page, over the four corner colours Plex
 * derives from the poster so the fade lands on a colour that belongs to this
 * title rather than on black.
 */
export function Backdrop({ item }: { item: PlexItem }) {
  const art = plexArt(item.art ?? item.grandparentArt, 720)
  const c = item.colors
  const gradient = c
    ? `linear-gradient(135deg, #${c.topLeft} 0%, #${c.topRight} 50%, #${c.bottomRight} 100%)`
    : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))'
  return (
    <div className="absolute inset-x-0 top-0 h-56 -z-10 overflow-hidden rounded-3xl" style={{ background: gradient }}>
      {art && <img src={art} alt="" className="w-full h-full object-cover opacity-70" />}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/40 to-black" />
    </div>
  )
}

const RATING_LABEL: Record<string, string> = {
  imdb: 'IMDb', themoviedb: 'TMDB', tmdb: 'TMDB', rottentomatoes: 'Rotten Tomatoes', thetvdb: 'TVDB', tvdb: 'TVDB', metacritic: 'Metacritic',
}

/** Every score the agent found, named by source — not one anonymous star. */
export function RatingsRow({ item }: { item: PlexItem }) {
  const list = item.ratings ?? []
  if (!list.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((r, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-white/10 text-[12px] text-white">
          <span className="text-white/50">{RATING_LABEL[r.source] ?? r.source}</span>
          <span className="font-semibold tabular-nums">{r.source === 'rottentomatoes' ? `${Math.round(r.value * 10)}%` : r.value.toFixed(1)}</span>
          {r.kind === 'critic' && <span className="text-white/35">critics</span>}
        </span>
      ))}
    </div>
  )
}

export function GenreChips({ item }: { item: PlexItem }) {
  if (!item.genres?.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.genres.map(g => <span key={g} className="h-7 px-2.5 rounded-full bg-white/5 border border-hairline text-[11px] text-white/60 flex items-center">{g}</span>)}
    </div>
  )
}

/** Year · runtime · rating · studio · first aired — the line under the title. */
export function factsLine(item: PlexItem): string {
  const bits: string[] = []
  if (item.year) bits.push(String(item.year))
  if (item.type === 'movie' && item.duration) bits.push(`${Math.round(item.duration / 60000)} min`)
  if (item.type === 'show' && item.leafCount) bits.push(`${item.childCount ?? 0} season${item.childCount === 1 ? '' : 's'} · ${item.leafCount} episodes`)
  if (item.contentRating) bits.push(item.contentRating)
  if (item.studio) bits.push(item.studio)
  if (item.media?.[0]?.videoResolution) bits.push(`${item.media[0].videoResolution}p`)
  return bits.join(' · ')
}

/** The cast, with the headshots Plex's agent attaches — the same strip Plex draws. */
export function CastRow({ item }: { item: PlexItem }) {
  const cast = item.cast ?? []
  if (!cast.length) return null
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Cast</h3>
      <div className="flex gap-3 overflow-x-auto -mx-6 px-6 pb-1">
        {cast.slice(0, 16).map((p, i) => (
          <div key={`${p.name}-${i}`} className="shrink-0 w-[76px] text-center">
            <div className="w-[76px] h-[76px] rounded-full overflow-hidden bg-white/10 border border-hairline mx-auto">
              {p.thumb
                ? <img src={p.thumb} alt="" loading="lazy" className="w-full h-full object-cover" />
                : <div className="w-full h-full flex items-center justify-center text-white/40 text-lg font-semibold">{p.name.slice(0, 1)}</div>}
            </div>
            <p className="mt-1.5 text-[12px] text-white leading-tight line-clamp-2">{p.name}</p>
            {p.role && <p className="text-[11px] text-ink-dim leading-tight line-clamp-2">{p.role}</p>}
          </div>
        ))}
      </div>
    </section>
  )
}

export function CrewLine({ item }: { item: PlexItem }) {
  const bits: string[] = []
  if (item.directors?.length) bits.push(`Directed by ${item.directors.map(d => d.name).join(', ')}`)
  if (item.writers?.length) bits.push(`Written by ${item.writers.slice(0, 3).map(w => w.name).join(', ')}`)
  if (item.countries?.length) bits.push(item.countries.join(', '))
  if (item.originallyAvailableAt) bits.push(`${item.type === 'show' ? 'First aired' : 'Released'} ${item.originallyAvailableAt}`)
  if (!bits.length) return null
  return <p className="text-[12px] text-white/45 leading-relaxed">{bits.join(' · ')}</p>
}

/** The trailer Plex fetched, played through the same transcoder as the film. */
export function TrailerButton({ item }: { item: PlexItem }) {
  const trailer = item.extras?.find(e => e.subtype === 'trailer') ?? item.extras?.[0]
  if (!trailer) return null
  return (
    <button type="button" onClick={() => openPlexPlayer({ key: trailer.key, title: `${item.title} — ${trailer.subtype ?? 'extra'}` })}
      className="h-11 px-4 rounded-full bg-white/10 border border-hairline flex items-center gap-2 text-[13px] text-white active:bg-white/25 self-start">
      <Film size={15} style={{ color: ACCENT }} />
      {trailer.subtype === 'trailer' ? 'Trailer' : trailer.title}
      {trailer.duration ? <span className="text-white/40">{Math.round(trailer.duration / 1000)}s</span> : null}
    </button>
  )
}

/** Plex's per-item shelves: similar titles, more from the studio, more with each lead. */
export function RelatedShelves({ item, onOpen }: { item: PlexItem; onOpen: (key: string) => void }) {
  if (!item.related?.length) return null
  return <>{item.related.map(h => <HubStrip key={h.id} hub={h} onOpen={onOpen} />)}</>
}

/** The header poster with the season/show poster fallback an episode carries. */
export function HeaderPoster({ item }: { item: PlexItem }) {
  const fallback = { ...item, thumb: item.thumb ?? item.parentThumb ?? item.grandparentThumb }
  return <Poster item={fallback} w={112} />
}
