import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { SlidersHorizontal, MoreHorizontal, RotateCw, ChevronLeft, ChevronRight, CheckSquare, X, FileText, List, Columns3, CalendarDays, ChartGantt, LayoutGrid } from 'lucide-react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { DatabaseSchema } from './notion-types'
import { PropertyValue } from './PropertyEditor'
import { colorBg, colorFg } from './notion-colors'
import { richTextWrite, rawIconUrl } from './notion-types'
import { TouchInput } from '../../TouchInput'
import FilterTree, { type FilterModel, EMPTY_FILTER, toNotionFilter } from './FilterTree'
import MultiSort,  { type SortKey,     EMPTY_SORT,   toNotionSorts  } from './MultiSort'
import { useDatabaseViews, type ViewMode } from '../../../hooks/useDatabaseViews'
import DatabaseSettingsSheet from './DatabaseSettingsSheet'
import RowContextSheet from './RowContextSheet'
import InlineChipEditor from './InlineChipEditor'
import TimelineView from './TimelineView'
import MineFilterChip from './MineFilterChip'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRowTitle(row: any, schema: DatabaseSchema): string {
  const titleKey = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title')
  if (!titleKey) return 'Untitled'
  const t = (row.properties[titleKey]?.title ?? []) as any[]
  return t.map(x => x.plain_text).join('') || 'Untitled'
}

function findKeyOfType(schema: DatabaseSchema, types: string[]): string | null {
  return Object.keys(schema.properties).find(k => types.includes(schema.properties[k].type)) ?? null
}

// Press-and-hold detector — fires `onLong` after 500ms unless the touch is
// lifted, moved beyond 10px, or cancelled.
function useLongPress(onLong: () => void): {
  start: (x: number, y: number) => void
  move:  (x: number, y: number) => void
  end:   () => void
  cancel:() => void
} {
  const timer = useRef<number | null>(null)
  const fired = useRef(false)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  return {
    start(x, y) {
      fired.current = false
      startPos.current = { x, y }
      timer.current = window.setTimeout(() => { fired.current = true; onLong() }, 500)
    },
    move(x, y) {
      if (!startPos.current || timer.current === null) return
      const dx = x - startPos.current.x, dy = y - startPos.current.y
      if (dx * dx + dy * dy > 100) { window.clearTimeout(timer.current); timer.current = null }
    },
    end()    { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null } },
    cancel() { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }; fired.current = false },
  }
}

// ── Quick-add row with default property chips ────────────────────────────────

function QuickAddRow({
  schema, dbId, client, onCreated,
}: {
  schema:    DatabaseSchema
  dbId:      string
  client:    NotionClient
  onCreated: () => void
}) {
  const titleKey = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title')
  const [title,  setTitle]  = useState('')
  const [busy,   setBusy]   = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Find a status/select prop to surface as a default chip. Picking it on the
  // quick-add is the most common need — anything more sets via the page view.
  const statusKey = useMemo(() => findKeyOfType(schema, ['status', 'select']), [schema])
  const statusProp = statusKey ? schema.properties[statusKey] : null
  const statusOpts = statusProp?.type === 'status' ? (statusProp.status?.options ?? []) : (statusProp?.select?.options ?? [])

  async function create() {
    if (!title.trim() || !titleKey) return
    setBusy(true)
    try {
      const properties: any = { [titleKey]: { title: richTextWrite(title.trim()) } }
      if (statusKey && status) {
        properties[statusKey] = statusProp.type === 'status' ? { status: { name: status } } : { select: { name: status } }
      }
      await client.createPage({ parent: { database_id: dbId }, properties })
      setTitle('')
      setStatus(null)
      onCreated()
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex gap-2">
        <TouchInput value={title} onChange={setTitle} commitOn="change"
          placeholder="+ New row…"
          ariaLabel="New row title"
          className="flex-1 bg-white/[0.04] text-white text-sm rounded-lg px-3 py-2 outline-none focus:bg-white/[0.08] placeholder-white/25" />
        <button type="button" onClick={create} disabled={!title.trim() || busy}
          className="px-4 rounded-lg bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">
          Add
        </button>
      </div>
      {statusKey && statusOpts.length > 0 && (
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {statusOpts.map((o: any) => (
            <button key={o.id} type="button" onClick={() => setStatus(s => s === o.name ? null : o.name)}
              className="flex-shrink-0 px-2.5 py-0.5 rounded-full text-xs border"
              style={{
                background:  status === o.name ? colorBg(o.color, 0.3) : 'rgba(255,255,255,0.04)',
                color:       status === o.name ? colorFg(o.color)       : 'rgba(255,255,255,0.45)',
                borderColor: status === o.name ? colorBg(o.color, 0.6)  : 'transparent',
              }}>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Row tile — chips become tap-targets for inline editing where applicable ──

function Row({
  row, schema, displayProps, onTap, onLongPress, onEditChip,
}: {
  row:          any
  schema:       DatabaseSchema
  displayProps: string[]
  onTap:        () => void
  onLongPress:  () => void
  onEditChip:   (propKey: string) => void
}) {
  const title = getRowTitle(row, schema)
  const press = useLongPress(onLongPress)

  return (
    <button type="button"
      onTouchStart={e => press.start(e.touches[0]!.clientX, e.touches[0]!.clientY)}
      onTouchMove={e  => press.move (e.touches[0]!.clientX, e.touches[0]!.clientY)}
      onTouchEnd={() => { press.end();   if (!(press as any).fired) onTap() }}
      onTouchCancel={press.cancel}
      onMouseDown={e => press.start(e.clientX, e.clientY)}
      onMouseMove={e => press.move (e.clientX, e.clientY)}
      onMouseUp={()  => { press.end();   /* desktop falls through to onClick */ }}
      onClick={onTap}
      className="w-full text-left bg-white/[0.04] active:bg-white/[0.09] rounded-xl p-3 border border-white/[0.06] active:scale-[0.99] transition-all">
      <div className="flex items-center gap-2 mb-1.5">
        {row.icon?.type === 'emoji'
          ? <span className="flex-shrink-0">{row.icon.emoji}</span>
          : rawIconUrl(row.icon) && <img src={rawIconUrl(row.icon)!} alt="" className="w-4 h-4 rounded flex-shrink-0" />}
        <p className="text-[15px] font-medium text-white truncate flex-1">{title}</p>
      </div>
      {displayProps.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[13px]">
          {displayProps.map(k => {
            const val = row.properties[k]
            if (!val) return null
            const sch = schema.properties[k]
            if (!sch) return null
            const editable = sch.type === 'select' || sch.type === 'status' || sch.type === 'multi_select'
            return (
              <span key={k}
                onClick={editable ? e => { e.stopPropagation(); onEditChip(k) } : undefined}
                className={editable ? 'inline-flex items-center cursor-pointer' : 'inline-flex items-center'}>
                <PropertyValue schema={sch} value={val} />
              </span>
            )
          })}
        </div>
      )}
    </button>
  )
}

// ── List view (with optional bulk-select + grouping) ─────────────────────────

function ListView({
  rows, schema, displayProps,
  selectMode, selected, onToggleSelect,
  onRowTap, onRowLong, onEditChip, groupBy,
}: {
  rows:           any[]
  schema:         DatabaseSchema
  displayProps:   string[]
  selectMode:     boolean
  selected:       Set<string>
  onToggleSelect: (id: string) => void
  onRowTap:       (id: string) => void
  onRowLong:      (id: string) => void
  onEditChip:     (rowId: string, propKey: string) => void
  groupBy:        string | null
}) {
  if (rows.length === 0) return <p className="text-base text-white/45 italic px-1 py-6 text-center">No rows.</p>

  const renderRow = (r: any) => {
    if (selectMode) {
      const isSel = selected.has(r.id)
      return (
        <button key={r.id} type="button" onClick={() => onToggleSelect(r.id)}
          className={`w-full text-left rounded-xl p-3 border flex items-start gap-3
            ${isSel ? 'bg-blue-500/15 border-blue-500/40' : 'bg-white/[0.04] border-white/[0.06] active:bg-white/[0.08]'}`}>
          <span className={`flex-shrink-0 w-6 h-6 mt-0.5 rounded-md border-2 flex items-center justify-center text-xs
            ${isSel ? 'bg-blue-500/40 border-blue-500/60 text-white' : 'border-white/30'}`}>
            {isSel && '✓'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-medium text-white truncate">{getRowTitle(r, schema)}</p>
          </div>
        </button>
      )
    }
    return (
      <Row key={r.id} row={r} schema={schema} displayProps={displayProps}
        onTap={() => onRowTap(r.id)}
        onLongPress={() => onRowLong(r.id)}
        onEditChip={k => onEditChip(r.id, k)} />
    )
  }

  // No grouping — flat list.
  if (!groupBy) return <div className="flex flex-col gap-2">{rows.map(renderRow)}</div>

  // Group by a status/select/multi_select prop. For multi_select rows that
  // belong to several groups, render under each of their values.
  const propSchema = schema.properties[groupBy]
  if (!propSchema) return <div className="flex flex-col gap-2">{rows.map(renderRow)}</div>

  const buckets = new Map<string, { color: string; rows: any[] }>()
  const ungrouped: any[] = []

  function bucket(name: string, color: string, r: any) {
    if (!buckets.has(name)) buckets.set(name, { color, rows: [] })
    buckets.get(name)!.rows.push(r)
  }

  for (const r of rows) {
    const val = r.properties[groupBy]
    if (propSchema.type === 'status' && val?.status) {
      bucket(val.status.name, val.status.color ?? 'gray', r)
    } else if (propSchema.type === 'select' && val?.select) {
      bucket(val.select.name, val.select.color ?? 'gray', r)
    } else if (propSchema.type === 'multi_select') {
      const items = val?.multi_select ?? []
      if (items.length === 0) ungrouped.push(r)
      for (const m of items) bucket(m.name, m.color ?? 'gray', r)
    } else {
      ungrouped.push(r)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {Array.from(buckets.entries()).map(([name, { color, rows: rs }]) => (
        <details key={name} open className="flex flex-col gap-1">
          <summary className="flex items-center gap-2 cursor-pointer list-none px-1 py-1">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: colorFg(color) }}>{name}</span>
            <span className="text-xs text-white/30 tabular-nums">{rs.length}</span>
          </summary>
          <div className="flex flex-col gap-2 mt-1">{rs.map(renderRow)}</div>
        </details>
      ))}
      {ungrouped.length > 0 && (
        <details className="flex flex-col gap-1">
          <summary className="flex items-center gap-2 cursor-pointer list-none px-1 py-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/35">No {groupBy}</span>
            <span className="text-xs text-white/25 tabular-nums">{ungrouped.length}</span>
          </summary>
          <div className="flex flex-col gap-2 mt-1">{ungrouped.map(renderRow)}</div>
        </details>
      )}
    </div>
  )
}

// ── Board view (unchanged from previous) ─────────────────────────────────────

function BoardView({
  rows, schema, client, groupKey,
}: {
  rows:     any[]
  schema:   DatabaseSchema
  client:   NotionClient
  groupKey: string
}) {
  const propSchema = schema.properties[groupKey]
  const options: { id: string; name: string; color: string }[] = propSchema?.type === 'status'
    ? (propSchema.status?.options ?? [])
    : (propSchema?.select?.options ?? [])
  const groupedRows: Record<string, any[]> = { '__none__': [] }
  for (const o of options) groupedRows[o.name] = []
  for (const r of rows) {
    const v = r.properties[groupKey]
    const name = propSchema.type === 'status' ? v?.status?.name : v?.select?.name
    const list = (name && groupedRows[name]) || groupedRows['__none__']!
    list.push(r)
  }

  const columns: { key: string; label: string; color: string; rows: any[] }[] = []
  for (const o of options) {
    columns.push({ key: o.name, label: o.name, color: o.color, rows: groupedRows[o.name] ?? [] })
  }
  if (groupedRows['__none__']!.length > 0) {
    columns.push({ key: '__none__', label: 'No ' + groupKey, color: 'gray', rows: groupedRows['__none__']! })
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-3 scrollbar-hide -mx-1 px-1">
      {columns.map(col => (
        <div key={col.key} className="flex-shrink-0 w-56 flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: colorFg(col.color) }}>{col.label}</span>
            <span className="text-xs text-white/30 tabular-nums">{col.rows.length}</span>
          </div>
          <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
            {col.rows.map(r => (
              <button key={r.id} type="button" onClick={() => client.navigate({ kind: 'page', id: r.id })}
                className="text-left rounded-lg p-2.5 border active:scale-[0.99]"
                style={{ background: colorBg(col.color, 0.08), borderColor: colorBg(col.color, 0.25) }}>
                <p className="text-sm text-white truncate">{getRowTitle(r, schema)}</p>
              </button>
            ))}
            {col.rows.length === 0 && <p className="text-[13px] text-white/20 italic px-1">empty</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Calendar view (unchanged) ────────────────────────────────────────────────

function CalendarView({
  rows, schema, client, dateKey,
}: {
  rows:    any[]
  schema:  DatabaseSchema
  client:  NotionClient
  dateKey: string
}) {
  const today = new Date()
  const [py, setPy] = useState(today.getFullYear())
  const [pm, setPm] = useState(today.getMonth())

  const byDay: Record<string, any[]> = {}
  for (const r of rows) {
    const start = r.properties[dateKey]?.date?.start
    if (!start) continue
    const day = start.slice(0, 10)
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(r)
  }

  const days  = new Date(py, pm + 1, 0).getDate()
  const first = new Date(py, pm, 1).getDay()
  const mName = new Date(py, pm).toLocaleString('default', { month: 'long' })

  function prev() { pm === 0 ? (setPm(11), setPy(y => y - 1)) : setPm(m => m - 1) }
  function next() { pm === 11 ? (setPm(0), setPy(y => y + 1)) : setPm(m => m + 1) }

  return (
    <div className="bg-white/[0.03] rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prev} aria-label="Previous month" className="w-11 h-11 rounded-full bg-glass-2 text-white flex items-center justify-center active:scale-90"><ChevronLeft size={20} /></button>
        <span className="text-sm font-semibold text-white">{mName} {py}</span>
        <button type="button" onClick={next} aria-label="Next month" className="w-11 h-11 rounded-full bg-glass-2 text-white flex items-center justify-center active:scale-90"><ChevronRight size={20} /></button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {['S','M','T','W','T','F','S'].map((d, i) => <span key={i} className="text-xs text-white/25 text-center">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: first }).map((_, i) => <div key={i} />)}
        {Array.from({ length: days }).map((_, i) => {
          const day = i + 1
          const key  = `${py}-${String(pm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const rs   = byDay[key] ?? []
          const isT  = day === today.getDate() && pm === today.getMonth() && py === today.getFullYear()
          return (
            <div key={day} className={`min-h-[60px] rounded-md p-1 ${isT ? 'bg-white/10' : 'bg-white/[0.03]'}`}>
              <div className={`text-xs mb-0.5 ${isT ? 'text-white' : 'text-white/35'}`}>{day}</div>
              <div className="flex flex-col gap-0.5">
                {rs.slice(0, 3).map(r => (
                  <button key={r.id} type="button" onClick={() => client.navigate({ kind: 'page', id: r.id })}
                    className="text-left text-xs truncate text-white/85 bg-blue-500/30 rounded px-1 active:bg-blue-500/50">
                    {getRowTitle(r, schema).slice(0, 16)}
                  </button>
                ))}
                {rs.length > 3 && <span className="text-[11px] text-white/40">+{rs.length - 3}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Gallery view (unchanged) ─────────────────────────────────────────────────

function GalleryView({
  rows, schema, client,
}: {
  rows:   any[]
  schema: DatabaseSchema
  client: NotionClient
}) {
  if (rows.length === 0) return <p className="text-base text-white/45 italic py-6 text-center">No rows.</p>
  return (
    <div className="grid grid-cols-2 gap-2">
      {rows.map(r => {
        const cover = r.cover?.file?.url ?? r.cover?.external?.url
        return (
          <button key={r.id} type="button" onClick={() => client.navigate({ kind: 'page', id: r.id })}
            className="text-left bg-white/[0.04] rounded-xl overflow-hidden border border-white/[0.06] active:scale-[0.98]">
            <div className="h-20 bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
              {cover ? <img src={cover} alt="" className="w-full h-full object-cover" />
                     : rawIconUrl(r.icon) ? <img src={rawIconUrl(r.icon)!} alt="" className="w-8 h-8 rounded" />
                     : r.icon?.emoji ? <span className="text-2xl">{r.icon.emoji}</span>
                     : <FileText size={24} className="text-white/40" />}
            </div>
            <p className="px-2.5 py-2 text-xs text-white truncate">{getRowTitle(r, schema)}</p>
          </button>
        )
      })}
    </div>
  )
}

// ── Top-level DatabaseView ───────────────────────────────────────────────────

export default function DatabaseView({ dbId, client, onTitle }: { dbId: string; client: NotionClient; onTitle?: (t: string) => void }) {
  const [schema,  setSchema]  = useState<DatabaseSchema | null>(null)
  const [rows,    setRows]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [view,    setView]    = useState<ViewMode>('list')
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [reload,  setReload]  = useState(0)

  const [selectMode, setSelectMode]     = useState(false)
  const [selected,   setSelected]       = useState<Set<string>>(new Set())
  const [showViewSheet, setShowViewSheet] = useState(false)
  const [showAddProp,   setShowAddProp]   = useState(false)
  const [showSettings,  setShowSettings]  = useState(false)
  // Inline name form for saving the current view (a browser prompt() would be
  // unusable on the touch kiosk).
  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')

  const [sorts,   setSorts]   = useState<SortKey[]>(EMPTY_SORT)
  const [filter,  setFilter]  = useState<FilterModel>(EMPTY_FILTER)

  // Tap-to-edit chip state and long-press row context state.
  const [editingChip, setEditingChip] = useState<{ rowId: string; propKey: string } | null>(null)
  const [contextRow,  setContextRow]  = useState<any | null>(null)

  const savedViews = useDatabaseViews(dbId)

  // Auto-detect props for board grouping + calendar/timeline dates. Group-by
  // for list view starts unset until the user picks something.
  const groupKey = useMemo(() => schema ? findKeyOfType(schema, ['status', 'select']) : null, [schema])
  const dateKey  = useMemo(() => schema ? findKeyOfType(schema, ['date']) : null, [schema])
  // Assignee property for the "Only mine" shortcut — prefer an assignee/owner-
  // named people property, else the first people property in the schema.
  const peopleKey = useMemo(() => {
    if (!schema) return null
    const ppl = Object.keys(schema.properties).filter(k => schema.properties[k].type === 'people')
    if (ppl.length === 0) return null
    return ppl.find(k => /assign|owner|person/i.test(k)) ?? ppl[0]!
  }, [schema])

  const displayProps = useMemo(() => {
    if (!schema) return []
    const out: string[] = []
    if (groupKey) out.push(groupKey)
    const priorityKey = Object.keys(schema.properties).find(k => /priority|importance/i.test(k) && schema.properties[k].type === 'select')
    if (priorityKey && priorityKey !== groupKey) out.push(priorityKey)
    if (dateKey)  out.push(dateKey)
    return out.slice(0, 3)
  }, [schema, groupKey, dateKey])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body: any = { sorts: toNotionSorts(sorts) }
      const f = toNotionFilter(filter)
      if (f) body.filter = f
      const [s, q] = await Promise.all([
        client.getDatabase(dbId, true),
        client.queryDatabase(dbId, body),
      ])
      setSchema(s)
      setRows(q.results)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load database')
    } finally { setLoading(false) }
  }, [dbId, client, sorts, filter])

  useEffect(() => { void load() }, [load, reload])

  // Surface the real title in the widget's fixed header.
  useEffect(() => {
    if (schema) onTitle?.(schema.title || 'Untitled')
  }, [schema?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="flex items-center justify-center py-12"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error || !schema) {
    return <p className="text-sm text-red-400 px-4 py-6">{error ?? 'Database not found'}</p>
  }

  const VIEW_TABS: { id: ViewMode; label: string; icon: React.ReactElement; enabled: boolean }[] = [
    { id: 'list',     label: 'List',     icon: <List size={15} />,         enabled: true },
    { id: 'board',    label: 'Board',    icon: <Columns3 size={15} />,     enabled: !!groupKey },
    { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={15} />, enabled: !!dateKey  },
    { id: 'timeline', label: 'Timeline', icon: <ChartGantt size={15} />,   enabled: !!dateKey  },
    { id: 'gallery',  label: 'Gallery',  icon: <LayoutGrid size={15} />,   enabled: true },
  ]

  // Properties usable as a grouping key in list view — same set the board view
  // already accepts.
  const groupCandidates = Object.entries(schema.properties)
    .filter(([, p]) => p.type === 'status' || p.type === 'select' || p.type === 'multi_select')

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function bulkArchive() {
    const ids = Array.from(selected)
    setSelected(new Set())
    setSelectMode(false)
    await Promise.all(ids.map(id => client.archivePage(id)))
    setReload(r => r + 1)
  }

  // Apply an inline chip edit immediately and refresh the row in local state.
  async function applyChipEdit(rowId: string, propKey: string, next: string | string[] | null) {
    const propSchema = schema!.properties[propKey]
    let body: any
    if (propSchema.type === 'multi_select') {
      const arr = (next as string[] | null) ?? []
      body = { [propKey]: { multi_select: arr.map(n => ({ name: n })) } }
    } else if (propSchema.type === 'status') {
      body = { [propKey]: { status: next ? { name: next as string } : null } }
    } else {
      body = { [propKey]: { select: next ? { name: next as string } : null } }
    }
    // Optimistic update.
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, properties: { ...r.properties, ...body } } : r))
    try { await client.updatePage(rowId, { properties: body }) }
    catch { setReload(r => r + 1) }
  }

  function saveCurrentView() {
    const name = viewName.trim()
    if (!name) return
    savedViews.createView({ name, view, filter, sorts, groupBy })
    setViewName('')
    setSaveOpen(false)
  }
  function applySavedView(id: string) {
    const v = savedViews.views.find(x => x.id === id)
    if (!v) return
    setView(v.view); setFilter(v.filter); setSorts(v.sorts); setGroupBy(v.groupBy)
    setShowViewSheet(false)
  }

  // Dot on the View button when anything diverges from the default view.
  const viewCustomized = filter.conditions.length > 0 || sorts.length > 0 || groupBy !== null

  return (
    <div className="flex flex-col gap-3 px-1">
      {/* Header */}
      <div className="flex items-center gap-2">
        {schema.icon?.type === 'emoji'
          ? <span className="text-2xl">{schema.icon.value}</span>
          : schema.icon?.type === 'url' && <img src={schema.icon.value} alt="" className="w-7 h-7 rounded" />}
        <h2 className="text-xl font-bold font-display text-white truncate flex-1">{schema.title}</h2>
        <button type="button" onClick={() => setShowViewSheet(true)}
          aria-label="View options"
          className={`h-11 px-4 rounded-full flex items-center justify-center gap-1.5 text-sm font-medium active:scale-95 ${viewCustomized ? 'bg-green-500/30 text-green-300' : 'bg-glass-2 text-white/60'}`}>
          <SlidersHorizontal size={16} /> View
        </button>
        <button type="button" onClick={() => setShowSettings(true)}
          aria-label="Database settings"
          className="w-11 h-11 rounded-full bg-glass-2 text-white/60 flex items-center justify-center active:scale-90"><MoreHorizontal size={18} /></button>
        <button type="button" onClick={() => setReload(r => r + 1)}
          aria-label="Refresh"
          className="w-11 h-11 rounded-full bg-glass-2 text-white/60 flex items-center justify-center active:scale-90"><RotateCw size={18} /></button>
      </div>
      {schema.description && <p className="text-sm text-white/50">{schema.description}</p>}

      {/* Assigned-to-me shortcut — only when the database has a people property */}
      {peopleKey && (
        <MineFilterChip peopleKey={peopleKey} filter={filter} onChange={setFilter} />
      )}

      {/* View tabs */}
      <div className="flex gap-1.5 bg-white/[0.04] rounded-lg p-1">
        {VIEW_TABS.filter(t => t.enabled).map(t => (
          <button key={t.id} type="button" onClick={() => setView(t.id)}
            className={`flex-1 py-2.5 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-1.5
              ${view === t.id ? 'bg-white/15 text-white' : 'text-white/50 active:bg-white/[0.07]'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Bulk-select toggle (list view only) */}
      {view === 'list' && (
        <div className="flex gap-2">
          <button type="button"
            onClick={() => { setSelectMode(s => !s); setSelected(new Set()) }}
            className={`px-4 py-2 rounded-full text-sm font-medium flex items-center gap-1.5 ${selectMode ? 'bg-blue-500/30 text-blue-300' : 'bg-white/[0.06] text-white/60 active:bg-white/10'}`}>
            {selectMode ? `${selected.size} selected` : <><CheckSquare size={15} /> Select</>}
          </button>
          {selectMode && selected.size > 0 && (
            <button type="button" onClick={bulkArchive}
              className="px-4 py-2 rounded-full text-sm font-bold bg-red-500 text-white active:bg-red-600">
              Archive {selected.size}
            </button>
          )}
          <button type="button" onClick={() => setShowAddProp(true)}
            className="ml-auto px-4 py-2 rounded-full text-sm font-medium bg-white/[0.06] text-white/60 active:bg-white/10">
            + Property
          </button>
        </div>
      )}

      {!selectMode && <QuickAddRow schema={schema} dbId={dbId} client={client} onCreated={() => setReload(r => r + 1)} />}

      {/* Active view */}
      {view === 'list' && (
        <ListView rows={rows} schema={schema} displayProps={displayProps}
          selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect}
          onRowTap={id => client.navigate({ kind: 'page', id })}
          onRowLong={id => setContextRow(rows.find(r => r.id === id))}
          onEditChip={(rowId, propKey) => setEditingChip({ rowId, propKey })}
          groupBy={groupBy} />
      )}
      {view === 'board'    && groupKey && <BoardView rows={rows} schema={schema} client={client} groupKey={groupKey} />}
      {view === 'calendar' && dateKey  && <CalendarView rows={rows} schema={schema} client={client} dateKey={dateKey} />}
      {view === 'timeline' && dateKey  && <TimelineView rows={rows} schema={schema} client={client} dateKey={dateKey} />}
      {view === 'gallery'  && <GalleryView rows={rows} schema={schema} client={client} />}

      <p className="text-xs text-white/25 text-center pt-2">{rows.length} row{rows.length === 1 ? '' : 's'}</p>

      {/* View options sheet — saved views, filter, sort, group-by in one place */}
      {showViewSheet && (
        <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={() => setShowViewSheet(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[88vh] overflow-y-auto notion-sheet"
               onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-3 pb-8 flex flex-col gap-5">
              <div className="w-10 h-1 rounded-full bg-white/15 mx-auto" />
              <h3 className="text-base font-bold text-white">View options</h3>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-white/45 uppercase tracking-wider">Saved views</span>
                {savedViews.views.length === 0 && !saveOpen && (
                  <p className="text-[13px] text-white/40 italic">No saved views yet — set up filters below, then save them.</p>
                )}
                {savedViews.views.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap">
                    {savedViews.views.map(v => (
                      <div key={v.id} className="flex items-center gap-0.5">
                        <button type="button" onClick={() => applySavedView(v.id)}
                          className="px-3 py-2 rounded-l-full text-[13px] bg-white/[0.06] text-white/75 active:bg-white/10">
                          {v.name}
                        </button>
                        <button type="button" onClick={() => savedViews.deleteView(v.id)}
                          aria-label={`Delete view ${v.name}`}
                          className="w-9 h-9 rounded-r-full bg-red-500/20 text-red-300 flex items-center justify-center active:bg-red-500/40"><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {saveOpen ? (
                  <div className="flex gap-2">
                    <TouchInput value={viewName} onChange={setViewName} commitOn="change"
                      placeholder="View name…" ariaLabel="View name"
                      className="flex-1 bg-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-400" />
                    <button type="button" onClick={saveCurrentView} disabled={!viewName.trim()}
                      className="px-4 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Save</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setSaveOpen(true)}
                    className="self-start px-4 py-2 rounded-full text-[13px] font-medium bg-green-500/20 text-green-200 active:bg-green-500/35">
                    + Save current view
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-white/45 uppercase tracking-wider">Filter</span>
                <FilterTree schema={schema} model={filter} onChange={setFilter} />
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-white/45 uppercase tracking-wider">Sort</span>
                <MultiSort schema={schema} sorts={sorts} onChange={setSorts} />
              </div>

              {view === 'list' && groupCandidates.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-white/45 uppercase tracking-wider">Group by</span>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => setGroupBy(null)}
                      className={`px-3 py-2 rounded-full text-[13px] ${groupBy === null ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>None</button>
                    {groupCandidates.map(([name, p]) => (
                      <button key={name} type="button" onClick={() => setGroupBy(name)}
                        className={`px-3 py-2 rounded-full text-[13px] ${groupBy === name ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
                        {name} <span className="opacity-50">·{p.type}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button type="button" onClick={() => setShowViewSheet(false)}
                className="h-12 rounded-xl bg-green-500 text-black text-sm font-bold active:bg-green-400">Done</button>
            </div>
          </div>
        </div>
      )}

      {showAddProp && (
        <AddPropertySheet
          dbId={dbId}
          client={client}
          onClose={() => setShowAddProp(false)}
          onAdded={() => { setShowAddProp(false); setReload(r => r + 1) }}
        />
      )}
      {showSettings && (
        <DatabaseSettingsSheet schema={schema} client={client}
          onClose={() => setShowSettings(false)}
          onChanged={() => setReload(r => r + 1)} />
      )}
      {contextRow && (
        <RowContextSheet rowId={contextRow.id}
          rowTitle={getRowTitle(contextRow, schema)}
          rowUrl={contextRow.url}
          client={client}
          onClose={() => setContextRow(null)}
          onChanged={() => setReload(r => r + 1)} />
      )}
      {editingChip && (() => {
        const propSchema = schema.properties[editingChip.propKey]
        if (!propSchema) { setEditingChip(null); return null }
        const row = rows.find(r => r.id === editingChip.rowId)
        const val = row?.properties[editingChip.propKey]
        const current: string | string[] | null =
          propSchema.type === 'multi_select' ? (val?.multi_select ?? []).map((x: any) => x.name) :
          propSchema.type === 'status'       ? (val?.status?.name ?? null) :
                                               (val?.select?.name ?? null)
        const options =
          propSchema.type === 'status'       ? (propSchema.status?.options ?? []) :
          propSchema.type === 'multi_select' ? (propSchema.multi_select?.options ?? []) :
                                               (propSchema.select?.options ?? [])
        return (
          <InlineChipEditor
            propType={propSchema.type as 'select' | 'status' | 'multi_select'}
            options={options}
            current={current}
            onPick={next => void applyChipEdit(editingChip.rowId, editingChip.propKey, next)}
            onClose={() => setEditingChip(null)} />
        )
      })()}
    </div>
  )
}

// ── Add Property bottom sheet (unchanged) ────────────────────────────────────

function AddPropertySheet({
  dbId, client, onClose, onAdded,
}: {
  dbId:    string
  client:  NotionClient
  onClose: () => void
  onAdded: () => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<string>('rich_text')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)

  const TYPES: { id: string; label: string }[] = [
    { id: 'rich_text',    label: 'Text' },
    { id: 'number',       label: 'Number' },
    { id: 'select',       label: 'Select' },
    { id: 'multi_select', label: 'Multi-select' },
    { id: 'status',       label: 'Status' },
    { id: 'date',         label: 'Date' },
    { id: 'checkbox',     label: 'Checkbox' },
    { id: 'url',          label: 'URL' },
    { id: 'email',        label: 'Email' },
    { id: 'phone_number', label: 'Phone' },
  ]

  async function save() {
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await client.addProperty(dbId, name.trim(), type)
      onAdded()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to add property')
    } finally { setBusy(false) }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[85vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-8">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white mb-4">Add property</h3>

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-white/35 uppercase tracking-wider">Name</span>
              <TouchInput value={name} onChange={setName} commitOn="change"
                placeholder="Property name…"
                ariaLabel="Property name"
                className="bg-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-400" />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-white/35 uppercase tracking-wider">Type</span>
              <div className="flex flex-wrap gap-1.5">
                {TYPES.map(t => (
                  <button key={t.id} type="button" onClick={() => setType(t.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium ${type === t.id ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onClose}
                className="h-12 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
              <button type="button" onClick={save} disabled={!name.trim() || busy}
                className="h-12 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
