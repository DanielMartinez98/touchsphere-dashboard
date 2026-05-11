import { colorBg, colorFg } from './notion-colors'

// Popover for tapping a status/select chip on a DB row and changing the value
// without opening the page. Tap an option to apply + close; tap × to clear.

export default function InlineChipEditor({
  propType, options, current, onPick, onClose,
}: {
  propType: 'select' | 'status' | 'multi_select'
  options:  { id: string; name: string; color: string }[]
  // string for select/status, string[] for multi_select
  current:  string | string[] | null
  onPick:   (next: string | string[] | null) => void
  onClose:  () => void
}) {
  const isMulti = propType === 'multi_select'
  const selected = new Set(Array.isArray(current) ? current : current ? [current] : [])

  function toggle(name: string) {
    if (isMulti) {
      const next = new Set(selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      onPick(Array.from(next))
    } else {
      onPick(selected.has(name) ? null : name)
      onClose()
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50 max-h-[70vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <div className="flex items-center mb-3">
          <h3 className="text-sm font-bold text-white flex-1">
            {propType === 'multi_select' ? 'Pick options' : 'Pick a value'}
          </h3>
          <button type="button" onClick={() => { onPick(isMulti ? [] : null); if (!isMulti) onClose() }}
            className="text-[11px] text-white/55 active:text-white/85 px-2 py-1 rounded-full bg-white/[0.06]">Clear</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {options.map(o => {
            const isOn = selected.has(o.name)
            return (
              <button key={o.id} type="button" onClick={() => toggle(o.name)}
                className="px-3 py-1.5 rounded-full text-xs font-medium border"
                style={{
                  background:  isOn ? colorBg(o.color, 0.3) : 'rgba(255,255,255,0.05)',
                  color:       isOn ? colorFg(o.color)       : 'rgba(255,255,255,0.45)',
                  borderColor: isOn ? colorBg(o.color, 0.6)  : 'transparent',
                }}>
                {o.name}
              </button>
            )
          })}
          {options.length === 0 && (
            <p className="text-xs text-white/30 italic">No options defined.</p>
          )}
        </div>
        {isMulti && (
          <button type="button" onClick={onClose}
            className="mt-4 w-full h-11 rounded-xl bg-green-500 text-black text-sm font-bold active:bg-green-400">
            Done
          </button>
        )}
      </div>
    </div>
  )
}
