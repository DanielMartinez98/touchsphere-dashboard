// What is wanted and absent.
//
// The queue answers "what is coming". This answers the question underneath it,
// and the one that usually prompted the queue in the first place: of the shows
// I follow, which episodes do I actually not have. Sonarr counts it per season
// already — aired, monitored episodes against episodes with files — so the
// list is a join and a sort rather than a scan of the disk.
//
// A series opens to its seasons and, inside those, every episode with a tick
// or a gap. That is deliberately the level it opens to: "12 missing" is a
// number, and "S03E04, S03E05 and the whole of season 6" is a thing you can
// act on. Each season carries its own search, because a gap is nearly always
// a season's worth rather than one file.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { plexApi, type MissingEpisode, type MissingMovie, type MissingSeries } from '../../../hooks/usePlex'

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`
  return ''
}

function airLabel(iso: string, aired: boolean): string {
  if (!iso) return 'no air date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const s = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  return aired ? s : `airs ${s}`
}

export function MissingView({ onNote }: { onNote: (m: string) => void }) {
  const [data, setData] = useState<{ series: MissingSeries[]; movies: MissingMovie[]; episodesMissing: number; sonarr: boolean; radarr: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const load = useCallback(async () => {
    try { setData(await plexApi.missing()); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  useEffect(() => { const t = setTimeout(() => { void load() }, 0); return () => clearTimeout(t) }, [load])

  if (error) return <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>
  if (!data) return <p className="text-ink-dim text-sm">Asking Sonarr and Radarr…</p>

  const unreleased = data.movies.filter(m => !m.available)
  const films = data.movies.filter(m => m.available)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-white/60 leading-snug">
        {data.episodesMissing > 0
          ? <>{data.episodesMissing} episode{data.episodesMissing === 1 ? '' : 's'} missing across {data.series.length} show{data.series.length === 1 ? '' : 's'}{films.length > 0 ? `, and ${films.length} film${films.length === 1 ? '' : 's'}` : ''}.</>
          : films.length > 0
            ? <>Every episode you follow is here. {films.length} film{films.length === 1 ? '' : 's'} still missing.</>
            : <>Nothing is missing. Every monitored episode and film that has come out is on disk.</>}
        {' '}Only aired episodes count — a show that has not broadcast yet is not missing.
      </p>

      {data.series.map(s => (
        <SeriesRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} onNote={onNote} />
      ))}

      {films.length > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Films · {films.length}</h3>
          <div className="flex flex-col gap-2">
            {films.map(m => <MovieRow key={m.id} m={m} onNote={onNote} />)}
          </div>
        </section>
      )}

      {unreleased.length > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Not out yet · {unreleased.length}</h3>
          <p className="text-[12px] text-white/35 leading-snug mb-2">
            Wanted, but not released, so there is nothing to find. Listed to explain why they are not above.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unreleased.slice(0, 20).map(m => (
              <span key={m.id} className="h-8 px-2.5 rounded-full bg-white/5 border border-hairline text-[11px] text-white/50 flex items-center">
                {m.title}{m.year ? ` (${m.year})` : ''}
              </span>
            ))}
          </div>
        </section>
      )}

      {!data.sonarr && <p className="text-[12px] text-white/30">Sonarr is not configured, so no shows are listed.</p>}
      {!data.radarr && <p className="text-[12px] text-white/30">Radarr is not configured, so no films are listed.</p>}
    </div>
  )
}

function SeriesRow({ s, open, onToggle, onNote }: { s: MissingSeries; open: boolean; onToggle: () => void; onNote: (m: string) => void }) {
  const have = s.episodes > 0 ? s.onDisk / s.episodes : 0
  return (
    <div className="rounded-2xl bg-white/5 border border-hairline overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full text-left p-3 active:bg-white/5 flex items-start gap-3">
        <div className="w-12 h-[72px] rounded-lg overflow-hidden bg-white/5 shrink-0">
          <img src={`/api/plex/arr/poster/show/${s.id}`} alt="" loading="lazy" className="w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white font-semibold leading-snug line-clamp-2">
            {s.title}{s.year ? <span className="text-white/40 font-normal"> {s.year}</span> : null}
          </p>
          <p className="text-[12px] text-amber-200/80 mt-0.5 tabular-nums">
            {s.missing} missing of {s.episodes}
            {!s.monitored && <span className="text-white/35"> · not monitored</span>}
            {s.status === 'continuing' && <span className="text-white/35"> · still airing</span>}
          </p>
          <div className="h-1.5 mt-2 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-400/70" style={{ width: `${have * 100}%` }} />
          </div>
        </div>
        <span className="shrink-0 text-white/30 mt-1">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </button>
      {open && <SeriesDetail s={s} onNote={onNote} />}
    </div>
  )
}

/** The seasons, and inside them every episode with a tick or a gap. */
function SeriesDetail({ s, onNote }: { s: MissingSeries; onNote: (m: string) => void }) {
  const [eps, setEps] = useState<MissingEpisode[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  // Seasons with gaps open themselves; a complete season stays shut, since
  // the reason for being here is the gaps.
  const [shut, setShut] = useState<Record<number, boolean>>({})

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      plexApi.missingSeries(s.id)
        .then(d => { if (!cancelled) setEps(d.episodes) })
        .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
    }, 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [s.id])

  const searchSeason = async (season: number) => {
    setBusy(season)
    try { onNote((await plexApi.missingSearch({ seriesId: s.id, season })).detail) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (err) return <p className="px-3 pb-3 text-amber-300 text-[13px]">{err}</p>
  if (!eps) return <p className="px-3 pb-3 text-white/40 text-[13px]">Reading the episode list…</p>

  const seasons = [...new Set(eps.map(e => e.season))].sort((a, b) => a - b)

  return (
    <div className="border-t border-hairline px-3 py-3 flex flex-col gap-3">
      {seasons.map(n => {
        const list = eps.filter(e => e.season === n)
        const wanted = list.filter(e => e.monitored && e.aired)
        const missing = wanted.filter(e => !e.hasFile)
        const onDisk = list.filter(e => e.hasFile).length
        const isOpen = shut[n] === undefined ? missing.length > 0 : !shut[n]
        return (
          <div key={n}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShut(v => ({ ...v, [n]: isOpen }))}
                className="flex items-center gap-2 flex-1 min-w-0 text-left active:opacity-70">
                {isOpen ? <ChevronDown size={14} className="text-white/30 shrink-0" /> : <ChevronRight size={14} className="text-white/30 shrink-0" />}
                <span className="text-[13px] font-semibold text-white/85">
                  {n === 0 ? 'Specials' : `Season ${n}`}
                </span>
                <span className={`text-[12px] tabular-nums ${missing.length ? 'text-amber-200/80' : 'text-emerald-300/70'}`}>
                  {onDisk} of {list.length} on disk{missing.length ? ` · ${missing.length} missing` : ''}
                </span>
              </button>
              {missing.length > 0 && (
                <button type="button" disabled={busy !== null} onClick={() => { void searchSeason(n) }}
                  className="h-9 px-2.5 shrink-0 rounded-lg bg-white/10 text-white/75 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
                  {busy === n ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
                  Search
                </button>
              )}
            </div>
            {isOpen && (
              <div className="mt-1.5 flex flex-col">
                {list.map(e => (
                  <div key={e.id} className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0">
                    <span className={`w-4 h-4 rounded-full shrink-0 mt-0.5 flex items-center justify-center ${
                      e.hasFile ? 'bg-emerald-500/25 text-emerald-300'
                      : !e.aired ? 'bg-white/5 text-white/25'
                      : e.monitored ? 'bg-amber-500/25 text-amber-300' : 'bg-white/5 text-white/25'}`}>
                      {e.hasFile ? <Check size={10} /> : <span className="text-[9px] leading-none">·</span>}
                    </span>
                    <span className="text-[12px] text-white/35 tabular-nums shrink-0 w-9">
                      E{String(e.episode).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[12px] leading-snug line-clamp-1 ${e.hasFile ? 'text-white/70' : 'text-white/85'}`}>
                        {e.title || 'Untitled'}
                      </span>
                      <span className="block text-[11px] text-white/30 leading-snug">
                        {e.hasFile
                          ? [e.quality, fmtBytes(e.size)].filter(Boolean).join(' · ') || 'on disk'
                          : !e.aired ? airLabel(e.airDate, false)
                          : !e.monitored ? 'not monitored'
                          : `missing · ${airLabel(e.airDate, true)}`}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MovieRow({ m, onNote }: { m: MissingMovie; onNote: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/5 border border-hairline p-2">
      <div className="w-11 h-16 rounded-lg overflow-hidden bg-white/5 shrink-0 flex items-center justify-center">
        <img src={`/api/plex/arr/poster/movie/${m.id}`} alt="" loading="lazy" className="w-full h-full object-cover"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white leading-snug line-clamp-1">{m.title}{m.year ? <span className="text-white/40"> {m.year}</span> : null}</p>
        <p className="text-[12px] text-amber-200/70">not downloaded</p>
      </div>
      <button type="button" disabled={busy}
        onClick={() => { setBusy(true); plexApi.missingSearch({ movieId: m.id }).then(r => onNote(r.detail)).catch(() => {}).finally(() => setBusy(false)) }}
        className="h-10 px-3 shrink-0 rounded-xl bg-white/10 text-white/75 text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
        {busy ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}Search
      </button>
    </div>
  )
}
