import { useState } from 'react'
import type { MediaItem, MediaType } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'
import { TouchKeyboard } from './TouchKeyboard'

const TYPES: MediaType[] = ['game', 'show', 'movie']

interface Props {
  items: MediaItem[]
  addItem: (title: string, type: MediaType) => void
  removeItem: (id: string) => void
  markDone: (id: string) => void
}

export default function MediaListExpanded({ items, addItem, removeItem, markDone }: Props) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<MediaType>('show')
  const [showKeyboard, setShowKeyboard] = useState(false)

  const handleAdd = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    addItem(trimmed, type)
    setTitle('')
    setShowKeyboard(false)
  }

  return (
    <div className="flex flex-col h-full p-4 pt-16 gap-4">
      <h2 className="text-2xl font-bold text-white/80">Watch / Play List</h2>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="none"
          value={title}
          readOnly
          onClick={() => setShowKeyboard(true)}
          onPointerDown={() => setShowKeyboard(true)}
          placeholder="Add title..."
          className="flex-1 bg-white/10 text-white placeholder-white/30 rounded-xl px-4 py-3 text-sm outline-none cursor-pointer"
        />
        <div className="flex rounded-xl overflow-hidden border border-white/20">
          {TYPES.map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              aria-label={t}
              className={`px-5 py-3 text-xl transition-colors ${
                type === t
                  ? 'bg-[var(--accent,#06b6d4)] text-black'
                  : 'bg-white/15 text-white hover:bg-white/25'
              }`}
            >
              <MediaTypeIcon type={t} />
            </button>
          ))}
        </div>
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-[var(--accent,#06b6d4)] text-black font-bold rounded-xl active:scale-95"
        >
          +
        </button>
      </div>

      {/* List — extra bottom padding when keyboard is open so items aren't hidden */}
      <div className={`flex-1 overflow-auto flex flex-col gap-2 ${showKeyboard ? 'pb-64' : ''}`}>
        {items.length === 0 && (
          <p className="text-white/30 text-sm text-center mt-8">Nothing added yet</p>
        )}
        {items.map(item => (
          <div
            key={item.id}
            className={`flex items-center gap-3 bg-white/5 rounded-xl p-3 ${item.done ? 'opacity-40' : ''}`}
          >
            <MediaTypeIcon type={item.type} className="text-xl text-white/80" />
            <span
              className={`flex-1 text-sm font-medium ${item.done ? 'line-through text-white/40' : 'text-white'}`}
            >
              {item.title}
            </span>
            <button
              onClick={() => markDone(item.id)}
              className="w-7 h-7 rounded-full border border-white/20 flex items-center justify-center text-sm active:scale-90"
            >
              {item.done ? '↩' : '✓'}
            </button>
            <button
              onClick={() => removeItem(item.id)}
              className="w-7 h-7 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-sm active:scale-90"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {showKeyboard && (
        <TouchKeyboard
          value={title}
          onChange={setTitle}
          onDone={handleAdd}
        />
      )}
    </div>
  )
}
