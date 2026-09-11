import { colorFg, colorBg } from './notion-colors'

// A labelled row of option chips (status, priority) coloured by Notion's
// own option colours. Shared by the task sheet and the create sheet.
export default function ChipRow({
  label, options, value, onChange, allowNone = false,
}: {
  label:     string
  options:   { id: string; name: string; color: string }[]
  value:     string | null
  onChange:  (v: string | null) => void
  allowNone?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-white/35 uppercase tracking-wider font-medium">{label}</span>
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-hide">
        {allowNone && (
          <button type="button" onClick={() => onChange(null)}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95
              ${value === null
                ? 'bg-white/20 text-white border-white/30'
                : 'bg-white/[0.05] text-white/35 border-transparent active:bg-white/10'}`}>
            None
          </button>
        )}
        {options.map(opt => (
          <button type="button" key={opt.id} onClick={() => onChange(opt.name)}
            className="flex-shrink-0 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95"
            style={{
              background:   value === opt.name ? colorBg(opt.color, 0.2) : 'rgba(255,255,255,0.04)',
              color:        value === opt.name ? colorFg(opt.color)       : 'rgba(255,255,255,0.35)',
              borderColor:  value === opt.name ? colorBg(opt.color, 0.5)  : 'transparent',
            }}>
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  )
}
