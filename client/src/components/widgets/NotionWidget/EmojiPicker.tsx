import { useState } from 'react'
import { TouchInput } from '../../TouchInput'

// Curated set — covers the 95% of icons people pick for Notion pages without
// shipping a 5MB unicode database. Categorised so the touchscreen has compact
// tabs instead of one giant scrollable wall.

const CATEGORIES: { name: string; emojis: string[] }[] = [
  { name: 'Common',  emojis: ['📄','📝','📋','✅','⭐','💡','🔥','🎯','🚀','📌','📎','🔖','📚','📖','✏️','🖊️','📊','📈','📉','💼'] },
  { name: 'Work',    emojis: ['💻','🖥️','⌨️','🖱️','📱','📞','✉️','📧','📥','📤','🗂️','🗃️','🗄️','📦','🏢','🏠','💰','💸','💳','🏦'] },
  { name: 'Tech',    emojis: ['🤖','⚙️','🔧','🔨','🛠️','💾','💿','📀','🔌','🔋','📡','🛰️','🛜','🌐','🔗','🔓','🔐','🔑','🛡️','⚡'] },
  { name: 'Symbols', emojis: ['❤️','💚','💙','💛','💜','🖤','🤍','✨','🌟','💫','⚡','💥','🔆','🔅','🎉','🎊','🏆','🥇','🥈','🥉'] },
  { name: 'Nature',  emojis: ['🌳','🌲','🌴','🌵','🌷','🌸','🌹','🌺','🌻','🌼','☀️','🌙','⭐','🌈','☁️','🌧️','⛅','🌊','🔥','❄️'] },
  { name: 'Food',    emojis: ['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🥝','🍔','🍕','🌮','🍣','🍜','🍰','🍪','☕','🍵','🍺','🍷','🥂'] },
  { name: 'Activity',emojis: ['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🎮','🎲','🎯','🏆','🥊','🚴','🏃','🏋️','🧘','🎨','🎵','🎤'] },
  { name: 'Animals', emojis: ['🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🦄','🐝','🐞','🦋','🐢'] },
]

export default function EmojiPicker({
  current, onPick, onClear, onClose,
}: {
  current?: string | null
  onPick:   (emoji: string) => void
  onClear:  () => void
  onClose:  () => void
}) {
  const [tab,   setTab]   = useState(CATEGORIES[0]!.name)
  const [query, setQuery] = useState('')

  const active = CATEGORIES.find(c => c.name === tab) ?? CATEGORIES[0]!
  const flatAll = CATEGORIES.flatMap(c => c.emojis)
  // Extremely simple "search" — just shows everything if query is non-empty,
  // matching by codepoint substring isn't useful since emojis are not text.
  // The TouchKeyboard on this kiosk can't actually type emojis, so search is
  // mostly a placeholder hint that the picker is the source of truth.
  const list = query.trim() ? flatAll : active.emojis

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[80vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="px-4 pt-3 pb-6">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white mb-3 px-1">Page icon</h3>

          <div className="flex gap-2 mb-3">
            <TouchInput
              value={query}
              onChange={setQuery}
              commitOn="change"
              placeholder="Search…"
              ariaLabel="Search emoji"
              className="flex-1 bg-white/[0.06] text-white text-sm rounded-lg px-3 py-2 outline-none placeholder-white/25"
            />
            {current && (
              <button type="button" onClick={() => { onClear(); onClose() }}
                className="px-3 py-2 rounded-lg bg-red-500/15 text-red-400/70 text-xs active:bg-red-500/25">
                Remove
              </button>
            )}
          </div>

          <div className="flex gap-1 mb-3 overflow-x-auto scrollbar-hide">
            {CATEGORIES.map(c => (
              <button key={c.name} type="button" onClick={() => setTab(c.name)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors
                  ${tab === c.name ? 'bg-green-500 text-black' : 'bg-white/[0.05] text-white/45 active:bg-white/10'}`}>
                {c.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-8 gap-1">
            {list.map((e, i) => (
              <button key={`${e}-${i}`} type="button"
                onClick={() => { onPick(e); onClose() }}
                className="aspect-square text-2xl rounded-lg bg-white/[0.04] active:bg-white/[0.12] active:scale-90 transition-all flex items-center justify-center">
                {e}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
