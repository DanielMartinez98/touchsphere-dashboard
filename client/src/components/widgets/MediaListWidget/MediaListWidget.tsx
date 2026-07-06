import type { MediaItem } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'

interface Props {
  nextItem: MediaItem | null
}

export function MediaCollapsed({ nextItem }: Props) {
  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Up Next</span>
      {nextItem ? (
        <>
          <MediaTypeIcon type={nextItem.type} className="text-lg text-white/80" />
          <span className="text-[15px] font-semibold text-white leading-tight truncate w-full">
            {nextItem.title}
          </span>
        </>
      ) : (
        <span className="text-sm text-ink-dim">Nothing in queue</span>
      )}
    </>
  )
}
