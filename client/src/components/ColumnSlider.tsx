// The "how many across" slider above a grid, 1 to 12. Shared by the Draw
// gallery and the Plex corner so the two grids are set the same way; the
// accent differs because each corner has its own colour.
//
// A slider rather than a row of chips: twelve chips don't fit beside a
// heading on a 7" screen, and for a whole number between 1 and 12 a thumb
// lands where it is put. (The Advanced panel's rule against sliders is about
// 0.05 on a cfg dial, which is a different problem.)

import { MAX_COLUMNS, MIN_COLUMNS } from '../hooks/useGalleryColumns'

export function ColumnSlider({ value, onChange, accent = 'pink' }: {
  value: number
  onChange: (n: number) => void
  accent?: 'pink' | 'amber'
}) {
  return (
    <label className="flex items-center gap-2 min-w-0">
      <input
        type="range"
        min={MIN_COLUMNS}
        max={MAX_COLUMNS}
        step={1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        aria-label="Per row"
        className={`w-28 h-2 cursor-pointer ${accent === 'amber' ? 'accent-[#e5a00d]' : 'accent-pink-400'}`}
      />
      <span className="text-[12px] text-white/50 tabular-nums w-12 shrink-0">{value} / row</span>
    </label>
  )
}
