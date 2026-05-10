import { useState } from 'react'
import MiniCalendar from './MiniCalendar'
import { colorFg, colorBg } from './notion-colors'
import { richTextWrite } from './notion-types'

// Edits one property of a Notion page. Two layers:
//   - PropertyValue (display text, used by DB rows / inline view)
//   - PropertyEditor (full input UI, used in the page header)
//
// Notion has ~20 property types; this covers everything edit-able through the
// API. Computed types (formula/rollup/created_time/last_edited_*/people writes)
// are read-only, displayed via PropertyValue.

// ── Read-side renderer (compact display) ─────────────────────────────────────

export function PropertyValue({ schema, value }: { schema: any; value: any }) {
  if (!value) return <span className="text-white/30 italic">—</span>
  const type = schema.type

  switch (type) {
    case 'title':
    case 'rich_text': {
      const text = (value[type] ?? []).map((t: any) => t.plain_text).join('')
      return text ? <span className="text-white/80">{text}</span> : <span className="text-white/30 italic">empty</span>
    }
    case 'number':
      return <span className="text-white/80 tabular-nums">{value.number ?? '—'}</span>
    case 'checkbox':
      return <span className={value.checkbox ? 'text-green-400' : 'text-white/30'}>{value.checkbox ? '☑' : '☐'}</span>
    case 'url':
      return value.url ? <a href={value.url} className="text-blue-400 underline truncate" target="_blank" rel="noreferrer">{value.url}</a> : <span className="text-white/30 italic">—</span>
    case 'email':
      return value.email ? <a href={`mailto:${value.email}`} className="text-blue-400 underline truncate">{value.email}</a> : <span className="text-white/30 italic">—</span>
    case 'phone_number':
      return value.phone_number ? <a href={`tel:${value.phone_number}`} className="text-blue-400 underline">{value.phone_number}</a> : <span className="text-white/30 italic">—</span>
    case 'select': {
      const v = value.select
      if (!v) return <span className="text-white/30 italic">—</span>
      return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: colorBg(v.color, 0.2), color: colorFg(v.color) }}>{v.name}</span>
    }
    case 'status': {
      const v = value.status
      if (!v) return <span className="text-white/30 italic">—</span>
      return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: colorBg(v.color, 0.2), color: colorFg(v.color) }}>{v.name}</span>
    }
    case 'multi_select': {
      const items = (value.multi_select ?? []) as any[]
      if (items.length === 0) return <span className="text-white/30 italic">—</span>
      return (
        <span className="flex flex-wrap gap-1">
          {items.map(o => (
            <span key={o.id} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: colorBg(o.color, 0.2), color: colorFg(o.color) }}>{o.name}</span>
          ))}
        </span>
      )
    }
    case 'date': {
      const d = value.date
      if (!d?.start) return <span className="text-white/30 italic">—</span>
      const start = new Date(d.start + (d.start.length === 10 ? 'T12:00' : ''))
      const label = start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      return <span className="text-white/80">{d.end ? `${label} → ${new Date(d.end).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : label}</span>
    }
    case 'people': {
      const ppl = (value.people ?? []) as any[]
      if (ppl.length === 0) return <span className="text-white/30 italic">—</span>
      return <span className="text-white/80">{ppl.map(p => p.name).filter(Boolean).join(', ') || `${ppl.length} people`}</span>
    }
    case 'files': {
      const files = (value.files ?? []) as any[]
      if (files.length === 0) return <span className="text-white/30 italic">—</span>
      return <span className="text-white/80">{files.length} file{files.length === 1 ? '' : 's'}</span>
    }
    case 'relation': {
      const rels = (value.relation ?? []) as any[]
      if (rels.length === 0) return <span className="text-white/30 italic">—</span>
      return <span className="text-white/80">{rels.length} linked</span>
    }
    case 'formula': {
      const f = value.formula ?? {}
      const v = f.string ?? f.number ?? f.boolean ?? (f.date?.start ?? '')
      return <span className="text-white/70 italic">{String(v ?? '—')}</span>
    }
    case 'rollup': {
      const r = value.rollup ?? {}
      if (r.type === 'number') return <span className="text-white/80 tabular-nums">{r.number ?? '—'}</span>
      if (r.type === 'date')   return <span className="text-white/80">{r.date?.start ?? '—'}</span>
      if (r.type === 'array')  return <span className="text-white/70 italic">{r.array.length} items</span>
      return <span className="text-white/70 italic">—</span>
    }
    case 'created_time':       return <span className="text-white/60 text-xs">{new Date(value.created_time).toLocaleString()}</span>
    case 'last_edited_time':   return <span className="text-white/60 text-xs">{new Date(value.last_edited_time).toLocaleString()}</span>
    case 'created_by':         return <span className="text-white/60 text-xs">{value.created_by?.name ?? value.created_by?.id?.slice(0, 8)}</span>
    case 'last_edited_by':     return <span className="text-white/60 text-xs">{value.last_edited_by?.name ?? value.last_edited_by?.id?.slice(0, 8)}</span>
    case 'unique_id':          return <span className="text-white/80 tabular-nums">{value.unique_id?.prefix ? `${value.unique_id.prefix}-` : ''}{value.unique_id?.number}</span>
    default:                   return <span className="text-white/40 italic text-xs">[{type}]</span>
  }
}

// ── Edit-side ────────────────────────────────────────────────────────────────

interface EditProps {
  name:     string
  schema:   any                       // Notion property schema entry
  value:    any                       // current property value (raw API shape)
  onSave:   (propertyPayload: any) => void
}

const READ_ONLY_TYPES = new Set([
  'formula', 'rollup', 'created_time', 'last_edited_time',
  'created_by', 'last_edited_by', 'unique_id', 'relation', 'files', 'people',
])

export default function PropertyEditor({ name, schema, value, onSave }: EditProps) {
  const type = schema.type

  if (READ_ONLY_TYPES.has(type)) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-white/35 uppercase tracking-wider">{name}</span>
        <div className="text-sm py-2"><PropertyValue schema={schema} value={value} /></div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-white/35 uppercase tracking-wider">{name}</span>
      <Inner schema={schema} value={value} onSave={onSave} />
    </div>
  )
}

function Inner({ schema, value, onSave }: { schema: any; value: any; onSave: (p: any) => void }) {
  const type = schema.type

  if (type === 'rich_text' || type === 'title') {
    return <TextProp value={value} type={type} onSave={onSave} />
  }
  if (type === 'number') {
    return <NumberProp value={value} schema={schema} onSave={onSave} />
  }
  if (type === 'checkbox') {
    return <CheckboxProp value={value} onSave={onSave} />
  }
  if (type === 'url' || type === 'email' || type === 'phone_number') {
    return <UrlProp value={value} kind={type} onSave={onSave} />
  }
  if (type === 'select') {
    return <SelectProp options={schema.select?.options ?? []} value={value?.select} onSave={n => onSave({ select: n ? { name: n } : null })} />
  }
  if (type === 'status') {
    return <SelectProp options={schema.status?.options ?? []} value={value?.status} onSave={n => onSave({ status: n ? { name: n } : null })} />
  }
  if (type === 'multi_select') {
    return <MultiSelectProp options={schema.multi_select?.options ?? []} value={value?.multi_select ?? []} onSave={names => onSave({ multi_select: names.map(n => ({ name: n })) })} />
  }
  if (type === 'date') {
    return <DateProp value={value?.date} onSave={d => onSave({ date: d })} />
  }
  return <p className="text-xs text-white/40 italic py-2">Editing {type} is not supported here.</p>
}

// ── Per-type editors ─────────────────────────────────────────────────────────

function TextProp({ value, type, onSave }: { value: any; type: string; onSave: (p: any) => void }) {
  const initial = (value?.[type] ?? []).map((t: any) => t.plain_text).join('')
  const [text, setText] = useState(initial)
  function commit() {
    if (text === initial) return
    onSave({ [type]: richTextWrite(text) })
  }
  return (
    <textarea value={text} onChange={e => setText(e.target.value)} onBlur={commit}
      className="w-full bg-white/[0.05] text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-white/20 resize-none"
      rows={Math.min(4, Math.max(1, text.split('\n').length))} />
  )
}

function NumberProp({ value, schema, onSave }: { value: any; schema: any; onSave: (p: any) => void }) {
  const initial = value?.number ?? ''
  const [n, setN] = useState<string>(initial.toString())
  const fmt = schema.number?.format
  function commit() {
    const v = n.trim() === '' ? null : Number(n)
    if (v === initial) return
    onSave({ number: Number.isFinite(v as number) ? v : null })
  }
  return (
    <div className="flex items-center gap-2">
      <input inputMode="decimal" value={n} onChange={e => setN(e.target.value)} onBlur={commit}
        className="flex-1 bg-white/[0.05] text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-white/20" />
      {fmt && fmt !== 'number' && <span className="text-xs text-white/35">{fmt}</span>}
    </div>
  )
}

function CheckboxProp({ value, onSave }: { value: any; onSave: (p: any) => void }) {
  const checked = !!value?.checkbox
  return (
    <button type="button" onClick={() => onSave({ checkbox: !checked })}
      className={`w-12 h-7 rounded-full relative transition-colors ${checked ? 'bg-green-500/40' : 'bg-white/10'}`}>
      <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function UrlProp({ value, kind, onSave }: { value: any; kind: string; onSave: (p: any) => void }) {
  const initial = value?.[kind] ?? ''
  const [v, setV] = useState(initial)
  function commit() {
    if (v === initial) return
    onSave({ [kind]: v.trim() || null })
  }
  return (
    <input type={kind === 'email' ? 'email' : kind === 'phone_number' ? 'tel' : 'url'}
      value={v} onChange={e => setV(e.target.value)} onBlur={commit}
      className="w-full bg-white/[0.05] text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-white/20" />
  )
}

function SelectProp({
  options, value, onSave,
}: {
  options: { id: string; name: string; color: string }[]
  value:   { id: string; name: string; color: string } | null | undefined
  onSave:  (name: string | null) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => onSave(null)}
        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all
          ${!value ? 'bg-white/20 text-white' : 'bg-white/[0.04] text-white/35 active:bg-white/10'}`}>None</button>
      {options.map(o => {
        const active = value?.name === o.name
        return (
          <button key={o.id} onClick={() => onSave(o.name)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border transition-all"
            style={{
              background:   active ? colorBg(o.color, 0.25) : 'rgba(255,255,255,0.04)',
              color:        active ? colorFg(o.color)        : 'rgba(255,255,255,0.4)',
              borderColor:  active ? colorBg(o.color, 0.5)   : 'transparent',
            }}>
            {o.name}
          </button>
        )
      })}
    </div>
  )
}

function MultiSelectProp({
  options, value, onSave,
}: {
  options: { id: string; name: string; color: string }[]
  value:   { id?: string; name: string; color?: string }[]
  onSave:  (names: string[]) => void
}) {
  const selected = new Set(value.map(v => v.name))
  function toggle(name: string) {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onSave(Array.from(next))
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const active = selected.has(o.name)
        return (
          <button key={o.id} onClick={() => toggle(o.name)}
            className="px-3 py-1.5 rounded-full text-xs font-medium border transition-all"
            style={{
              background:   active ? colorBg(o.color, 0.25) : 'rgba(255,255,255,0.04)',
              color:        active ? colorFg(o.color)        : 'rgba(255,255,255,0.4)',
              borderColor:  active ? colorBg(o.color, 0.5)   : 'transparent',
            }}>
            {o.name}
          </button>
        )
      })}
    </div>
  )
}

function DateProp({ value, onSave }: { value: any; onSave: (d: any) => void }) {
  const [showCal, setShowCal] = useState(false)
  const start = value?.start ?? ''
  const label = start
    ? new Date(start + (start.length === 10 ? 'T12:00' : '')).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : 'No date'
  return (
    <>
      <div className="flex gap-2">
        <button type="button" onClick={() => setShowCal(s => !s)}
          className="flex-1 flex items-center gap-2 bg-white/[0.05] rounded-lg px-3 py-2 text-sm active:bg-white/10">
          <span>📅</span><span className={start ? 'text-white' : 'text-white/30'}>{label}</span>
          <span className="ml-auto text-white/20 text-xs">{showCal ? '▲' : '▼'}</span>
        </button>
        {start && (
          <button type="button" onClick={() => onSave(null)} className="text-xs text-red-400/60 px-2 active:text-red-400">Clear</button>
        )}
      </div>
      {showCal && (
        <MiniCalendar value={start.slice(0, 10)} onChange={d => { onSave({ start: d }); setShowCal(false) }} />
      )}
    </>
  )
}
