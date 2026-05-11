import { useState } from 'react'
import type { DatabaseSchema } from './notion-types'
import { colorBg, colorFg } from './notion-colors'
import { TouchInput } from '../../TouchInput'
import MiniCalendar from './MiniCalendar'

// Flat conjunction/disjunction filter model. Each condition targets one
// property; the top-level `combinator` AND/OR joins all of them. This covers
// the overwhelming common case on touch — nested groups are reachable by
// adding extra conditions or toggling combinator. (A future iteration can
// promote this to a true tree.)

export interface FilterCondition {
  // Stable per-row id so React keys and the remove() helper work.
  id:        string
  property:  string
  type:      string          // select / status / date / number / rich_text / title / checkbox / multi_select / url / email / phone_number
  operator:  string
  // The value shape depends on operator: string for equals/contains, number,
  // boolean, ISO date — all kept loose here.
  value:     any
}

export interface FilterModel {
  combinator: 'and' | 'or'
  conditions: FilterCondition[]
}

export const EMPTY_FILTER: FilterModel = { combinator: 'and', conditions: [] }

// ── Per-type operator catalog ────────────────────────────────────────────────
// Each entry maps a Notion property type to the operators we expose plus the
// Notion API filter key for that operator. Some operators take no value
// (`is_empty`); the UI hides the value input in that case.

interface OperatorDef { id: string; label: string; api: string; valueless?: boolean }

const OPS: Record<string, OperatorDef[]> = {
  select:       [{ id: 'equals', label: 'is',       api: 'equals' },
                 { id: 'does_not_equal', label: 'is not', api: 'does_not_equal' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  status:       [{ id: 'equals', label: 'is',       api: 'equals' },
                 { id: 'does_not_equal', label: 'is not', api: 'does_not_equal' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  multi_select: [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'does_not_contain', label: 'does not contain', api: 'does_not_contain' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  date:         [{ id: 'equals', label: 'is',       api: 'equals' },
                 { id: 'before', label: 'is before', api: 'before' },
                 { id: 'after',  label: 'is after',  api: 'after' },
                 { id: 'past_week',  label: 'past week',  api: 'past_week',  valueless: true },
                 { id: 'next_week',  label: 'next week',  api: 'next_week',  valueless: true },
                 { id: 'is_empty',   label: 'is empty',   api: 'is_empty',   valueless: true }],
  number:       [{ id: 'equals', label: '=',  api: 'equals' },
                 { id: 'does_not_equal', label: '≠', api: 'does_not_equal' },
                 { id: 'greater_than', label: '>', api: 'greater_than' },
                 { id: 'less_than',    label: '<', api: 'less_than' },
                 { id: 'greater_than_or_equal_to', label: '≥', api: 'greater_than_or_equal_to' },
                 { id: 'less_than_or_equal_to',    label: '≤', api: 'less_than_or_equal_to' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  rich_text:    [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'does_not_contain', label: 'does not contain', api: 'does_not_contain' },
                 { id: 'equals',   label: 'is',       api: 'equals' },
                 { id: 'starts_with', label: 'starts with', api: 'starts_with' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  title:        [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'equals',   label: 'is',       api: 'equals' },
                 { id: 'starts_with', label: 'starts with', api: 'starts_with' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  url:          [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  email:        [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  phone_number: [{ id: 'contains', label: 'contains', api: 'contains' },
                 { id: 'is_empty', label: 'is empty', api: 'is_empty', valueless: true }],
  checkbox:     [{ id: 'equals_true',  label: 'is checked',   api: 'equals',  valueless: true },
                 { id: 'equals_false', label: 'is unchecked', api: 'equals',  valueless: true }],
}

function opsFor(type: string): OperatorDef[] { return OPS[type] ?? OPS['rich_text']! }

// ── Notion filter conversion ─────────────────────────────────────────────────
// Build the `filter` body Notion's POST /databases/:id/query expects. Returns
// undefined when the model is empty so callers can omit the field entirely.

export function toNotionFilter(model: FilterModel): any | undefined {
  const leaves = model.conditions
    .map(c => conditionToLeaf(c))
    .filter((x): x is any => x != null)
  if (leaves.length === 0) return undefined
  if (leaves.length === 1) return leaves[0]
  return { [model.combinator]: leaves }
}

function conditionToLeaf(c: FilterCondition): any | null {
  const op = opsFor(c.type).find(o => o.id === c.operator)
  if (!op) return null
  // Operator + value shape per type.
  if (c.type === 'checkbox') {
    return { property: c.property, checkbox: { equals: c.operator === 'equals_true' } }
  }
  if (op.valueless) {
    if (c.type === 'date' && (op.id === 'past_week' || op.id === 'next_week')) {
      return { property: c.property, date: { [op.api]: {} } }
    }
    return { property: c.property, [c.type]: { [op.api]: true } }
  }
  // Operator with value
  if (c.type === 'number') {
    const n = Number(c.value)
    if (!Number.isFinite(n)) return null
    return { property: c.property, number: { [op.api]: n } }
  }
  if (c.type === 'date') {
    if (!c.value) return null
    return { property: c.property, date: { [op.api]: c.value } }
  }
  // select / status / multi_select / rich_text / title / url / email / phone
  if (!c.value) return null
  return { property: c.property, [c.type]: { [op.api]: c.value } }
}

// Generate a tiny unique id for each condition. Doesn't need to be globally
// unique; we just need stable React keys.
let nextId = 1
export function newCondition(property: string, type: string, value: any = null): FilterCondition {
  return { id: `c${nextId++}`, property, type, operator: opsFor(type)[0]!.id, value }
}

// ── UI ───────────────────────────────────────────────────────────────────────

export default function FilterTree({
  schema, model, onChange,
}: {
  schema:   DatabaseSchema
  model:    FilterModel
  onChange: (next: FilterModel) => void
}) {
  // Properties usable in filters — everything except formula/rollup (which
  // Notion does support but with idiosyncratic shapes we'd need to model).
  const filterable = Object.entries(schema.properties)
    .filter(([, p]) => Object.keys(OPS).includes(p.type))
    .map(([name, p]) => ({ name, type: p.type as string }))

  function setCondition(idx: number, patch: Partial<FilterCondition>) {
    const next = [...model.conditions]
    next[idx] = { ...next[idx]!, ...patch }
    onChange({ ...model, conditions: next })
  }
  function removeCondition(idx: number) {
    onChange({ ...model, conditions: model.conditions.filter((_, i) => i !== idx) })
  }
  function addCondition() {
    if (filterable.length === 0) return
    const first = filterable[0]!
    onChange({ ...model, conditions: [...model.conditions, newCondition(first.name, first.type)] })
  }

  if (filterable.length === 0) {
    return <p className="text-xs text-white/40 italic px-1">No filterable properties.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {model.conditions.length > 1 && (
        <div className="flex gap-1 self-start">
          <button type="button" onClick={() => onChange({ ...model, combinator: 'and' })}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${model.combinator === 'and' ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.06] text-white/45 active:bg-white/10'}`}>AND</button>
          <button type="button" onClick={() => onChange({ ...model, combinator: 'or' })}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${model.combinator === 'or'  ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.06] text-white/45 active:bg-white/10'}`}>OR</button>
        </div>
      )}

      {model.conditions.map((c, i) => (
        <ConditionRow key={c.id}
          condition={c}
          properties={filterable}
          schema={schema}
          onChange={p => setCondition(i, p)}
          onRemove={() => removeCondition(i)} />
      ))}

      <button type="button" onClick={addCondition}
        className="self-start px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/[0.06] text-white/55 active:bg-white/10">
        + Add condition
      </button>
    </div>
  )
}

function ConditionRow({
  condition, properties, schema, onChange, onRemove,
}: {
  condition:  FilterCondition
  properties: { name: string; type: string }[]
  schema:     DatabaseSchema
  onChange:   (patch: Partial<FilterCondition>) => void
  onRemove:   () => void
}) {
  const [propPick, setPropPick] = useState(false)
  const [opPick,   setOpPick]   = useState(false)
  const [showCal,  setShowCal]  = useState(false)
  const ops = opsFor(condition.type)
  const op  = ops.find(o => o.id === condition.operator) ?? ops[0]!

  // Property selector — when the property changes, also reset operator to the
  // first one valid for that new type and clear the value.
  function pickProperty(name: string, type: string) {
    onChange({
      property: name,
      type,
      operator: opsFor(type)[0]!.id,
      value: null,
    })
    setPropPick(false)
  }

  // Value renderer per type. Uses inline pickers and TouchInput consistently
  // with the rest of the widget.
  let valueUi: React.ReactNode = null
  if (op.valueless) {
    valueUi = <span className="text-[11px] text-white/30 italic">no value</span>
  } else if (condition.type === 'select' || condition.type === 'status' || condition.type === 'multi_select') {
    const propSchema = schema.properties[condition.property]
    const opts: { id: string; name: string; color: string }[] =
      condition.type === 'status'       ? (propSchema?.status?.options ?? []) :
      condition.type === 'multi_select' ? (propSchema?.multi_select?.options ?? []) :
                                          (propSchema?.select?.options ?? [])
    valueUi = (
      <div className="flex flex-wrap gap-1">
        {opts.map(o => (
          <button key={o.id} type="button"
            onClick={() => onChange({ value: o.name })}
            className="px-2 py-0.5 rounded-full text-[11px] border"
            style={{
              background:  condition.value === o.name ? colorBg(o.color, 0.3) : 'rgba(255,255,255,0.04)',
              color:       condition.value === o.name ? colorFg(o.color)       : 'rgba(255,255,255,0.45)',
              borderColor: condition.value === o.name ? colorBg(o.color, 0.6)  : 'transparent',
            }}>
            {o.name}
          </button>
        ))}
      </div>
    )
  } else if (condition.type === 'date') {
    valueUi = (
      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={() => setShowCal(v => !v)}
          className="self-start px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/65 active:bg-white/10">
          📅 {condition.value || 'pick a date'}
        </button>
        {showCal && <MiniCalendar value={condition.value ?? ''} onChange={v => { onChange({ value: v }); setShowCal(false) }} />}
      </div>
    )
  } else if (condition.type === 'number') {
    valueUi = (
      <TouchInput value={String(condition.value ?? '')} onChange={v => onChange({ value: v })} commitOn="change"
        placeholder="number"
        ariaLabel="Filter value"
        className="bg-white/[0.06] text-white text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-white/20 w-28" />
    )
  } else {
    valueUi = (
      <TouchInput value={String(condition.value ?? '')} onChange={v => onChange({ value: v })} commitOn="change"
        placeholder="value…"
        ariaLabel="Filter value"
        className="bg-white/[0.06] text-white text-xs rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-white/20 flex-1 min-w-[8rem]" />
    )
  }

  return (
    <div className="flex flex-col gap-1.5 bg-white/[0.02] border border-white/[0.05] rounded-xl p-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" onClick={() => setPropPick(o => !o)}
          className="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/75 active:bg-white/10">
          {condition.property}
        </button>
        <button type="button" onClick={() => setOpPick(o => !o)}
          className="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/55 active:bg-white/10">
          {op.label}
        </button>
        <button type="button" onClick={onRemove}
          aria-label="Remove condition"
          className="ml-auto w-6 h-6 rounded-full bg-red-500/20 text-red-300 text-xs active:bg-red-500/40">×</button>
      </div>

      {propPick && (
        <div className="flex flex-wrap gap-1 bg-white/[0.025] rounded-lg p-2">
          {properties.map(p => (
            <button key={p.name} type="button" onClick={() => pickProperty(p.name, p.type)}
              className={`px-2.5 py-1 rounded-full text-[11px] ${condition.property === p.name ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
              {p.name} <span className="opacity-50">·{p.type}</span>
            </button>
          ))}
        </div>
      )}
      {opPick && (
        <div className="flex flex-wrap gap-1 bg-white/[0.025] rounded-lg p-2">
          {ops.map(o => (
            <button key={o.id} type="button" onClick={() => { onChange({ operator: o.id }); setOpPick(false) }}
              className={`px-2.5 py-1 rounded-full text-[11px] ${condition.operator === o.id ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      <div className="px-1">{valueUi}</div>
    </div>
  )
}
