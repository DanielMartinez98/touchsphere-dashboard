import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Shuffle, Dices, Star, Plus, X, Circle, Play, Check, ChevronDown, ChevronRight, Trash2, Undo2, Image as ImageIcon, Pencil } from 'lucide-react'
import type { ArtworkResult, MediaItem, MediaStatus, MediaType } from '../../../types'
import { statusesFor } from '../../../types'
import { MediaTypeIcon } from './MediaTypeIcon'
import { TouchKeyboard } from '../../TouchKeyboard'

const STATUS_LABEL: Record<MediaStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done:        'Done',
  dropped:     'Dropped',
}

const STATUS_ICON: Record<MediaStatus, React.ReactElement> = {
  not_started: <Circle size={15} />,
  in_progress: <Play size={15} />,
  done:        <Check size={16} />,
  dropped:     <X size={15} />,
}

// Tailwind class fragments per status — used on the row pill so the current
// state is visible at a glance.
const STATUS_PILL_CLASS: Record<MediaStatus, string> = {
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

// ── Cover art ────────────────────────────────────────────────────────────────
// Real posters come from the server (TMDB for movies/shows, IGDB for games),
// cached to disk on add so they render offline. Anything without one — no
// match, or added while the Pi had no WAN — keeps the old gradient tile derived
// from the title, so the list is never a row of broken images.

function hueFromTitle(title: string): number {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  return h % 360
}

// Posters are 2:3 — a square crop throws away most of the artwork.
const COVER_SIZE = 'w-[52px] h-[78px] rounded-lg'

function MediaCover({ item, className = COVER_SIZE }: { item: MediaItem; className?: string }) {
  // A cached file can still 404 if the volume was wiped under a stale media.json.
  const [broken, setBroken] = useState(false)
  const hue = hueFromTitle(item.title)

  if (item.cover && !broken) {
    return (
      <img
        src={`/api/artwork/cover/${item.cover}`}
        alt=""
        onError={() => setBroken(true)}
        className={`${className} shrink-0 object-cover bg-white/5`}
      />
    )
  }

  return (
    <div
      className={`${className} flex items-center justify-center shrink-0 text-white/90`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 40%), hsl(${(hue + 45) % 360} 70% 24%))` }}
    >
      <MediaTypeIcon type={item.type} className="text-xl" />
    </div>
  )
}

// ── Cover picker ─────────────────────────────────────────────────────────────
// The auto-match takes the provider's top hit, which is wrong often enough for
// ambiguous titles ("Dune", "The Office", numbered sequels). This sheet shows
// the other candidates so a bad guess is a two-tap fix rather than a dead end.

function CoverPicker({
  item, onClose, onPick,
}: {
  item:    MediaItem
  onClose: () => void
  onPick:  (imageUrl: string) => void
}) {
  const [results, setResults] = useState<ArtworkResult[] | null>(null)
  const [failed, setFailed]   = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/artwork/search?type=${item.type}&q=${encodeURIComponent(item.title)}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<ArtworkResult[]>
      })
      .then(data => { if (!cancelled) setResults(data) })
      .catch(err => {
        console.error('[MediaList] cover search failed:', err)
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [item.type, item.title])

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-hairline rounded-t-3xl notion-sheet"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-8">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />

          <div className="flex items-center justify-between mb-4">
            <div className="min-w-0">
              <p className="text-base font-semibold text-white truncate">Choose cover</p>
              <p className="text-xs text-white/50 mt-0.5 truncate">{item.title}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="w-11 h-11 shrink-0 rounded-full bg-glass-2 text-white/60 flex items-center justify-center active:scale-90">
              <X size={18} />
            </button>
          </div>

          {results === null && !failed && (
            <p className="text-white/45 text-sm text-center py-10">Searching…</p>
          )}
          {failed && (
            <p className="text-white/45 text-sm text-center py-10">Couldn’t reach the artwork service</p>
          )}
          {results?.length === 0 && (
            <p className="text-white/45 text-sm text-center py-10">No artwork found for this title</p>
          )}

          {results && results.length > 0 && (
            <div className="grid grid-cols-3 gap-3 max-h-[46vh] overflow-auto scroll-fade-y">
              {results.map(r => (
                <button key={r.id} type="button"
                  onClick={() => { onPick(r.imageUrl); onClose() }}
                  className="flex flex-col gap-1.5 active:scale-95 transition-transform">
                  <img src={r.imageUrl} alt=""
                    className="w-full aspect-[2/3] object-cover rounded-lg bg-white/5" />
                  <span className="text-xs text-white/70 leading-tight line-clamp-2 text-left">{r.title}</span>
                  {r.year && <span className="text-[11px] text-white/40 text-left -mt-1">{r.year}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Rename sheet ─────────────────────────────────────────────────────────────
// A misspelled title is the usual reason an item has no cover, so renaming is
// also the fix-up path for artwork: the server re-runs the lookup on save.

function RenameSheet({
  item, onClose, onSave,
}: {
  item:    MediaItem
  onClose: () => void
  onSave:  (title: string) => void
}) {
  const [value, setValue] = useState(item.title)

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== item.title) onSave(trimmed)
    onClose()
  }

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-hairline rounded-t-3xl notion-sheet"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-4">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />

          <p className="text-base font-semibold text-white mb-1">Rename</p>
          <p className="text-xs text-white/45 mb-3">Fixing the spelling re-fetches the cover art.</p>

          <div className="flex gap-2">
            <input
              type="text"
              inputMode="none"
              readOnly
              value={value}
              className="flex-1 bg-glass-2 text-white rounded-xl px-4 py-3 text-base outline-none"
            />
            <button type="button" onClick={commit}
              className="px-5 bg-[var(--accent,#06b6d4)] text-black font-bold rounded-xl active:scale-95">
              Save
            </button>
          </div>
        </div>

        <TouchKeyboard value={value} onChange={setValue} onDone={commit} />
      </div>
    </div>
  )
}

// ── Bottom sheet: status / star / delete for one item ────────────────────────

function ItemSheet({
  item, onClose, onSetStatus, onToggleStar, onDelete, onChangeCover, onRename,
}: {
  item:          MediaItem
  onClose:       () => void
  onSetStatus:   (status: MediaStatus) => void
  onToggleStar:  () => void
  onDelete:      () => void
  onChangeCover: () => void
  onRename:      () => void
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-hairline rounded-t-3xl notion-sheet"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-8">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />

          <div className="flex items-center gap-3 mb-5">
            <MediaCover item={item} />
            <div className="flex-1 min-w-0">
              <p className="text-base font-semibold text-white truncate">{item.title}</p>
              <p className="text-xs uppercase tracking-wider text-white/50 mt-0.5">{TYPE_LABEL[item.type]}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2 mb-5">
            {statusesFor(item.type).map(s => (
              <button key={s} type="button"
                onClick={() => { onSetStatus(s); onClose() }}
                className={`flex items-center gap-3 h-13 px-4 py-3.5 rounded-xl text-sm font-semibold transition-colors
                  ${item.status === s
                    ? STATUS_PILL_CLASS[s] + ' ring-1 ring-white/20'
                    : 'bg-white/[0.05] text-white/60 active:bg-white/10'}`}>
                {STATUS_ICON[s]}
                {STATUS_LABEL[s]}
                {item.status === s && <span className="ml-auto text-xs font-medium opacity-70">Current</span>}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 mb-2">
            <button type="button" onClick={onRename}
              className="h-13 py-3.5 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 flex items-center justify-center gap-2">
              <Pencil size={16} /> Rename
            </button>
            <button type="button" onClick={onChangeCover}
              className="h-13 py-3.5 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 flex items-center justify-center gap-2">
              <ImageIcon size={16} /> Cover
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { onToggleStar(); onClose() }}
              className={`h-13 py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2
                ${item.starred ? 'bg-amber-400/25 text-amber-300' : 'bg-white/[0.06] text-white/70 active:bg-white/10'}`}>
              <Star size={16} fill={item.starred ? 'currentColor' : 'none'} />
              {item.starred ? 'Unstar' : 'Star'}
            </button>
            <button type="button" onClick={onDelete}
              className="h-13 py-3.5 rounded-xl text-sm font-semibold bg-red-500/15 text-red-400 active:bg-red-500/25 flex items-center justify-center gap-2">
              <Trash2 size={16} /> Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-2">
      <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/50">{label}</span>
      <span className="text-xs text-white/35 tabular-nums">{count}</span>
    </div>
  )
}

interface Props {
  items: MediaItem[]
  addItem: (title: string, type: MediaType) => void
  removeItem: (id: string) => void
  markDone: (id: string) => void
  toggleStar: (id: string) => void
  setStatus: (id: string, status: MediaStatus) => void
  setCover: (id: string, coverUrl: string) => void
  renameItem: (id: string, title: string) => void
}

export default function MediaListExpanded({
  items,
  addItem,
  removeItem,
  markDone: _markDone,
  toggleStar,
  setStatus,
  setCover,
  renameItem,
}: Props) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<MediaType>('show')
  const [showKeyboard, setShowKeyboard] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [shuffleSeed, setShuffleSeed] = useState(0)
  const [recommendedId, setRecommendedId] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const rollTimer = useRef<number | null>(null)
  const [sheetItemId, setSheetItemId] = useState<string | null>(null)
  const [coverItemId, setCoverItemId] = useState<string | null>(null)
  const [renameItemId, setRenameItemId] = useState<string | null>(null)
  const [showFinished, setShowFinished] = useState(false)

  // Stop a roulette mid-spin if the widget unmounts.
  useEffect(() => () => {
    if (rollTimer.current !== null) window.clearTimeout(rollTimer.current)
  }, [])

  // Pending delete — the item is hidden immediately but only removed on the
  // server after a 5s undo window. Deleting a second item commits the first.
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null)
  const pendingTimer = useRef<number | null>(null)

  function commitPendingDelete() {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
    setPendingDelete(prev => {
      if (prev) removeItem(prev.id)
      return null
    })
  }

  function requestDelete(item: MediaItem) {
    commitPendingDelete()
    setPendingDelete(item)
    setSheetItemId(null)
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null
      setPendingDelete(prev => {
        if (prev) removeItem(prev.id)
        return null
      })
    }, 5000)
  }

  function undoDelete() {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
    setPendingDelete(null)
  }

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

  // Sections: Continue (in progress) → Up next (not started, starred first)
  // → Finished (done/dropped, collapsed behind a header). The item awaiting
  // undo is hidden everywhere.
  const sections = useMemo(() => {
    const visible = pendingDelete ? filtered.filter(i => i.id !== pendingDelete.id) : filtered
    const starFirst = (arr: MediaItem[]) => [...arr.filter(i => i.starred), ...arr.filter(i => !i.starred)]
    return {
      cont:     starFirst(visible.filter(i => i.status === 'in_progress')),
      upNext:   starFirst(visible.filter(i => i.status === 'not_started')),
      finished: visible.filter(i => i.status === 'done' || i.status === 'dropped'),
    }
  }, [filtered, pendingDelete])

  // Recommend with a short roulette: the banner flicks through candidates,
  // decelerating before it lands. Pure timeouts — nothing to render off-screen.
  const recommend = () => {
    const pool = [...sections.cont, ...sections.upNext]
    if (pool.length === 0) {
      setRecommendedId(null)
      return
    }
    if (rollTimer.current !== null) window.clearTimeout(rollTimer.current)
    if (pool.length === 1) {
      setRecommendedId(pool[0].id)
      return
    }
    setRolling(true)
    const steps = 9
    let i = 0
    const spin = () => {
      setRecommendedId(prev => {
        // Avoid landing on the same title twice in a row mid-spin.
        let pick = pool[Math.floor(Math.random() * pool.length)]
        if (pick.id === prev) pick = pool[(pool.indexOf(pick) + 1) % pool.length]
        return pick.id
      })
      i++
      if (i < steps) {
        rollTimer.current = window.setTimeout(spin, 55 + i * i * 4)
      } else {
        rollTimer.current = null
        setRolling(false)
      }
    }
    spin()
  }

  const recommended = recommendedId
    ? items.find(i => i.id === recommendedId) ?? null
    : null

  const sheetItem = sheetItemId ? items.find(i => i.id === sheetItemId) ?? null : null
  const coverItem  = coverItemId  ? items.find(i => i.id === coverItemId)  ?? null : null
  const renameTarget = renameItemId ? items.find(i => i.id === renameItemId) ?? null : null

  const filterTabs: { key: Filter; label: string }[] = [
    { key: 'all',   label: 'All' },
    { key: 'game',  label: 'Games' },
    { key: 'show',  label: 'Shows' },
    { key: 'movie', label: 'Movies' },
  ]

  const renderRow = (item: MediaItem, idx: number) => {
    const isRecommended = item.id === recommendedId
    const isInactive = item.status === 'done' || item.status === 'dropped'
    return (
      <motion.div
        key={item.id}
        layoutId={item.id}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          layout:  { type: 'spring', stiffness: 420, damping: 34 },
          opacity: { duration: 0.2, delay: Math.min(idx * 0.03, 0.24) },
          y:       { duration: 0.2, delay: Math.min(idx * 0.03, 0.24) },
        }}
        onClick={() => setSheetItemId(item.id)}
        className={`flex items-center gap-3 rounded-xl p-2.5 border transition-colors cursor-pointer active:scale-[0.99] ${
          isRecommended
            ? 'bg-[var(--accent,#06b6d4)]/10 border-[var(--accent,#06b6d4)]/40'
            : item.starred && !isInactive
              ? 'bg-amber-400/10 border-amber-400/30'
              : 'bg-glass border-transparent'
        } ${isInactive ? 'opacity-50' : ''}`}
      >
        <MediaCover item={item} />
        <div className="flex-1 min-w-0">
          <div
            className={`text-base font-semibold leading-tight truncate ${
              item.status === 'done'    ? 'line-through text-white/40' :
              item.status === 'dropped' ? 'line-through text-white/30' :
                                          'text-white'
            }`}
          >
            {item.title}
          </div>
          <div className="text-xs uppercase tracking-wider text-white/50 mt-1">
            {TYPE_LABEL[item.type]}
          </div>
        </div>
        <button
          onClick={e => { e.stopPropagation(); toggleStar(item.id) }}
          aria-label={item.starred ? 'Unstar' : 'Star'}
          className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90 shrink-0 ${
            item.starred
              ? 'bg-amber-400/30 text-amber-300'
              : 'bg-glass text-white/40'
          }`}
        >
          <Star size={19} fill={item.starred ? 'currentColor' : 'none'} />
        </button>
        <span className={`h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-semibold shrink-0 ${STATUS_PILL_CLASS[item.status]}`}>
          {STATUS_ICON[item.status]}
          <span className="hidden min-[400px]:inline">{STATUS_LABEL[item.status]}</span>
        </span>
      </motion.div>
    )
  }

  const nothingVisible = sections.cont.length === 0 && sections.upNext.length === 0 && sections.finished.length === 0

  return (
    <div className="relative flex flex-col h-full p-4 pt-16 gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold font-display text-white/85">Watch / Play List</h2>
        <span className="text-sm text-ink-dim tabular-nums">{items.length} total</span>
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
          className={`flex-1 bg-glass-2 text-white placeholder-white/35 rounded-xl px-4 py-3 text-base outline-none ${hasMouse ? '' : 'cursor-pointer'}`}
        />
        <div className="flex rounded-xl overflow-hidden border border-hairline">
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
          aria-label="Add item"
          className="px-4 bg-[var(--accent,#06b6d4)] text-black font-bold rounded-xl active:scale-95 touch-manipulation flex items-center justify-center"
        >
          <Plus size={24} strokeWidth={2.5} />
        </button>
      </div>

      {/* Filter + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl overflow-hidden border border-hairline">
          {filterTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`px-4 py-2.5 text-sm font-semibold transition-colors ${
                filter === t.key
                  ? 'bg-white/25 text-white'
                  : 'bg-glass text-white/55 hover:bg-white/15'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShuffleSeed(Date.now() & 0xffffffff)}
          className="px-4 py-2.5 rounded-xl bg-glass-2 text-white text-sm font-semibold hover:bg-white/20 active:scale-95 flex items-center gap-2"
        >
          <Shuffle size={16} /> Shuffle
        </button>
        {shuffleSeed !== 0 && (
          <button
            onClick={() => setShuffleSeed(0)}
            className="px-3 py-2.5 rounded-xl bg-glass text-white/60 text-sm hover:bg-white/15"
          >
            Reset
          </button>
        )}
        <button
          onClick={recommend}
          className="px-4 py-2.5 rounded-xl bg-[var(--accent,#06b6d4)]/20 text-[var(--accent,#06b6d4)] text-sm font-semibold border border-[var(--accent,#06b6d4)]/30 hover:bg-[var(--accent,#06b6d4)]/30 active:scale-95 flex items-center gap-2"
        >
          <Dices size={16} /> Recommend
        </button>
      </div>

      {/* Tonight's pick — the payoff card. While rolling it flicks through
          candidates; on landing it settles with a soft accent glow. */}
      {recommended && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0, scale: rolling ? 0.99 : 1 }}
          className="flex items-center gap-3 rounded-2xl border border-[var(--accent,#06b6d4)]/40 bg-[var(--accent,#06b6d4)]/10 p-3.5"
          style={{ boxShadow: rolling ? 'none' : '0 0 30px 0 color-mix(in srgb, var(--accent, #06b6d4) 28%, transparent)' }}
        >
          <motion.div key={recommended.id} initial={{ opacity: 0.4, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}>
            <MediaCover item={recommended} className="w-[68px] h-[102px] rounded-xl" />
          </motion.div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wider text-[var(--accent,#06b6d4)] font-bold">
              {rolling ? 'Rolling…' : `Tonight's pick · ${TYPE_LABEL[recommended.type]}`}
            </div>
            <motion.div key={recommended.id + (rolling ? '-r' : '')}
              initial={{ opacity: 0.35 }} animate={{ opacity: 1 }}
              className="text-lg font-semibold font-display text-white truncate">
              {recommended.title}
            </motion.div>
          </div>
          <button
            onClick={recommend}
            disabled={rolling}
            className="px-3 py-2.5 rounded-lg bg-glass-2 text-white/80 text-sm hover:bg-white/20 disabled:opacity-40"
          >
            Re-roll
          </button>
          <button
            onClick={() => setRecommendedId(null)}
            disabled={rolling}
            className="w-10 h-10 rounded-full bg-glass-2 text-white/60 flex items-center justify-center hover:bg-white/20 disabled:opacity-40"
            aria-label="Dismiss recommendation"
          >
            <X size={18} />
          </button>
        </motion.div>
      )}

      {/* Sections */}
      <div className={`flex-1 overflow-auto scroll-fade-y flex flex-col gap-2 ${showKeyboard ? 'pb-64' : 'pb-16'}`}>
        {nothingVisible && (
          <p className="text-white/45 text-base text-center mt-8">
            {items.length === 0 ? 'Nothing added yet' : 'No items match this filter'}
          </p>
        )}

        {sections.cont.length > 0 && (
          <>
            <SectionHeader label="Continue" count={sections.cont.length} />
            {sections.cont.map(renderRow)}
          </>
        )}

        {sections.upNext.length > 0 && (
          <>
            <SectionHeader label="Up next" count={sections.upNext.length} />
            {sections.upNext.map(renderRow)}
          </>
        )}

        {sections.finished.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowFinished(v => !v)}
              className="flex items-center gap-2 px-1 pt-2 pb-1 active:opacity-70"
            >
              {showFinished ? <ChevronDown size={15} className="text-white/40" /> : <ChevronRight size={15} className="text-white/40" />}
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/50">Finished</span>
              <span className="text-xs text-white/35 tabular-nums">{sections.finished.length}</span>
            </button>
            {showFinished && sections.finished.map(renderRow)}
          </>
        )}
      </div>

      {/* Undo toast — visible for 5s after a delete */}
      {pendingDelete && (
        <div className="absolute bottom-5 left-4 right-4 z-30 flex items-center gap-3 bg-[#16181d] border border-hairline rounded-2xl px-4 py-3 shadow-2xl">
          <Trash2 size={17} className="text-red-400/80 shrink-0" />
          <span className="flex-1 text-sm text-white/80 truncate">Removed “{pendingDelete.title}”</span>
          <button
            type="button"
            onClick={undoDelete}
            className="flex items-center gap-1.5 text-[var(--accent,#06b6d4)] font-semibold text-sm px-4 py-2.5 rounded-full bg-[var(--accent,#06b6d4)]/10 active:bg-[var(--accent,#06b6d4)]/25"
          >
            <Undo2 size={15} /> Undo
          </button>
        </div>
      )}

      {sheetItem && (
        <ItemSheet
          item={sheetItem}
          onClose={() => setSheetItemId(null)}
          onSetStatus={s => setStatus(sheetItem.id, s)}
          onToggleStar={() => toggleStar(sheetItem.id)}
          onDelete={() => requestDelete(sheetItem)}
          onChangeCover={() => { setCoverItemId(sheetItem.id); setSheetItemId(null) }}
          onRename={() => { setRenameItemId(sheetItem.id); setSheetItemId(null) }}
        />
      )}

      {coverItem && (
        <CoverPicker
          item={coverItem}
          onClose={() => setCoverItemId(null)}
          onPick={url => setCover(coverItem.id, url)}
        />
      )}

      {renameTarget && (
        <RenameSheet
          item={renameTarget}
          onClose={() => setRenameItemId(null)}
          onSave={title => renameItem(renameTarget.id, title)}
        />
      )}

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
