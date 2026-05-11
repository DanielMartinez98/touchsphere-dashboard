import { useState } from 'react'
import { TouchInput } from '../../TouchInput'
import { BLOCK_KINDS, filterBlockKinds, type BlockKindDef } from './markdown'

// Bottom-sheet block picker. Single visual treatment whether the user opens it
// via the floating + button or by typing `/`. The TouchInput at the top
// filters; tap a tile to pick.

export default function SlashMenu({
  initialQuery = '', onPick, onClose,
}: {
  initialQuery?: string
  onPick:        (kind: BlockKindDef) => void
  onClose:       () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const list = filterBlockKinds(query)

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-40 max-h-[80vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-1">Insert block</h3>
        <TouchInput value={query} onChange={setQuery} commitOn="change"
          placeholder="Filter…" ariaLabel="Filter blocks"
          className="bg-white/[0.06] text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-white/20 placeholder-white/30 mb-3" />
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {list.length === 0 && (
            <p className="text-xs text-white/40 italic text-center py-6">No match for "{query}".</p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {list.map(k => (
              <button key={k.type} type="button" onClick={() => { onPick(k); onClose() }}
                className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-white/[0.05] active:bg-white/[0.12] active:scale-95 transition-all">
                <span className="text-lg text-white/85">{k.icon}</span>
                <span className="text-[11px] text-white/55">{k.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Re-export so consumers can hit a known shape — keeps the import surface tight.
export { BLOCK_KINDS }
export type { BlockKindDef }
