import { useState } from 'react'
import type { MediaItem } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'

// ── Cover art ────────────────────────────────────────────────────────────────
// Real posters come from the server (TMDB for movies/shows, IGDB for games),
// cached to disk on add so they render offline. Anything without one — no
// match, or added while the Pi had no WAN — keeps the old gradient tile derived
// from the title, so the list is never a row of broken images.

function hueFromTitle(title: string): number {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  return h % 360
}

// Posters are 2:3 — a square crop throws away most of the artwork.
export const COVER_SIZE = 'w-[52px] h-[78px] rounded-lg'

export function MediaCover({ item, className = COVER_SIZE }: { item: MediaItem; className?: string }) {
  // A cached file can still 404 if the volume was wiped under a stale media.json.
  const [broken, setBroken] = useState(false)
  const hue = hueFromTitle(item.title)

  if (item.cover && !broken) {
    return (
      <img
        src={`/api/artwork/cover/${item.cover}`}
        alt=""
        onError={() => setBroken(true)}
        className={`${className} shrink-0 object-cover bg-white/5`}
      />
    )
  }

  return (
    <div
      className={`${className} flex items-center justify-center shrink-0 text-white/90`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 40%), hsl(${(hue + 45) % 360} 70% 24%))` }}
    >
      <MediaTypeIcon type={item.type} className="text-xl" />
    </div>
  )
}
