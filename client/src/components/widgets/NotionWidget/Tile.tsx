import { useRef } from 'react'
import { Database, FileText, Folder, ChevronRight } from 'lucide-react'

// Shared row tile used by Browse / Groups / Search / Trash. A long-press
// (~500 ms) fires `onLongPress` so the caller can open Add-to-Group without
// stealing the regular tap.

interface Props {
  title:         string
  icon:          { type: 'emoji' | 'url'; value: string } | null
  kind:          'page' | 'database'
  onTap:         () => void
  onLongPress?:  () => void
  // Right-side affordance — when in a group, show how many groups contain this item.
  inGroupCount?: number
  // Optional secondary line (e.g. "page" or parent name).
  subtitle?:     string
}

export default function Tile({
  title, icon, kind, onTap, onLongPress, inGroupCount, subtitle,
}: Props) {
  // Track press start to distinguish a tap from a long-press. The timer fires
  // onLongPress; if the user lifts before that, we run the tap.
  const timer    = useRef<number | null>(null)
  const fired    = useRef(false)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  function pressStart(x: number, y: number) {
    fired.current = false
    startPos.current = { x, y }
    if (!onLongPress) return
    timer.current = window.setTimeout(() => {
      fired.current = true
      onLongPress()
    }, 500)
  }
  function pressMove(x: number, y: number) {
    // Cancel long-press if the user drags more than 10 px — that's a scroll.
    if (!startPos.current || timer.current === null) return
    const dx = x - startPos.current.x
    const dy = y - startPos.current.y
    if (dx * dx + dy * dy > 100) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  function pressEnd() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    // Tap fires only if long-press didn't.
    if (!fired.current) onTap()
  }
  function pressCancel() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    fired.current = false
  }

  return (
    <button type="button"
      onTouchStart={e => pressStart(e.touches[0]!.clientX, e.touches[0]!.clientY)}
      onTouchMove={e => pressMove(e.touches[0]!.clientX, e.touches[0]!.clientY)}
      onTouchEnd={pressEnd}
      onTouchCancel={pressCancel}
      onMouseDown={e => pressStart(e.clientX, e.clientY)}
      onMouseMove={e => pressMove(e.clientX, e.clientY)}
      onMouseUp={pressEnd}
      onMouseLeave={pressCancel}
      className="w-full text-left flex items-center gap-3 bg-white/[0.04] rounded-xl px-3 py-3.5 active:bg-white/[0.09] active:scale-[0.99] transition-all">
      <span className="text-lg flex-shrink-0 text-white/60">
        {icon?.type === 'emoji' ? icon.value
          : icon?.type === 'url' ? <img src={icon.value} alt="" className="w-5 h-5 rounded inline" />
          : kind === 'database' ? <Database size={19} /> : <FileText size={19} />}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[15px] text-white truncate">{title}</p>
        <p className="text-xs text-white/40 uppercase tracking-wider">{subtitle ?? kind}</p>
      </div>
      {inGroupCount !== undefined && inGroupCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-yellow-300/80 bg-yellow-500/10 rounded-full px-2 py-1 mr-1 tabular-nums" title={`In ${inGroupCount} group${inGroupCount === 1 ? '' : 's'}`}>
          <Folder size={12} /> {inGroupCount}
        </span>
      )}
      <ChevronRight size={16} className="text-white/25 flex-shrink-0" />
    </button>
  )
}
