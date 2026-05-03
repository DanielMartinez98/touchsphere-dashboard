import type { MediaItem } from '../../../types'

const TYPE_ICON = { game: '🎮', show: '📺', movie: '🎬' } as const

interface Props {
  nextItem: MediaItem | null
}

export function MediaCollapsed({ nextItem }: Props) {
  return (
    <>
      <span className="text-xs text-white/40 uppercase tracking-wider">Up Next</span>
      {nextItem ? (
        <>
          <span className="text-lg">{TYPE_ICON[nextItem.type]}</span>
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
