import { useState, useEffect, useCallback, useMemo } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { DatabaseSchema } from './notion-types'
import { PropertyValue } from './PropertyEditor'
import { colorBg, colorFg } from './notion-colors'
import { richTextWrite } from './notion-types'

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
      <input value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void create() }}
        placeholder="+ New row…"
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

// ── List view ────────────────────────────────────────────────────────────────

function ListView({
  rows, schema, client, displayProps,
}: {
  rows:         any[]
  schema:       DatabaseSchema
  client:       NotionClient
  displayProps: string[]
}) {
  if (rows.length === 0) return <p className="text-sm text-white/30 italic px-1 py-6 text-center">No rows.</p>
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => (
        <Row key={r.id} row={r} schema={schema} displayProps={displayProps}
             onTap={() => client.navigate({ kind: 'page', id: r.id })} />
      ))}
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

export default function DatabaseView({ dbId, client }: { dbId: string; client: NotionClient }) {
  const [schema,  setSchema]  = useState<DatabaseSchema | null>(null)
  const [rows,    setRows]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [view,    setView]    = useState<ViewMode>('list')
  const [reload,  setReload]  = useState(0)

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
      const [s, q] = await Promise.all([
        client.getDatabase(dbId, true),
        client.queryDatabase(dbId, { sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }),
      ])
      setSchema(s)
      setRows(q.results)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load database')
    } finally { setLoading(false) }
  }, [dbId, client])

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

  return (
    <div className="flex flex-col gap-3 px-1">
      <div className="flex items-center gap-2">
        {schema.icon?.type === 'emoji' && <span className="text-2xl">{schema.icon.value}</span>}
        <h2 className="text-xl font-bold text-white truncate flex-1">{schema.title}</h2>
        <button type="button" onClick={() => setReload(r => r + 1)}
          className="w-9 h-9 rounded-full bg-white/10 text-white/50 text-xl flex items-center justify-center active:scale-90">↺</button>
      </div>
      {schema.description && <p className="text-xs text-white/45">{schema.description}</p>}

      {/* View tabs */}
      <div className="flex gap-1.5 bg-white/[0.04] rounded-lg p-1">
        {VIEW_TABS.filter(t => t.enabled).map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors
              ${view === t.id ? 'bg-white/15 text-white' : 'text-white/45 active:bg-white/[0.07]'}`}>
            <span className="mr-1">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      <QuickAddRow schema={schema} dbId={dbId} client={client} onCreated={() => setReload(r => r + 1)} />

      {/* Active view */}
      {view === 'list'    && <ListView rows={rows} schema={schema} client={client} displayProps={displayProps} />}
      {view === 'board'   && groupKey && <BoardView rows={rows} schema={schema} client={client} groupKey={groupKey} />}
      {view === 'calendar' && dateKey  && <CalendarView rows={rows} schema={schema} client={client} dateKey={dateKey} />}
      {view === 'gallery' && <GalleryView rows={rows} schema={schema} client={client} />}

      <p className="text-[10px] text-white/25 text-center pt-2">{rows.length} row{rows.length === 1 ? '' : 's'}</p>
    </div>
  )
}
