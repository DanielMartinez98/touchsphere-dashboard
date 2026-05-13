import { useEffect, useMemo, useState } from 'react'
import type { MediaItem, MediaStatus, MediaType } from '../../../types'
import { statusesFor } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'
import { TouchKeyboard } from '../../TouchKeyboard'

const STATUS_LABEL: Record<MediaStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done:        'Done',
  dropped:     'Dropped',
}

const STATUS_GLYPH: Record<MediaStatus, string> = {
  not_started: '○',
  in_progress: '▶',
  done:        '✓',
  dropped:     '✕',
}

// Tailwind class fragments per status — used on the cycle button so the
// current state is visible at a glance.
const STATUS_BTN_CLASS: Record<MediaStatus, string> = {
  not_started: 'bg-white/10 text-white/60',
  in_progress: 'bg-cyan-400/25 text-cyan-200',
  done:        'bg-emerald-500/25 text-emerald-300',
  dropped:     'bg-rose-500/20 text-rose-300',
}

const TYPES: MediaType[] = ['game', 'show', 'movie']
type Filter = 'all' | MediaType

const TYPE_LABEL: Record<MediaType, string> = {
  game: 'Game',
  show: 'Show',
  movie: 'Movie',
}

interface Props {
  items: MediaItem[]
  addItem: (title: string, type: MediaType) => void
  removeItem: (id: string) => void
  markDone: (id: string) => void
  toggleStar: (id: string) => void
  setStatus: (id: string, status: MediaStatus) => void
}

export default function MediaListExpanded({
  items,
  addItem,
  removeItem,
  markDone: _markDone,
  toggleStar,
  setStatus,
}: Props) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<MediaType>('show')
  const [showKeyboard, setShowKeyboard] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [shuffleSeed, setShuffleSeed] = useState(0)
  const [recommendedId, setRecommendedId] = useState<string | null>(null)

  // Detect a fine pointer (mouse) — on desktop the user wants to type with
  // their physical keyboard rather than tap the on-screen one.
  const [hasMouse, setHasMouse] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: fine)')
    const update = () => setHasMouse(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])

  const handleAdd = (e?: React.SyntheticEvent) => {
    e?.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) {
      if (!hasMouse) setShowKeyboard(true)
      return
    }
    addItem(trimmed, type)
    setTitle('')
    setShowKeyboard(false)
  }

  // Seeded shuffle so order is stable per `shuffleSeed` (no flicker on render).
  const filtered = useMemo(() => {
    const base = filter === 'all' ? items : items.filter(i => i.type === filter)
    if (shuffleSeed === 0) return base
    const arr = base.slice()
    let h = shuffleSeed
    for (let i = arr.length - 1; i > 0; i--) {
      h = (h * 1664525 + 1013904223) >>> 0
      const j = h % (i + 1)
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }, [items, filter, shuffleSeed])

  // Display order: starred first, then the (possibly shuffled) rest. Done and
  // dropped sink to the bottom so the active queue stays clean.
  const ordered = useMemo(() => {
    const isInactive = (i: MediaItem) => i.status === 'done' || i.status === 'dropped'
    const active = filtered.filter(i => !isInactive(i))
    const inactive = filtered.filter(isInactive)
    const starred = active.filter(i => i.starred)
    const rest = active.filter(i => !i.starred)
    return [...starred, ...rest, ...inactive]
  }, [filtered])

  const recommend = () => {
    const pool = filtered.filter(i => i.status !== 'done' && i.status !== 'dropped')
    if (pool.length === 0) {
      setRecommendedId(null)
      return
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]
    setRecommendedId(pick.id)
  }

  const recommended = recommendedId
    ? items.find(i => i.id === recommendedId) ?? null
    : null

  const filterTabs: { key: Filter; label: string }[] = [
    { key: 'all',   label: 'All' },
    { key: 'game',  label: 'Games' },
    { key: 'show',  label: 'Shows' },
    { key: 'movie', label: 'Movies' },
  ]

  return (
    <div className="flex flex-col h-full p-4 pt-16 gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white/80">Watch / Play List</h2>
        <span className="text-xs text-white/40">{items.length} total</span>
      </div>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          inputMode={hasMouse ? 'text' : 'none'}
          value={title}
          readOnly={!hasMouse}
          onChange={hasMouse ? e => setTitle(e.target.value) : undefined}
          onKeyDown={hasMouse ? e => { if (e.key === 'Enter') handleAdd(e) } : undefined}
          onClick={hasMouse ? undefined : () => setShowKeyboard(true)}
          onPointerDown={hasMouse ? undefined : () => setShowKeyboard(true)}
          placeholder="Add title..."
          className={`flex-1 bg-white/10 text-white placeholder-white/30 rounded-xl px-4 py-3 text-sm outline-none ${hasMouse ? '' : 'cursor-pointer'}`}
        />
        <div className="flex rounded-xl overflow-hidden border border-white/20">
          {TYPES.map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              aria-label={t}
              className={`px-4 py-3 text-xl transition-colors ${
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
          onPointerDown={handleAdd}
          className="px-4 py-2 bg-[var(--accent,#06b6d4)] text-black font-bold rounded-xl active:scale-95 touch-manipulation"
        >
          +
        </button>
      </div>

      {/* Filter + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-white/15">
          {filterTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === t.key
                  ? 'bg-white/25 text-white'
                  : 'bg-white/5 text-white/60 hover:bg-white/15'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShuffleSeed(Date.now() & 0xffffffff)}
          className="px-3 py-1.5 rounded-xl bg-white/10 text-white text-xs font-semibold hover:bg-white/20 active:scale-95"
        >
          🔀 Shuffle
        </button>
        {shuffleSeed !== 0 && (
          <button
            onClick={() => setShuffleSeed(0)}
            className="px-2 py-1.5 rounded-xl bg-white/5 text-white/60 text-xs hover:bg-white/15"
          >
            Reset
          </button>
        )}
        <button
          onClick={recommend}
          className="px-3 py-1.5 rounded-xl bg-[var(--accent,#06b6d4)]/20 text-[var(--accent,#06b6d4)] text-xs font-semibold border border-[var(--accent,#06b6d4)]/30 hover:bg-[var(--accent,#06b6d4)]/30 active:scale-95"
        >
          🎲 Recommend
        </button>
      </div>

      {/* Recommendation banner */}
      {recommended && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--accent,#06b6d4)]/40 bg-[var(--accent,#06b6d4)]/10 p-3">
          <MediaTypeIcon type={recommended.type} className="text-2xl text-[var(--accent,#06b6d4)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent,#06b6d4)] font-bold">
              Tonight's pick · {TYPE_LABEL[recommended.type]}
            </div>
            <div className="text-sm font-semibold text-white truncate">{recommended.title}</div>
          </div>
          <button
            onClick={recommend}
            className="px-2 py-1 rounded-lg bg-white/10 text-white/80 text-xs hover:bg-white/20"
          >
            Re-roll
          </button>
          <button
            onClick={() => setRecommendedId(null)}
            className="w-7 h-7 rounded-full bg-white/10 text-white/60 flex items-center justify-center text-xs hover:bg-white/20"
            aria-label="Dismiss recommendation"
          >
            ✕
          </button>
        </div>
      )}

      {/* List */}
      <div className={`flex-1 overflow-auto flex flex-col gap-2 ${showKeyboard ? 'pb-64' : ''}`}>
        {ordered.length === 0 && (
          <p className="text-white/30 text-sm text-center mt-8">
            {items.length === 0 ? 'Nothing added yet' : 'No items match this filter'}
          </p>
        )}
        {ordered.map(item => {
          const isRecommended = item.id === recommendedId
          const cycle = statusesFor(item.type)
          const nextStatus = cycle[(cycle.indexOf(item.status) + 1) % cycle.length]!
          const isInactive = item.status === 'done' || item.status === 'dropped'
          return (
            <div
              key={item.id}
              className={`flex items-center gap-3 rounded-xl p-3 border transition-colors ${
                isRecommended
                  ? 'bg-[var(--accent,#06b6d4)]/10 border-[var(--accent,#06b6d4)]/40'
                  : item.starred
                    ? 'bg-amber-400/10 border-amber-400/30'
                    : 'bg-white/5 border-transparent'
              } ${isInactive ? 'opacity-50' : ''}`}
            >
              <MediaTypeIcon type={item.type} className="text-2xl text-white/80 shrink-0" />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-base font-semibold leading-tight ${
                    item.status === 'done'    ? 'line-through text-white/40' :
                    item.status === 'dropped' ? 'line-through text-white/30' :
                                                'text-white'
                  }`}
                >
                  {item.title}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-white/40 mt-0.5 flex items-center gap-1.5">
                  <span>{TYPE_LABEL[item.type]}</span>
                  <span className="text-white/20">·</span>
                  <span>{STATUS_LABEL[item.status]}</span>
                </div>
              </div>
              <button
                onClick={() => toggleStar(item.id)}
                aria-label={item.starred ? 'Unstar' : 'Star'}
                className={`w-9 h-9 rounded-full flex items-center justify-center text-lg active:scale-90 ${
                  item.starred
                    ? 'bg-amber-400/30 text-amber-300'
                    : 'bg-white/5 text-white/40 hover:bg-white/15'
                }`}
              >
                {item.starred ? '★' : '☆'}
              </button>
              <button
                onClick={() => setStatus(item.id, nextStatus)}
                aria-label={`Status: ${STATUS_LABEL[item.status]}. Tap for ${STATUS_LABEL[nextStatus]}.`}
                title={`${STATUS_LABEL[item.status]} → ${STATUS_LABEL[nextStatus]}`}
                className={`min-w-[2.25rem] h-9 px-2 rounded-full flex items-center justify-center text-sm font-bold active:scale-90 ${STATUS_BTN_CLASS[item.status]}`}
              >
                {STATUS_GLYPH[item.status]}
              </button>
              <button
                onClick={() => removeItem(item.id)}
                className="w-9 h-9 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-sm active:scale-90"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      {showKeyboard && !hasMouse && (
        <TouchKeyboard
          value={title}
          onChange={setTitle}
          onDone={handleAdd}
        />
      )}
    </div>
  )
}
