// Bottom-left collapsed pill for image generation.
//
// The pill shows the last picture rather than an icon, because that is the
// thing that makes someone tap it — a thumbnail of the cat you drew ten minutes
// ago is a far better affordance than a generic image glyph, and it doubles as
// proof the GPU box is alive.

import { ImageIcon, Sparkles } from 'lucide-react'
import type { StoredImage } from '../../../hooks/useImages'

export function ImageCollapsed({
  images, enabled, busy, queued,
}: {
  images:  StoredImage[]
  /** null while we haven't asked the server yet — don't claim it's off. */
  enabled: boolean | null
  /** A render is in flight, started from here or from the assistant. */
  busy:    boolean
  /** How many are waiting BEHIND the one being drawn. 0 = just the one. */
  queued:  number
}) {
  const last = images[0]

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
          Drawing…
          {/* The count is the whole reason the corner is worth reading while
              busy: "still going" and "still going, four to come" are different
              answers to the only question someone walking past has. */}
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
