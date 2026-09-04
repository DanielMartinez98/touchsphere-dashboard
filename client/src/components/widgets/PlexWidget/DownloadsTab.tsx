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
  Search, Trash2, Wifi, HardDrive, Gauge, Activity, Layers, ListFilter, Download,
} from 'lucide-react'
import {
  plexApi,
  type ArrRelease, type BulkAction, type BulkState, type DownloadAction, type DownloadAdvice,
  type StackAdvice, type StackHealth, type Torrent, type TorrentDetail,
} from '../../../hooks/usePlex'
import { onServerEvent } from '../../../hooks/useServerEvents'

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

/** What a bulk button says, and how the confirmation puts it. */
const BULK: Record<BulkAction, { label: (n: number) => string; danger?: boolean; confirm?: (n: number) => string }> = {
  reannounce:       { label: n => `Ask trackers again · ${n}` },
  recheck:          { label: n => `Check the files · ${n}` },
  'force-start':    { label: n => `Force start · ${n}` },
  resume:           { label: n => `Resume all · ${n}` },
  pause:            { label: n => `Pause all · ${n}` },
  'refresh-import': { label: () => 'Try importing them all' },
  replace:          { label: n => `Find another for all ${n}`, danger: true,
                      confirm: n => `Blocklist ${n} release${n === 1 ? '' : 's'}, delete them with their files, and ask Sonarr and Radarr to search for replacements. Blocklisting cannot be undone from here.` },
  remove:           { label: n => `Remove all ${n}, keep files`, danger: true,
                      confirm: n => `Remove ${n} download${n === 1 ? '' : 's'} from qBittorrent and leave their files on disk?` },
  'remove-data':    { label: n => `Remove all ${n} and delete`, danger: true,
                      confirm: n => `Remove ${n} download${n === 1 ? '' : 's'} and delete everything they downloaded?` },
}

/** Bulk only makes sense for these; the rest are per-row decisions ('top'
    means nothing when applied to everything at once). */
const BULKABLE: BulkAction[] = ['reannounce', 'recheck', 'force-start', 'resume', 'pause', 'refresh-import', 'replace', 'remove', 'remove-data']

const LEVEL_ORDER: Record<DownloadAdvice['level'], number> = { error: 0, warn: 1, working: 2, info: 3, ok: 4 }

export function DownloadsTab({ canControl }: { canControl: boolean }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState<{ action: BulkAction; group: string; hashes: string[] } | null>(null)

  const load = useCallback(async () => {
    try { setData(await plexApi.torrents()); setError(null) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    const poll = setInterval(() => { void load() }, 8_000)
    return () => { clearTimeout(t); clearInterval(poll) }
  }, [load])

  // The bulk run: its state on open, then every frame it broadcasts. A run
  // outlives this panel, so opening the tab mid-run has to catch up.
  useEffect(() => {
    const t = setTimeout(() => { plexApi.bulkState().then(setBulk).catch(() => {}) }, 0)
    const off = onServerEvent('downloads-bulk', raw => {
      if (raw && typeof raw === 'object') {
        const s = raw as BulkState
        setBulk(s)
        // The list is stale the moment a run touches it.
        if (!s.running) { void load() }
      }
    })
    return () => { clearTimeout(t); off(); }
  }, [load])

  const list = data?.torrents ?? []

  // One group per verdict. This is the whole point of the verdicts: a queue of
  // a hundred rows is really five or six situations, and each has one answer.
  const groups = (() => {
    const by = new Map<string, Torrent[]>()
    for (const t of list) {
      const k = t.advice?.headline ?? 'Unknown'
      const g = by.get(k); if (g) g.push(t); else by.set(k, [t])
    }
    return [...by.entries()]
      .map(([headline, items]) => {
        const level = items[0]?.advice?.level ?? 'info'
        // Only offer what applies to EVERY row in the group — a button that
        // silently skips a third of what it names is worse than no button.
        const shared = BULKABLE.filter(a => items.every(t => (t.advice?.actions as string[] | undefined)?.includes(a)))
        return {
          headline, items, level, shared,
          bytes: items.reduce((n, t) => n + t.downloaded, 0),
        }
      })
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.items.length - a.items.length)
  })()

  const startBulk = async (action: BulkAction, group: string, hashes: string[]) => {
    setConfirm(null)
    try {
      const r = await plexApi.bulk(action, hashes, group)
      setBulk(r.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDone = (m: string) => { setNote(m); void load(); setTimeout(() => setNote(null), 6000) }

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
            <span className="flex items-center gap-1 text-amber-300">
              <Gauge size={13} />slow limits on{data.health.altDownKB > 0 ? ` (${data.health.altDownKB} kB/s)` : ''}
            </span>
          )}
        </div>
      )}

      {/* A bulk run, going or just finished. Above everything: while it runs
          it is the most important thing on the screen. */}
      {bulk && (bulk.running || bulk.summary) && (
        <div className={`rounded-2xl border p-3 ${bulk.running ? 'bg-cyan-500/10 border-cyan-400/30' : bulk.failed ? 'bg-amber-500/10 border-amber-400/30' : 'bg-emerald-500/10 border-emerald-400/25'}`}>
          <div className="flex items-center gap-2">
            {bulk.running && <RefreshCw size={14} className="animate-spin text-cyan-300 shrink-0" />}
            <p className="text-sm text-white/85 font-semibold flex-1 min-w-0">
              {bulk.running ? `${bulk.label} — ${bulk.done} of ${bulk.total}` : bulk.summary}
            </p>
            {bulk.running && (
              <button type="button" onClick={() => { void plexApi.bulkCancel().then(r => setBulk(r.state)) }}
                className="h-9 px-3 rounded-lg bg-white/10 text-white/70 text-[12px] font-semibold active:scale-95">
                Stop
              </button>
            )}
          </div>
          {bulk.running && (
            <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-cyan-400 transition-all" style={{ width: `${bulk.total ? (bulk.done / bulk.total) * 100 : 0}%` }} />
            </div>
          )}
          {bulk.errors.length > 0 && (
            <p className="text-[11px] text-amber-200/80 mt-2 leading-snug">
              {bulk.errors.length} failed: {bulk.errors.slice(0, 3).map(e => `${e.name} (${e.error ?? '?'})`).join('; ')}
            </p>
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

      {/* The confirmation for a destructive bulk run, over everything. */}
      {confirm && (
        <div className="rounded-2xl bg-black/60 border border-red-400/30 p-3 flex flex-col gap-2">
          <p className="text-sm text-white/85 font-semibold">{confirm.group}</p>
          <p className="text-[13px] text-white/65 leading-snug">{BULK[confirm.action].confirm?.(confirm.hashes.length)}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirm(null)}
              className="flex-1 h-11 rounded-xl bg-white/10 text-white/60 text-sm font-medium">Cancel</button>
            <button type="button" onClick={() => { void startBulk(confirm.action, confirm.group, confirm.hashes) }}
              className="flex-1 h-11 rounded-xl bg-red-600 text-white text-sm font-bold active:scale-95">
              Do it for all {confirm.hashes.length}
            </button>
          </div>
        </div>
      )}

      {groups.map(g => {
        const isOpen = expanded[g.headline] ?? g.items.length <= 4
        const tone = LEVEL_STYLE[g.level]
        return (
          <section key={g.headline}>
            <div className="flex items-start gap-2 mb-2">
              <button type="button" onClick={() => setExpanded(e => ({ ...e, [g.headline]: !isOpen }))}
                className="flex items-center gap-2 min-w-0 flex-1 text-left active:opacity-70">
                <span className={`w-2 h-2 rounded-full shrink-0 ${tone.dot}`} />
                <span className={`text-[13px] font-semibold ${tone.text}`}>{g.headline}</span>
                <span className="text-[12px] text-white/35 tabular-nums">
                  · {g.items.length}{g.bytes > 1e8 ? ` · ${fmtBytes(g.bytes)}` : ''}
                </span>
                <span className="text-white/25 ml-auto shrink-0">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
              </button>
            </div>

            {/* One answer for the whole group. Only actions every row in the
                group accepts, so the count on the button is honest. */}
            {canControl && g.shared.length > 0 && !bulk?.running && (
              <div className="flex flex-wrap gap-2 mb-2">
                <span className="flex items-center gap-1 text-[11px] text-white/30 pr-1"><Layers size={12} />all {g.items.length}:</span>
                {g.shared.map(a => {
                  const meta = BULK[a]
                  return (
                    <button key={a} type="button"
                      onClick={() => {
                        const hashes = g.items.map(t => t.hash)
                        if (meta.confirm) setConfirm({ action: a, group: g.headline, hashes })
                        else void startBulk(a, g.headline, hashes)
                      }}
                      className={`h-10 px-3 rounded-xl text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 ${
                        meta.danger ? 'bg-red-500/15 text-red-200 border border-red-400/25' : 'bg-white/10 text-white/75'}`}>
                      {a === 'replace' ? <Search size={13} /> : a === 'remove' || a === 'remove-data' ? <Trash2 size={13} /> : a === 'refresh-import' ? <RefreshCw size={13} /> : <Activity size={13} />}
                      {meta.label(g.items.length)}
                    </button>
                  )
                })}
              </div>
            )}

            {isOpen && (
              <div className="flex flex-col gap-2">
                {g.items.slice(0, 40).map(t => (
                  <Row key={t.hash} t={t} open={open === t.hash} onToggle={() => setOpen(open === t.hash ? null : t.hash)}
                    canControl={canControl && data?.source === 'qbit'} onDone={onDone} />
                ))}
                {g.items.length > 40 && (
                  <p className="text-[12px] text-white/30 px-1">…and {g.items.length - 40} more. The buttons above act on all {g.items.length}.</p>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
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

      {/* Search for a different release. Only when an *arr is tracking this —
          without a queue row there is no episode or film to search FOR. */}
      {d?.arr && <ReleaseSearch hash={hash} kind={d.arr.kind} onDone={onDone} />}

      {/* The numbers */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <Fact k="Done" v={`${fmtBytes(t.downloaded)} of ${fmtBytes(t.size)}`} />
        <Fact k="Added" v={fmtAgo(t.addedOn)} />
        <Fact k="Seeders" v={`${t.seeds} connected of ${t.swarmSeeds} in the swarm`} />
        <Fact k="Peers" v={`${t.peers} connected of ${t.swarmPeers} in the swarm`} />
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

/**
 * Sonarr and Radarr's interactive search, in the row for the download it is
 * meant to replace.
 *
 * The automatic search is a black box: it picks something, and when what it
 * picks is dead or refused you get a stuck row and no way to see what it was
 * choosing between. This asks every indexer live and shows the lot — including
 * the releases the *arr REFUSED and the reason, which is the half that
 * explains an empty queue. Grabbing one overrides that judgement.
 *
 * Not fetched until asked for: it queries every indexer and routinely takes
 * the better part of a minute.
 */
function ReleaseSearch({ hash, kind, onDone }: { hash: string; kind: 'show' | 'movie'; onDone: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ArrRelease[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [grabbing, setGrabbing] = useState<string | null>(null)
  const [showRefused, setShowRefused] = useState(false)
  const arrName = kind === 'show' ? 'Sonarr' : 'Radarr'

  const search = async () => {
    setOpen(true); setBusy(true); setErr(null)
    try { setList((await plexApi.releases(hash)).releases) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const grab = async (r: ArrRelease) => {
    setGrabbing(r.guid); setErr(null)
    try { onDone((await plexApi.grab(hash, r.guid, r.indexerId)).detail) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setGrabbing(null) }
  }

  const auto = async () => {
    setBusy(true); setErr(null)
    try { onDone((await plexApi.searchAgain(hash)).detail) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const approved = (list ?? []).filter(r => r.approved)
  const refused = (list ?? []).filter(r => !r.approved)
  const shown = showRefused ? [...approved, ...refused] : approved

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => { void auto() }}
          className="h-11 px-3 rounded-xl bg-white/10 text-white/80 text-[13px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
          <RefreshCw size={14} className={busy && !open ? 'animate-spin' : ''} />Search again
        </button>
        <button type="button" disabled={busy} onClick={() => { if (open && list) setOpen(false); else void search() }}
          className="h-11 px-3 rounded-xl bg-white/10 text-white/80 text-[13px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
          <ListFilter size={14} />{open && list ? 'Hide releases' : 'Search manually'}
        </button>
      </div>

      {err && <p className="text-amber-300 text-[12px] flex items-center gap-2"><AlertTriangle size={13} />{err}</p>}

      {open && busy && (
        <p className="text-white/45 text-[12px] flex items-center gap-2">
          <RefreshCw size={13} className="animate-spin" />Asking every indexer — this takes a moment.
        </p>
      )}

      {open && !busy && list && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-white/35">
            {approved.length} {arrName} would take
            {refused.length > 0 && <>, {refused.length} it refused{' '}
              <button type="button" onClick={() => setShowRefused(v => !v)} className="underline active:opacity-70">
                {showRefused ? 'hide them' : 'show them'}
              </button></>}
          </p>
          {shown.length === 0 && (
            <p className="text-white/40 text-[13px]">
              Nothing came back{refused.length > 0 ? ` that ${arrName} would accept — the refused ones above say why.` : '. The indexers have nothing for this right now.'}
            </p>
          )}
          {shown.slice(0, 25).map(r => (
            <button key={r.guid} type="button" disabled={grabbing !== null} onClick={() => { void grab(r) }}
              className={`text-left rounded-xl p-2.5 border active:scale-[0.99] disabled:opacity-50 ${
                r.approved ? 'bg-white/5 border-hairline' : 'bg-amber-500/5 border-amber-400/20'}`}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-white/85 leading-snug line-clamp-2">{r.title}</span>
                  <span className="block text-[11px] text-white/45 tabular-nums mt-0.5">
                    {[
                      r.quality,
                      fmtBytes(r.size),
                      r.seeders !== null ? `${r.seeders} seeders` : null,
                      r.indexer,
                      r.ageHours < 48 ? `${Math.round(r.ageHours)}h old` : `${Math.round(r.ageHours / 24)}d old`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  {r.rejections.length > 0 && (
                    <span className="block text-[11px] text-amber-200/70 leading-snug mt-0.5">
                      {arrName} refused it: {r.rejections.slice(0, 2).join('; ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-white/40 mt-0.5">
                  {grabbing === r.guid ? <RefreshCw size={15} className="animate-spin" /> : <Download size={15} />}
                </span>
              </div>
            </button>
          ))}
          {shown.length > 25 && <p className="text-[11px] text-white/30">…and {shown.length - 25} more.</p>}
          <p className="text-[11px] text-white/25 leading-relaxed">
            Tapping one tells {arrName} to download it, overriding what it would have chosen. The stuck
            download stays until you remove it.
          </p>
        </div>
      )}
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
