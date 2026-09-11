import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type {
  NotionTask, NotionSchema, TaskFields, ProjectRef, NotionBoard, NotionTeam, CalendarItem, NotionIdentity,
} from '../../../hooks/useNotion'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { colorBg, colorFg } from './notion-colors'
import TeamChips from './TeamChips'
import TaskSheet from './TaskSheet'
import { todayKey, isoInDays, fmtDay, dayKey, kindGlyph, GOOGLE_COLOR } from './task-utils'
import { buildEntries, groupByDay, useGoogleMonths, monthKeys, type AgendaEntry, type Layers } from './agenda'

// ── Calendar ─────────────────────────────────────────────────────────────────
// What is on the calendars: every dated thing in Notion — task due dates, the
// content calendars' film and publish dates, meetings, project timelines —
// and the Google calendar the Time corner shows, on one month grid or one
// rolling agenda. Layers switch each source off; "Only mine" keeps it to what
// is assigned to me; the team chips narrow to one team.

type Mode = 'month' | 'agenda'
const LS_MODE   = 'notion.agenda.mode'
const LS_LAYERS = 'notion.agenda.layers'
const LS_MINE   = 'notion.agenda.mine'

function loadJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } as T : fallback } catch { return fallback }
}
function saveJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* quota */ } }

interface Props {
  schema:    NotionSchema | null
  schemas:   Record<string, NotionSchema>
  boards:    NotionBoard[]
  teams:     NotionTeam[]
  tasks:     NotionTask[]
  items:     CalendarItem[]
  projects:  Record<string, ProjectRef>
  me:        NotionIdentity | null
  team:      string | null
  setTeam:   (id: string | null) => void
  initialDay: string | null
  client:    NotionClient
  onUpdate:  (id: string, fields: TaskFields) => void
  onArchive?: (id: string) => void
}

export default function AgendaView({
  schema, schemas, boards, teams, tasks, items, projects, me, team, setTeam, initialDay, client, onUpdate, onArchive,
}: Props) {
  const today = todayKey()
  const start = initialDay ?? today
  // Opened on a particular day (from My work's strip) it shows that day on the
  // month grid whatever mode was last used; the agenda has no notion of one day.
  const [mode,     setMode]     = useState<Mode>(() => (initialDay ? 'month' : localStorage.getItem(LS_MODE) === 'agenda' ? 'agenda' : 'month'))
  const [py,       setPy]       = useState(() => Number(start.slice(0, 4)))
  const [pm,       setPm]       = useState(() => Number(start.slice(5, 7)) - 1)
  const [selected, setSelected] = useState(start)
  const [layers,   setLayers]   = useState<Layers>(() => loadJson<Layers>(LS_LAYERS, { tasks: true, content: true, google: true }))
  const [onlyMine, setOnlyMine] = useState<boolean>(() => { const raw = localStorage.getItem(LS_MINE); return raw === null ? true : raw === '1' })
  const [editing,  setEditing]  = useState<string | null>(null)

  function pickMode(m: Mode) { setMode(m); try { localStorage.setItem(LS_MODE, m) } catch { /* quota */ } }
  function toggleLayer(k: keyof Layers) { setLayers(l => { const n = { ...l, [k]: !l[k] }; saveJson(LS_LAYERS, n); return n }) }
  function toggleMine() { setOnlyMine(v => { try { localStorage.setItem(LS_MINE, v ? '0' : '1') } catch { /* quota */ } return !v }) }

  // Google events for the months on screen: the visible month, or the next
  // thirty days' months for the agenda.
  const agendaEnd = isoInDays(30)
  const monthFirst = dayKey(new Date(py, pm, 1))
  const monthLast  = dayKey(new Date(py, pm + 1, 0))
  const keys = mode === 'month' ? monthKeys(monthFirst, monthLast) : monthKeys(today, agendaEnd)
  const { events: google, available: googleAvailable } = useGoogleMonths(keys)

  const entries = useMemo(() => buildEntries({ tasks, items, boards, teams, google, layers, onlyMine: onlyMine && !!me, team }),
    [tasks, items, boards, teams, google, layers, onlyMine, me, team])
  const byDay = useMemo(() => groupByDay(entries), [entries])

  const teamById = new Map(teams.map(t => [t.id, t]))
  const boardById = new Map(boards.map(b => [b.id, b]))
  const hasContent = boards.some(b => b.role === 'calendar')

  function prev() { if (pm === 0) { setPm(11); setPy(y => y - 1) } else setPm(m => m - 1) }
  function next() { if (pm === 11) { setPm(0); setPy(y => y + 1) } else setPm(m => m + 1) }
  function goToday() { setPy(Number(today.slice(0, 4))); setPm(Number(today.slice(5, 7)) - 1); setSelected(today) }

  function open(e: AgendaEntry) {
    if (e.task) setEditing(e.task.id)
    else if (e.item) client.navigate({ kind: 'page', id: e.item.id })
  }

  const entryRow = (e: AgendaEntry) => {
    const sch = e.boardId ? schemas[e.boardId] : null
    const statusOpt = sch && e.status ? sch.statusOptions.find(o => o.name === e.status) : null
    const tm = e.teamId ? teamById.get(e.teamId) : null
    return (
      <button key={e.key} type="button" onClick={() => open(e)}
        className={`w-full text-left flex items-start gap-3 rounded-2xl px-3.5 py-3 border transition-colors
          ${e.done ? 'bg-white/[0.02] border-white/[0.04] opacity-50' : 'bg-white/[0.05] border-white/[0.08] active:bg-white/[0.09]'}`}>
        <span className="w-1.5 self-stretch rounded-full shrink-0" style={{ background: e.color }} />
        <span className="text-lg leading-none mt-0.5 shrink-0">{kindGlyph(e.kind)}</span>
        <span className="flex-1 min-w-0">
          <span className={`block text-[15px] font-medium leading-snug ${e.done ? 'line-through text-white/40' : 'text-white'}`}>{e.title}</span>
          <span className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-sm text-white/45">
              {e.dateLabel}{e.endDay && e.endDay !== e.day ? ` → ${fmtDay(e.endDay)}` : ''}{e.time ? ` · ${e.time}` : ''}
            </span>
            {(tm || e.boardTitle) && (
              <span className="text-sm text-white/40 truncate max-w-[12rem]">· {tm ? `${tm.name} · ` : ''}{e.boardTitle}</span>
            )}
            {statusOpt && (
              <span className="text-sm font-medium px-2 py-0.5 rounded-full"
                style={{ color: colorFg(statusOpt.color), background: colorBg(statusOpt.color, 0.25) }}>
                {statusOpt.name}
              </span>
            )}
            {!e.mine && e.kind !== 'google' && <span className="text-sm text-white/35">· not mine</span>}
          </span>
        </span>
        {(e.task || e.item) && <ChevronRight size={16} className="text-white/20 mt-1 shrink-0" />}
      </button>
    )
  }

  // ── Month grid ──────────────────────────────────────────────────────────────
  const days  = new Date(py, pm + 1, 0).getDate()
  const first = new Date(py, pm, 1).getDay()
  const mName = new Date(py, pm).toLocaleString('default', { month: 'long' })
  const selectedEntries = byDay.get(selected) ?? []

  // ── Agenda list ─────────────────────────────────────────────────────────────
  const overdue = entries.filter(e => e.kind === 'due' && e.day < today && !e.done)
  const agendaDays: { day: string; entries: AgendaEntry[] }[] = []
  for (let i = 0; i <= 30; i++) { const day = isoInDays(i); const l = byDay.get(day); if (l && l.length) agendaDays.push({ day, entries: l }) }

  const teamCounts: Record<string, number> = { all: entries.filter(e => e.day >= today && !e.done).length }
  for (const tm of teams) teamCounts[tm.id] = entries.filter(e => e.teamId === tm.id && e.day >= today && !e.done).length

  return (
    <div className="flex flex-col gap-3 px-1">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold font-display text-white flex-1">Calendar</h2>
        <div className="flex gap-1 bg-white/[0.04] rounded-full p-1">
          {(['month', 'agenda'] as Mode[]).map(m => (
            <button key={m} type="button" onClick={() => pickMode(m)}
              className={`h-9 px-4 rounded-full text-sm font-medium ${mode === m ? 'bg-green-500/25 text-green-200' : 'text-white/50 active:bg-white/[0.07]'}`}>
              {m === 'month' ? 'Month' : 'Agenda'}
            </button>
          ))}
        </div>
      </div>

      <TeamChips teams={teams} value={team} onChange={setTeam} counts={teamCounts} />

      {/* Layers and "only mine". */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {me && (
          <button type="button" onClick={toggleMine}
            className={`flex-shrink-0 h-9 px-3.5 rounded-full text-sm font-medium ${onlyMine ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
            🙋 Only mine
          </button>
        )}
        {([['tasks', '⏰ Tasks due'], ['content', '🎬 Content'], ['google', '📅 Google']] as [keyof Layers, string][])
          .filter(([k]) => (k !== 'content' || hasContent) && (k !== 'google' || (googleAvailable && !team)))
          .map(([k, label]) => (
            <button key={k} type="button" onClick={() => toggleLayer(k)}
              className={`flex-shrink-0 h-9 px-3.5 rounded-full text-sm font-medium border
                ${layers[k] ? 'bg-white/[0.12] text-white border-white/15' : 'bg-white/[0.03] text-white/35 border-transparent line-through'}`}>
              {label}
            </button>
          ))}
      </div>

      {mode === 'month' ? (
        <>
          <div className="flex items-center gap-2">
            <button type="button" onClick={prev} aria-label="Previous month" className="w-11 h-11 rounded-full bg-glass-2 text-white flex items-center justify-center active:scale-90"><ChevronLeft size={20} /></button>
            <span className="text-base font-semibold text-white flex-1 text-center">{mName} {py}</span>
            <button type="button" onClick={goToday} className="h-9 px-3 rounded-full text-sm bg-white/[0.06] text-white/60 active:bg-white/10">Today</button>
            <button type="button" onClick={next} aria-label="Next month" className="w-11 h-11 rounded-full bg-glass-2 text-white flex items-center justify-center active:scale-90"><ChevronRight size={20} /></button>
          </div>
          <div className="grid grid-cols-7 mb-0.5">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="text-sm text-white/25 text-center">{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: first }).map((_, i) => <div key={`p${i}`} />)}
            {Array.from({ length: days }).map((_, i) => {
              const day = `${py}-${String(pm + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
              const l = byDay.get(day) ?? []
              const isT = day === today
              const isSel = day === selected
              const past = day < today
              return (
                <button key={day} type="button" onClick={() => setSelected(day)}
                  className={`min-h-[58px] rounded-xl p-1.5 flex flex-col items-center gap-1.5 border transition-colors active:bg-white/10
                    ${isSel ? 'bg-white/[0.14] border-white/25' : isT ? 'bg-white/[0.07] border-white/10' : 'bg-white/[0.03] border-transparent'}`}>
                  <span className={`text-sm leading-none tabular-nums ${isT ? 'text-green-300 font-bold' : past ? 'text-white/30' : 'text-white/70'}`}>{i + 1}</span>
                  <span className="flex items-center gap-0.5 flex-wrap justify-center h-2.5">
                    {l.slice(0, 4).map(e => <span key={e.key} className={`w-2 h-2 rounded-full ${e.done ? 'opacity-30' : ''}`} style={{ background: e.color }} />)}
                    {l.length > 4 && <span className="text-[10px] text-white/50 leading-none">+{l.length - 4}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex flex-col gap-2 pb-6">
            <div className="flex items-center gap-2 px-1 pt-1">
              <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/50">{fmtDay(selected)}</span>
              <span className="text-sm text-white/35 tabular-nums">{selectedEntries.length || ''}</span>
            </div>
            {selectedEntries.length === 0 && <p className="text-sm text-white/35 px-1 py-3">Nothing on this day.</p>}
            {selectedEntries.map(entryRow)}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 pb-6">
          {overdue.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1 pt-1">
                <span className="text-sm font-medium uppercase tracking-[0.14em] text-red-300">Overdue</span>
                <span className="text-sm text-white/35 tabular-nums">{overdue.length}</span>
              </div>
              {overdue.map(entryRow)}
            </div>
          )}
          {agendaDays.length === 0 && overdue.length === 0 && (
            <p className="text-sm text-white/35 px-1 py-6 text-center">Nothing scheduled in the next 30 days.</p>
          )}
          {agendaDays.map(({ day, entries: l }) => (
            <div key={day} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1 pt-2">
                <span className={`text-sm font-medium uppercase tracking-[0.14em] ${day === today ? 'text-green-300' : 'text-white/50'}`}>{fmtDay(day)}</span>
                <span className="text-sm text-white/35 tabular-nums">{l.length}</span>
              </div>
              {l.map(entryRow)}
            </div>
          ))}
        </div>
      )}

      <p className="text-[12px] text-white/25 px-1 flex items-center gap-2 flex-wrap">
        {teams.map(t => <span key={t.id} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: t.color }} />{t.name}</span>)}
        {googleAvailable && <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: GOOGLE_COLOR }} />Google</span>}
      </p>

      {editing && (() => {
        const task = tasks.find(t => t.id === editing)
        if (!task) return null
        const sch = schemas[task.dbId] ?? schema
        if (!sch) return null
        const b = boardById.get(task.dbId)
        const tm = b?.conn ? teamById.get(b.conn.id) : null
        return (
          <TaskSheet
            task={task}
            schema={sch}
            projects={projects}
            sourceTitle={b?.title ?? null}
            team={tm ? { name: tm.name, color: tm.color } : null}
            me={me}
            onUpdate={fields => onUpdate(task.id, fields)}
            onArchive={onArchive ? () => onArchive(task.id) : undefined}
            onOpenPage={() => { setEditing(null); client.navigate({ kind: 'page', id: task.id }) }}
            onClose={() => setEditing(null)}
          />
        )
      })()}
    </div>
  )
}
