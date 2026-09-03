// The full-screen video player for the Plex library.
//
// Plex serves the film as an HLS stream through /api/plex/hls (the server holds
// the token and proxies), and hls.js feeds that to a <video> — Chromium has no
// native HLS, and Plex's transcoder is what turns an MKV with DTS audio into
// something a browser on a Pi can decode at all.
//
// Two things about the stream shape this player everything around:
//
//   • SEEKING RESTARTS THE TRANSCODE. The media playlist only reaches as far as
//     the transcoder has written, so the scrub bar is measured against the
//     duration Plex reported for the file, not against what hls.js can see, and
//     a seek asks the server for a NEW session starting at that offset. The
//     <video>'s own clock is therefore relative to the offset — every time
//     shown or reported is `offsetMs + currentTime`.
//   • PROGRESS IS REPORTED. Every ten seconds while playing, on pause, and on
//     close, so Plex's "continue watching" — and the resume point play_media
//     picks up — is the one the kiosk actually reached.
//
// `hold`, exactly as on BrowserOverlay: the assistant holding the floor pauses
// the film, and it resumes when she is done. Playback and the voice loop must
// never share the room.
//
// Z-band 9300/9290: above the browser window (a film is the thing that was just
// asked for) and below a generated picture, which keeps its place on top of
// everything.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Play, Pause, RotateCcw, RotateCw, AlertTriangle } from 'lucide-react'
import { closePlexPlayer, plexApi, usePlexPlayerTarget, type PlayTarget } from '../hooks/usePlex'

const PROGRESS_EVERY_MS = 10_000
const CONTROLS_HIDE_MS = 4_000

interface Session { id: string; src: string; offsetMs: number; durationMs: number; title: string }

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function PlexPlayer({ hold = false }: { hold?: boolean }) {
  const target = usePlexPlayerTarget()
  if (!target) return null
  // Keyed on seq so asking for a second film tears the first player down
  // entirely — its session, its hls instance, its timers — rather than reusing
  // a <video> half-way through the previous stream.
  return <Player key={target.seq} target={target} hold={hold} />
}

function Player({ target, hold }: { target: PlayTarget; hold: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<{ destroy: () => void } | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [needsTap, setNeedsTap] = useState(false)
  const [posMs, setPosMs] = useState(0)
  const [controls, setControls] = useState(true)
  const hideTimer = useRef<number | null>(null)
  // Whether the USER paused it, as opposed to `hold` — so a hold lifting
  // resumes a film that was playing and leaves alone one that wasn't.
  const userPaused = useRef(false)
  const sessionRef = useRef<Session | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])

  const absMs = useCallback((): number => {
    const v = videoRef.current
    const s = sessionRef.current
    return (s?.offsetMs ?? 0) + (v ? v.currentTime * 1000 : 0)
  }, [])

  // ── Start (or restart at an offset) ────────────────────────────────────
  const start = useCallback(async (offsetMs?: number) => {
    setError(null); setBuffering(true); setNeedsTap(false)
    const prev = sessionRef.current
    if (prev) void plexApi.stop(prev.id)
    hlsRef.current?.destroy(); hlsRef.current = null
    try {
      const res = await plexApi.play({
        key: target.key,
        ...(target.partId !== undefined ? { partId: target.partId } : {}),
        ...(target.audioStreamId !== undefined ? { audioStreamId: target.audioStreamId } : {}),
        ...(target.subtitleStreamId !== undefined ? { subtitleStreamId: target.subtitleStreamId } : {}),
        ...(offsetMs !== undefined ? { offsetMs } : target.offsetMs !== undefined ? { offsetMs: target.offsetMs } : {}),
        maxHeight: window.innerWidth >= 1280 ? 1080 : 720,
      })
      if (res.mode !== 'local') throw new Error('server did not start a stream')
      const s: Session = { id: res.session, src: res.src, offsetMs: res.offsetMs, durationMs: res.durationMs, title: res.title }
      setSession(s)
      setPosMs(s.offsetMs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBuffering(false)
    }
  }, [target])

  useEffect(() => { void start() }, [start])

  // ── Attach the stream ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v || !session) return
    let cancelled = false
    const tryPlay = () => {
      v.play().then(() => setNeedsTap(false)).catch(() => {
        // Autoplay refused (a phone with no gesture behind a voice command):
        // show a big Play rather than a black rectangle.
        setNeedsTap(true); setBuffering(false)
      })
    }
    ;(async () => {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = session.src
        if (!hold) tryPlay()
        return
      }
      const { default: Hls } = await import('hls.js')
      if (cancelled) return
      if (!Hls.isSupported()) { setError('This browser cannot play the stream'); return }
      const hls = new Hls({
        // Plex writes the playlist as the transcoder goes, so treat it live-ish:
        // keep asking for the playlist, don't give up on a gap.
        lowLatencyMode: false,
        maxBufferLength: 60,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 8,
      })
      hlsRef.current = hls
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        else setError(`Playback failed (${data.details})`)
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!hold) tryPlay() })
      hls.loadSource(session.src)
      hls.attachMedia(v)
    })()
    return () => { cancelled = true; hlsRef.current?.destroy(); hlsRef.current = null }
    // `hold` is read at attach time only; the hold effect below handles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // ── Hold: the assistant has the floor ──────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v || !session) return
    if (hold) { if (!v.paused) v.pause() }
    else if (!userPaused.current && v.paused && !needsTap) { v.play().catch(() => setNeedsTap(true)) }
  }, [hold, session, needsTap])

  // ── Clock + progress reports ───────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v || !session) return
    const report = (state: 'playing' | 'paused') => {
      void plexApi.progress({ key: target.key, state, timeMs: absMs(), durationMs: session.durationMs, session: session.id })
    }
    const onTime = () => setPosMs(session.offsetMs + v.currentTime * 1000)
    const onPlay = () => { setPlaying(true); setBuffering(false); report('playing') }
    const onPause = () => { setPlaying(false); report('paused') }
    const onWaiting = () => setBuffering(true)
    const onPlaying = () => setBuffering(false)
    const onEnded = () => { setPlaying(false); void plexApi.progress({ key: target.key, state: 'stopped', timeMs: session.durationMs, durationMs: session.durationMs, session: session.id }) }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('playing', onPlaying)
    v.addEventListener('ended', onEnded)
    const tick = window.setInterval(() => { if (!v.paused) report('playing') }, PROGRESS_EVERY_MS)
    return () => {
      window.clearInterval(tick)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('waiting', onWaiting)
      v.removeEventListener('playing', onPlaying)
      v.removeEventListener('ended', onEnded)
    }
  }, [session, target.key, absMs])

  // ── Teardown: tell Plex where we got to and stop the transcoder ────────
  useEffect(() => () => {
    const s = sessionRef.current
    if (s) {
      const timeMs = absMs()
      // keepalive so the report survives the page going away with the tap.
      void fetch('/api/plex/stop', {
        method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ session: s.id, timeMs, durationMs: s.durationMs }),
      }).catch(() => {})
    }
    hlsRef.current?.destroy()
  }, [absMs])

  // ── Controls visibility ────────────────────────────────────────────────
  const poke = useCallback(() => {
    setControls(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControls(false), CONTROLS_HIDE_MS)
  }, [])
  useEffect(() => { poke(); return () => { if (hideTimer.current) window.clearTimeout(hideTimer.current) } }, [poke])
  // Paused, buffering or broken: keep the controls up — there is nothing to hide them for.
  const showControls = controls || !playing || buffering || !!error || needsTap

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return
    poke()
    if (v.paused) { userPaused.current = false; v.play().catch(() => setNeedsTap(true)) }
    else { userPaused.current = true; v.pause() }
  }
  const skip = (deltaMs: number) => {
    poke()
    const s = sessionRef.current; if (!s) return
    const to = Math.min(Math.max(0, absMs() + deltaMs), Math.max(0, s.durationMs - 5000))
    userPaused.current = false
    void start(to)
  }
  const seekTo = (fraction: number) => {
    poke()
    const s = sessionRef.current; if (!s || !s.durationMs) return
    userPaused.current = false
    void start(Math.round(fraction * s.durationMs))
  }

  const duration = session?.durationMs ?? 0
  const frac = duration ? Math.min(1, posMs / duration) : 0

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9290] bg-black" />
      <div className="fixed inset-0 z-[9300] flex flex-col select-none" onClick={() => { if (controls && playing) setControls(false); else poke() }}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          playsInline
          preload="auto"
        />

        {/* Spinner / big play / error — the middle of the screen */}
        {(buffering && !error && !needsTap) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 rounded-full border-4 border-white/20 border-t-white/80 animate-spin" />
          </div>
        )}
        {needsTap && !error && (
          <button type="button" aria-label="Play"
            onClick={e => { e.stopPropagation(); togglePlay() }}
            className="absolute inset-0 m-auto w-28 h-28 rounded-full bg-white/15 border border-white/30 backdrop-blur
                       flex items-center justify-center text-white active:scale-95">
            <Play size={52} fill="currentColor" className="ml-2" />
          </button>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <AlertTriangle size={40} className="text-amber-300" />
            <p className="text-white/85 text-lg">{error}</p>
            <button type="button" onClick={e => { e.stopPropagation(); void start(absMs()) }}
              className="px-6 py-3 rounded-2xl bg-glass-2 border border-hairline text-white text-base active:bg-white/25">
              Try again
            </button>
          </div>
        )}

        {/* Top bar: title + close */}
        <div className={`relative flex items-start gap-3 px-4 pt-4 pb-6 bg-gradient-to-b from-black/80 to-transparent transition-opacity ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
             style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold mb-1">Plex</p>
            <p className="text-white text-lg font-semibold leading-snug line-clamp-2">{session?.title ?? target.title}</p>
          </div>
          <button type="button" onClick={e => { e.stopPropagation(); closePlexPlayer() }} aria-label="Stop and close"
            className="w-14 h-14 shrink-0 rounded-full bg-glass-2 border border-hairline flex items-center
                       justify-center text-white/80 active:scale-90 active:bg-white/25 transition-colors">
            <X size={26} strokeWidth={2.25} />
          </button>
        </div>

        <div className="flex-1" />

        {/* Bottom bar: scrub + transport */}
        <div className={`relative px-4 pb-4 pt-8 bg-gradient-to-t from-black/85 to-transparent transition-opacity ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
             style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
             onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-3 text-white/70 text-sm tabular-nums mb-2">
            <span>{fmtClock(posMs)}</span>
            {/* The bar is a tap target the height of a finger; the visible line is thinner. */}
            <div className="flex-1 h-10 flex items-center" role="slider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}
                 onClick={e => {
                   const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                   seekTo((e.clientX - r.left) / r.width)
                 }}>
              <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
                <div className="h-full bg-[#e5a00d]" style={{ width: `${frac * 100}%` }} />
              </div>
            </div>
            <span>{fmtClock(duration)}</span>
          </div>
          <div className="flex items-center justify-center gap-6">
            <button type="button" onClick={() => skip(-15_000)} aria-label="Back 15 seconds"
              className="w-16 h-16 rounded-full bg-glass-2 border border-hairline flex items-center justify-center text-white active:bg-white/25">
              <RotateCcw size={26} />
            </button>
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
              className="w-20 h-20 rounded-full bg-white text-black flex items-center justify-center active:scale-95">
              {playing ? <Pause size={34} fill="currentColor" /> : <Play size={34} fill="currentColor" className="ml-1" />}
            </button>
            <button type="button" onClick={() => skip(30_000)} aria-label="Forward 30 seconds"
              className="w-16 h-16 rounded-full bg-glass-2 border border-hairline flex items-center justify-center text-white active:bg-white/25">
              <RotateCw size={26} />
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
