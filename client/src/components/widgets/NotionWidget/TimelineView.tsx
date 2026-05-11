import { useState } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { DatabaseSchema } from './notion-types'
import { colorBg, colorFg } from './notion-colors'

// Horizontal Gantt-style view over a 30-day window. Each row is one DB row;
// its bar spans the date property's start..end (or one day when end is null).
// Rows without any date in the visible window are skipped.

const DAY_PX  = 36   // width per day column
const DAY_MS  = 86_400_000

function rowTitle(row: any, schema: DatabaseSchema): string {
  const titleKey = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title')
  if (!titleKey) return 'Untitled'
  const t = (row.properties[titleKey]?.title ?? []) as any[]
  return t.map(x => x.plain_text).join('') || 'Untitled'
}

// Reusable status/select detector — colors the bar by the row's first such
// property so a Kanban-like view emerges horizontally.
function rowColor(row: any, schema: DatabaseSchema): string {
  for (const [k, p] of Object.entries(schema.properties)) {
    if ((p as any).type === 'status') return row.properties[k]?.status?.color ?? 'blue'
    if ((p as any).type === 'select') return row.properties[k]?.select?.color ?? 'blue'
  }
  return 'blue'
}

export default function TimelineView({
  rows, schema, client, dateKey,
}: {
  rows:    any[]
  schema:  DatabaseSchema
  client:  NotionClient
  dateKey: string
}) {
  // Window anchored on today, scrollable horizontally to past/future.
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [anchorMs, setAnchorMs] = useState(today.getTime() - 7 * DAY_MS)  // start 7 days back
  const days = 30

  const dates: Date[] = []
  for (let i = 0; i < days; i++) dates.push(new Date(anchorMs + i * DAY_MS))

  // Project each row into a span in the window. Skip if outside.
  const projected = rows.map(r => {
    const d = r.properties[dateKey]?.date
    if (!d?.start) return null
    const start = new Date(d.start).getTime()
    const end   = d.end ? new Date(d.end).getTime() : start
    if (end < anchorMs || start > anchorMs + days * DAY_MS) return null
    const left  = Math.max(0,   Math.floor((start - anchorMs) / DAY_MS))
    const right = Math.min(days, Math.ceil ((end   - anchorMs) / DAY_MS) + 1)
    return { row: r, left, width: Math.max(1, right - left) }
  }).filter((x): x is { row: any; left: number; width: number } => x !== null)

  return (
    <div className="flex flex-col gap-2 bg-white/[0.02] rounded-xl p-2 border border-white/[0.05]">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setAnchorMs(m => m - 7 * DAY_MS)}
          className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">‹</button>
        <span className="text-xs text-white/55 flex-1 text-center tabular-nums">
          {new Date(anchorMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          {' → '}
          {new Date(anchorMs + (days - 1) * DAY_MS).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </span>
        <button type="button" onClick={() => setAnchorMs(today.getTime() - 7 * DAY_MS)}
          className="px-2 py-1 rounded-full text-[10px] bg-white/[0.06] text-white/55 active:bg-white/10">Today</button>
        <button type="button" onClick={() => setAnchorMs(m => m + 7 * DAY_MS)}
          className="w-9 h-9 rounded-full bg-white/10 text-white text-xl flex items-center justify-center active:scale-90">›</button>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: days * DAY_PX }}>
          {/* Day header */}
          <div className="flex border-b border-white/[0.06] pb-1 mb-2">
            {dates.map((d, i) => {
              const isToday = d.getTime() === today.getTime()
              const isWeekend = d.getDay() === 0 || d.getDay() === 6
              return (
                <div key={i} className={`flex-shrink-0 text-center text-[10px] ${isToday ? 'text-green-400 font-bold' : isWeekend ? 'text-white/25' : 'text-white/40'}`}
                  style={{ width: DAY_PX }}>
                  <div>{d.toLocaleDateString([], { weekday: 'narrow' })}</div>
                  <div className="tabular-nums">{d.getDate()}</div>
                </div>
              )
            })}
          </div>

          {/* Row bars */}
          <div className="flex flex-col gap-1.5">
            {projected.length === 0 && (
              <p className="text-xs text-white/30 italic py-4 text-center">No rows in window.</p>
            )}
            {projected.map(({ row, left, width }) => {
              const color = rowColor(row, schema)
              return (
                <div key={row.id} className="relative h-8" style={{ width: days * DAY_PX }}>
                  <button type="button"
                    onClick={() => client.navigate({ kind: 'page', id: row.id })}
                    className="absolute h-full rounded-md px-2 flex items-center text-[11px] truncate active:scale-[0.98] border"
                    style={{
                      left:        left * DAY_PX,
                      width:       width * DAY_PX - 4,
                      background:  colorBg(color, 0.25),
                      borderColor: colorBg(color, 0.5),
                      color:       colorFg(color),
                    }}>
                    {rowTitle(row, schema)}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
