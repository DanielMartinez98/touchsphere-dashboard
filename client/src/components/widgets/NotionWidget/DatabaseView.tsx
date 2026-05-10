import { useState, useEffect, useCallback, useMemo } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { DatabaseSchema } from './notion-types'
import { PropertyValue } from './PropertyEditor'
import { colorBg, colorFg } from './notion-colors'
import { richTextWrite } from './notion-types'
import { TouchInput } from '../../TouchInput'

type ViewMode = 'list' | 'board' | 'calendar' | 'gallery'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRowTitle(row: any, schema: DatabaseSchema): string {
  const titleKey = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title')
  if (!titleKey) return 'Untitled'
  const t = (row.properties[titleKey]?.title ?? []) as any[]
  return t.map(x => x.plain_text).join('') || 'Untitled'
}

// Find first property of given type — used to auto-detect groupings.
function findKeyOfType(schema: DatabaseSchema, types: string[]): string | null {
  return Object.keys(schema.properties).find(k => types.includes(schema.properties[k].type)) ?? null
}

// ── Quick add row ────────────────────────────────────────────────────────────

function QuickAddRow({
  schema, dbId, client, onCreated,
}: {
  schema:    DatabaseSchema
  dbId:      string
  client:    NotionClient
  onCreated: () => void
}) {
  const titleKey = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    if (!title.trim() || !titleKey) return
    setBusy(true)
    try {
      await client.createPage({
        parent: { database_id: dbId },
        properties: { [titleKey]: { title: richTextWrite(title.trim()) } },
      })
      setTitle('')
      onCreated()
    } finally { setBusy(false) }
  }

  return (
    <div className="flex gap-2 px-1">
      <TouchInput value={title} onChange={setTitle} commitOn="change"
        placeholder="+ New row…"
        ariaLabel="New row title"
        className="flex-1 bg-white/[0.04] text-white text-sm rounded-lg px-3 py-2 outline-none focus:bg-white/[0.08] placeholder-white/25" />
      <button type="button" onClick={create} disabled={!title.trim() || busy}
        className="px-4 rounded-lg bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">
        Add
      </button>
    </div>
  )
}

// ── Row tile (shared between list + gallery) ─────────────────────────────────

function Row({
  row, schema, displayProps, onTap,
}: {
  row:          any
  schema:       DatabaseSchema
  displayProps: string[]   // property keys to summarise inline
  onTap:        () => void
}) {
  const title = getRowTitle(row, schema)
  return (
    <button type="button" onClick={onTap}
      className="w-full text-left bg-white/[0.04] active:bg-white/[0.09] rounded-xl p-3 border border-white/[0.06] active:scale-[0.99] transition-all">
      <div className="flex items-center gap-2 mb-1.5">
        {row.icon?.type === 'emoji' && <span className="flex-shrink-0">{row.icon.emoji}</span>}
        <p className="text-sm font-medium text-white truncate flex-1">{title}</p>
      </div>
      {displayProps.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {displayProps.map(k => {
            const val = row.properties[k]
            if (!val) return null
            const sch = schema.properties[k]
            if (!sch) return null
            return <span key={k} className="inline-flex items-center"><PropertyValue schema={sch} value={val} /></span>
          })}
        </div>
      )}
    </button>
  )
}

// ── List view (with optional bulk-select) ────────────────────────────────────

function ListView({
  rows, schema, client, displayProps, selectMode, selected, onToggleSelect,
}: {
  rows:           any[]
  schema:         DatabaseSchema
  client:         NotionClient
  displayProps:   string[]
  selectMode:     boolean
  selected:       Set<string>
  onToggleSelect: (id: string) => void
}) {
  if (rows.length === 0) return <p className="text-sm text-white/30 italic px-1 py-6 text-center">No rows.</p>
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => {
        const isSel = selected.has(r.id)
        if (selectMode) {
          return (
            <button key={r.id} type="button" onClick={() => onToggleSelect(r.id)}
              className={`w-full text-left rounded-xl p-3 border flex items-start gap-3
                ${isSel ? 'bg-blue-500/15 border-blue-500/40' : 'bg-white/[0.04] border-white/[0.06] active:bg-white/[0.08]'}`}>
              <span className={`flex-shrink-0 w-6 h-6 mt-0.5 rounded-md border-2 flex items-center justify-center text-xs
                ${isSel ? 'bg-blue-500/40 border-blue-500/60 text-white' : 'border-white/30'}`}>
                {isSel && '✓'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{getRowTitle(r, schema)}</p>
              </div>
            </button>
          )
        }
        return (
          <Row key={r.id} row={r} schema={schema} displayProps={displayProps}
               onTap={() => client.navigate({ kind: 'page', id: r.id })} />
        )
      })}
    </div>
  )
}

// ── Board view (kanban grouped by status/select) ─────────────────────────────

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

  // Render columns horizontally; each column scrolls vertically.
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
            <span className="text-[10px] text-white/30 tabular-nums">{col.rows.length}</span>
          </div>
          <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
            {col.rows.map(r => (
              <button key={r.id} onClick={() => client.navigate({ kind: 'page', id: r.id })}
                className="text-left rounded-lg p-2.5 border active:scale-[0.99]"
                style={{ background: colorBg(col.color, 0.08), borderColor: colorBg(col.color, 0.25) }}>
                <p className="text-sm text-white truncate">{getRowTitle(r, schema)}</p>
              </button>
            ))}
            {col.rows.length === 0 && <p className="text-[11px] text-white/20 italic px-1">empty</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Calendar view (rows grouped by date prop into a month grid) ──────────────

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

  // Bucket rows by date string YYYY-MM-DD
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
        <button type="button" onClick={prev} className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">‹</button>
        <span className="text-sm font-semibold text-white">{mName} {py}</span>
        <button type="button" onClick={next} className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">›</button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {['S','M','T','W','T','F','S'].map((d, i) => <span key={i} className="text-[10px] text-white/25 text-center">{d}</span>)}
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
              <div className={`text-[10px] mb-0.5 ${isT ? 'text-white' : 'text-white/35'}`}>{day}</div>
              <div className="flex flex-col gap-0.5">
                {rs.slice(0, 3).map(r => (
                  <button key={r.id} onClick={() => client.navigate({ kind: 'page', id: r.id })}
                    className="text-left text-[10px] truncate text-white/85 bg-blue-500/30 rounded px-1 active:bg-blue-500/50">
                    {getRowTitle(r, schema).slice(0, 16)}
                  </button>
                ))}
                {rs.length > 3 && <span className="text-[9px] text-white/40">+{rs.length - 3}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Gallery view (large tiles) ───────────────────────────────────────────────

function GalleryView({
  rows, schema, client,
}: {
  rows:   any[]
  schema: DatabaseSchema
  client: NotionClient
}) {
  if (rows.length === 0) return <p className="text-sm text-white/30 italic py-6 text-center">No rows.</p>
  return (
    <div className="grid grid-cols-2 gap-2">
      {rows.map(r => {
        const cover = r.cover?.file?.url ?? r.cover?.external?.url
        return (
          <button key={r.id} onClick={() => client.navigate({ kind: 'page', id: r.id })}
            className="text-left bg-white/[0.04] rounded-xl overflow-hidden border border-white/[0.06] active:scale-[0.98]">
            <div className="h-20 bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
              {cover ? <img src={cover} alt="" className="w-full h-full object-cover" />
                     : <span className="text-2xl">{r.icon?.emoji ?? '📄'}</span>}
            </div>
            <p className="px-2.5 py-2 text-xs text-white truncate">{getRowTitle(r, schema)}</p>
          </button>
        )
      })}
    </div>
  )
}

// ── Top-level DatabaseView ───────────────────────────────────────────────────

interface SortConfig {
  property?:  string
  timestamp?: 'last_edited_time' | 'created_time'
  direction:  'ascending' | 'descending'
}
interface FilterConfig {
  property: string
  type:     'select' | 'status'
  value:    string | null
}

export default function DatabaseView({ dbId, client }: { dbId: string; client: NotionClient }) {
  const [schema,  setSchema]  = useState<DatabaseSchema | null>(null)
  const [rows,    setRows]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [view,    setView]    = useState<ViewMode>('list')
  const [reload,  setReload]  = useState(0)
  const [selectMode, setSelectMode] = useState(false)
  const [selected,   setSelected]   = useState<Set<string>>(new Set())
  const [showFilterBar, setShowFilterBar] = useState(false)
  const [showAddProp,   setShowAddProp]   = useState(false)
  const [sort,    setSort]    = useState<SortConfig>({ timestamp: 'last_edited_time', direction: 'descending' })
  const [filter,  setFilter]  = useState<FilterConfig | null>(null)

  // Discovery: detect a status/select prop (board) and a date prop (calendar).
  const groupKey = useMemo(() => schema ? findKeyOfType(schema, ['status', 'select']) : null, [schema])
  const dateKey  = useMemo(() => schema ? findKeyOfType(schema, ['date']) : null, [schema])

  // Build the auto-summary props for list/gallery: status + priority + date,
  // skipping ones that don't exist.
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
      // Build the query body from current sort/filter state. Notion accepts
      // either a `property` or `timestamp` key on a sort entry, never both.
      const body: any = { sorts: [sort] }
      if (filter && filter.value) {
        body.filter = filter.type === 'status'
          ? { property: filter.property, status: { equals: filter.value } }
          : { property: filter.property, select: { equals: filter.value } }
      }
      const [s, q] = await Promise.all([
        client.getDatabase(dbId, true),
        client.queryDatabase(dbId, body),
      ])
      setSchema(s)
      setRows(q.results)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load database')
    } finally { setLoading(false) }
  }, [dbId, client, sort, filter])

  useEffect(() => { void load() }, [load, reload])

  if (loading) {
    return <div className="flex items-center justify-center py-12"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error || !schema) {
    return <p className="text-sm text-red-400 px-4 py-6">{error ?? 'Database not found'}</p>
  }

  const VIEW_TABS: { id: ViewMode; label: string; icon: string; enabled: boolean }[] = [
    { id: 'list',     label: 'List',     icon: '☰', enabled: true },
    { id: 'board',    label: 'Board',    icon: '⊞', enabled: !!groupKey },
    { id: 'calendar', label: 'Calendar', icon: '📅', enabled: !!dateKey  },
    { id: 'gallery',  label: 'Gallery',  icon: '▦', enabled: true },
  ]

  // Properties candidates for filter (select/status only — those are the
  // simplest filter shapes Notion accepts) and for sort (any property).
  const filterCandidates = Object.entries(schema.properties)
    .filter(([, p]) => p.type === 'select' || p.type === 'status')
  const sortCandidates = Object.entries(schema.properties)
    .filter(([, p]) => ['number','date','title','rich_text','select','status','created_time','last_edited_time'].includes(p.type))

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
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

  return (
    <div className="flex flex-col gap-3 px-1">
      <div className="flex items-center gap-2">
        {schema.icon?.type === 'emoji' && <span className="text-2xl">{schema.icon.value}</span>}
        <h2 className="text-xl font-bold text-white truncate flex-1">{schema.title}</h2>
        <button type="button" onClick={() => setShowFilterBar(o => !o)}
          aria-label="Filter and sort"
          className={`w-9 h-9 rounded-full text-base flex items-center justify-center active:scale-90 ${showFilterBar || filter ? 'bg-green-500/30 text-green-300' : 'bg-white/10 text-white/50'}`}>⚙</button>
        <button type="button" onClick={() => setReload(r => r + 1)}
          aria-label="Refresh"
          className="w-9 h-9 rounded-full bg-white/10 text-white/50 text-xl flex items-center justify-center active:scale-90">↺</button>
      </div>
      {schema.description && <p className="text-xs text-white/45">{schema.description}</p>}

      {showFilterBar && (
        <div className="flex flex-col gap-2 bg-white/[0.025] rounded-xl p-3 border border-white/[0.05]">
          {/* Sort builder */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-white/35 uppercase tracking-wider">Sort by</span>
            <div className="flex flex-wrap gap-1.5">
              <button type="button"
                onClick={() => setSort({ timestamp: 'last_edited_time', direction: sort.direction })}
                className={`px-2.5 py-1 rounded-full text-[11px] ${sort.timestamp === 'last_edited_time' ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                Last edited
              </button>
              <button type="button"
                onClick={() => setSort({ timestamp: 'created_time', direction: sort.direction })}
                className={`px-2.5 py-1 rounded-full text-[11px] ${sort.timestamp === 'created_time' ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                Created
              </button>
              {sortCandidates.map(([name, p]) => (
                <button key={name} type="button"
                  onClick={() => setSort({ property: name, direction: sort.direction })}
                  className={`px-2.5 py-1 rounded-full text-[11px] ${sort.property === name ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                  {name} <span className="opacity-50">·{p.type}</span>
                </button>
              ))}
            </div>
            <button type="button"
              onClick={() => setSort(s => ({ ...s, direction: s.direction === 'ascending' ? 'descending' : 'ascending' }))}
              className="self-start px-2.5 py-1 rounded-full text-[11px] bg-white/[0.06] text-white/50 active:bg-white/10">
              {sort.direction === 'descending' ? '↓ Descending' : '↑ Ascending'}
            </button>
          </div>

          {/* Filter builder */}
          {filterCandidates.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] text-white/35 uppercase tracking-wider">Filter</span>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => setFilter(null)}
                  className={`px-2.5 py-1 rounded-full text-[11px] ${!filter ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                  No filter
                </button>
                {filterCandidates.map(([name, p]) => (
                  <button key={name} type="button"
                    onClick={() => setFilter({ property: name, type: p.type, value: null })}
                    className={`px-2.5 py-1 rounded-full text-[11px] ${filter?.property === name ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/50 active:bg-white/10'}`}>
                    {name}
                  </button>
                ))}
              </div>
              {filter && (
                <div className="flex flex-wrap gap-1.5">
                  {((filter.type === 'status'
                    ? schema.properties[filter.property]?.status?.options
                    : schema.properties[filter.property]?.select?.options) ?? []).map((o: any) => (
                    <button key={o.id} type="button"
                      onClick={() => setFilter({ ...filter, value: filter.value === o.name ? null : o.name })}
                      className="px-2.5 py-1 rounded-full text-[11px] border"
                      style={{
                        background:   filter.value === o.name ? colorBg(o.color, 0.3) : 'rgba(255,255,255,0.04)',
                        color:        filter.value === o.name ? colorFg(o.color)       : 'rgba(255,255,255,0.4)',
                        borderColor:  filter.value === o.name ? colorBg(o.color, 0.6)  : 'transparent',
                      }}>
                      = {o.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-1.5 bg-white/[0.04] rounded-lg p-1">
        {VIEW_TABS.filter(t => t.enabled).map(t => (
          <button key={t.id} type="button" onClick={() => setView(t.id)}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors
              ${view === t.id ? 'bg-white/15 text-white' : 'text-white/45 active:bg-white/[0.07]'}`}>
            <span className="mr-1">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* Bulk-select toggle (list view only) */}
      {view === 'list' && (
        <div className="flex gap-2">
          <button type="button"
            onClick={() => { setSelectMode(s => !s); setSelected(new Set()) }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${selectMode ? 'bg-blue-500/30 text-blue-300' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
            {selectMode ? `${selected.size} selected` : '☑ Select'}
          </button>
          {selectMode && selected.size > 0 && (
            <button type="button" onClick={bulkArchive}
              className="px-3 py-1.5 rounded-full text-xs font-bold bg-red-500 text-white active:bg-red-600">
              Archive {selected.size}
            </button>
          )}
          <button type="button" onClick={() => setShowAddProp(true)}
            className="ml-auto px-3 py-1.5 rounded-full text-xs font-medium bg-white/[0.06] text-white/55 active:bg-white/10">
            + Property
          </button>
        </div>
      )}

      {!selectMode && <QuickAddRow schema={schema} dbId={dbId} client={client} onCreated={() => setReload(r => r + 1)} />}

      {/* Active view */}
      {view === 'list'    && <ListView rows={rows} schema={schema} client={client} displayProps={displayProps}
                                       selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect} />}
      {view === 'board'   && groupKey && <BoardView rows={rows} schema={schema} client={client} groupKey={groupKey} />}
      {view === 'calendar' && dateKey  && <CalendarView rows={rows} schema={schema} client={client} dateKey={dateKey} />}
      {view === 'gallery' && <GalleryView rows={rows} schema={schema} client={client} />}

      <p className="text-[10px] text-white/25 text-center pt-2">{rows.length} row{rows.length === 1 ? '' : 's'}</p>

      {showAddProp && (
        <AddPropertySheet
          dbId={dbId}
          client={client}
          onClose={() => setShowAddProp(false)}
          onAdded={() => { setShowAddProp(false); setReload(r => r + 1) }}
        />
      )}
    </div>
  )
}

// ── Add Property bottom sheet ────────────────────────────────────────────────

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
              <span className="text-[11px] text-white/35 uppercase tracking-wider">Name</span>
              <TouchInput value={name} onChange={setName} commitOn="change"
                placeholder="Property name…"
                ariaLabel="Property name"
                className="bg-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-400" />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] text-white/35 uppercase tracking-wider">Type</span>
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
