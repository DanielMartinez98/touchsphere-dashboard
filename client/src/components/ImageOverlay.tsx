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

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, RefreshCw } from 'lucide-react'
import { closeImage, openImage, useImageJob, useImageTarget } from '../hooks/useImageOverlay'

export function ImageOverlay() {
  const target = useImageTarget()
  // A re-shown picture arrives with its url already on the payload and needs no
  // job tracking at all — the job it came from may not even exist any more.
  const done = !!target?.url
  const job = useImageJob(target?.jobId ?? null, done)

  const url = target?.url ?? job?.url
  const failed = job?.status === 'failed'

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

      <div className="fixed left-4 right-4 top-10 bottom-10 mx-auto max-w-[880px] z-[9400]
                      bg-black/95 backdrop-blur-xl rounded-3xl border border-hairline
                      flex flex-col overflow-hidden shadow-2xl">

        {/* ── Header: what was asked for, and the way out ── */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-1">
              {failed ? 'Could not draw this' : url ? 'Generated image' : 'Drawing'}
            </p>
            {/* The prompt is the caption. It's the only thing that identifies one
                picture from another later, and the model expands what the user
                said — so it's worth reading, not hiding behind a title. */}
            <p className="text-sm text-white/85 leading-snug line-clamp-3">{target.prompt}</p>
          </div>
          <CloseImageButton onClick={closeImage} />
        </div>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4">
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
            <Failed message={job?.error ?? 'the render failed'} onRetry={retry} />
          ) : (
            <Drawing phase={job?.phase ?? 'starting'} etaMs={job?.etaMs ?? 0} />
          )}
        </div>
      </div>
    </>,
    document.body,
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
 */
function Drawing({ phase, etaMs }: { phase: string; etaMs: number }) {
  const [elapsed, setElapsed] = useState(0)

  // SSE frames only arrive on phase changes, which can be twenty seconds apart.
  // The seconds have to tick locally or the screen looks frozen.
  useEffect(() => {
    const started = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - started), 250)
    return () => clearInterval(t)
  }, [])

  const pct = etaMs > 0 ? Math.min(95, (elapsed / etaMs) * 100) : null

  return (
    <div className="w-full max-w-[420px] flex flex-col items-center gap-4">
      <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
        {pct === null
          ? <div className="h-full w-1/3 rounded-full bg-white/40 animate-pulse" />
          : <div className="h-full rounded-full bg-white/60 transition-[width] duration-300"
                 style={{ width: `${pct}%` }} />}
      </div>
      <div className="text-center">
        <p className="text-sm text-white/70 capitalize">{phase}</p>
        <p className="text-xs text-white/35 mt-1 tabular-nums">
          {(elapsed / 1000).toFixed(0)}s
          {etaMs > 0
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
