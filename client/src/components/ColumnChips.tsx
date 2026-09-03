// The "how many across" chips above a grid: one tap per count, 2 to 6. Shared
// by the Draw gallery and the Plex corner so the two grids are set the same
// way; the accent differs because each corner has its own colour.

import { MAX_COLUMNS, MIN_COLUMNS } from '../hooks/useGalleryColumns'

export function ColumnChips({ value, onChange, accent = 'pink' }: {
  value: number
  onChange: (n: number) => void
  accent?: 'pink' | 'amber'
}) {
  const on = accent === 'amber'
    ? 'bg-[#e5a00d]/20 text-[#e5a00d] border border-[#e5a00d]/40'
    : 'bg-pink-500/25 text-pink-200 border border-pink-400/40'
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Per row">
      {Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, i) => MIN_COLUMNS + i).map(n => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          onClick={() => onChange(n)}
          className={`w-9 h-9 rounded-lg text-[13px] font-semibold tabular-nums active:scale-90 transition ${
            value === n ? on : 'bg-white/5 text-white/45 border border-transparent'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  )
}
