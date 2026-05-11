import { useState } from 'react'
import type { DatabaseSchema } from './notion-types'

// Multi-key sort. Each entry is either a property name or a Notion `timestamp`
// (created_time / last_edited_time). Direction is per-entry. Order matters —
// the first entry is the primary sort key.

export interface SortKey {
  // exactly one of property / timestamp is set
  property?:  string
  timestamp?: 'created_time' | 'last_edited_time'
  direction:  'ascending' | 'descending'
}

export const EMPTY_SORT: SortKey[] = [
  { timestamp: 'last_edited_time', direction: 'descending' },
]

// Convert to Notion's sort body. Notion accepts an array of entries with the
// same shape we use internally so this is essentially a pass-through.
export function toNotionSorts(keys: SortKey[]): any[] {
  return keys
    .filter(k => k.property || k.timestamp)
    .map(k => k.property
      ? { property:  k.property,  direction: k.direction }
      : { timestamp: k.timestamp, direction: k.direction },
    )
}

export default function MultiSort({
  schema, sorts, onChange,
}: {
  schema:   DatabaseSchema
  sorts:    SortKey[]
  onChange: (next: SortKey[]) => void
}) {
  // Sort-eligible property types — Notion accepts most types but filters that
  // are useful on touch are the comparable ones.
  const props = Object.entries(schema.properties)
    .filter(([, p]) => ['number', 'date', 'title', 'rich_text', 'select', 'status', 'created_time', 'last_edited_time'].includes(p.type))
    .map(([name, p]) => ({ name, type: p.type as string }))

  function setKey(idx: number, patch: Partial<SortKey>) {
    const next = [...sorts]
    next[idx] = { ...next[idx]!, ...patch }
    onChange(next)
  }
  function removeKey(idx: number) {
    onChange(sorts.filter((_, i) => i !== idx))
  }
  function moveKey(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= sorts.length) return
    const next = [...sorts]
    ;[next[idx], next[j]] = [next[j]!, next[idx]!]
    onChange(next)
  }
  function addKey() {
    onChange([...sorts, { timestamp: 'last_edited_time', direction: 'descending' }])
  }

  return (
    <div className="flex flex-col gap-1.5">
      {sorts.map((k, i) => (
        <SortRow key={i}
          k={k}
          props={props}
          isFirst={i === 0}
          isLast={i === sorts.length - 1}
          onChange={p => setKey(i, p)}
          onRemove={() => removeKey(i)}
          onMove={dir => moveKey(i, dir)} />
      ))}
      <button type="button" onClick={addKey}
        className="self-start px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/[0.06] text-white/55 active:bg-white/10">
        + Add sort
      </button>
    </div>
  )
}

function SortRow({
  k, props, isFirst, isLast, onChange, onRemove, onMove,
}: {
  k:        SortKey
  props:    { name: string; type: string }[]
  isFirst:  boolean
  isLast:   boolean
  onChange: (patch: Partial<SortKey>) => void
  onRemove: () => void
  onMove:   (dir: -1 | 1) => void
}) {
  const [pick, setPick] = useState(false)
  const label = k.property ?? (k.timestamp === 'created_time' ? 'Created' : 'Last edited')

  return (
    <div className="flex flex-col gap-1.5 bg-white/[0.02] border border-white/[0.05] rounded-xl p-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" onClick={() => setPick(o => !o)}
          className="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/75 active:bg-white/10">
          {label}
        </button>
        <button type="button"
          onClick={() => onChange({ direction: k.direction === 'ascending' ? 'descending' : 'ascending' })}
          className="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/55 active:bg-white/10">
          {k.direction === 'ascending' ? '↑ Asc' : '↓ Desc'}
        </button>
        <div className="ml-auto flex gap-1">
          <button type="button" disabled={isFirst} onClick={() => onMove(-1)}
            aria-label="Move up"
            className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20 disabled:opacity-25">↑</button>
          <button type="button" disabled={isLast}  onClick={() => onMove(1)}
            aria-label="Move down"
            className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20 disabled:opacity-25">↓</button>
          <button type="button" onClick={onRemove}
            aria-label="Remove sort"
            className="w-6 h-6 rounded-full bg-red-500/20 text-red-300 text-xs active:bg-red-500/40">×</button>
        </div>
      </div>

      {pick && (
        <div className="flex flex-wrap gap-1 bg-white/[0.025] rounded-lg p-2">
          <button type="button"
            onClick={() => { onChange({ timestamp: 'last_edited_time', property: undefined }); setPick(false) }}
            className={`px-2.5 py-1 rounded-full text-[11px] ${k.timestamp === 'last_edited_time' ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
            Last edited
          </button>
          <button type="button"
            onClick={() => { onChange({ timestamp: 'created_time', property: undefined }); setPick(false) }}
            className={`px-2.5 py-1 rounded-full text-[11px] ${k.timestamp === 'created_time' ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
            Created
          </button>
          {props.map(p => (
            <button key={p.name} type="button"
              onClick={() => { onChange({ property: p.name, timestamp: undefined }); setPick(false) }}
              className={`px-2.5 py-1 rounded-full text-[11px] ${k.property === p.name ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
              {p.name} <span className="opacity-50">·{p.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
