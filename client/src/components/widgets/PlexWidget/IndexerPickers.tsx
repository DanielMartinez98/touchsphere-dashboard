/* eslint-disable react-refresh/only-export-components -- the label helpers live beside the pickers they describe */
// The pickers on Prowlarr's search page — Indexers, Categories, the Query
// Options modal and the sort menu — as bottom sheets. Prowlarr draws the
// first two as multi-select dropdowns; a native <select> opens an OS popup
// TouchKio renders badly (the Draw panel's Style row carries the same note),
// so each is a sheet of tappable rows with a Clear and a Done.
//
// Pinned to the viewport with `fixed`, the way the Notion task sheet is: the
// tab sits in the widget's single scroll container, and an `absolute` sheet
// at the bottom of a long result list opens below the fold.

import { useState } from 'react'
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Film, Lock, Music, Search, Tv } from 'lucide-react'
import type { Indexer, IndexerCategory, IndexerSearchType } from '../../../hooks/usePlex'
import { ACCENT } from './items'

// ── Shared pieces ────────────────────────────────────────────────────────────

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[9050] flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-hairline rounded-t-3xl notion-sheet max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-2 shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <p className="text-[11px] uppercase tracking-widest text-white/40 font-semibold">{title}</p>
        </div>
        <div className="px-5 pb-2 overflow-y-auto min-h-0 flex-1 scrollbar-hide">{children}</div>
        <div className="px-5 pt-2 pb-8 shrink-0 flex gap-2" style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
          {footer ?? (
            <button type="button" onClick={onClose} className="flex-1 h-12 rounded-xl text-sm font-semibold text-black active:scale-[0.98]" style={{ background: ACCENT }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CheckRow({ on, implied = false, dim = false, indent = false, label, hint, icon, trailing, onToggle }: {
  on: boolean; implied?: boolean; dim?: boolean; indent?: boolean
  label: string; hint?: string; icon?: React.ReactNode; trailing?: React.ReactNode; onToggle: () => void
}) {
  const checked = on || implied
  return (
    <div className={`flex items-center gap-3 min-h-12 ${indent ? 'pl-8' : ''}`}>
      <button type="button" role="checkbox" aria-checked={checked} onClick={onToggle} disabled={dim}
        className={`flex-1 min-w-0 flex items-center gap-3 py-2 text-left active:opacity-70 ${dim ? 'opacity-40' : ''}`}>
        <span className={`w-6 h-6 shrink-0 rounded-md border flex items-center justify-center transition-colors ${
          checked ? (implied && !on ? 'bg-[#e5a00d]/40 border-[#e5a00d]/40 text-black' : 'bg-[#e5a00d] border-[#e5a00d] text-black') : 'bg-white/5 border-white/20'}`}>
          {checked && <Check size={15} strokeWidth={3} />}
        </span>
        {icon}
        <span className="text-[14px] text-white/85 truncate">{label}</span>
        {hint && <span className="text-[12px] text-white/35 tabular-nums shrink-0">{hint}</span>}
      </button>
      {trailing}
    </div>
  )
}

function ClearDone({ onClear, onDone, cleared }: { onClear: () => void; onDone: () => void; cleared: boolean }) {
  return (
    <>
      <button type="button" onClick={onClear} disabled={cleared}
        className="h-12 px-5 rounded-xl bg-white/[0.06] text-white/70 text-sm font-semibold active:bg-white/10 disabled:opacity-40">
        Clear
      </button>
      <button type="button" onClick={onDone} className="flex-1 h-12 rounded-xl text-sm font-semibold text-black active:scale-[0.98]" style={{ background: ACCENT }}>
        Done
      </button>
    </>
  )
}

// ── Indexers ─────────────────────────────────────────────────────────────────
// Prowlarr's picker groups by protocol, and the group rows are values of their
// own: -1 means every usenet indexer, -2 every torrent one. Nothing selected
// is every enabled indexer.

export const ALL_USENET = -1
export const ALL_TORRENT = -2

export function indexerPickLabel(value: number[], indexers: Indexer[]): string {
  if (!value.length) return 'All indexers'
  const byId = new Map(indexers.map(i => [i.id, i.name]))
  const names = value.map(v => v === ALL_TORRENT ? 'All torrent' : v === ALL_USENET ? 'All usenet' : byId.get(v) ?? `#${v}`)
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
}

export function IndexerPicker({ indexers, value, onChange, onClose }: { indexers: Indexer[]; value: number[]; onChange: (v: number[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<Set<number>>(() => new Set(value))
  const groups: { protocol: string; label: string; group: number }[] = [
    { protocol: 'torrent', label: 'Torrent', group: ALL_TORRENT },
    { protocol: 'usenet', label: 'Usenet', group: ALL_USENET },
  ]
  const toggle = (id: number) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleGroup = (g: { protocol: string; group: number }) => setSel(prev => {
    const n = new Set(prev)
    if (n.has(g.group)) n.delete(g.group)
    else {
      n.add(g.group)
      // The group covers its members, so their own ticks are redundant.
      for (const i of indexers) if (i.protocol === g.protocol) n.delete(i.id)
    }
    return n
  })
  const done = () => { onChange([...sel]); onClose() }
  return (
    <Sheet title="Indexers" onClose={done} footer={<ClearDone cleared={sel.size === 0} onClear={() => setSel(new Set())} onDone={done} />}>
      {groups.map(g => {
        const members = indexers.filter(i => i.protocol === g.protocol)
        if (!members.length) return null
        return (
          <div key={g.protocol} className="mb-2">
            <CheckRow on={sel.has(g.group)} label={g.label} hint={`${members.filter(m => m.enabled).length} enabled`} onToggle={() => toggleGroup(g)} />
            {members.map(i => (
              <CheckRow key={i.id} indent on={sel.has(i.id)} implied={sel.has(g.group)} dim={!i.enabled}
                label={i.name} hint={i.enabled ? `(${i.id})` : 'disabled'}
                icon={i.privacy !== 'public' ? <Lock size={13} className="text-white/40 shrink-0" /> : undefined}
                onToggle={() => toggle(i.id)} />
            ))}
          </div>
        )
      })}
      {indexers.length === 0 && <p className="text-white/45 text-sm py-4">Prowlarr has no indexers yet.</p>}
    </Sheet>
  )
}

// ── Categories ───────────────────────────────────────────────────────────────
// The Newznab tree Prowlarr serves: a parent (2000 Movies) and its
// subcategories (2040 Movies/HD), each selectable on its own, with the id
// shown as a hint the way Prowlarr's picker prints it.

export function categoryPickLabel(value: number[], categories: IndexerCategory[]): string {
  if (!value.length) return 'All'
  const names = new Map<number, string>()
  for (const c of categories) { names.set(c.id, c.name); for (const s of c.subCategories) names.set(s.id, s.name) }
  const labels = value.map(v => names.get(v) ?? String(v))
  return labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ')
}

export function CategoryPicker({ categories, value, onChange, onClose }: { categories: IndexerCategory[]; value: number[]; onChange: (v: number[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<Set<number>>(() => new Set(value))
  const [open, setOpen] = useState<Set<number>>(() => {
    // A parent with a chosen subcategory opens on it, so the tick is visible.
    const o = new Set<number>()
    for (const c of categories) if (c.subCategories.some(s => value.includes(s.id))) o.add(c.id)
    return o
  })
  const toggle = (id: number) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const flip = (id: number) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const done = () => { onChange([...sel]); onClose() }
  return (
    <Sheet title="Categories" onClose={done} footer={<ClearDone cleared={sel.size === 0} onClear={() => setSel(new Set())} onDone={done} />}>
      {categories.map(c => (
        <div key={c.id}>
          <CheckRow on={sel.has(c.id)} label={c.name} hint={`(${c.id})`} onToggle={() => toggle(c.id)}
            trailing={c.subCategories.length > 0 ? (
              <button type="button" onClick={() => flip(c.id)} aria-label={open.has(c.id) ? `Collapse ${c.name}` : `Expand ${c.name}`}
                className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-white/50 active:bg-white/10">
                {open.has(c.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>
            ) : undefined} />
          {open.has(c.id) && c.subCategories.map(s => (
            <CheckRow key={s.id} indent on={sel.has(s.id)} implied={sel.has(c.id)} label={s.name} hint={`(${s.id})`} onToggle={() => toggle(s.id)} />
          ))}
        </div>
      ))}
      {categories.length === 0 && <p className="text-white/45 text-sm py-4">Prowlarr sent no category list.</p>}
    </Sheet>
  )
}

// ── Query options ────────────────────────────────────────────────────────────
// Prowlarr's modal behind the icon on the query field: the search type, and
// the id tokens that type understands, each a tap that writes it into the
// query. Verbatim from its QueryParameterModal.

export const SEARCH_TYPES: { id: IndexerSearchType; label: string }[] = [
  { id: 'search',   label: 'Basic Search' },
  { id: 'tvsearch', label: 'TV Search' },
  { id: 'movie',    label: 'Movie Search' },
  { id: 'music',    label: 'Audio Search' },
  { id: 'book',     label: 'Book Search' },
]

const TOKENS: Record<IndexerSearchType, { token: string; example: string }[]> = {
  search: [],
  tvsearch: [
    { token: '{ImdbId:tt1234567}', example: 'tt12345' },
    { token: '{TvdbId:12345}', example: '12345' },
    { token: '{TmdbId:12345}', example: '12345' },
    { token: '{TvMazeId:12345}', example: '54321' },
    { token: '{Season:00}', example: '01' },
    { token: '{Episode:00}', example: '01' },
  ],
  movie: [
    { token: '{ImdbId:tt1234567}', example: 'tt12345' },
    { token: '{TmdbId:12345}', example: '12345' },
    { token: '{Year:2000}', example: '2005' },
  ],
  music: [
    { token: '{Artist:Some Body}', example: 'Nirvana' },
    { token: '{Album:Some Album}', example: 'Nevermind' },
    { token: '{Label:Some Label}', example: 'Geffen' },
  ],
  book: [
    { token: '{Author:Some Author}', example: 'J. R. R. Tolkien' },
    { token: '{Title:Some Book}', example: 'Lord of the Rings' },
  ],
}

export function TypeIcon({ type, size = 18 }: { type: IndexerSearchType; size?: number }) {
  switch (type) {
    case 'tvsearch': return <Tv size={size} />
    case 'movie':    return <Film size={size} />
    case 'music':    return <Music size={size} />
    case 'book':     return <BookOpen size={size} />
    default:         return <Search size={size} />
  }
}

export function QueryOptionsSheet({ type, onType, onInsert, onClose }: { type: IndexerSearchType; onType: (t: IndexerSearchType) => void; onInsert: (token: string) => void; onClose: () => void }) {
  const tokens = TOKENS[type]
  return (
    <Sheet title="Query options" onClose={onClose}>
      <p className="text-[12px] text-white/45 mb-2">Search type</p>
      <div className="flex flex-col gap-1.5 mb-4">
        {SEARCH_TYPES.map(t => (
          <button key={t.id} type="button" onClick={() => onType(t.id)}
            className={`h-12 px-3 rounded-xl flex items-center gap-3 text-[14px] font-medium text-left transition-colors ${
              type === t.id ? 'bg-white/15 text-white border border-white/20' : 'bg-white/[0.04] text-white/70 border border-transparent active:bg-white/10'}`}>
            <TypeIcon type={t.id} size={17} />{t.label}
            {type === t.id && <Check size={16} className="ml-auto text-[#e5a00d]" />}
          </button>
        ))}
      </div>
      {tokens.length > 0 && (
        <>
          <p className="text-[12px] text-white/45 mb-2">Tap to add to the query, then put the id in</p>
          <div className="grid grid-cols-2 gap-1.5">
            {tokens.map(t => (
              <button key={t.token} type="button" onClick={() => onInsert(t.token)}
                className="rounded-xl bg-white/[0.04] border border-hairline px-3 py-2.5 text-left active:bg-white/10">
                <span className="block font-mono text-[12px] text-white/85 truncate">{t.token}</span>
                <span className="block text-[11px] text-white/40 mt-0.5 truncate">{t.example}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tokens.length === 0 && <p className="text-[12px] text-white/35">A basic search sends the words as typed to every indexer.</p>}
    </Sheet>
  )
}

// ── Sort ─────────────────────────────────────────────────────────────────────

export type SortKey = 'protocol' | 'age' | 'sortTitle' | 'indexer' | 'size' | 'files' | 'grabs' | 'peers' | 'category'
export type SortDir = 'asc' | 'desc'

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'protocol',  label: 'Protocol' },
  { id: 'age',       label: 'Age' },
  { id: 'sortTitle', label: 'Title' },
  { id: 'indexer',   label: 'Indexer' },
  { id: 'size',      label: 'Size' },
  { id: 'files',     label: 'Files' },
  { id: 'grabs',     label: 'Grabs' },
  { id: 'peers',     label: 'Peers' },
  { id: 'category',  label: 'Category' },
]

export function SortSheet({ sortKey, dir, onChange, onClose }: { sortKey: SortKey; dir: SortDir; onChange: (k: SortKey, d: SortDir) => void; onClose: () => void }) {
  return (
    <Sheet title="Sort by" onClose={onClose}>
      <div className="flex flex-col gap-1.5">
        {SORT_OPTIONS.map(o => {
          const active = o.id === sortKey
          return (
            // Prowlarr's sort menu: the active key flips direction, another key takes over ascending.
            <button key={o.id} type="button" onClick={() => onChange(o.id, active ? (dir === 'asc' ? 'desc' : 'asc') : 'asc')}
              className={`h-12 px-3 rounded-xl flex items-center gap-3 text-[14px] font-medium text-left ${
                active ? 'bg-white/15 text-white border border-white/20' : 'bg-white/[0.04] text-white/70 border border-transparent active:bg-white/10'}`}>
              {o.label}
              {active && <span className="ml-auto text-[#e5a00d]">{dir === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}</span>}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}
