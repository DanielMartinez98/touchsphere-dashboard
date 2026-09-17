// The Indexers tab: Prowlarr's own Search page, on the wall.
//
// Copied from Prowlarr rather than invented, piece by piece: its footer form
// (a Query field with the search-type button on it, an Indexers picker, a
// Categories picker, the "Search all indexers" / "Found N releases" label,
// Search that becomes More once a page is in, Grab Release(s) over a
// selection), its toolbar (a sort menu and a filter), its table on a wide
// screen — select, protocol, age, title, indexer, size, grabs, peers,
// category, flags, actions — and its mobile card on a narrow one: title,
// indexer, and a row of labels with the peers coloured by seeder count on
// exactly its thresholds. Only two things moved. The form is at the TOP,
// because the kiosk's keyboard rises from the bottom and would cover a
// footer; and there is no "save the .torrent" button, since a kiosk has
// nowhere to save one — a grab goes to Prowlarr's download client, which
// is the half that matters here.
//
// Two things about the API are Prowlarr's, not choices: no indexer ids at
// all means every enabled indexer (-1 and -2 are its usenet and torrent
// groups, which the picker's group rows send), and a search is a page of a
// hundred, with More fetching the next offset and appending.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, Download, Flag, Info, ListFilter, LoaderCircle, Radar, Square, SquareCheck,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { plexApi, type Indexer, type IndexerCategory, type IndexerGrab, type IndexerRelease, type IndexerSearchType } from '../../../hooks/usePlex'
import { openBrowse } from '../../../hooks/useBrowse'
import { ACCENT, fmtBytes } from './items'
import {
  CategoryPicker, IndexerPicker, QueryOptionsSheet, Sheet, SortSheet, TypeIcon,
  categoryPickLabel, indexerPickLabel, SORT_OPTIONS, type SortDir, type SortKey,
} from './IndexerPickers'

// ── Formatting, Prowlarr's own ───────────────────────────────────────────────

/** Verbatim from Prowlarr's formatAge(): minutes under two hours, hours under two days, else days. */
function formatAge(age: number, ageHours: number, ageMinutes: number): string {
  const days = Math.round(age)
  if (days < 2 && ageHours) {
    if (ageHours < 2 && ageMinutes) return `${ageMinutes.toFixed(0)} ${ageMinutes.toFixed(0) === '1' ? 'minute' : 'minutes'}`
    return `${ageHours.toFixed(1)} ${ageHours === 1 ? 'hour' : 'hours'}`
  }
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

function titleCase(s: string): string { return s.replace(/\b\w/g, c => c.toUpperCase()) }

type Kind = 'default' | 'primary' | 'info' | 'warning' | 'danger' | 'success' | 'torrent' | 'usenet'

const KIND: Record<Kind, string> = {
  default: 'bg-white/[0.08] text-white/70 border-white/10',
  primary: 'bg-sky-400/15 text-sky-200 border-sky-400/25',
  info:    'bg-sky-400/15 text-sky-200 border-sky-400/25',
  warning: 'bg-amber-400/15 text-amber-200 border-amber-400/25',
  danger:  'bg-red-400/15 text-red-200 border-red-400/25',
  success: 'bg-green-400/15 text-green-200 border-green-400/25',
  torrent: 'bg-green-500/15 text-green-200 border-green-500/25',
  usenet:  'bg-cyan-400/15 text-cyan-200 border-cyan-400/25',
}

/** Prowlarr's Label: a small bordered tag, coloured by kind. */
function Lbl({ kind = 'default', title, children }: { kind?: Kind; title?: string; children: React.ReactNode }) {
  return <span title={title} className={`inline-flex items-center h-6 px-2 rounded-md border text-[11px] font-semibold tabular-nums whitespace-nowrap ${KIND[kind]}`}>{children}</span>
}

/** Prowlarr's Peers label and its thresholds: over 50 seeders is primary, over 10 info, any warning, none danger. */
function Peers({ seeders, leechers }: { seeders: number | null; leechers: number | null }) {
  const s = seeders ?? 0
  const kind: Kind = s > 50 ? 'primary' : s > 10 ? 'info' : s > 0 ? 'warning' : 'danger'
  const part = (n: number | null, unit: string) => n === null ? `Unknown ${unit}s` : `${n} ${unit}${n === 1 ? '' : 's'}`
  return <Lbl kind={kind} title={`${part(seeders, 'seeder')}, ${part(leechers, 'leecher')}`}>{seeders ?? '-'} / {leechers ?? '-'}</Lbl>
}

function ProtocolLabel({ protocol }: { protocol: string }) {
  return <Lbl kind={protocol === 'usenet' ? 'usenet' : 'torrent'}>{protocol === 'usenet' ? 'nzb' : protocol}</Lbl>
}

const rid = (r: IndexerGrab) => `${r.indexerId}:${r.guid}`

/** Prowlarr's release links popover: IMDb / TMDb / TVDb / TV Maze, when the indexer supplied the ids. */
function releaseLinks(r: IndexerRelease): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []
  if (r.imdbId) out.push({ label: 'IMDb', url: `https://imdb.com/title/tt${String(r.imdbId).padStart(7, '0')}/` })
  if (r.tmdbId) out.push({ label: 'TMDb', url: `https://www.themoviedb.org/${r.categories.some(c => c.name === 'Movies') ? 'movie' : 'tv'}/${r.tmdbId}` })
  if (r.tvdbId) out.push({ label: 'TVDb', url: `https://www.thetvdb.com/?tab=series&id=${r.tvdbId}` })
  if (r.tvMazeId) out.push({ label: 'TV Maze', url: `https://www.tvmaze.com/shows/${r.tvMazeId}/_` })
  return out
}

function openPage(url: string, title: string) {
  let site = url
  try { site = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep the url */ }
  openBrowse({ kind: 'web', url, title, site, embeddable: true })
}

// ── Sorting and filtering, Prowlarr's toolbar ────────────────────────────────

type Filter = 'all' | 'torrent' | 'usenet' | 'seeded'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'torrent', label: 'Torrents' }, { id: 'usenet', label: 'Usenet' }, { id: 'seeded', label: 'Has seeders' },
]

function sortReleases(list: IndexerRelease[], key: SortKey, dir: SortDir): IndexerRelease[] {
  const num = (a: number | null | undefined, b: number | null | undefined) => (a ?? -1) - (b ?? -1)
  const cmp: Record<SortKey, (a: IndexerRelease, b: IndexerRelease) => number> = {
    protocol:  (a, b) => a.protocol.localeCompare(b.protocol),
    age:       (a, b) => a.ageMinutes - b.ageMinutes,
    sortTitle: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
    indexer:   (a, b) => a.indexer.localeCompare(b.indexer),
    size:      (a, b) => a.size - b.size,
    files:     (a, b) => num(a.files, b.files),
    grabs:     (a, b) => num(a.grabs, b.grabs),
    peers:     (a, b) => num(a.seeders, b.seeders),
    category:  (a, b) => num(a.categories[0]?.id, b.categories[0]?.id),
  }
  const out = [...list].sort(cmp[key])
  return dir === 'desc' ? out.reverse() : out
}

function passes(r: IndexerRelease, f: Filter): boolean {
  if (f === 'torrent') return r.protocol === 'torrent'
  if (f === 'usenet') return r.protocol === 'usenet'
  if (f === 'seeded') return r.protocol === 'torrent' && (r.seeders ?? 0) > 0
  return true
}

/** Prowlarr switches from its table to cards on a small screen; 900px is where the mail panel makes the same call. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

// The last spoken request this screen ran, kept outside the component: the
// tab is unmounted on every switch away from it, and a spoken search must run
// once when it arrives, not again each time the tab is opened afterwards.
let handledRequestSeq = 0

type GrabState = { state: 'grabbing' | 'grabbed' | 'error'; error?: string }

interface Meta { indexers: Indexer[]; categories: IndexerCategory[]; canGrab: { torrent: boolean; usenet: boolean } }

// ── The tab ──────────────────────────────────────────────────────────────────

export function IndexersTab({ request }: { request: { q: string; seq: number } }) {
  const wide = useWide()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)

  // The form, as Prowlarr's footer keeps it.
  const [query, setQuery] = useState('')
  const [type, setType] = useState<IndexerSearchType>('search')
  const [indexerIds, setIndexerIds] = useState<number[]>([])
  const [cats, setCats] = useState<number[]>([])
  /** True until a search runs, and again the moment the form changes: it decides whether the button reads Search or More. */
  const [newSearch, setNewSearch] = useState(true)

  // The results and what has been done to them.
  const [results, setResults] = useState<IndexerRelease[]>([])
  const [populated, setPopulated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [more, setMore] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('age')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [grabs, setGrabs] = useState<Record<string, GrabState>>({})
  const [bulkBusy, setBulkBusy] = useState(false)
  const [sheet, setSheet] = useState<null | 'query' | 'indexers' | 'categories' | 'sort' | 'filter'>(null)
  // Searches are numbered so a slow one that was superseded cannot land its list over the newer answer.
  const searchSeq = useRef(0)

  useEffect(() => {
    plexApi.indexers().then(setMeta).catch(err => setMetaErr(err instanceof Error ? err.message : String(err)))
  }, [])

  const search = useCallback(async (q: string, opts: { type: IndexerSearchType; indexers: number[]; cats: number[]; append: boolean; offset: number }) => {
    const words = q.trim()
    if (!words) return
    const n = ++searchSeq.current
    const off = opts.append ? opts.offset + 100 : 0
    setBusy(true); setError(null)
    try {
      const r = await plexApi.indexerSearch(words, { type: opts.type, indexers: opts.indexers, cats: opts.cats, offset: off })
      if (n !== searchSeq.current) return
      setResults(prev => {
        if (!opts.append) return r.releases
        const seen = new Set(prev.map(rid))
        return [...prev, ...r.releases.filter(x => !seen.has(rid(x)))]
      })
      if (!opts.append) { setSelected(new Set()); setGrabs({}) }
      setOffset(off); setMore(r.more); setPopulated(true); setNewSearch(false)
    } catch (err) {
      if (n !== searchSeq.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (n === searchSeq.current) setBusy(false)
    }
  }, [])

  const runSearch = useCallback((q = query) => { void search(q, { type, indexers: indexerIds, cats, append: false, offset: 0 }) }, [search, query, type, indexerIds, cats])
  const runMore = useCallback(() => { void search(query, { type, indexers: indexerIds, cats, append: true, offset }) }, [search, query, type, indexerIds, cats, offset])

  // A spoken search_indexers lands here with the words already searched on
  // the server; running them again gives this screen the list to tap.
  // Deferred a tick so the field and the list update after the render that
  // brought the request in, not during it.
  useEffect(() => {
    if (!request.q || !request.seq || request.seq === handledRequestSeq) return
    const t = setTimeout(() => {
      if (request.seq === handledRequestSeq) return
      handledRequestSeq = request.seq
      setQuery(request.q); setType('search'); setIndexerIds([]); setCats([])
      void search(request.q, { type: 'search', indexers: [], cats: [], append: false, offset: 0 })
    }, 0)
    return () => clearTimeout(t)
  }, [request, search])

  // Every change to the form makes the next press a fresh Search, as in Prowlarr.
  const changeQuery = (v: string) => { setQuery(v); setNewSearch(true) }
  const changeType = (t: IndexerSearchType) => { setType(t); setNewSearch(true) }
  const changeIndexers = (v: number[]) => { setIndexerIds(v); setNewSearch(true) }
  const changeCats = (v: number[]) => { setCats(v); setNewSearch(true) }
  const insertToken = (token: string) => changeQuery(query && !/\s$/.test(query) ? `${query} ${token}` : `${query}${token}`)

  const grabOne = async (r: IndexerRelease) => {
    const id = rid(r)
    setGrabs(g => ({ ...g, [id]: { state: 'grabbing' } }))
    try {
      await plexApi.grabRelease(r.guid, r.indexerId)
      setGrabs(g => ({ ...g, [id]: { state: 'grabbed' } }))
    } catch (err) {
      setGrabs(g => ({ ...g, [id]: { state: 'error', error: err instanceof Error ? err.message : String(err) } }))
    }
  }

  const shownAll = useMemo(() => sortReleases(results.filter(r => passes(r, filter)), sortKey, sortDir), [results, filter, sortKey, sortDir])
  const selectedRows = useMemo(() => shownAll.filter(r => selected.has(rid(r))), [shownAll, selected])

  const grabSelected = async () => {
    const rows = selectedRows.filter(r => grabs[rid(r)]?.state !== 'grabbed')
    if (!rows.length) return
    setBulkBusy(true); setError(null)
    setGrabs(g => { const n = { ...g }; for (const r of rows) n[rid(r)] = { state: 'grabbing' }; return n })
    try {
      const { grabbed } = await plexApi.grabReleases(rows.map(r => ({ guid: r.guid, indexerId: r.indexerId })))
      const ok = new Set(grabbed.map(rid))
      setGrabs(g => { const n = { ...g }; for (const r of rows) n[rid(r)] = ok.has(rid(r)) ? { state: 'grabbed' } : { state: 'error', error: 'Prowlarr could not grab this one' }; return n })
      setSelected(new Set())
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      setGrabs(g => { const n = { ...g }; for (const r of rows) n[rid(r)] = { state: 'error', error: m }; return n })
      setError(m)
    } finally { setBulkBusy(false) }
  }

  const toggleSelected = (r: IndexerRelease) => setSelected(prev => { const n = new Set(prev); const id = rid(r); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allSelected = shownAll.length > 0 && shownAll.every(r => selected.has(rid(r)))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(shownAll.map(rid)))
  const setSort = (k: SortKey, d: SortDir) => { setSortKey(k); setSortDir(d) }
  const headerSort = (k: SortKey) => setSort(k, k === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc')

  const enabled = (meta?.indexers ?? []).filter(i => i.enabled)
  const hasIndexers = enabled.length > 0
  const footerLabel = populated
    ? (selected.size === 0 ? `Found ${results.length} release${results.length === 1 ? '' : 's'}` : `Selected ${selected.size} of ${results.length} releases`)
    : (indexerIds.length === 0 ? 'Search all indexers' : `Search ${indexerIds.length} indexer${indexerIds.length === 1 ? '' : 's'}`)
  // Which protocol's results have nowhere to go, if any — said before a tap, not after a bare 500.
  const noClientFor = !meta || !populated ? null
    : results.some(r => r.protocol === 'torrent') && !meta.canGrab.torrent ? 'torrent'
    : results.some(r => r.protocol === 'usenet') && !meta.canGrab.usenet ? 'usenet'
    : null
  const canSearch = !!query.trim() && hasIndexers && !busy
  const grabbable = selectedRows.some(r => grabs[rid(r)]?.state !== 'grabbed')

  const grabButton = (extraClass = '') => (
    <button type="button" onClick={() => { void grabSelected() }} disabled={bulkBusy || busy || !grabbable}
      className={`h-12 px-4 rounded-xl text-sm font-semibold bg-green-500 text-black flex items-center gap-2 active:scale-95 disabled:opacity-40 ${extraClass}`}>
      {bulkBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
      Grab release{selected.size === 1 ? '' : 's'}
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      {/* ── The form (Prowlarr's footer) ─────────────────────────────────── */}
      <section className="rounded-2xl bg-white/5 border border-hairline p-3 flex flex-col gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-1.5">Query</p>
          <div className="flex gap-2">
            <TouchInput value={query} onChange={v => { changeQuery(v); if (v.trim()) void search(v, { type, indexers: indexerIds, cats, append: false, offset: 0 }) }} commitOn="done"
              placeholder={type === 'search' ? 'Search…' : `${type === 'tvsearch' ? 'Show' : type === 'movie' ? 'Film' : type === 'music' ? 'Artist or album' : 'Author or title'}, or an id token…`}
              ariaLabel="Search query"
              className="flex-1 min-w-0 bg-white/10 text-white rounded-2xl px-4 py-3.5 text-base placeholder:text-white/30 border border-hairline" />
            <button type="button" onClick={() => setSheet('query')} title="Click to change query options" aria-label="Query options"
              className="h-[52px] w-16 shrink-0 rounded-2xl bg-white/10 border border-hairline flex items-center justify-center gap-1 text-white/80 active:scale-95">
              <TypeIcon type={type} /><ChevronDown size={13} className="text-white/45" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-1.5">Indexers</p>
            <button type="button" onClick={() => setSheet('indexers')} disabled={!meta}
              className="w-full h-12 px-3.5 rounded-xl bg-white/10 border border-hairline flex items-center gap-2 text-left text-[14px] text-white/85 active:scale-[0.98] disabled:opacity-50">
              <span className="flex-1 min-w-0 truncate">{meta ? indexerPickLabel(indexerIds, meta.indexers) : '…'}</span>
              <ChevronDown size={15} className="text-white/45 shrink-0" />
            </button>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-1.5">Categories</p>
            <button type="button" onClick={() => setSheet('categories')} disabled={!meta}
              className="w-full h-12 px-3.5 rounded-xl bg-white/10 border border-hairline flex items-center gap-2 text-left text-[14px] text-white/85 active:scale-[0.98] disabled:opacity-50">
              <span className="flex-1 min-w-0 truncate">{meta ? categoryPickLabel(cats, meta.categories) : '…'}</span>
              <ChevronDown size={15} className="text-white/45 shrink-0" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          <p className="text-[12px] text-white/50 flex-1 min-w-0 truncate">{footerLabel}</p>
          {populated && selected.size > 0 && grabButton()}
          <button type="button" onClick={() => (newSearch || !more ? runSearch() : runMore())} disabled={!canSearch}
            className="h-12 px-5 rounded-xl text-sm font-semibold text-black flex items-center gap-2 active:scale-95 disabled:opacity-40"
            style={{ background: ACCENT }}>
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : null}
            {busy ? 'Searching' : newSearch || !more ? 'Search' : 'More'}
          </button>
        </div>
      </section>

      {metaErr && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{metaErr}</p>}
      {meta && !hasIndexers && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />Prowlarr has no enabled indexers, so there is nothing to search.</p>}
      {error && <p className="text-red-300 text-sm flex items-start gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{error}</p>}
      {noClientFor && (
        <p className="text-amber-200/80 text-[13px] leading-snug flex items-start gap-2">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          Prowlarr has no {noClientFor} download client, so grabbing {noClientFor} results will fail — add one under Prowlarr → Settings → Download Clients.
        </p>
      )}

      {/* ── Before the first search ─────────────────────────────────────── */}
      {!populated && !busy && !error && (
        <div className="rounded-2xl border border-hairline bg-white/[0.03] px-5 py-8 flex flex-col items-center text-center gap-2">
          <Radar size={34} className="text-white/25" />
          <p className="text-white/70 text-[15px] font-semibold">Search every indexer Prowlarr has</p>
          <p className="text-white/40 text-[13px] leading-relaxed max-w-sm">
            Type what you are after and press Search. The icon beside the query picks a search type — a TV or Movie
            search also takes an id, like <span className="font-mono text-white/60">{'{TmdbId:12345}'}</span>.
          </p>
        </div>
      )}

      {busy && !populated && (
        <p className="text-white/45 text-[13px] flex items-center gap-2">
          <LoaderCircle size={14} className="animate-spin" />Asking {indexerIds.length || enabled.length || 'the'} indexer{(indexerIds.length || enabled.length) === 1 ? '' : 's'} — this takes a moment.
        </p>
      )}

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {populated && (
        <section className="flex flex-col gap-2">
          {/* Prowlarr's toolbar: sort menu and filter menu, right-aligned. */}
          <div className="flex items-center gap-2">
            <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold flex-1 min-w-0 truncate">
              {shownAll.length === results.length ? `${results.length} release${results.length === 1 ? '' : 's'}` : `${shownAll.length} of ${results.length} releases`}
            </p>
            <button type="button" onClick={() => setSheet('sort')} disabled={!results.length}
              className="h-10 px-3 rounded-full bg-white/[0.06] border border-hairline text-[12px] font-semibold text-white/70 flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
              {sortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{SORT_OPTIONS.find(o => o.id === sortKey)?.label}
            </button>
            <button type="button" onClick={() => setSheet('filter')} disabled={!results.length}
              className={`h-10 px-3 rounded-full border text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40 ${
                filter === 'all' ? 'bg-white/[0.06] border-hairline text-white/70' : 'bg-[#e5a00d]/15 border-[#e5a00d]/30 text-[#e5a00d]'}`}>
              <ListFilter size={13} />{FILTERS.find(f => f.id === filter)?.label}
            </button>
          </div>

          {results.length === 0 && (
            <div className="rounded-2xl bg-sky-400/10 border border-sky-400/20 px-4 py-3.5 flex items-start gap-3 text-sky-100 text-[13px] leading-snug">
              <Info size={17} className="shrink-0 mt-0.5" />No search results found, try performing a new search above.
            </div>
          )}
          {results.length > 0 && shownAll.length === 0 && (
            <div className="rounded-2xl bg-amber-400/10 border border-amber-400/20 px-4 py-3.5 flex items-start gap-3 text-amber-100 text-[13px] leading-snug">
              <AlertTriangle size={17} className="shrink-0 mt-0.5" />All search results are hidden by the applied filter.
            </div>
          )}

          {shownAll.length > 0 && (wide
            ? <ReleaseTable rows={shownAll} selected={selected} grabs={grabs} sortKey={sortKey} sortDir={sortDir} allSelected={allSelected}
                onSort={headerSort} onToggle={toggleSelected} onToggleAll={toggleAll} onGrab={grabOne} />
            : shownAll.map(r => (
                <ReleaseCard key={rid(r)} r={r} selected={selected.has(rid(r))} grab={grabs[rid(r)]} onToggle={() => toggleSelected(r)} onGrab={() => { void grabOne(r) }} />
              ))
          )}

          {busy && populated && <p className="text-white/45 text-[13px] flex items-center gap-2"><LoaderCircle size={14} className="animate-spin" />Fetching more…</p>}
          {!busy && more && shownAll.length > 0 && (
            <button type="button" onClick={runMore} className="h-12 rounded-xl bg-white/[0.06] border border-hairline text-sm font-semibold text-white/75 active:bg-white/10">
              More
            </button>
          )}

          {/* The selection bar follows a long list down, since the form's own Grab button has scrolled off. */}
          {selected.size > 0 && (
            <div className="sticky bottom-2 z-20 rounded-2xl bg-[#0e1117]/95 border border-hairline px-4 py-2.5 flex items-center gap-3 shadow-lg shadow-black/40">
              <p className="text-[13px] text-white/75 flex-1 min-w-0 truncate">Selected {selected.size} of {results.length} releases</p>
              <button type="button" onClick={() => setSelected(new Set())} className="text-[12px] text-white/50 underline active:opacity-70">Clear</button>
              {grabButton('h-11')}
            </div>
          )}
        </section>
      )}

      {/* ── Sheets ──────────────────────────────────────────────────────── */}
      {sheet === 'query' && <QueryOptionsSheet type={type} onType={changeType} onInsert={insertToken} onClose={() => setSheet(null)} />}
      {sheet === 'indexers' && meta && <IndexerPicker indexers={meta.indexers} value={indexerIds} onChange={changeIndexers} onClose={() => setSheet(null)} />}
      {sheet === 'categories' && meta && <CategoryPicker categories={meta.categories} value={cats} onChange={changeCats} onClose={() => setSheet(null)} />}
      {sheet === 'sort' && <SortSheet sortKey={sortKey} dir={sortDir} onChange={setSort} onClose={() => setSheet(null)} />}
      {sheet === 'filter' && <FilterSheet filter={filter} onChange={setFilter} onClose={() => setSheet(null)} />}
    </div>
  )
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function GrabButton({ state, onPress, small = false }: { state?: GrabState; onPress: () => void; small?: boolean }) {
  const s = state?.state
  const title = s === 'grabbed' ? 'Release added to client' : s === 'error' ? state?.error : 'Add release to download client'
  return (
    <button type="button" onClick={onPress} disabled={s === 'grabbing' || s === 'grabbed'} title={title} aria-label={title}
      className={`${small ? 'w-10 h-10' : 'w-11 h-11'} shrink-0 rounded-full border flex items-center justify-center active:scale-95 transition-colors ${
        s === 'grabbed' ? 'bg-green-500/20 border-green-400/30 text-green-300'
        : s === 'error' ? 'bg-red-500/15 border-red-400/30 text-red-300'
        : 'bg-white/10 border-hairline text-white/80'}`}>
      {s === 'grabbing' ? <LoaderCircle size={18} className="animate-spin" /> : s === 'grabbed' ? <Check size={18} /> : <Download size={18} />}
    </button>
  )
}

function SelectBox({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} onClick={onToggle}
      className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center active:bg-white/10 ${on ? 'text-[#e5a00d]' : 'text-white/35'}`}>
      {on ? <SquareCheck size={20} /> : <Square size={20} />}
    </button>
  )
}

function LinksRow({ r }: { r: IndexerRelease }) {
  const links = releaseLinks(r)
  if (!links.length) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {links.map(l => (
        <button key={l.label} type="button" onClick={() => openPage(l.url, `${l.label} · ${r.title}`)}
          className="h-7 px-2.5 rounded-md bg-sky-400/10 border border-sky-400/20 text-sky-200 text-[11px] font-semibold active:bg-sky-400/20">
          {l.label}
        </button>
      ))}
    </div>
  )
}

/** Prowlarr's mobile row: title with the grab beside it, the indexer under it, then the labels. */
function ReleaseCard({ r, selected, grab, onToggle, onGrab }: { r: IndexerRelease; selected: boolean; grab?: GrabState; onToggle: () => void; onGrab: () => void }) {
  return (
    <div className={`rounded-2xl border p-2.5 pl-1 flex gap-1.5 ${selected ? 'bg-[#e5a00d]/10 border-[#e5a00d]/30' : 'bg-white/5 border-hairline'}`}>
      <SelectBox on={selected} onToggle={onToggle} label={`Select ${r.title}`} />
      {r.posterUrl && <img src={r.posterUrl} alt="" loading="lazy" className="w-12 h-[72px] rounded-lg object-cover shrink-0 bg-white/5" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <button type="button" disabled={!r.infoUrl} onClick={() => r.infoUrl && openPage(r.infoUrl, r.title)} className="min-w-0 flex-1 text-left active:opacity-70 disabled:opacity-100">
            <p className="text-[13px] font-medium text-white/90 leading-snug line-clamp-2 break-words">{r.title}</p>
          </button>
          <GrabButton state={grab} onPress={onGrab} />
        </div>
        <p className="text-[12px] text-white/40 mt-0.5 truncate">{r.indexer}</p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          <ProtocolLabel protocol={r.protocol} />
          {r.protocol === 'torrent' && <Peers seeders={r.seeders} leechers={r.leechers} />}
          <Lbl>{fmtBytes(r.size)}</Lbl>
          <Lbl title={r.publishDate ? new Date(r.publishDate).toLocaleString() : undefined}>{formatAge(r.age, r.ageHours, r.ageMinutes)}</Lbl>
          {r.grabs !== null && <Lbl title="Grabs">{r.grabs} grab{r.grabs === 1 ? '' : 's'}</Lbl>}
          {r.categories.map(c => <Lbl key={c.id}>{c.name}</Lbl>)}
          {[...r.flags].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(f => <Lbl key={f} kind="info">{titleCase(f)}</Lbl>)}
        </div>
        {grab?.state === 'error' && <p className="text-[12px] text-red-300 mt-1.5 leading-snug">{grab.error}</p>}
        <LinksRow r={r} />
      </div>
    </div>
  )
}

const COLS = '44px 84px 96px minmax(0,1fr) 130px 88px 64px 88px 160px 40px 56px'

/** A sortable column heading: the active one is amber and carries its direction. */
function Head({ k, label, right = false, sortKey, sortDir, onSort }: { k: SortKey; label: string; right?: boolean; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void }) {
  return (
    <button type="button" onClick={() => onSort(k)} className={`h-10 px-2 flex items-center gap-1 text-[11px] uppercase tracking-wider font-semibold active:opacity-70 ${right ? 'justify-end' : ''} ${
      sortKey === k ? 'text-[#e5a00d]' : 'text-white/45'}`}>
      {label}{sortKey === k && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  )
}

/** Prowlarr's table, column for column, on a screen wide enough for it. */
function ReleaseTable({ rows, selected, grabs, sortKey, sortDir, allSelected, onSort, onToggle, onToggleAll, onGrab }: {
  rows: IndexerRelease[]; selected: Set<string>; grabs: Record<string, GrabState>; sortKey: SortKey; sortDir: SortDir; allSelected: boolean
  onSort: (k: SortKey) => void; onToggle: (r: IndexerRelease) => void; onToggleAll: () => void; onGrab: (r: IndexerRelease) => Promise<void>
}) {
  const head = { sortKey, sortDir, onSort }
  return (
    <div className="rounded-2xl border border-hairline bg-white/[0.03] overflow-hidden">
      <div className="grid items-center border-b border-hairline bg-white/[0.04]" style={{ gridTemplateColumns: COLS }}>
        <div className="flex justify-center"><SelectBox on={allSelected} onToggle={onToggleAll} label="Select all" /></div>
        <Head {...head} k="protocol" label="Protocol" />
        <Head {...head} k="age" label="Age" />
        <Head {...head} k="sortTitle" label="Title" />
        <Head {...head} k="indexer" label="Indexer" />
        <Head {...head} k="size" label="Size" right />
        <Head {...head} k="grabs" label="Grabs" right />
        <Head {...head} k="peers" label="Peers" />
        <Head {...head} k="category" label="Category" />
        <div className="flex justify-center text-white/45"><Flag size={13} /></div>
        <div />
      </div>
      {rows.map(r => {
        const id = rid(r)
        const on = selected.has(id)
        const grab = grabs[id]
        return (
          <div key={id} className={`grid items-center border-b border-hairline last:border-b-0 min-h-14 ${on ? 'bg-[#e5a00d]/10' : ''}`} style={{ gridTemplateColumns: COLS }}>
            <div className="flex justify-center"><SelectBox on={on} onToggle={() => onToggle(r)} label={`Select ${r.title}`} /></div>
            <div className="px-2"><ProtocolLabel protocol={r.protocol} /></div>
            <div className="px-2 text-[12px] text-white/70 tabular-nums" title={r.publishDate ? new Date(r.publishDate).toLocaleString() : undefined}>{formatAge(r.age, r.ageHours, r.ageMinutes)}</div>
            <div className="px-2 py-2 min-w-0">
              <button type="button" disabled={!r.infoUrl} onClick={() => r.infoUrl && openPage(r.infoUrl, r.title)} className="text-left w-full active:opacity-70 disabled:opacity-100">
                <p className="text-[13px] text-white/90 leading-snug line-clamp-2 break-words">{r.title}</p>
              </button>
              {grab?.state === 'error' && <p className="text-[11px] text-red-300 mt-0.5 leading-snug">{grab.error}</p>}
              <LinksRow r={r} />
            </div>
            <div className="px-2 text-[12px] text-white/70 truncate">{r.indexer}</div>
            <div className="px-2 text-[12px] text-white/70 tabular-nums text-right">{fmtBytes(r.size)}</div>
            <div className="px-2 text-[12px] text-white/70 tabular-nums text-right">{r.grabs ?? ''}</div>
            <div className="px-2">{r.protocol === 'torrent' && <Peers seeders={r.seeders} leechers={r.leechers} />}</div>
            <div className="px-2 flex flex-wrap gap-1 py-1">{r.categories.map(c => <Lbl key={c.id}>{c.name}</Lbl>)}</div>
            <div className="flex justify-center text-sky-300" title={r.flags.map(titleCase).join(', ')}>{r.flags.length > 0 && <Flag size={14} />}</div>
            <div className="flex justify-center"><GrabButton small state={grab} onPress={() => { void onGrab(r) }} /></div>
          </div>
        )
      })}
    </div>
  )
}

function FilterSheet({ filter, onChange, onClose }: { filter: Filter; onChange: (f: Filter) => void; onClose: () => void }) {
  return (
    <Sheet title="Filter" onClose={onClose}>
      <div className="flex flex-col gap-1.5">
      {FILTERS.map(f => (
        <button key={f.id} type="button" onClick={() => { onChange(f.id); onClose() }}
          className={`h-12 px-3 rounded-xl flex items-center gap-3 text-[14px] font-medium text-left ${
            filter === f.id ? 'bg-white/15 text-white border border-white/20' : 'bg-white/[0.04] text-white/70 border border-transparent active:bg-white/10'}`}>
          {f.label}{filter === f.id && <Check size={16} className="ml-auto text-[#e5a00d]" />}
        </button>
      ))}
      </div>
    </Sheet>
  )
}
