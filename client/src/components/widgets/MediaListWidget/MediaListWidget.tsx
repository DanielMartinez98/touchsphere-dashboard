import type { MediaItem } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'

interface Props {
  nextItem: MediaItem | null
}

export function MediaCollapsed({ nextItem }: Props) {
  return (
    <>
      <span className="text-xs text-white/40 uppercase tracking-wider">Up Next</span>
      {nextItem ? (
        <>
          <MediaTypeIcon type={nextItem.type} className="text-lg text-white/80" />
          <span className="text-sm font-semibold text-white leading-tight truncate w-full">
            {nextItem.title}
          </span>
        </>
      ) : (
        <span className="text-xs text-white/40">Nothing in queue</span>
      )}
    </>
  )
}
