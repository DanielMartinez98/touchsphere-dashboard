// The full-screen generated picture.
//
// Opened two ways, which is why it's a top-level overlay driven by a store
// rather than a piece of some widget's state: the assistant being asked out loud
// ("draw me a cat in a spacesuit"), and a tap on an earlier picture.
//
// THE STACK, top to bottom — the four portals that can be on screen together:
//
//   9400/9390  this picture / its backdrop
//   9200/9190  BrowserOverlay window / its backdrop
//   9100       GuideOverlay
//   9000       Widget's expanded overlay
//
// A picture goes on TOP of the browser window on purpose: it is the thing that
// was just asked for, and it can be asked for while a video is playing. The
// guide's 8900 → 9100 fix is the cautionary tale for guessing a band wrong —
// it rendered under the very list it was opened from and read as "nothing
// happened".
//
// The frame goes up BEFORE the picture exists. A render is ten to thirty
// seconds and the overlay opens at the moment the spoken reply is revealed, so
// the empty frame with its phase text IS the feedback that something is
// happening — the alternative is half a minute of silence after "drawing that
// for you now".
//
// Once the picture DOES exist, this is also where the two things anyone actually
// does with one live: step to the picture either side of it, and take its prompt
// back to the compose field. Both belong here rather than in the gallery grid,
// because looking at a render full size is the moment you decide it's nearly
// right and want another go at it.

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight, Copy, Check, Wand2,
} from 'lucide-react'
import { closeImage, openImage, useImageJob, useImageTarget } from '../hooks/useImageOverlay'
import { reuseImagePrompt } from '../hooks/useImagePrompt'
import { onServerEvent } from '../hooks/useServerEvents'

/** Just enough of a StoredImage to step between them. */
interface GalleryEntry {
  id:     string
  prompt: string
  url:    string
}

/**
 * The gallery, for the sole purpose of knowing what sits either side of this
 * picture.
 *
 * Fetched here rather than handed in when the overlay opens, because it is
 * opened from three places — a thumbnail, a queue row, and a spoken
 * `generate_image` — and only one of those has the list to hand. One GET when
 * the frame goes up, and another whenever a render finishes, since the picture
 * being watched joins the list at the moment it lands.
 */
function useGallery(open: boolean): GalleryEntry[] {
  const [gallery, setGallery] = useState<GalleryEntry[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!open) return
    return onServerEvent('image', data => {
      const d = data as Record<string, unknown> | null
      if (d && d['status'] === 'ready') setTick(t => t + 1)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/image')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { images?: GalleryEntry[] }) => { if (!cancelled) setGallery(j.images ?? []) })
      // No neighbours is a perfectly good outcome: the arrows simply don't
      // appear, and the picture itself is unaffected.
      .catch(() => { if (!cancelled) setGallery([]) })
    return () => { cancelled = true }
  }, [open, tick])

  return gallery
}

export function ImageOverlay() {
  const target = useImageTarget()
  // A re-shown picture arrives with its url already on the payload and needs no
  // job tracking at all — the job it came from may not even exist any more.
  const done = !!target?.url
  const job = useImageJob(target?.jobId ?? null, done)

  const url = target?.url ?? job?.url
  // Taken out of the queue before it started. Not an error — nothing went wrong
  // — but the frame must stop pretending a picture is coming, and "try again"
  // is exactly the right offer, since re-queueing is what undoes it.
  const cancelled = job?.status === 'cancelled'
  const failed = job?.status === 'failed' || cancelled
  // Queued behind other renders. Worth its own state: the phase text and the
  // progress bar are both about a render that has not begun.
  const waiting = job?.status === 'queued'

  const gallery = useGallery(!!target)
  // A stored picture keeps the id of the job that drew it (remember() in
  // server/src/image.ts), so one id addresses both halves — which is what lets a
  // render finishing under the frame slot straight into the list without the
  // overlay having to re-point itself at a different id.
  const index = target ? gallery.findIndex(g => g.id === target.jobId) : -1
  const prev = index > 0 ? gallery[index - 1] : undefined
  const next = index >= 0 && index < gallery.length - 1 ? gallery[index + 1] : undefined

  const show = useCallback((entry: GalleryEntry) => {
    openImage(entry.id, entry.prompt, entry.url)
  }, [])

  // Arrow keys, for the same reason a dialog closes on Escape: free on a desktop
  // browser, invisible on the kiosk.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft'  && prev) show(prev)
      if (e.key === 'ArrowRight' && next) show(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, prev, next, show])

  const retry = useCallback(() => {
    if (!target) return
    fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: target.prompt }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      // Re-open on the NEW job id: the overlay follows one job, so pointing it
      // at the retry is what makes the frame start filling in again.
      .then((j: { id: string }) => openImage(j.id, target.prompt))
      .catch(err => console.error('[image] retry failed:', err))
  }, [target])

  if (!target) return null

  return createPortal(
    <>
      {/* Tapping outside the frame closes it — the same gesture as the browser
          window's backdrop, so the two overlays behave identically. */}
      <div className="fixed inset-0 z-[9390] bg-black/70" onClick={closeImage} />

      {/* Insets are max()'d against the safe area so the frame clears a notch and
          a home indicator on a phone, and sits exactly where it always did on
          the kiosk, where every env() is 0. */}
      <div
        className="fixed mx-auto max-w-[880px] z-[9400]
                   bg-black/95 backdrop-blur-xl rounded-3xl border border-hairline
                   flex flex-col overflow-hidden shadow-2xl"
        style={{
          left:   'max(1rem, env(safe-area-inset-left))',
          right:  'max(1rem, env(safe-area-inset-right))',
          top:    'max(2.5rem, env(safe-area-inset-top))',
          bottom: 'max(2.5rem, env(safe-area-inset-bottom))',
        }}
      >

        {/* ── Header: what was asked for, and the way out ── */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-1">
              {cancelled ? 'Taken out of the queue'
                : failed  ? 'Could not draw this'
                : url     ? 'Generated image'
                : waiting ? 'In the queue'
                : 'Drawing'}
            </p>
            {/* The prompt is the caption. It's the only thing that identifies one
                picture from another later, and the model expands what the user
                said — so it's worth reading, not hiding behind a title.

                `selectable-text` opts it out of the app-wide "a tap is never a
                text selection" rule. This is the one string in the app worth
                lifting a phrase out of by hand, and on a phone a long press is
                how that is done; the class also has to put -webkit-touch-callout
                back, or the press selects nothing and offers no Copy. The two
                buttons below cover the whole string, which is the common case
                and the only one the kiosk — where a long-press selection is
                genuinely fiddly — can manage. */}
            <p className="selectable-text text-sm text-white/85 leading-snug line-clamp-3">
              {target.prompt}
            </p>
          </div>
          <CloseImageButton onClick={closeImage} />
        </div>

        {/* ── What you do with the prompt ──
            Only once there is a picture. While one is drawing this row would
            offer to reuse a prompt that has produced nothing yet, and the
            position counter would be counting a list this picture isn't in. */}
        {url && target.prompt !== '' && (
          <PromptActions
            prompt={target.prompt}
            position={index >= 0 ? `${index + 1} of ${gallery.length}` : ''}
          />
        )}

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4 relative">
          {url ? (
            <img
              src={url}
              alt={target.prompt}
              // `contain` rather than `cover`: a picture the user asked for should
              // be shown whole. Cropping the subject out of a portrait render to
              // fill a frame is the one thing that makes it look broken.
              className="max-w-full max-h-full object-contain rounded-2xl"
            />
          ) : failed ? (
            <Failed
              message={cancelled
                ? 'You took this one out of the queue before it started.'
                : job?.error ?? 'the render failed'}
              onRetry={retry}
            />
          ) : (
            <Drawing phase={job?.phase ?? 'starting'} etaMs={job?.etaMs ?? 0} waiting={waiting} />
          )}

          {/* Stepping between pictures. Over the image rather than in a row under
              it, because the image is sized to fill whatever is left and a row
              beneath would take that height from every picture just to serve the
              ones being paged through. Absent — not disabled — at either end of
              the list: a dead arrow on a touchscreen is a tap that looks broken. */}
          {prev && <NavButton side="left"  label="Previous picture" onClick={() => show(prev)} />}
          {next && <NavButton side="right" label="Next picture"     onClick={() => show(next)} />}
        </div>
      </div>
    </>,
    document.body,
  )
}

/**
 * Copy the prompt, or take it back to the Draw panel.
 *
 * "Use as prompt" is the one that matters. Looking at a picture full size is
 * exactly when you decide it's nearly right, and re-typing forty words on an
 * on-screen keyboard is the most expensive thing this app can ask of anyone. It
 * fills the compose field and opens the Draw corner on it — filling a field
 * nobody can see would not be reuse — and closes this frame so the field is the
 * thing in front of you.
 *
 * Copy is the phone half: `navigator.clipboard` needs a secure context, which
 * Caddy provides, and the label reports what happened either way rather than
 * failing silently into the console.
 */
function PromptActions({ prompt, position }: { prompt: string; position: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)

  useEffect(() => {
    if (copied === null) return
    const t = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(prompt)
      .then(() => setCopied('yes'))
      .catch(() => setCopied('no'))
  }, [prompt])

  return (
    <div className="flex items-center gap-2 px-4 pb-3 shrink-0">
      <button
        type="button"
        onClick={() => { reuseImagePrompt(prompt); closeImage() }}
        className="h-11 px-4 rounded-full bg-pink-500/20 border border-pink-400/35 text-white
                   text-[13px] font-semibold flex items-center gap-2
                   active:scale-95 active:bg-pink-500/35 transition"
      >
        <Wand2 size={16} />
        Use as prompt
      </button>

      <button
        type="button"
        onClick={copy}
        aria-label="Copy the prompt"
        className="h-11 px-4 rounded-full bg-white/10 border border-hairline text-white/70
                   text-[13px] font-semibold flex items-center gap-2
                   active:scale-95 active:bg-white/20 transition"
      >
        {copied === 'yes' ? <Check size={16} /> : <Copy size={16} />}
        {copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : 'Copy'}
      </button>

      {/* Where this picture sits in the gallery — the thing that makes the two
          arrows over the image legible as "there are more of these". */}
      {position !== '' && (
        <span className="ml-auto text-[11px] text-white/30 tabular-nums shrink-0">{position}</span>
      )}
    </div>
  )
}

/**
 * One of the two stepping arrows.
 *
 * The same 56px round glass as every other control in this app, pinned to the
 * edge of the image area and vertically centred — where a thumb already expects
 * it from every photo viewer on the device. Sits over the frame's padding rather
 * than the picture for anything but a very wide render, and is translucent so it
 * never hides the middle of one that is.
 */
function NavButton({
  side, label, onClick,
}: {
  side:    'left' | 'right'
  label:   string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 -translate-y-1/2 w-14 h-14 rounded-full
                  bg-black/60 backdrop-blur-md border border-hairline
                  flex items-center justify-center text-white/75
                  active:scale-90 active:bg-white/25 transition ${
        side === 'left' ? 'left-1' : 'right-1'
      }`}
    >
      {side === 'left'
        ? <ChevronLeft  size={28} strokeWidth={2.25} />
        : <ChevronRight size={28} strokeWidth={2.25} />}
    </button>
  )
}

/**
 * The same round 56px glass X as every expanded widget and the game guide.
 * That's the one gesture in this app that already means "done with this screen",
 * and a new overlay inventing its own exit is how a kiosk gets confusing.
 */
function CloseImageButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Close the picture"
      className="w-14 h-14 shrink-0 rounded-full bg-glass-2 border border-hairline flex items-center
                 justify-center text-white/80 active:scale-90 active:bg-white/25 transition-colors">
      <X size={26} strokeWidth={2.25} />
    </button>
  )
}

/**
 * The waiting state.
 *
 * The bar is honest or it isn't there. ComfyUI's real per-step progress only
 * comes over its WebSocket, which the server doesn't hold open — so with a
 * previous render to compare against we show elapsed-against-that, capped below
 * full because a bar that sits at 100% while nothing happens is worse than no
 * bar. With no history (the first render after a restart, which is also the
 * slowest, because the checkpoint has to load) we show the seconds and say so.
 *
 * `waiting` — queued behind other renders — takes the bar away entirely. There
 * is nothing to measure against: how long this picture waits depends on the
 * ones in front of it, and an elapsed-vs-eta bar would fill to 95% while the
 * GPU had not yet touched it.
 */
function Drawing({ phase, etaMs, waiting }: { phase: string; etaMs: number; waiting: boolean }) {
  const [elapsed, setElapsed] = useState(0)

  // SSE frames only arrive on phase changes, which can be twenty seconds apart.
  // The seconds have to tick locally or the screen looks frozen.
  //
  // Restarted when the render actually begins, which is what keeps the estimate
  // truthful for a queued picture: the minute it spent in the line is not part
  // of how long it takes to draw.
  useEffect(() => {
    const started = Date.now()
    // No setElapsed(0) here: the next tick is 250ms away and re-zeroing from
    // inside an effect is a cascading render for a quarter-second of staleness.
    const t = setInterval(() => setElapsed(Date.now() - started), 250)
    return () => clearInterval(t)
  }, [waiting])

  const pct = !waiting && etaMs > 0 ? Math.min(95, (elapsed / etaMs) * 100) : null

  return (
    <div className="w-full max-w-[420px] flex flex-col items-center gap-4">
      <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
        {pct === null
          ? <div className="h-full w-1/3 rounded-full bg-white/40 animate-pulse" />
          : <div className="h-full rounded-full bg-white/60 transition-[width] duration-300"
                 style={{ width: `${pct}%` }} />}
      </div>
      <div className="text-center">
        <p className="text-sm text-white/70 capitalize">
          {waiting ? (phase || 'waiting for the GPU') : phase}
        </p>
        <p className="text-xs text-white/35 mt-1 tabular-nums">
          {(elapsed / 1000).toFixed(0)}s
          {waiting
            ? ' · pictures are drawn one at a time'
            : etaMs > 0
              ? ` · usually about ${(etaMs / 1000).toFixed(0)}s`
              : ' · first picture since a restart takes longer'}
        </p>
      </div>
    </div>
  )
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center px-6">
      <AlertTriangle size={40} className="text-amber-400/80" />
      {/* The real reason, not "something went wrong". These failures are almost
          always one of two boring things — the GPU box is off, or the workflow
          references a checkpoint that isn't installed — and both are fixable in
          a minute IF the message says which. */}
      <p className="text-sm text-white/70 leading-relaxed max-w-[380px] break-words">{message}</p>
      <button type="button" onClick={onRetry}
        className="px-6 h-12 rounded-full bg-white/15 border border-white/25 text-white text-sm
                   font-semibold flex items-center gap-2 active:scale-95 active:bg-white/30 transition">
        <RefreshCw size={18} />
        Try again
      </button>
    </div>
  )
}
