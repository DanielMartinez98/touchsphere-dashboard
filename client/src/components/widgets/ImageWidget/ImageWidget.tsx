// Bottom-left collapsed pill for image generation.
//
// The pill shows the last picture rather than an icon, because that is the
// thing that makes someone tap it — a thumbnail of the cat you drew ten minutes
// ago is a far better affordance than a generic image glyph, and it doubles as
// proof the GPU box is alive.

import { useEffect, useState } from 'react'
import { ImageIcon, Sparkles } from 'lucide-react'
import type { StoredImage } from '../../../hooks/useImages'

export function ImageCollapsed({
  images, enabled, busy, queued, etaMs, elapsedMs,
}: {
  images:  StoredImage[]
  /** null while we haven't asked the server yet — don't claim it's off. */
  enabled: boolean | null
  /** A render is in flight, started from here or from the assistant. */
  busy:    boolean
  /** How many are waiting BEHIND the one being drawn. 0 = just the one. */
  queued:  number
  /** How long the picture on the GPU should take. 0 = no usable history. */
  etaMs:   number
  /** The server's own elapsed figure for it, which the countdown anchors to. */
  elapsedMs: number
}) {
  const last = images[0]
  const left = useCountdown(busy && etaMs > 0 ? etaMs : 0, elapsedMs)

  return (
    <>
      <div className="flex items-center gap-2 w-full">
        <ImageIcon size={22} className="text-pink-300/80 shrink-0" />
        <span className="text-sm font-semibold text-white">Draw</span>
        {images.length > 0 && (
          <span className="ml-auto text-[13px] text-ink-dim tabular-nums">{images.length}</span>
        )}
      </div>

      {enabled === false ? (
        // The GPU box being off is the expected state half the time — say so
        // plainly here rather than letting the tap open a panel that can't work.
        <span className="text-[13px] text-ink-dim">Image server offline</span>
      ) : busy ? (
        <span className="flex items-center gap-1.5 text-pink-300 text-[13px]">
          <Sparkles size={14} className="animate-pulse" />
          {/* The time left, when there is a real estimate behind it. This corner
              is read at walking speed from across a room, and "about a minute"
              is the difference between waiting for it and coming back later —
              which is the only decision this pill exists to support. Falls back
              to the bare word when the history can't answer, rather than
              inventing a number. */}
          {left !== '' ? `Drawing · ${left} left` : 'Drawing…'}
          {/* The count is the other half: "still going" and "still going, four
              to come" are different answers to the same question. */}
          {queued > 0 && (
            <span className="text-white/45 tabular-nums">+{queued} queued</span>
          )}
        </span>
      ) : last ? (
        <div className="flex items-center gap-2 w-full">
          <img
            src={last.url}
            alt=""
            className="w-11 h-11 rounded-lg object-cover border border-hairline shrink-0"
          />
          <span className="text-[13px] text-ink-dim leading-tight line-clamp-2 text-left">
            {last.prompt}
          </span>
        </div>
      ) : (
        <span className="text-[13px] text-ink-dim">Tap to make a picture</span>
      )}
    </>
  )
}

/**
 * Time remaining, ticking locally between SSE frames.
 *
 * Anchored to the SERVER's elapsed figure plus the local instant it arrived —
 * the same reasoning as the overlay's Drawing clock, and for the same bug:
 * measuring from when this component mounted would restart the count every time
 * the corner re-rendered, and a render two minutes in would read as five
 * seconds. Returns '' when there is nothing honest to say.
 */
function useCountdown(etaMs: number, elapsedMs: number): string {
  const [now, setNow] = useState(() => Date.now())
  const [frame, setFrame] = useState(() => ({ elapsedMs, at: Date.now() }))
  // Derive-state-from-props in the render body, matching ImageOverlay's Drawing:
  // an effect would paint one frame of the previous render's clock first.
  if (frame.elapsedMs !== elapsedMs) setFrame({ elapsedMs, at: now })

  useEffect(() => {
    if (etaMs <= 0) return
    // Once a second, not four times: this is a word on a pill, not a bar.
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [etaMs])

  if (etaMs <= 0) return ''
  const elapsed = Math.max(0, frame.elapsedMs + (now - frame.at))
  const remaining = etaMs - elapsed
  // Past the estimate: say so rather than counting into the negative or parking
  // on "0s left", both of which read as the corner having frozen.
  if (remaining <= 0) return 'nearly there'
  const secs = Math.round(remaining / 1000)
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return secs % 60 === 0 ? `${m}m` : `${m}m ${secs % 60}s`
}
