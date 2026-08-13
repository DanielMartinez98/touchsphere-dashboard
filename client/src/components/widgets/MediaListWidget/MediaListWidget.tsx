import type { GuideSummary, MediaItem } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'
import { MediaCover } from './MediaCover'

interface Props {
  nextItem: MediaItem | null
  /** Guide progress for the up-next item, when it has one. */
  guide?: GuideSummary | undefined
}

export function MediaCollapsed({ nextItem, guide }: Props) {
  const showProgress = guide?.status === 'ready' && guide.counted.total > 0
  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Up Next</span>
      {nextItem ? (
        // The poster is the fastest way to recognise the queued item from arm's
        // length — same cached artwork the expanded list uses, so no extra fetch.
        <div className="flex items-center gap-2.5 w-full text-left">
          <MediaCover item={nextItem} className="w-[42px] h-[63px] rounded-lg" />
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <MediaTypeIcon type={nextItem.type} className="text-lg text-white/80" />
            <span className="block text-[15px] font-semibold text-white leading-tight truncate w-full">
              {nextItem.title}
            </span>
            {/* Guide progress on the pill: for a game you're partway through,
                "how far am I" is the one number worth surfacing uncollapsed. */}
            {showProgress && (
              <span className="flex items-center gap-1.5 w-full">
                <span className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                  <span className="block h-full bg-[var(--accent,#06b6d4)]/70 rounded-full"
                        style={{ width: `${guide.percent}%` }} />
                </span>
                <span className="text-[11px] text-white/40 tabular-nums shrink-0">{guide.percent}%</span>
              </span>
            )}
          </div>
        </div>
      ) : (
        <span className="text-sm text-ink-dim">Nothing in queue</span>
      )}
    </>
  )
}
