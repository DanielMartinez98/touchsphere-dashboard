import { useState } from 'react'
import type { MediaItem, MediaType } from '../../../types'

const TYPE_ICON = { game: '🎮', show: '📺', movie: '🎬' } as const
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

  const handleAdd = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    addItem(trimmed, type)
    setTitle('')
  }

  return (
    <div className="flex flex-col h-full p-4 pt-16 gap-4">
      <h2 className="text-2xl font-bold text-white/80">Watch / Play List</h2>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="Add title..."
          className="flex-1 bg-white/10 text-white placeholder-white/30 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-cyan-500"
        />
        <div className="flex rounded-xl overflow-hidden border border-white/10">
          {TYPES.map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-3 py-2 text-lg transition-colors ${type === t ? 'bg-cyan-500' : 'bg-white/5 hover:bg-white/10'}`}
            >
              {TYPE_ICON[t]}
            </button>
          ))}
        </div>
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-cyan-500 text-black font-bold rounded-xl active:scale-95"
        >
          +
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto flex flex-col gap-2">
        {items.length === 0 && (
          <p className="text-white/30 text-sm text-center mt-8">Nothing added yet</p>
        )}
        {items.map(item => (
          <div
            key={item.id}
            className={`flex items-center gap-3 bg-white/5 rounded-xl p-3 ${item.done ? 'opacity-40' : ''}`}
          >
            <span className="text-xl">{TYPE_ICON[item.type]}</span>
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
    </div>
  )
}
