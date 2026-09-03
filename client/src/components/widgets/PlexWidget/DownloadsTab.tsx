// The Downloads tab: what is coming, why it is stuck, and what to do about it.
//
// It used to be a list of state words and percentages, which names the symptom
// and answers nothing — "stalled" is not a reason and "47%" is not a plan. The
// server now joins what qBittorrent, Sonarr and Radarr each know into one
// verdict per download (server/src/downloads.ts), so this screen leads with
// that: the rows that need attention first, each with a sentence saying what
// is wrong and buttons that do the specific thing that fixes it.
//
// A row opens to the full account — the evidence the verdict was reached
// from, the numbers, the trackers and what they replied — because a verdict
// you cannot check is just a different opinion. The precise verdict is
// fetched per row (trackers and properties are a call each in qBittorrent, and
// this list runs to a hundred rows), so the list shows the cheap one and
// opening a row upgrades it.

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Pause, Play, RefreshCw,
  Search, Trash2, Wifi, HardDrive, Gauge, Activity,
} from 'lucide-react'
import {
  plexApi,
  type DownloadAction, type DownloadAdvice, type StackAdvice, type StackHealth,
  type Torrent, type TorrentDetail,
} from '../../../hooks/usePlex'

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
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
function fmtAgo(unixSec: number): string {
  if (!unixSec) return '—'
  const mins = Math.max(0, Math.round((Date.now() - unixSec * 1000) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}
function fmtDuration(sec: number): string {
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  return h >= 24 ? `${Math.round(h / 24)}d` : h >= 1 ? `${h}h ${Math.round((sec % 3600) / 60)}m` : `${Math.round(sec / 60)}m`
}

const PHASE_LABEL: Record<Torrent['phase'], string> = {
  downloading: 'Downloading', seeding: 'Seeding', paused: 'Paused', stalled: 'Stalled',
  queued: 'Queued', checking: 'Checking', done: 'Finished', error: 'Error',
}

const LEVEL_STYLE: Record<DownloadAdvice['level'], { dot: string; text: string }> = {
  error:   { dot: 'bg-red-400',     text: 'text-red-200'     },
  warn:    { dot: 'bg-amber-400',   text: 'text-amber-200'   },
  info:    { dot: 'bg-sky-400',     text: 'text-sky-200'     },
  working: { dot: 'bg-cyan-400',    text: 'text-cyan-200'    },
  ok:      { dot: 'bg-emerald-400', text: 'text-emerald-200' },
}

/** What each action's button says, and whether it needs a second tap. */
const ACTION: Record<DownloadAction, { label: string; icon: React.ReactElement; danger?: boolean; confirm?: string }> = {
  resume:           { label: 'Resume',              icon: <Play size={14} fill="currentColor" /> },
  pause:            { label: 'Pause',               icon: <Pause size={14} fill="currentColor" /> },
  recheck:          { label: 'Check the files',     icon: <Check size={14} /> },
  reannounce:       { label: 'Ask trackers again',  icon: <Activity size={14} /> },
  'force-start':    { label: 'Force start',         icon: <Play size={14} fill="currentColor" /> },
  top:              { label: 'Move to the top',     icon: <ChevronDown size={14} className="rotate-180" /> },
  'refresh-import': { label: 'Try importing again', icon: <RefreshCw size={14} /> },
  replace:          { label: 'Find another release', icon: <Search size={14} />, danger: true, confirm: 'Blocklist this release, delete it, and search for another?' },
  remove:           { label: 'Remove, keep files',  icon: <Trash2 size={14} />, danger: true, confirm: 'Remove from qBittorrent and leave the files on disk?' },
  'remove-data':    { label: 'Remove and delete',   icon: <Trash2 size={14} />, danger: true, confirm: 'Remove it and delete what it downloaded?' },
}

// ── The tab ──────────────────────────────────────────────────────────────────

interface Data {
  source: 'qbit' | 'arr'
  warning?: string
  torrents: Torrent[]
  transfer: { dlspeed: number; upspeed: number; connected: boolean } | null
  health: StackHealth | null
  stackAdvice: StackAdvice[]
}

export function DownloadsTab({ canControl }: { canControl: boolean }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await plexApi.torrents()); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    const poll = setInterval(() => { void load() }, 8_000)
    return () => { clearTimeout(t); clearInterval(poll) }
  }, [load])

  const list = data?.torrents ?? []
  // Ordered by what wants doing: the broken first, then the working, then the
  // finished. Inside a group, newest first.
  const rank = (t: Torrent) => (t.advice?.level === 'error' ? 0 : t.advice?.level === 'warn' ? 1 : 0)
  const attention = list.filter(t => t.advice && (t.advice.level === 'error' || t.advice.level === 'warn'))
    .sort((a, b) => rank(a) - rank(b) || b.addedOn - a.addedOn)
  const active = list.filter(t => !attention.includes(t) && t.phase !== 'done' && t.phase !== 'seeding')
  const finished = list.filter(t => !attention.includes(t) && (t.phase === 'done' || t.phase === 'seeding'))

  return (
    <div className="flex flex-col gap-4">
      {/* Speeds and the connection, which is the first thing a slow queue
          raises and the last thing anyone thinks to check. */}
      {data?.transfer && (
        <div className="flex items-center gap-3 text-[13px] text-white/60 tabular-nums flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${data.transfer.connected ? 'bg-green-400' : 'bg-amber-400'}`} />
            ↓ {fmtSpeed(data.transfer.dlspeed)} <span className="text-white/30">·</span> ↑ {fmtSpeed(data.transfer.upspeed)}
          </span>
          {data.health?.connection && data.health.connection !== 'unknown' && (
            <span className="flex items-center gap-1"><Wifi size={13} className="text-white/40" />{data.health.connection}</span>
          )}
          {data.health?.freeSpaceGB !== null && data.health?.freeSpaceGB !== undefined && (
            <span className="flex items-center gap-1"><HardDrive size={13} className="text-white/40" />{data.health.freeSpaceGB.toFixed(0)} GB free</span>
          )}
          {data.health?.altSpeed && (
            <span className="flex items-center gap-1 text-amber-300"><Gauge size={13} />slow limits on</span>
          )}
        </div>
      )}

      {/* Whole-stack problems: the ones that explain several stuck rows at once. */}
      {data?.stackAdvice.map((a, i) => (
        <div key={i} className={`rounded-2xl border p-3 ${a.level === 'error' ? 'bg-red-500/10 border-red-400/30' : 'bg-amber-500/10 border-amber-400/30'}`}>
          <p className={`text-sm font-semibold ${a.level === 'error' ? 'text-red-200' : 'text-amber-100'}`}>{a.headline}</p>
          <p className="text-[12px] text-white/60 leading-snug mt-1">{a.detail}</p>
        </div>
      ))}

      {error && <p className="text-amber-300 text-sm flex items-center gap-2"><AlertTriangle size={16} />{error}</p>}
      {data?.warning && <p className="text-amber-300/80 text-[13px] flex items-center gap-2"><AlertTriangle size={14} />{data.warning} — showing Sonarr/Radarr's queue instead.</p>}
      {note && <p className="text-emerald-300/90 text-[13px] flex items-center gap-2"><Check size={14} />{note}</p>}
      {!data && !error && <p className="text-ink-dim text-sm">Loading…</p>}
      {data && !list.length && <p className="text-ink-dim text-sm">Nothing is downloading.</p>}

      {attention.length > 0 && (
        <Section title={`Needs attention · ${attention.length}`}>
          {attention.map(t => (
            <Row key={t.hash} t={t} open={open === t.hash} onToggle={() => setOpen(open === t.hash ? null : t.hash)}
              canControl={canControl && data?.source === 'qbit'} onDone={m => { setNote(m); void load(); setTimeout(() => setNote(null), 6000) }} />
          ))}
        </Section>
      )}
      {active.length > 0 && (
        <Section title="Coming">
          {active.map(t => (
            <Row key={t.hash} t={t} open={open === t.hash} onToggle={() => setOpen(open === t.hash ? null : t.hash)}
              canControl={canControl && data?.source === 'qbit'} onDone={m => { setNote(m); void load(); setTimeout(() => setNote(null), 6000) }} />
          ))}
        </Section>
      )}
      {finished.length > 0 && (
        <Section title={`Finished · ${finished.length}`}>
          {finished.slice(0, 20).map(t => (
            <Row key={t.hash} t={t} open={open === t.hash} onToggle={() => setOpen(open === t.hash ? null : t.hash)}
              canControl={canControl && data?.source === 'qbit'} onDone={m => { setNote(m); void load(); setTimeout(() => setNote(null), 6000) }} />
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

// ── One download ─────────────────────────────────────────────────────────────

function Row({ t, open, onToggle, canControl, onDone }: {
  t: Torrent; open: boolean; onToggle: () => void; canControl: boolean; onDone: (msg: string) => void
}) {
  const pct = Math.round(t.progress * 100)
  const live = t.phase === 'downloading'
  const adv = t.advice
  const tone = LEVEL_STYLE[adv?.level ?? 'info']

  return (
    <div className="rounded-2xl bg-white/5 border border-hairline overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full text-left p-3 active:bg-white/5">
        <div className="flex items-start gap-3">
          <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${tone.dot}`} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white font-semibold leading-snug line-clamp-2">{t.label ?? t.name}</p>
            {t.label && <p className="text-[11px] text-white/35 line-clamp-1 mt-0.5">{t.name}</p>}
            <p className="text-[12px] mt-1 tabular-nums text-white/55">
              {PHASE_LABEL[t.phase]}
              {t.phase !== 'done' && t.phase !== 'seeding' && ` · ${pct}%`}
              {live && ` · ${fmtSpeed(t.dlspeed)} · ${fmtEta(t.eta)} left`}
              {t.phase === 'seeding' && ` · ↑ ${fmtSpeed(t.upspeed)} · ratio ${t.ratio.toFixed(1)}`}
              {` · ${fmtBytes(t.size)}`}
            </p>
            {adv && (
              <p className={`text-[12px] mt-1 leading-snug ${tone.text}`}>
                {adv.headline}
                {!open && <span className="text-white/35"> · tap for why</span>}
              </p>
            )}
          </div>
          <span className="shrink-0 text-white/30 mt-1">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        </div>
        {t.phase !== 'done' && t.phase !== 'seeding' && (
          <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className={`h-full ${t.phase === 'paused' ? 'bg-white/40' : t.phase === 'stalled' || adv?.level === 'error' ? 'bg-amber-400' : 'bg-[#e5a00d]'}`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </button>

      {open && <Detail hash={t.hash} fallback={t} canControl={canControl} onDone={onDone} />}
    </div>
  )
}

/**
 * The opened row: the precise verdict (re-judged with the trackers and the
 * properties), what to do about it, the numbers, and the evidence.
 */
function Detail({ hash, fallback, canControl, onDone }: {
  hash: string; fallback: Torrent; canControl: boolean; onDone: (msg: string) => void
}) {
  const [d, setD] = useState<TorrentDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<DownloadAction | null>(null)
  const [confirming, setConfirming] = useState<DownloadAction | null>(null)
  // What a removal should also do. Pre-set to the useful answer and left
  // visible, because "delete the files too" and "never grab this release
  // again" are exactly the decisions a stuck download needs made.
  const [delFiles, setDelFiles] = useState(true)
  const [blocklist, setBlocklist] = useState(true)
  const [searchAgain, setSearchAgain] = useState(true)

  const reload = useCallback(() => {
    plexApi.torrent(hash).then(setD).catch(e => setErr(e instanceof Error ? e.message : String(e)))
  }, [hash])
  useEffect(() => { const t = setTimeout(reload, 0); return () => clearTimeout(t) }, [reload])

  const adv = d?.advice ?? fallback.advice
  const t = d?.torrent ?? fallback
  const tone = LEVEL_STYLE[adv?.level ?? 'info']

  const run = async (a: DownloadAction) => {
    setBusy(a); setErr(null)
    try {
      if (a === 'remove' || a === 'remove-data') {
        const r = await plexApi.removeTorrent(hash, { files: a === 'remove-data' && delFiles, blocklist, search: searchAgain })
        onDone(r.detail ?? 'Removed.')
        return
      }
      const r = await plexApi.torrentAction(hash, a)
      onDone(r.detail ?? `${ACTION[a].label} — done.`)
      if (a !== 'replace') reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null); setConfirming(null)
    }
  }

  const trackers = (d?.trackers ?? []).filter(x => !/^\*\*\s*\[/.test(x.url))
  const p = d?.props

  return (
    <div className="border-t border-hairline px-3 py-3 flex flex-col gap-3">
      {/* What is wrong and what to do */}
      {adv ? (
        <div className={`rounded-xl p-3 ${adv.level === 'error' ? 'bg-red-500/10' : adv.level === 'warn' ? 'bg-amber-500/10' : 'bg-white/5'}`}>
          <p className={`text-sm font-semibold ${tone.text}`}>{adv.headline}</p>
          <p className="text-[13px] text-white/70 leading-relaxed mt-1">{adv.detail}</p>
        </div>
      ) : <p className="text-white/40 text-sm">Looking at it…</p>}

      {err && <p className="text-amber-300 text-[13px] flex items-center gap-2"><AlertTriangle size={14} />{err}</p>}

      {/* What to do about it */}
      {canControl && adv && adv.actions.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {adv.actions.map(a => {
              const meta = ACTION[a]
              const isRemove = a === 'remove' || a === 'remove-data'
              return (
                <button key={a} type="button" disabled={busy !== null}
                  onClick={() => { if (meta.confirm) setConfirming(confirming === a ? null : a); else void run(a) }}
                  className={`h-11 px-3 rounded-xl text-[13px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40 ${
                    confirming === a ? 'bg-red-600/85 text-white'
                    : meta.danger ? 'bg-red-500/15 text-red-200 border border-red-400/25'
                    : 'bg-white/10 text-white/80'}`}>
                  {busy === a ? <RefreshCw size={14} className="animate-spin" /> : meta.icon}
                  {isRemove && confirming === a ? 'Confirm' : meta.label}
                </button>
              )
            })}
          </div>

          {/* The confirmation, with the two decisions a removal implies. */}
          {confirming && (
            <div className="rounded-xl bg-black/40 border border-red-400/25 p-3 flex flex-col gap-2">
              <p className="text-[13px] text-white/80 leading-snug">{ACTION[confirming].confirm}</p>
              {(confirming === 'remove' || confirming === 'remove-data') && (
                <div className="flex flex-col gap-1.5">
                  {confirming === 'remove-data' && (
                    <Toggle on={delFiles} onChange={setDelFiles} label="Delete the downloaded files" hint="Off leaves them in the download folder." />
                  )}
                  <Toggle on={blocklist} onChange={setBlocklist} label="Blocklist this release" hint="Sonarr/Radarr will never grab this exact file again." />
                  <Toggle on={searchAgain} onChange={setSearchAgain} label="Search for another" hint="Ask for a different release of the same thing." />
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirming(null)}
                  className="flex-1 h-11 rounded-xl bg-white/10 text-white/60 text-sm font-medium">Cancel</button>
                <button type="button" disabled={busy !== null} onClick={() => void run(confirming)}
                  className="flex-1 h-11 rounded-xl bg-red-600 text-white text-sm font-bold active:scale-95 disabled:opacity-50">
                  {busy ? 'Working…' : 'Do it'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {!canControl && <p className="text-white/30 text-[12px]">qBittorrent isn’t reachable, so nothing here can be changed.</p>}

      {/* The numbers */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <Fact k="Done" v={`${fmtBytes(t.downloaded)} of ${fmtBytes(t.size)}`} />
        <Fact k="Added" v={fmtAgo(t.addedOn)} />
        <Fact k="Seeders" v={p ? `${p.seeds} of ${p.seedsTotal} known` : String(t.seeds)} />
        <Fact k="Peers" v={p ? `${p.peers} of ${p.peersTotal} known` : String(t.peers)} />
        <Fact k="Ratio" v={t.ratio.toFixed(2)} />
        {p && <Fact k="Connections" v={String(p.connections)} />}
        {p && <Fact k="Active for" v={fmtDuration(p.timeElapsedSec)} />}
        {p && p.piecesNum > 0 && <Fact k="Pieces" v={`${p.piecesHave} / ${p.piecesNum}`} />}
        {p && p.wasted > 0 && <Fact k="Wasted" v={fmtBytes(p.wasted)} />}
        {d?.arr && <Fact k="Tracked by" v={d.arr.kind === 'show' ? 'Sonarr' : 'Radarr'} />}
        {d?.arr?.trackedState && <Fact k="Import state" v={d.arr.trackedState} />}
      </div>
      {p?.savePath && <p className="text-[11px] text-white/30 break-all">{p.savePath}</p>}
      {d?.arr?.note && <p className="text-[12px] text-amber-200/80 leading-snug">{d.arr.note}</p>}

      {/* The trackers — where the real reason usually is */}
      {trackers.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-1">Trackers</p>
          <div className="flex flex-col gap-1">
            {trackers.slice(0, 6).map(tr => (
              <div key={tr.url} className="flex items-start gap-2 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  tr.status === 2 ? 'bg-emerald-400' : tr.status === 4 ? 'bg-red-400' : 'bg-white/25'}`} />
                <span className="text-white/45 break-all flex-1 min-w-0">{tr.url.replace(/^https?:\/\//, '').slice(0, 60)}</span>
                {tr.msg && <span className="text-amber-200/70 shrink-0 max-w-[45%] truncate">{tr.msg}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Why it says what it says */}
      {adv?.evidence?.length ? (
        <p className="text-[11px] text-white/25 leading-relaxed">Based on: {adv.evidence.join(' · ')}.</p>
      ) : null}
    </div>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return <><span className="text-white/35">{k}</span><span className="text-white/70 tabular-nums text-right">{v}</span></>
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="flex items-start gap-2.5 text-left py-1.5 active:opacity-70">
      <span className={`w-5 h-5 rounded-md shrink-0 mt-0.5 flex items-center justify-center border ${
        on ? 'bg-red-500 border-red-400 text-white' : 'bg-white/5 border-white/20'}`}>
        {on && <Check size={13} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-white/85 leading-snug">{label}</span>
        <span className="block text-[11px] text-white/35 leading-snug">{hint}</span>
      </span>
    </button>
  )
}
