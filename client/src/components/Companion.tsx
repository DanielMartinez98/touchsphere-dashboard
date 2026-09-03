// The phone layout: a remote for the kiosk, not a cramped copy of it.
//
// The four-corner dashboard is built for a 7" panel at arm's length. On a
// phone the corners overlap the centre controls and the sphere costs battery
// for nothing, so below the `sm` breakpoint (see useClientRole) the app shows
// THIS instead: a home screen that answers "what is the kiosk doing" — the
// film on it, with pause/stop; what's up next, with "play on the kiosk"; how
// many pictures are drawing — and a tab bar that opens the same full-screen
// panels the corners open (Plex, Draw, Watch/Play, Time) plus Settings, where
// the Server tab lives. The panels are unchanged: they were already full
// screen, which is exactly the shape a phone wants.
//
// "Play on the kiosk" is the one genuinely new thing here, and it goes
// through the server: POST /api/plex/remote → an SSE frame to the KIOSK's
// connection only → its player opens. The phone never streams the film; it
// tells the wall to.

import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, Brush, ListChecks, Clock, Settings, Pause, Play, Square, Tv, Smartphone, WifiOff, Radio, Sparkles } from 'lucide-react'
import { openPlexPlayer, plexApi, plexImg, type PlexItem, type PlexStatus } from '../hooks/usePlex'
import { onServerEvent } from '../hooks/useServerEvents'
import type { PlexSummary } from './widgets/PlexWidget/PlexWidget'

type OpenWidget = 'time' | 'plex' | 'media' | 'notion' | 'images' | null

export interface NowPlaying {
  key: string
  title: string
  state: 'playing' | 'paused' | 'stopped'
  timeMs: number
  durationMs: number
  at: number
  thumb?: string
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

/** What the kiosk is playing: one GET for the backlog, then the `plex-now` frames. */
function useKioskNow(): { now: NowPlaying | null; kiosks: number; refresh: () => void } {
  const [now, setNow] = useState<NowPlaying | null>(null)
  const [kiosks, setKiosks] = useState(0)
  const refresh = useCallback(() => {
    plexApi.now().then(r => { setNow(r.playing); setKiosks(r.kiosks) }).catch(() => {})
  }, [])
  useEffect(() => {
    const t = setTimeout(refresh, 0)
    const poll = setInterval(refresh, 15_000)
    const off = onServerEvent('plex-now', raw => {
      const f = raw as { playing?: NowPlaying | null } | null
      if (f && typeof f === 'object' && 'playing' in f) setNow(f.playing ?? null)
    })
    return () => { clearTimeout(t); clearInterval(poll); off() }
  }, [refresh])
  return { now, kiosks, refresh }
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function nextLine(i: PlexItem): string {
  if (i.type === 'episode') {
    const se = i.parentIndex !== undefined && i.index !== undefined ? ` S${i.parentIndex}E${i.index}` : ''
    return `${i.grandparentTitle ?? i.title}${se} · ${i.title}`
  }
  return i.title
}

export function Companion({ open, setOpen, plexStatus, plexSummary, agent, setAgent, voice }: {
  open: OpenWidget
  setOpen: (w: OpenWidget) => void
  plexStatus: PlexStatus | null
  plexSummary: PlexSummary | null
  /** The Agent tab: App renders the avatar/sphere and the voice UI behind this layout while it is on. */
  agent: boolean
  setAgent: (on: boolean) => void
  voice: { isListening: boolean; isThinking: boolean; isSpeaking: boolean }
}) {
  const online = useOnline()
  const { now, kiosks, refresh } = useKioskNow()
  const [queued, setQueued] = useState<number>(0)
  const [busy, setBusy] = useState<string | null>(null)
  const plexOk = !!plexStatus?.enabled && plexStatus.services.plex.ok

  // How many pictures are drawing on the kiosk: the queue endpoint is the
  // catch-up half of the `image` event; polling it is enough for a badge.
  useEffect(() => {
    const load = () => fetch('/api/image/queue').then(r => (r.ok ? r.json() : null))
      .then((j: { jobs?: unknown[] } | null) => { if (j && Array.isArray(j.jobs)) setQueued(j.jobs.length) })
      .catch(() => {})
    const t = setTimeout(load, 0)
    const poll = setInterval(load, 15_000)
    const off = onServerEvent('image', () => { void load() })
    return () => { clearTimeout(t); clearInterval(poll); off() }
  }, [])

  const remote = async (action: 'play' | 'pause' | 'resume' | 'stop', key?: string, title?: string) => {
    setBusy(action)
    try { await plexApi.remote({ action, ...(key ? { key } : {}), ...(title ? { title } : {}) }); setTimeout(refresh, 800) }
    catch (err) { console.warn('[companion] remote failed:', err) }
    finally { setBusy(null) }
  }

  const next = plexSummary?.onDeck ?? null
  // Staleness is judged by the server (/now drops a report older than 90 s);
  // an SSE frame is fresh by definition.
  const live = now && now.state !== 'stopped' ? now : null

  const TABS: { id: OpenWidget | 'settings' | 'agent'; label: string; icon: React.ReactElement; badge?: number }[] = [
    { id: 'agent',  label: 'Agent',  icon: <Sparkles size={20} /> },
    { id: 'plex',   label: 'Plex',   icon: <Clapperboard size={20} />, ...(plexSummary?.downloading ? { badge: plexSummary.downloading } : {}) },
    { id: 'images', label: 'Draw',   icon: <Brush size={20} />, ...(queued ? { badge: queued } : {}) },
    { id: 'media',  label: 'List',   icon: <ListChecks size={20} /> },
    { id: 'time',   label: 'Time',   icon: <Clock size={20} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={20} /> },
  ]

  const activeTab = open ?? (agent ? 'agent' : null)

  return (
    // In the Agent view this layout goes transparent and lets taps through to
    // the sphere behind it; only the header and the tab bar stay solid.
    <div className={`absolute inset-0 flex flex-col text-white ${agent ? 'bg-transparent pointer-events-none' : 'bg-black'}`}
         style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-3 pointer-events-auto">
        <Smartphone size={18} className="text-cyan-300" />
        <span className="text-base font-semibold">TouchSphere</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-white/45">
          {!online
            ? <><WifiOff size={13} className="text-amber-300" /><span className="text-amber-200/80">Offline · showing the last thing fetched</span></>
            : kiosks > 0
              ? <><Radio size={13} className="text-emerald-300" />kiosk connected</>
              : <><Radio size={13} className="text-white/30" />no kiosk online</>}
        </span>
      </div>

      {agent ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-end pb-6 pointer-events-none">
          <p className="text-[13px] text-white/50 text-center px-8 leading-snug">
            {voice.isListening ? 'Listening…' : voice.isThinking ? 'Thinking…' : voice.isSpeaking ? 'Speaking' : 'Tap the sphere to talk'}
          </p>
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 flex flex-col gap-4">
        {/* Now on the kiosk */}
        <section>
          <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">On the kiosk</h3>
          <div className="rounded-2xl bg-white/5 border border-hairline p-4">
            {live ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-[72px] rounded-lg overflow-hidden bg-white/5 shrink-0">
                    {live.thumb && <img src={plexImg(live.thumb, 96) ?? ''} alt="" className="w-full h-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug line-clamp-2">{live.title}</p>
                    <p className="text-[12px] text-white/50 mt-1 tabular-nums">
                      {live.state === 'paused' ? 'Paused' : 'Playing'} · {fmtClock(live.timeMs)}{live.durationMs ? ` / ${fmtClock(live.durationMs)}` : ''}
                    </p>
                    {live.durationMs > 0 && (
                      <div className="h-1 mt-2 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-[#e5a00d]" style={{ width: `${Math.min(100, (live.timeMs / live.durationMs) * 100)}%` }} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button type="button" disabled={busy !== null}
                    onClick={() => void remote(live.state === 'paused' ? 'resume' : 'pause')}
                    className="flex-1 h-12 rounded-xl bg-[#e5a00d] text-black font-semibold flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50">
                    {live.state === 'paused' ? <><Play size={18} fill="currentColor" />Resume</> : <><Pause size={18} fill="currentColor" />Pause</>}
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void remote('stop')} aria-label="Stop"
                    className="w-12 h-12 rounded-xl bg-white/10 border border-hairline flex items-center justify-center active:scale-95 disabled:opacity-50">
                    <Square size={16} fill="currentColor" />
                  </button>
                </div>
              </>
            ) : (
              <p className="text-white/40 text-sm">
                {kiosks > 0 ? 'Nothing playing on the kiosk.' : 'The kiosk isn’t connected right now.'}
              </p>
            )}
          </div>
        </section>

        {/* Up next */}
        {plexOk && next && (
          <section>
            <h3 className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-2">Up next</h3>
            <div className="rounded-2xl bg-white/5 border border-hairline p-3 flex items-center gap-3">
              <div className="w-12 h-[72px] rounded-lg overflow-hidden bg-white/5 shrink-0">
                {plexImg(next.thumb ?? next.grandparentThumb, 96) && <img src={plexImg(next.thumb ?? next.grandparentThumb, 96) ?? ''} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug line-clamp-2">{nextLine(next)}</p>
                {next.viewOffset && next.duration ? <p className="text-[12px] text-white/50 mt-0.5">{Math.round((next.duration - next.viewOffset) / 60000)} min left</p> : null}
                <div className="flex gap-2 mt-2">
                  <button type="button" disabled={busy !== null || kiosks === 0}
                    onClick={() => void remote('play', next.key, nextLine(next))}
                    className="h-10 px-3 rounded-xl bg-[#e5a00d] text-black text-[13px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
                    <Tv size={15} />On the kiosk
                  </button>
                  <button type="button"
                    onClick={() => openPlexPlayer({ key: next.key, title: nextLine(next) })}
                    className="h-10 px-3 rounded-xl bg-white/10 border border-hairline text-[13px] font-semibold flex items-center gap-1.5 active:scale-95">
                    <Play size={15} fill="currentColor" />Here
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        <p className="text-white/25 text-xs leading-relaxed">
          Open a film in the Plex tab and pick “TouchSphere kiosk” under Play on… to send it to the wall.
          Drawings queued here are drawn there. Add this page to your home screen to keep it working offline.
        </p>
      </div>
      )}

      {/* Tab bar */}
      <div className="shrink-0 border-t border-hairline bg-black/90 px-2 pt-2 pb-1 flex pointer-events-auto">
        {TABS.map(t => (
          <button key={t.id} type="button"
            onClick={() => {
              if (t.id === 'settings') window.dispatchEvent(new CustomEvent('ts:open-settings'))
              else if (t.id === 'agent') setAgent(!agent)
              else setOpen(t.id as OpenWidget)
            }}
            className={`flex-1 h-14 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-medium relative active:bg-white/10 ${
              activeTab === t.id ? 'text-cyan-200' : 'text-white/60'}`}>
            {t.icon}{t.label}
            {t.badge ? <span className="absolute top-1 right-3 min-w-[18px] h-[18px] px-1 rounded-full bg-[#e5a00d] text-black text-[10px] font-bold flex items-center justify-center">{t.badge}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
