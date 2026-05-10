import { colorFg, colorBg } from './notion-colors'
import type { NotionColor } from './notion-types'

// Color picker for blocks. Notion's color set is finite — we expose all of
// them as 1-tap chips. The text/background distinction is handled by the
// `_background` suffix in the color name.

const FOREGROUND_COLORS: NotionColor[] = [
  'default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red',
]

const BACKGROUND_COLORS: NotionColor[] = [
  'gray_background', 'brown_background', 'orange_background', 'yellow_background',
  'green_background', 'blue_background', 'purple_background', 'pink_background', 'red_background',
]

export default function BlockColorMenu({
  current, onPick, onClose,
}: {
  current?: string
  onPick:   (color: string) => void
  onClose:  () => void
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-6">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white mb-3">Block color</h3>

          <div className="mb-4">
            <p className="text-[10px] text-white/35 uppercase tracking-wider mb-2">Text color</p>
            <div className="flex flex-wrap gap-2">
              {FOREGROUND_COLORS.map(c => (
                <button key={c} type="button" onClick={() => { onPick(c); onClose() }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border min-w-[64px]
                    ${current === c ? 'border-white/40' : 'border-transparent'}`}
                  style={{ background: 'rgba(255,255,255,0.04)', color: colorFg(c) }}>
                  Aa
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[10px] text-white/35 uppercase tracking-wider mb-2">Background</p>
            <div className="flex flex-wrap gap-2">
              {BACKGROUND_COLORS.map(c => (
                <button key={c} type="button" onClick={() => { onPick(c); onClose() }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border min-w-[64px]
                    ${current === c ? 'border-white/40' : 'border-transparent'}`}
                  style={{ background: colorBg(c, 0.25), color: 'rgba(255,255,255,0.85)' }}>
                  Aa
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
