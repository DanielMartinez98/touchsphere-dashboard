// The Indexers tab: Prowlarr's own search page, on the wall.
//
// The Requests tab asks for a TITLE and lets the *arrs choose the file; the
// Downloads tab's manual search asks the indexers about a queue row the *arrs
// already own. Neither answers "what is actually out there for X" — a concert
// film, a soundtrack, a remux of something already in the library, a game —
// and that is Prowlarr's search page, which this is. Results come back as the
// indexers returned them, best seeded first, and a tap on one OPENS it rather
// than grabbing it: a mis-tap on a 7" screen is otherwise forty gigabytes, so
// the grab is a second, labelled tap inside the opened row (the two-tap rule
// Settings → Server uses for a reboot).
//
// Searched on Done rather than per keystroke: a search asks every indexer
// live and a private tracker rate-limits, so debouncing keystrokes would be
// five searches for one word. The Requests tab's per-keystroke TMDB search
// does not have that problem.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, RefreshCw, Search, Lock } from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { plexApi, type Indexer, type IndexerRelease } from '../../../hooks/usePlex'
import { ACCENT, fmtAgeHours, fmtBytes } from './items'

type Sort = 'seeders' | 'size' | 'newest'

const SORTS: { id: Sort; label: string }[] = [
  { id: 'seeders', label: 'Seeders' },
  { id: 'size',    label: 'Size' },
  { id: 'newest',  label: 'Newest' },
]

function sorted(list: IndexerRelease[], by: Sort): IndexerRelease[] {
  const out = [...list]
  if (by === 'size') out.sort((a, b) => b.size - a.size)
  else if (by === 'newest') out.sort((a, b) => a.ageHours - b.ageHours)
  else out.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || a.ageHours - b.ageHours)
  return out
}

/**
 * A release's identity on this screen. A guid is the indexer's own and two
 * indexers can hand back the same one for the same swarm, so it is qualified.
 */
function rid(r: IndexerRelease): string { return `${r.indexerId}:${r.guid}` }

// The last spoken request this screen ran, kept outside the component: the
// tab is unmounted on every switch away from it, and a spoken search must run
// once when it arrives, not again each time the tab is opened afterwards.
let handledRequestSeq = 0

/** The category chips a release carries, shortest first, without the "Movies/" prefix repeating. */
function catLine(cats: string[]): string {
  if (!cats.length) return ''
  const top = cats.find(c => !c.includes('/')) ?? cats[0]!
  const sub = cats.find(c => c.includes('/'))
  return sub ?? top
}

export function IndexersTab({ request }: { request: { q: string; seq: number } }) {
  const [query, setQuery] = useState('')
  /** The words the results on screen are for. */
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [cat, setCat] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ indexers: Indexer[]; canGrab: { torrent: boolean; usenet: boolean }; categories: { id: string; label: string }[] } | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [pickIndexers, setPickIndexers] = useState(false)
  const [results, setResults] = useState<IndexerRelease[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('seeders')
  const [open, setOpen] = useState<string | null>(null)
  const [grabbing, setGrabbing] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  // Searches are numbered so a slow one that was superseded by a category tap
  // cannot land its list over the newer answer.
  const searchSeq = useRef(0)

  useEffect(() => {
    plexApi.indexers().then(setMeta).catch(err => setMetaErr(err instanceof Error ? err.message : String(err)))
  }, [])

  /**
   * One live search. Called from the handlers rather than run by an effect
   * on the inputs, because which of the inputs should trigger a search is a
   * decision: a category tap means "again, narrower"; ticking indexers is a
   * multi-select and applies to the next Search.
   */
  const search = useCallback(async (words: string, c: string | null, ids: Set<number>) => {
    const q = words.trim()
    if (!q) return
    const n = ++searchSeq.current
    setSubmitted(q); setBusy(true); setError(null); setOpen(null)
    try {
      const r = await plexApi.indexerSearch(q, { ...(c ? { cat: c } : {}), indexers: [...ids] })
      if (n !== searchSeq.current) return
      setResults(r.releases)
    } catch (err) {
      if (n !== searchSeq.current) return
      setError(err instanceof Error ? err.message : String(err)); setResults(null)
    } finally {
      if (n === searchSeq.current) setBusy(false)
    }
  }, [])

  // A spoken search_indexers lands here with the words already searched on
  // the server; running them again gives this screen the list to tap.
  // Deferred a tick so the field and the list update after the render that
  // brought the request in, not during it.
  useEffect(() => {
    if (!request.q || !request.seq || request.seq === handledRequestSeq) return
    const t = setTimeout(() => {
      if (request.seq === handledRequestSeq) return
      handledRequestSeq = request.seq
      setQuery(request.q)
      void search(request.q, null, new Set())
    }, 0)
    return () => clearTimeout(t)
  }, [request, search])

  const grab = async (r: IndexerRelease) => {
    setGrabbing(rid(r)); setError(null)
    try {
      const { detail } = await plexApi.grabRelease(r.guid, r.indexerId)
      setDone(d => ({ ...d, [rid(r)]: detail }))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setGrabbing(null) }
  }

  const pickCat = (id: string | null) => {
    setCat(id)
    if (submitted) void search(submitted, id, chosen)
  }

  const toggleIndexer = (id: number) => setChosen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const enabled = (meta?.indexers ?? []).filter(i => i.enabled)
  const privateCount = enabled.filter(i => i.privacy !== 'public').length
  const list = results ? sorted(results, sort) : null
  // Which protocol's results have nowhere to go, if any — said before a tap, not after a bare 500.
  const noClientFor = !meta || !list ? null
    : list.some(r => r.protocol === 'torrent') && !meta.canGrab.torrent ? 'torrent'
    : list.some(r => r.protocol === 'usenet') && !meta.canGrab.usenet ? 'usenet'
    : null
  const catLabel = cat ? meta?.categories.find(c => c.id === cat)?.label : undefined

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
          <TouchInput value={query} onChange={v => { setQuery(v); void search(v, cat, chosen) }} commitOn="done"
            placeholder="Search the indexers…" ariaLabel="Search the indexers"
            className="w-full bg-white/10 text-white rounded-2xl pl-11 pr-4 py-3.5 text-base placeholder:text-white/30 border border-hairline" />
        </div>
        <button type="button" onClick={() => { void search(query, cat, chosen) }} disabled={busy || !query.trim()}
          className="h-[52px] px-4 shrink-0 rounded-2xl text-sm font-semibold text-black active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
          style={{ background: ACCENT }}>
          <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />{busy ? 'Asking…' : 'Search'}
        </button>
      </div>

      {/* Categories, then which indexers */}
      {meta && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
            {[{ id: null as string | null, label: 'Everything' }, ...meta.categories].map(c => (
              <button key={c.id ?? 'all'} type="button" onClick={() => pickCat(c.id)}
                className={`h-10 px-4 shrink-0 rounded-full text-[13px] font-semibold border transition-colors active:scale-95 ${
                  cat === c.id ? 'bg-white/20 text-white border-white/25' : 'bg-white/5 text-white/55 border-transparent'}`}>
                {c.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setPickIndexers(v => !v)}
            className="flex items-center gap-2 text-[12px] text-white/45 active:opacity-70 self-start h-8">
            {pickIndexers ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {chosen.size ? `${chosen.size} of ${enabled.length} indexers` : `All ${enabled.length} indexer${enabled.length === 1 ? '' : 's'}`}
            {privateCount > 0 && <span className="text-white/30">· {privateCount} private</span>}
          </button>
          {pickIndexers && (
            <div className="flex flex-wrap gap-2 items-center">
              {enabled.map(i => (
                <button key={i.id} type="button" onClick={() => toggleIndexer(i.id)}
                  className={`h-10 px-3.5 rounded-full text-[13px] font-medium border flex items-center gap-1.5 active:scale-95 ${
                    chosen.size === 0 || chosen.has(i.id) ? 'bg-white/15 text-white border-white/20' : 'bg-white/5 text-white/40 border-transparent'}`}>
                  {i.privacy !== 'public' && <Lock size={12} className="text-white/50" />}{i.name}
                  <span className="text-white/35 text-[11px]">{i.protocol === 'usenet' ? 'nzb' : ''}</span>
                </button>
              ))}
              {chosen.size > 0 && (
                <button type="button" onClick={() => setChosen(new Set())} className="h-10 px-3 text-[12px] text-white/50 underline active:opacity-70">
                  all again
                </button>
              )}
              {enabled.length === 0 && <p className="text-white/40 text-[13px]">Prowlarr has no enabled indexers.</p>}
              {enabled.length > 0 && <p className="w-full text-[11px] text-white/30">Applies to the next search.</p>}
            </div>
          )}
        </div>
      )}
      {metaErr && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{metaErr}</p>}
      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}
      {noClientFor && (
        <p className="text-amber-200/80 text-[13px] leading-snug flex items-start gap-2">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          Prowlarr has no {noClientFor} download client, so grabbing {noClientFor} results will fail — add one under Prowlarr → Settings → Download Clients.
        </p>
      )}

      {/* Nothing asked yet */}
      {!submitted && !busy && (
        <p className="text-ink-dim text-sm leading-relaxed">
          Ask every indexer Prowlarr has, for anything by name — a film, a show, an album, a book, a game.
          The results are the raw releases; open one and tap Download to send it to the download client.
        </p>
      )}

      {busy && (
        <p className="text-white/45 text-[13px] flex items-center gap-2">
          <RefreshCw size={14} className="animate-spin" />Asking {chosen.size || enabled.length || 'every'} indexer{(chosen.size || enabled.length) === 1 ? '' : 's'} — this takes a moment.
        </p>
      )}

      {/* Results */}
      {!busy && list && submitted && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold flex-1 min-w-0">
              {list.length} result{list.length === 1 ? '' : 's'} for “{submitted}”{catLabel ? ` · ${catLabel}` : ''}
            </p>
            {list.length > 1 && (
              <div className="flex gap-1">
                {SORTS.map(s => (
                  <button key={s.id} type="button" onClick={() => setSort(s.id)}
                    className={`h-8 px-3 rounded-full text-[12px] font-semibold border active:scale-95 ${
                      sort === s.id ? 'bg-white/15 text-white border-white/20' : 'bg-transparent text-white/40 border-transparent'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {list.length === 0 && (
            <p className="text-ink-dim text-sm">
              Nothing on the indexers for “{submitted}”{catLabel ? ` under ${catLabel}` : ''}
              {cat ? ' — try Everything, since indexers file things unevenly.' : '.'}
            </p>
          )}
          {list.slice(0, 60).map(r => {
            const id = rid(r)
            const isOpen = open === id
            const grabbed = done[id]
            const seeds = r.protocol === 'torrent' && r.seeders !== null
            return (
              <div key={id} className={`rounded-2xl border ${isOpen ? 'bg-white/10 border-white/20' : 'bg-white/5 border-hairline'}`}>
                <button type="button" onClick={() => setOpen(isOpen ? null : id)} className="w-full text-left p-3 active:opacity-80">
                  <p className="text-[13px] text-white/90 leading-snug break-words line-clamp-2">{r.title}</p>
                  <p className="text-[11px] text-white/45 tabular-nums mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    <span className="text-white/70">{fmtBytes(r.size)}</span>
                    {seeds && (
                      <span className={r.seeders! > 0 ? 'text-green-300/80' : 'text-red-300/80'}>
                        {r.seeders} seed{r.seeders === 1 ? '' : 's'}{r.leechers !== null ? ` · ${r.leechers} peers` : ''}
                      </span>
                    )}
                    {r.protocol === 'usenet' && <span>usenet{r.grabs !== null ? ` · ${r.grabs} grabs` : ''}</span>}
                    <span>{r.indexer}</span>
                    <span>{fmtAgeHours(r.ageHours)}</span>
                    {catLine(r.categories) && <span className="text-white/35">{catLine(r.categories)}</span>}
                    {r.flags.slice(0, 2).map(f => <span key={f} className="text-[#e5a00d]/80">{f}</span>)}
                  </p>
                  {grabbed && <p className="text-[12px] text-green-300 mt-1 flex items-center gap-1"><Check size={13} />Sent to the download client</p>}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 flex flex-col gap-2">
                    <p className="text-[12px] text-white/50 leading-relaxed">
                      {r.categories.length ? `${r.categories.join(', ')} · ` : ''}{r.protocol}
                      {r.publishDate ? ` · posted ${new Date(r.publishDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                      {r.grabs !== null ? ` · grabbed ${r.grabs} time${r.grabs === 1 ? '' : 's'}` : ''}
                    </p>
                    {grabbed ? (
                      <p className="text-[12px] text-white/60 leading-snug">{grabbed}</p>
                    ) : (
                      <button type="button" disabled={grabbing !== null} onClick={() => { void grab(r) }}
                        className="h-11 px-4 self-start rounded-full text-sm font-semibold text-black active:scale-95 disabled:opacity-50 flex items-center gap-2"
                        style={{ background: ACCENT }}>
                        {grabbing === id ? <RefreshCw size={15} className="animate-spin" /> : <Download size={15} />}
                        Download this
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {list.length > 60 && <p className="text-[11px] text-white/30">…and {list.length - 60} more. Narrow the search or pick a category.</p>}
          {list.length > 0 && (
            <p className="text-[11px] text-white/25 leading-relaxed">
              Downloading sends the release to the client Prowlarr is set up with. It shows under Downloads once it
              starts; Sonarr or Radarr will file it only if it matches something they track.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
