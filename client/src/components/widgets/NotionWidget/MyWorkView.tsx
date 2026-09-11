import { useState, useEffect, useMemo } from 'react'
import { RotateCw, Mic, Plus, Check, ChevronRight, ChevronDown, Folder, UserRound } from 'lucide-react'
import type {
  NotionTask, NotionSchema, TaskFields, ProjectRef, NotionBoard, NotionTeam, CalendarItem, NotionErrorKind, NotionIdentity,
} from '../../../hooks/useNotion'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { useVoiceCapture } from '../../../hooks/useVoiceCapture'
import TaskRow from './TaskRow'
import TaskSheet from './TaskSheet'
import CreateTaskSheet from './CreateTaskSheet'
import TeamChips from './TeamChips'
import IdentityPicker from './IdentityPicker'
import { byUrgency, bucketOf, BUCKET_ORDER, BUCKET_LABELS, isoInDays, todayKey, fmtDay, kindGlyph, type Bucket } from './task-utils'
import { buildEntries, groupByDay, useGoogleMonths, monthKeys, ALL_LAYERS } from './agenda'

// ── My work ──────────────────────────────────────────────────────────────────
// The answer to "what do I have to do next", across every team: my tasks,
// grouped overdue / today / next 7 days / later / no date, urgent first; a
// strip of the next seven days on the calendars; the team's unassigned pile
// one tap away. Team chips narrow everything; the focus strip narrows the
// list to one group.

type Scope = 'mine' | 'everyone' | 'unassigned'

interface Props {
  schema:    NotionSchema | null
  schemas:   Record<string, NotionSchema>
  boards:    NotionBoard[]
  teams:     NotionTeam[]
  tasks:     NotionTask[]
  items:     CalendarItem[]
  projects:  Record<string, ProjectRef>
  loading:   boolean
  error:     string | null
  errorKind: NotionErrorKind | null
  me:        NotionIdentity | null
  team:      string | null
  setTeam:   (id: string | null) => void
  // Where the view opens when it is reached from the Teams tab.
  initialProject?: string | null
  initialScope?:   Scope
  client:    NotionClient
  onUpdate:  (id: string, fields: TaskFields) => void
  onCreate:  (fields: { title: string; status?: string; priority?: string; due?: string; dbId?: string }) => void
  onArchive?: (id: string) => void
  onRefresh: () => void
  // The quiet refetch — no spinner — run when the panel opens, since the
  // list on the pill may be up to a minute old.
  onRefreshSilent?: () => void
  onOpenDay: (day: string) => void
}

export default function MyWorkView({
  schema, schemas, boards, teams, tasks, items, projects, loading, error, errorKind, me, team, setTeam,
  initialProject = null, initialScope = 'mine', client, onUpdate, onCreate, onArchive, onRefresh, onRefreshSilent, onOpenDay,
}: Props) {
  useEffect(() => {
    const t = setTimeout(() => { onRefreshSilent?.() }, 0)
    return () => clearTimeout(t)
  }, [onRefreshSilent])

  const [editing,       setEditing]       = useState<string | null>(null)
  const [creating,      setCreating]      = useState(false)
  const [pickingMe,     setPickingMe]     = useState(false)
  const [bucket,        setBucket]        = useState<Bucket | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(initialProject)
  const [scope,         setScope]         = useState<Scope>(initialScope)
  const [showDone,      setShowDone]      = useState(false)
  const [showProjects,  setShowProjects]  = useState(!!initialProject)
  const voice = useVoiceCapture()

  const boardById = useMemo(() => new Map(boards.map(b => [b.id, b])), [boards])
  const teamById  = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams])
  const teamOfBoard = (dbId: string) => { const b = boardById.get(dbId); return b?.conn ? teamById.get(b.conn.id) ?? null : null }

  // Everything below is inside the chosen team. Nobody picked means every row
  // is "mine" (the server cannot tell), so the scope control has no meaning
  // and is hidden.
  const inTeam   = tasks.filter(t => !team || teamOfBoard(t.dbId)?.id === team)
  const scoped   = inTeam.filter(t => scope === 'mine' ? t.mine : scope === 'unassigned' ? t.unassigned : true)
  const filtered = scoped
    .filter(t => bucket === null || t.done || bucketOf(t.due) === bucket)
    .filter(t => projectFilter === null ? true
              : projectFilter === '__none__' ? t.projectIds.length === 0
              : t.projectIds.includes(projectFilter))
  const pending = filtered.filter(t => !t.done).sort(byUrgency)
  const done    = filtered.filter(t =>  t.done).sort(byUrgency)

  // Group the open ones by when they are due, in the order a wall wants.
  const groups = BUCKET_ORDER.map(b => ({ bucket: b, tasks: pending.filter(t => bucketOf(t.due) === b) })).filter(g => g.tasks.length > 0)

  // The focus numbers count MY open tasks in the team, whatever the scope
  // and bucket filter say — they are the glance, not the list.
  const mineOpen = inTeam.filter(t => t.mine && !t.done)
  const focus: Record<Bucket, number> = { overdue: 0, today: 0, week: 0, later: 0, nodate: 0 }
  for (const t of mineOpen) focus[bucketOf(t.due)]++

  // Per-team counts for the chips and the unassigned lines.
  const teamCounts: Record<string, number> = { all: tasks.filter(t => t.mine && !t.done).length }
  const unassignedByTeam: { team: NotionTeam; count: number }[] = []
  for (const tm of teams) {
    const own = tasks.filter(t => teamOfBoard(t.dbId)?.id === tm.id && !t.done)
    teamCounts[tm.id] = own.filter(t => t.mine).length
    const u = own.filter(t => t.unassigned).length
    if (u > 0 && (!team || team === tm.id)) unassignedByTeam.push({ team: tm, count: u })
  }

  // Project chips — derived from the tasks in view, most-used first.
  const projectsInUse = (() => {
    const counts = new Map<string, number>()
    let unassigned = 0
    for (const t of scoped) {
      if (t.projectIds.length === 0) unassigned++
      for (const id of t.projectIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const list = Array.from(counts.entries())
      .map(([id, count]) => ({ project: projects[id], count, id }))
      .filter(x => !!x.project) as { project: ProjectRef; count: number; id: string }[]
    list.sort((a, b) => b.count - a.count)
    return { list, unassigned }
  })()
  const hasProjects = projectsInUse.list.length > 0

  // The next seven days on the calendars: my due dates, my content dates,
  // Google. Tapping a day opens the Calendar tab on it.
  const today = todayKey()
  const weekEnd = isoInDays(6)
  const { events: google } = useGoogleMonths(monthKeys(today, weekEnd))
  const week = useMemo(() => {
    const entries = buildEntries({ tasks, items, boards, teams, google, layers: ALL_LAYERS, onlyMine: !!me, team })
    const byDay = groupByDay(entries)
    return Array.from({ length: 7 }, (_, i) => { const day = isoInDays(i); return { day, entries: byDay.get(day) ?? [] } })
  }, [tasks, items, boards, teams, google, me, team])

  const showSource = boards.filter(b => b.role === 'tasks').length > 1
  const anyTaskBoard = boards.some(b => b.role === 'tasks' && !b.unavailable)

  async function dictateTask() {
    if (!voice.supported || !schema) return
    const text = await voice.start()
    if (!text) return
    const defaultStatus = schema.statusOptions.find(o => schema.todoStatusNames.includes(o.name))?.name
    onCreate({ title: text, status: defaultStatus })
  }

  function toggleDone(task: NotionTask) {
    // Use the task's own DB schema so we set a status that database actually
    // has (its done/todo option names may differ from other task DBs).
    const sch = schemas[task.dbId] ?? schema
    if (!sch) return
    if (task.done) onUpdate(task.id, { status: sch.todoStatusNames[0] ?? null })
    else onUpdate(task.id, { status: sch.doneStatusNames[0] ?? 'Done' })
  }

  const row = (task: NotionTask) => {
    const sch = schemas[task.dbId] ?? schema
    if (!sch) return null
    const tm = teamOfBoard(task.dbId)
    return (
      <TaskRow
        key={task.id}
        task={task}
        schema={sch}
        projects={projects}
        sourceTitle={showSource ? (boardById.get(task.dbId)?.title ?? null) : null}
        team={tm ? { name: tm.name, color: tm.color } : null}
        onTap={() => setEditing(task.id)}
        onToggleDone={() => toggleDone(task)}
        onTapProject={id => { setProjectFilter(projectFilter === id ? null : id); setShowProjects(true) }}
      />
    )
  }

  const teamName = team ? teamById.get(team)?.name : null

  return (
    <div className="flex flex-col gap-3 px-1 relative">
      {/* Header: the title, who I am, refresh. */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold font-display text-white">My work{teamName ? <span className="text-white/45 font-medium"> · {teamName}</span> : ''}</h2>
          {!loading && !error && (
            <p className="text-sm text-white/50 mt-0.5 tabular-nums">
              {me
                ? `${mineOpen.length} to do${focus.overdue ? ` · ${focus.overdue} overdue` : ''}${focus.today ? ` · ${focus.today} today` : ''}`
                : `${inTeam.filter(t => !t.done).length} open · everyone's`}
            </p>
          )}
        </div>
        <button type="button" onClick={() => setPickingMe(v => !v)} aria-label="Who I am"
          title={me ? me.name : 'Pick who you are'}
          className={`h-11 pl-1.5 pr-3 rounded-full flex items-center gap-2 active:scale-95 ${pickingMe ? 'bg-green-500/25 text-green-200' : 'bg-glass-2 text-white/70'}`}>
          <span className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center text-sm font-semibold">
            {me ? (me.name || '?')[0]?.toUpperCase() : <UserRound size={16} />}
          </span>
          <span className="text-sm max-w-[6rem] truncate">{me ? me.name.split(' ')[0] : 'Who?'}</span>
        </button>
        {hasProjects && (
          <button type="button" onClick={() => setShowProjects(v => !v)} aria-label="Filter by project"
            className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90
              ${showProjects || projectFilter !== null ? 'bg-blue-500/30 text-blue-200' : 'bg-glass-2 text-white/60'}`}>
            <Folder size={18} />
          </button>
        )}
        <button type="button" onClick={onRefresh} aria-label="Refresh"
          className="w-11 h-11 rounded-full bg-glass-2 text-white/60 flex items-center justify-center active:scale-90"><RotateCw size={18} /></button>
      </div>

      {(pickingMe || (!loading && !error && !me && tasks.length > 0)) && (
        <IdentityPicker onDone={() => setPickingMe(false)} />
      )}

      <TeamChips teams={teams} value={team} onChange={id => { setTeam(id); setBucket(null); setProjectFilter(null) }} counts={teamCounts} />

      {/* The focus strip: my open tasks by when. Tapping narrows the list. */}
      {!loading && !error && me && (
        <div className="grid grid-cols-4 gap-1.5">
          {(['overdue', 'today', 'week', 'nodate'] as Bucket[]).map(b => {
            const n = focus[b]
            const active = bucket === b
            const hot = b === 'overdue' && n > 0
            return (
              <button key={b} type="button" onClick={() => { setBucket(active ? null : b); setScope('mine') }}
                className={`h-14 rounded-xl flex flex-col items-center justify-center leading-none transition-colors border
                  ${active ? 'bg-white/[0.14] border-white/20' : hot ? 'bg-red-500/10 border-red-500/25 active:bg-red-500/20' : 'bg-white/[0.04] border-transparent active:bg-white/10'}`}>
                <span className={`text-xl font-bold tabular-nums font-display ${hot ? 'text-red-300' : n > 0 ? 'text-white' : 'text-white/30'}`}>{n}</span>
                <span className={`text-[12px] mt-1 ${hot ? 'text-red-200/80' : 'text-white/45'}`}>{b === 'week' ? '7 days' : BUCKET_LABELS[b]}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mine / Everyone / Unassigned — only meaningful once somebody is picked. */}
      {!loading && !error && me && (
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-white/[0.04] rounded-full p-1">
            {(['mine', 'everyone', 'unassigned'] as Scope[]).map(s => (
              <button key={s} type="button" onClick={() => { setScope(s); if (s !== 'mine') setBucket(null) }}
                className={`h-9 px-3.5 rounded-full text-sm font-medium ${scope === s ? 'bg-green-500/25 text-green-200' : 'text-white/50 active:bg-white/[0.07]'}`}>
                {s === 'mine' ? 'Mine' : s === 'everyone' ? 'Everyone' : 'Unassigned'}
              </button>
            ))}
          </div>
          {unassignedByTeam.length > 0 && scope !== 'unassigned' && (
            <button type="button" onClick={() => setScope('unassigned')}
              className="flex-1 min-w-0 text-left text-sm text-amber-200/70 truncate active:text-amber-100">
              {unassignedByTeam.map(u => `${u.count} unassigned${teams.length > 1 ? ` on ${u.team.name}` : ''}`).join(' · ')}
            </button>
          )}
        </div>
      )}

      {/* Project filter — derived from the tasks in view. */}
      {showProjects && hasProjects && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          <button type="button" onClick={() => setProjectFilter(null)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium
              ${projectFilter === null ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/40 active:bg-white/[0.1]'}`}>
            All projects
          </button>
          {projectsInUse.list.map(({ project, count, id }) => (
            <button key={id} type="button"
              onClick={() => setProjectFilter(projectFilter === id ? null : id)}
              className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium
                ${projectFilter === id ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/55 active:bg-white/[0.1]'}`}>
              <span>{project.icon ?? '📁'}</span>
              <span className="truncate max-w-[7rem]">{project.title}</span>
              <span className="opacity-50 tabular-nums">{count}</span>
            </button>
          ))}
          {projectsInUse.unassigned > 0 && (
            <button type="button"
              onClick={() => setProjectFilter(projectFilter === '__none__' ? null : '__none__')}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium
                ${projectFilter === '__none__' ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/45 active:bg-white/[0.1]'}`}>
              No project · <span className="opacity-60 tabular-nums">{projectsInUse.unassigned}</span>
            </button>
          )}
        </div>
      )}

      {/* Coming up: the next seven days across the calendars. */}
      {!loading && !error && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between px-1">
            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/50">Coming up</span>
            <button type="button" onClick={() => onOpenDay(today)} className="text-sm text-white/40 active:text-white/70">Calendar →</button>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {week.map(({ day, entries }) => {
              const d = new Date(day + 'T12:00')
              const isToday = day === today
              return (
                <button key={day} type="button" onClick={() => onOpenDay(day)} title={fmtDay(day)}
                  className={`rounded-xl px-1 py-2 flex flex-col items-center gap-1.5 border active:bg-white/10
                    ${isToday ? 'bg-white/[0.08] border-white/15' : 'bg-white/[0.03] border-transparent'}`}>
                  <span className={`text-[12px] leading-none ${isToday ? 'text-green-300' : 'text-white/40'}`}>{d.toLocaleDateString([], { weekday: 'narrow' })}</span>
                  <span className={`text-base font-semibold leading-none tabular-nums ${isToday ? 'text-white' : 'text-white/75'}`}>{d.getDate()}</span>
                  <span className="flex items-center gap-0.5 h-2.5">
                    {entries.slice(0, 4).map(e => <span key={e.key} className="w-2 h-2 rounded-full" style={{ background: e.color }} />)}
                    {entries.length > 4 && <span className="text-[10px] text-white/50 leading-none">+{entries.length - 4}</span>}
                  </span>
                  <span className="text-[11px] text-white/45 leading-none truncate w-full text-center">
                    {entries.length === 0 ? '·' : `${kindGlyph(entries[0]!.kind)} ${entries[0]!.title}`.slice(0, 10)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* The list. */}
      <div className="flex flex-col gap-2 pb-20">
        {loading && (
          <div className="flex items-center justify-center h-40">
            <span className="w-9 h-9 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
          </div>
        )}
        {!loading && error && tasks.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
            <p className="text-white/70 text-base">{error}</p>
            <p className="text-white/45 text-sm mt-1">
              {errorKind === 'unconfigured' ? 'Connect a Notion workspace in Settings → Notion and share your boards with the integration.'
               : errorKind === 'auth'      ? 'A workspace token no longer works. Check Settings → Notion → Teams.'
               : errorKind === 'access'    ? 'In Notion, open the database, tap ··· → Connections, and add this integration.'
               : errorKind === 'rate'      ? 'Too many requests in a short time. It clears itself; try again in a minute.'
               : errorKind === 'offline'   ? 'The dashboard server is not answering. Check that it is running.'
               : 'Tap refresh to try again.'}
            </p>
            <button type="button" onClick={onRefresh}
              className="mt-3 h-11 px-5 rounded-full bg-white/10 text-white/80 text-sm font-semibold active:bg-white/15">
              Try again
            </button>
          </div>
        )}
        {!loading && error && tasks.length > 0 && (
          <p className="text-sm text-amber-200/80 px-1">{error} · showing the last list that loaded</p>
        )}
        {!loading && !error && !anyTaskBoard && (
          <p className="text-sm text-white/45 px-1 py-4 text-center">
            No to-do board yet. In Settings → Notion, add a board or set one's role to Tasks.
          </p>
        )}
        {!loading && !error && anyTaskBoard && pending.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8">
            {bucket || projectFilter || scope !== 'mine'
              ? <p className="text-white/45 text-base">{scope === 'unassigned' ? 'Nothing unassigned.' : 'No tasks match the current filter.'}</p>
              : <><Check size={40} className="text-green-400" /><p className="text-green-400 font-semibold mt-1">All done!</p></>}
          </div>
        )}
        {!loading && !error && groups.map(g => (
          <div key={g.bucket} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1 pt-2">
              <span className={`text-sm font-medium uppercase tracking-[0.14em] ${g.bucket === 'overdue' ? 'text-red-300' : g.bucket === 'today' ? 'text-amber-200/90' : 'text-white/50'}`}>
                {BUCKET_LABELS[g.bucket]}
              </span>
              <span className="text-sm text-white/35 tabular-nums">{g.tasks.length}</span>
            </div>
            {g.tasks.map(row)}
          </div>
        ))}
        {/* Completed tasks live behind a collapsed header so the active queue
            stays short — the count still gives the day's sense of progress. */}
        {!loading && !error && done.length > 0 && (
          <>
            <button type="button" onClick={() => setShowDone(v => !v)}
              className="flex items-center gap-2 px-1 pt-3 pb-1 active:opacity-70">
              {showDone ? <ChevronDown size={15} className="text-white/40" /> : <ChevronRight size={15} className="text-white/40" />}
              <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/50">Done</span>
              <span className="text-sm text-white/35 tabular-nums">{done.length}</span>
            </button>
            {showDone && done.map(row)}
          </>
        )}
      </div>

      {!loading && !error && schema && anyTaskBoard && (
        // Sticky (not absolute) so the buttons stay pinned to the bottom of the
        // scroll viewport even when the task list overflows. pointer-events-none
        // on the wrapper keeps the row beneath it tappable; the buttons re-enable
        // it. The negative margin lets it overlay the list's pb-20 gutter rather
        // than reserving a tall empty strip.
        <div className="sticky bottom-3 z-10 -mt-14 flex flex-col items-end gap-2 pr-1 pointer-events-none">
          {voice.supported && (
            <button type="button" onClick={voice.listening ? voice.stop : dictateTask}
              className={`pointer-events-auto w-12 h-12 rounded-full flex items-center justify-center shadow-lg active:scale-90 transition-transform
                ${voice.listening ? 'bg-red-500 text-white shadow-red-500/30 animate-pulse' : 'bg-blue-500 text-white shadow-blue-500/30'}`}
              aria-label="Dictate task"><Mic size={21} /></button>
          )}
          <button type="button" onClick={() => setCreating(true)}
            className="pointer-events-auto w-14 h-14 rounded-full bg-green-500 text-black
                       flex items-center justify-center shadow-lg shadow-green-500/30
                       active:scale-90 transition-transform"
            aria-label="Create task"><Plus size={30} /></button>
        </div>
      )}

      {voice.listening && voice.interim && (
        <div className="sticky bottom-20 z-10 mx-1 -mt-2 bg-blue-500/20 backdrop-blur-md border border-blue-500/40 rounded-xl px-3 py-2">
          <p className="text-sm text-blue-200 uppercase tracking-wider">Listening…</p>
          <p className="text-sm text-white">{voice.interim}</p>
        </div>
      )}

      {creating && schema && (
        <CreateTaskSheet schema={schema} schemas={schemas} boards={boards} teams={teams} onSave={onCreate} onClose={() => setCreating(false)} />
      )}
      {editing && (() => {
        // Read the task fresh from the list on every render, so the sheet
        // shows the optimistic update the moment a chip is tapped.
        const task = tasks.find(t => t.id === editing)
        if (!task) return null
        const sch = schemas[task.dbId] ?? schema
        if (!sch) return null
        const tm = teamOfBoard(task.dbId)
        return (
          <TaskSheet
            task={task}
            schema={sch}
            projects={projects}
            sourceTitle={showSource ? (boardById.get(task.dbId)?.title ?? null) : null}
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
