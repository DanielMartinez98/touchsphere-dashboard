import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { X, Globe, Play, FileText, Layout, Loader2, AlertTriangle } from 'lucide-react'
import { useBrowse, closeBrowse, type BrowseTarget } from '../hooks/useBrowse'

/**
 * The dashboard's browser window. Opened by the assistant (open_website /
 * play_video), never by a corner widget, so it lives here rather than inside
 * Widget's four-corner system — but it wears the same full-screen glass shell,
 * grab handle and close button so it doesn't read as a different app.
 *
 * Three bodies, picked by what the server resolved:
 *   • video              — the YouTube embed player
 *   • web + embeddable   — the live site in an iframe
 *   • web + !embeddable  — reader mode (server-extracted text)
 *
 * Reader mode is not just a fallback: most sites send X-Frame-Options and would
 * render as a blank rectangle, and even the ones that don't are usually unusable
 * at 720×1280. The header keeps a manual toggle either way, because an iframe
 * that passes the server's header check can still come back blank, and the user
 * needs an out that doesn't involve closing the window.
 *
 * Every window is keyed by its sequence number, so opening a new target
 * remounts the whole shell — that's what resets the reader toggle, the player
 * and the reader fetch without a single reset effect.
 *
 * Getting OUT deserves more than one button, because the body of this window is
 * an iframe: it swallows every pointer event inside its bounds, so none of the
 * usual dismiss gestures reach us there. The routes out are the close button,
 * a swipe down from anywhere on the header, a tap on the dimmed backdrop
 * outside the window, and — for video, which leaves wide black gutters — a tap
 * in the gutter or the Close video pill. Escape is a desktop convenience only;
 * the kiosk has no keyboard.
 */

const READER_MIN_CHARS = 200

interface ReaderDoc { url: string; title: string; site: string; text: string; image?: string }

function ReaderView({ url }: { url: string }) {
  const [doc, setDoc] = useState<ReaderDoc | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/browse/page?url=${encodeURIComponent(url)}`)
      .then(async res => {
        if (!res.ok) throw new Error(`page ${res.status}`)
        return res.json() as Promise<ReaderDoc>
      })
      .then(d => { if (!cancelled) setDoc(d) })
      .catch(err => {
        console.warn('[browse] reader fetch failed:', err)
        if (!cancelled) setError("Couldn't load that page.")
      })
    return () => { cancelled = true }
  }, [url])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
        <AlertTriangle size={32} className="text-amber-300/80" />
        <p className="text-ink-mid text-base">{error}</p>
        <p className="text-ink-dim text-sm break-all">{url}</p>
      </div>
    )
  }
  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 size={30} className="text-ink-dim animate-spin" />
        <p className="text-ink-dim text-sm">Loading page…</p>
      </div>
    )
  }

  const paragraphs = doc.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  // Most articles open with their own headline, which we're already showing as
  // the h1 — printing it twice reads like a rendering bug.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  while (paragraphs.length > 0 && norm(paragraphs[0]!) === norm(doc.title)) paragraphs.shift()

  return (
    <div className="h-full overflow-y-auto scroll-fade-y px-6 py-5">
      <article className="mx-auto max-w-[62ch]">
        {doc.image && (
          <img
            src={doc.image}
            alt=""
            className="w-full max-h-56 object-cover rounded-2xl mb-5 border border-hairline"
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        )}
        <h1 className="font-display text-ink text-2xl font-semibold leading-snug mb-4">{doc.title}</h1>
        {doc.text.length < READER_MIN_CHARS && (
          <p className="text-amber-200/70 text-sm mb-4">
            This page didn’t give up much readable text — it may need a real browser.
          </p>
        )}
        {paragraphs.map((p, i) => (
          <p key={i} className="text-ink-mid text-[17px] leading-[1.7] mb-4 whitespace-pre-wrap">
            {p}
          </p>
        ))}
        <p className="text-ink-dim text-xs mt-8 break-all">{doc.url}</p>
      </article>
    </div>
  )
}

const YT_ORIGIN = 'https://www.youtube-nocookie.com'

function VideoView({ target, hold }: { target: Extract<BrowseTarget, { kind: 'video' }>; hold: boolean }) {
  // `hold` = the assistant is mid-conversation (listening, thinking or
  // speaking). A video and a voice assistant cannot share one room: playback
  // would talk over her replies, and the mic would hear the video.
  //
  // So the video never starts while she's holding the floor — the poster waits —
  // and once it is playing, the iframe API pauses and resumes it around every
  // later turn. A tap on the poster starts it immediately, and doubles as the
  // user gesture Chromium's autoplay policy wants.
  //
  // "The floor is free" is latched rather than derived, because it has to STICK:
  // a follow-up turn puts hold back to true, and swapping a playing video back
  // to a poster would throw away the user's place in it. Adjusted during render
  // (the guard makes it idempotent) so the player mounts in the same commit the
  // hold lifts, with no extra frame of poster.
  const [playing, setPlaying] = useState(!hold)
  if (!hold && !playing) setPlaying(true)

  const frameRef = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (!playing) return
    const win = frameRef.current?.contentWindow
    if (!win) return
    win.postMessage(
      JSON.stringify({ event: 'command', func: hold ? 'pauseVideo' : 'playVideo', args: [] }),
      YT_ORIGIN,
    )
  }, [hold, playing])

  if (playing) {
    return (
      // The player is a 16:9 band in a tall window, so most of this body is
      // black gutter — and the gutter is ours, not the iframe's. Tapping it
      // closes, same as tapping the backdrop outside the window, and a visible
      // Close pill sits in the lower gutter so that exit isn't a secret. The
      // iframe eats every pointer event inside its own bounds, so without these
      // the only way out of a video is one 56px button in the header.
      <div
        className="relative h-full flex items-center justify-center bg-black"
        onClick={e => { if (e.target === e.currentTarget) closeBrowse() }}
      >
        <div className="w-full aspect-video">
          <iframe
            ref={frameRef}
            title={target.title}
            src={`${YT_ORIGIN}/embed/${target.videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
            className="w-full h-full border-0"
            // Set per-iframe as well as via the server's Referrer-Policy header.
            // The embed player refuses to start without a Referer identifying
            // the host ("error 153"), and a page-level `no-referrer` from any
            // source — Helmet, a meta tag, a privacy extension — strips it.
            // Stating it here means the player keeps working even if the page
            // policy is tightened again later.
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>

        <button
          type="button"
          onClick={closeBrowse}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 px-6 h-12 rounded-full
                     bg-glass-2 border border-hairline text-ink text-[15px] font-medium
                     flex items-center gap-2 active:scale-95 active:bg-white/25 transition-colors"
        >
          <X size={18} strokeWidth={2.25} />
          Close video
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${target.title}`}
      className="h-full w-full flex items-center justify-center bg-black active:scale-[0.99] transition-transform"
    >
      <div className="relative w-full aspect-video">
        <img
          src={`https://i.ytimg.com/vi/${target.videoId}/hqdefault.jpg`}
          alt=""
          className="w-full h-full object-cover opacity-70"
          onError={e => { e.currentTarget.style.opacity = '0' }}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-20 h-20 rounded-full bg-red-500/85 flex items-center justify-center shadow-2xl">
            <Play size={34} fill="white" className="text-white translate-x-0.5" />
          </span>
        </span>
      </div>
    </button>
  )
}

function BrowserWindow({ target, hold }: { target: BrowseTarget; hold: boolean }) {
  const dragControls = useDragControls()
  const [forceReader, setForceReader] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeBrowse() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const isWeb = target.kind === 'web'
  const showReader = target.kind === 'web' && (forceReader || !target.embeddable)

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={target.title}
      // Inset rather than full-bleed: the dashboard stays visible around the
      // edges, so the window reads as something the assistant put ON the
      // dashboard rather than an app that replaced it — and the corner widgets
      // stay glanceable while a video plays. max-w keeps it from becoming an
      // unusable slab on a desktop browser; on the 720×1280 kiosk the margins
      // are what's doing the work.
      // z: above the guide overlay (9100), because a chapter's walkthrough video
      // is opened from inside the guide and has to land on top of it.
      // See the stack comment in GuideOverlay.tsx.
      className="fixed left-4 right-4 top-10 bottom-10 mx-auto max-w-[880px] z-[9200]
                 bg-black/95 backdrop-blur-xl flex flex-col
                 rounded-[28px] overflow-hidden border border-hairline shadow-2xl shadow-black/60"
      initial={{ opacity: 0, y: 40, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 40, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.55 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 140 || info.velocity.y > 900) closeBrowse()
      }}
    >
      {/* Grab pill — pure decoration now; the whole header below is the handle,
          so it's drawn without pointer-events and the drag starts underneath it. */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-44 h-9 z-[9500] flex items-start justify-center pt-2.5 pointer-events-none"
        aria-hidden
      >
        <div className="w-12 h-1.5 rounded-full bg-white/20" />
      </div>

      {/* Header — what's on screen, where it came from, how to get out.
          The whole bar starts the swipe-down-to-dismiss drag: a 176×36 hidden
          strip was too small a target to find with a finger, and the body below
          is an iframe that swallows the gesture entirely. */}
      <div
        onPointerDown={e => dragControls.start(e)}
        className="flex items-start gap-3 pl-5 pr-3 pt-9 pb-3 border-b border-hairline flex-shrink-0 touch-none"
      >
        <span
          className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${
            target.kind === 'video'
              ? 'bg-red-500/20 text-red-300'
              : 'bg-cyan-500/15 text-cyan-300'
          }`}
        >
          {target.kind === 'video' ? <Play size={18} fill="currentColor" /> : <Globe size={18} />}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-display text-ink text-base font-semibold leading-snug line-clamp-2">
            {target.title}
          </p>
          <p className="text-ink-dim text-xs mt-1 truncate">
            {target.kind === 'video'
              ? (target.channel ? `${target.channel} · YouTube` : 'YouTube')
              : `${target.site}${showReader ? ' · reader' : ''}`}
          </p>
        </div>

        {/* The header is a drag handle, so its buttons swallow pointerdown —
            otherwise a tap on Close would also start a dismiss drag. */}
        {isWeb && (
          <button
            type="button"
            onClick={() => setForceReader(v => !v)}
            onPointerDown={e => e.stopPropagation()}
            aria-label={showReader ? 'Show the live site' : 'Show reader view'}
            className="w-14 h-14 rounded-full bg-glass border border-hairline flex items-center justify-center text-ink-mid active:scale-90 active:bg-white/20 transition-colors flex-shrink-0"
          >
            {showReader ? <Layout size={22} /> : <FileText size={22} />}
          </button>
        )}

        <button
          type="button"
          onClick={closeBrowse}
          onPointerDown={e => e.stopPropagation()}
          aria-label="Close"
          className="w-14 h-14 rounded-full bg-white/15 border border-white/25 flex items-center justify-center text-ink active:scale-90 active:bg-white/30 transition-colors flex-shrink-0"
        >
          <X size={26} strokeWidth={2.25} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {target.kind === 'video' ? (
          <VideoView target={target} hold={hold} />
        ) : showReader ? (
          <ReaderView url={target.url} />
        ) : (
          <iframe
            title={target.title}
            src={target.url}
            className="w-full h-full border-0 bg-white"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        )}
      </div>
    </motion.div>
  )
}

export function BrowserOverlay({ hold = false }: { hold?: boolean }) {
  const target = useBrowse()

  return createPortal(
    <AnimatePresence>
      {target && [
        // Backdrop. The window is inset, so the dashboard shows around its
        // edges — and that visible margin is the first place a finger goes to
        // dismiss. Without something to catch them, those taps fell through and
        // opened the widget behind the video instead of closing it.
        <motion.div
          key="backdrop"
          className="fixed inset-0 z-[9190] bg-black/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={closeBrowse}
          aria-hidden
        />,
        <BrowserWindow key={target.seq} target={target} hold={hold} />,
      ]}
    </AnimatePresence>,
    document.body,
  )
}
