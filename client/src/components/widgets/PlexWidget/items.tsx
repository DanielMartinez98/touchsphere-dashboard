/* eslint-disable react-refresh/only-export-components -- helpers live beside the components that use them */
// The pieces every library view is built from: how an item is titled, how far
// through it the viewer is, and the three ways it is drawn — a poster, a grid
// of posters, a landscape row. Shared by the browse layer, the library pages
// and the item page, so a film looks the same wherever it turns up.

import { Check, Tv } from 'lucide-react'
import { plexImg, type PlexItem } from '../../../hooks/usePlex'
import { setPlexColumns, usePinchColumns, usePlexColumns } from '../../../hooks/useGalleryColumns'
import { ColumnChips } from '../../ColumnChips'

export const ACCENT = '#e5a00d'

export function itemTitle(i: PlexItem): string {
  if (i.type === 'episode') {
    const se = i.parentIndex !== undefined && i.index !== undefined ? `S${i.parentIndex}E${i.index} · ` : ''
    return `${se}${i.title}`
  }
  return i.title
}

export function itemSubtitle(i: PlexItem): string {
  if (i.type === 'episode') return i.grandparentTitle ?? ''
  if (i.type === 'season') return i.parentTitle ?? ''
  const bits: string[] = []
  if (i.year) bits.push(String(i.year))
  if (i.type === 'show' && i.leafCount) bits.push(`${i.leafCount} episodes`)
  if (i.type === 'movie' && i.duration) bits.push(`${Math.round(i.duration / 60000)} min`)
  return bits.join(' · ')
}

export function progressOf(i: PlexItem): number {
  if (i.type === 'show' || i.type === 'season') return i.leafCount ? (i.viewedLeafCount ?? 0) / i.leafCount : 0
  if (i.viewOffset && i.duration) return i.viewOffset / i.duration
  return i.viewCount ? 1 : 0
}

export function Poster({ item, w = 120 }: { item: PlexItem; w?: number }) {
  const src = plexImg(item.thumb ?? item.art, w * 2)
  return src
    ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
    : <div className="w-full h-full bg-gradient-to-br from-white/15 to-white/5 flex items-center justify-center"><Tv size={28} className="text-white/30" /></div>
}

/** One poster with its progress bar and watched tick — the cell of a grid or a strip. */
export function PosterCell({ item, onOpen, className = '' }: { item: PlexItem; onOpen: (key: string) => void; className?: string }) {
  const p = progressOf(item)
  return (
    <button type="button" onClick={() => onOpen(item.key)} className={`text-left active:scale-95 transition-transform ${className}`}>
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden border border-hairline bg-white/5">
        <Poster item={item} />
        {p > 0 && p < 1 && <div className="absolute bottom-0 left-0 h-1 bg-[#e5a00d]" style={{ width: `${p * 100}%` }} />}
        {p >= 1 && <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center"><Check size={14} className="text-white" /></span>}
      </div>
      <p className="mt-1.5 text-[13px] text-white leading-tight line-clamp-2">{itemTitle(item)}</p>
      <p className="text-[12px] text-ink-dim leading-tight line-clamp-1">{itemSubtitle(item)}</p>
    </button>
  )
}

/**
 * Always `columns` across — a per-device setting shared by every poster grid
 * in the corner (see useGalleryColumns), changed with the chips beside a grid's
 * heading or by pinching the grid. It was hard-coded to three, which is right
 * on the 7" kiosk and wrong on everything else.
 */
export function PosterGrid({ items, onOpen }: { items: PlexItem[]; onOpen: (key: string) => void }) {
  const columns = usePlexColumns()
  const pinch = usePinchColumns(columns, setPlexColumns)
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} {...pinch}>
      {items.map(i => <PosterCell key={i.key} item={i} onOpen={onOpen} />)}
    </div>
  )
}

/** The chips for the grid above, in the corner's amber. */
export function PlexColumnChips() {
  const columns = usePlexColumns()
  return <ColumnChips value={columns} onChange={setPlexColumns} accent="amber" />
}

/** A landscape row: for episodes and continue-watching, where the title carries more than the art. */
export function Row({ item, onOpen, trailing }: { item: PlexItem; onOpen: (key: string) => void; trailing?: React.ReactNode }) {
  const p = progressOf(item)
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/5 border border-hairline overflow-hidden">
      <button type="button" onClick={() => onOpen(item.key)} className="flex items-center gap-3 flex-1 min-w-0 text-left p-2 active:bg-white/10">
        <div className="relative w-14 h-[84px] rounded-lg overflow-hidden shrink-0 bg-white/5">
          <Poster item={item} w={56} />
          {p > 0 && p < 1 && <div className="absolute bottom-0 left-0 h-1 bg-[#e5a00d]" style={{ width: `${p * 100}%` }} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink-dim line-clamp-1">{itemSubtitle(item)}</p>
          <p className="text-sm text-white font-semibold leading-snug line-clamp-2">{itemTitle(item)}</p>
          {item.viewOffset && item.duration ? (
            <p className="text-[12px] text-white/50 mt-0.5">{Math.round((item.duration - item.viewOffset) / 60000)} min left</p>
          ) : null}
        </div>
      </button>
      {trailing}
    </div>
  )
}
