import { useState } from 'react'
import { ArrowUpDown, RotateCw, Mic, Plus, Check, ChevronRight, ChevronUp, ChevronDown, CalendarDays } from 'lucide-react'
import type { NotionTask, NotionSchema, TaskFields, ProjectRef } from '../../../hooks/useNotion'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { colorFg, colorBg } from './notion-colors'
import MiniCalendar from './MiniCalendar'
import { TouchInput } from '../../TouchInput'
import { useNotionPins } from '../../../hooks/useNotionPins'
import { useNotionGroups } from '../../../hooks/useNotionGroups'
import { useVoiceCapture } from '../../../hooks/useVoiceCapture'

const PRI_ORDER: Record<string, number> = { High: 0, 'High Priority': 0, Urgent: 0, Medium: 1, Normal: 1, Low: 2 }
type SortMode = 'priority' | 'due' | 'created'
const SORT_LABELS: Record<SortMode, string> = { priority: 'Priority', due: 'Due', created: 'Recent' }
const SORT_CYCLE: SortMode[] = ['priority', 'due', 'created']

function sortedTasks(tasks: NotionTask[], mode: SortMode): NotionTask[] {
  return [...tasks].sort((a, b) => {
    if (mode === 'priority') {
      const pa = PRI_ORDER[a.priority ?? ''] ?? 99
      const pb = PRI_ORDER[b.priority ?? ''] ?? 99
      if (pa !== pb) return pa - pb
    }
    if (mode === 'due') {
      if (a.due && b.due) return a.due.localeCompare(b.due)
      if (a.due)  return -1
      if (b.due)  return  1
    }
    return b.createdAt.localeCompare(a.createdAt)
  })
}

function fmtDue(due: string): { label: string; overdue: boolean } {
  // Anchor both dates at local midnight so the difference is a whole-day count.
  // (Math.round, not floor, absorbs the ±1h DST wobble.) Anchoring the due date
  // at noon while today sits at midnight would skew every label half a day —
  // a task due today would read "Tomorrow", an overdue one "Today".
  const d = new Date(due + 'T00:00')
  const todayMs = new Date().setHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - todayMs) / 86_400_000)
  if (diff < 0)   return { label: `${Math.abs(diff)}d overdue`, overdue: true }
  if (diff === 0) return { label: 'Today', overdue: false }
  if (diff === 1) return { label: 'Tomorrow', overdue: false }
  if (diff < 7)   return { label: `${diff}d`, overdue: false }
  return { label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), overdue: false }
}

// ── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({
  task, schema, projects, onTap, onToggleDone, onTapProject,
}: {
  task:         NotionTask
  schema:       NotionSchema
  projects:     Record<string, ProjectRef>
  onTap:        () => void
  onToggleDone: () => void
  onTapProject: (projectId: string) => void
}) {
  const due       = task.due ? fmtDue(task.due) : null
  const priOpt    = schema.priorityOptions.find(o => o.name === task.priority)
  const statusOpt = schema.statusOptions.find(o => o.name === task.status)
  // Resolve project chips — tasks can belong to multiple projects, but on the
  // narrow Home row we render at most two to keep the layout scannable.
  const taskProjects = task.projectIds.map(id => projects[id]).filter(Boolean) as ProjectRef[]

  return (
    <div onClick={onTap}
      className={`flex items-start gap-3 rounded-2xl px-4 py-3.5 border transition-all cursor-pointer
        ${task.done
          ? 'bg-white/[0.025] border-white/[0.04] opacity-45'
          : 'bg-white/[0.05] border-white/[0.08] active:bg-white/[0.09] active:scale-[0.985]'}`}>
      <button type="button"
        onClick={e => { e.stopPropagation(); onToggleDone() }}
        className={`flex-shrink-0 w-8 h-8 mt-0.5 rounded-full border-2 flex items-center justify-center text-sm
                    active:scale-90 transition-all
          ${task.done
            ? 'bg-green-500/25 border-green-500/50 text-green-400'
            : 'border-green-500/40 active:bg-green-500/15'}`}
        aria-label={task.done ? 'Mark undone' : 'Mark done'}>
        {task.done && '✓'}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-[15px] font-medium leading-snug ${task.done ? 'line-through text-white/35' : 'text-white'}`}>
          {task.title}
        </p>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {statusOpt && (
            <span className="text-[13px] font-medium px-2 py-0.5 rounded-full"
              style={{ color: colorFg(statusOpt.color), background: colorBg(statusOpt.color, 0.25) }}>
              {statusOpt.name}
            </span>
          )}
          {priOpt && (
            <span className="text-[13px] font-medium px-2 py-0.5 rounded-full"
              style={{ color: colorFg(priOpt.color), background: colorBg(priOpt.color, 0.25) }}>
              {priOpt.name}
            </span>
          )}
          {due && (
            <span className={`text-[13px] px-2 py-0.5 rounded-full
              ${due.overdue ? 'text-red-400 bg-red-500/15' : 'text-white/35 bg-white/[0.06]'}`}>
              {due.label}
            </span>
          )}
          {taskProjects.slice(0, 2).map(p => (
            <button key={p.id} type="button"
              onClick={e => { e.stopPropagation(); onTapProject(p.id) }}
              className="text-[13px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-200/85 active:bg-blue-500/30 max-w-[10rem] truncate">
              {p.icon ? `${p.icon} ` : '📁 '}{p.title}
            </button>
          ))}
          {taskProjects.length > 2 && (
            <span className="text-xs text-white/30">+{taskProjects.length - 2}</span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="text-white/20 mt-1 flex-shrink-0" />
    </div>
  )
}

// ── Quick-add task sheet (creates in the configured task DB) ─────────────────

function ChipRow({
  label, options, value, onChange, allowNone = false,
}: {
  label:     string
  options:   { id: string; name: string; color: string }[]
  value:     string | null
  onChange:  (v: string | null) => void
  allowNone?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-white/35 uppercase tracking-wider font-medium">{label}</span>
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-hide">
        {allowNone && (
          <button type="button" onClick={() => onChange(null)}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold border transition-all active:scale-95
              ${value === null
                ? 'bg-white/20 text-white border-white/30'
                : 'bg-white/[0.05] text-white/35 border-transparent active:bg-white/10'}`}>
            None
          </button>
        )}
        {options.map(opt => (
          <button type="button" key={opt.id} onClick={() => onChange(opt.name)}
            className="flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold border transition-all active:scale-95"
            style={{
              background:   value === opt.name ? colorBg(opt.color, 0.2) : 'rgba(255,255,255,0.04)',
              color:        value === opt.name ? colorFg(opt.color)       : 'rgba(255,255,255,0.35)',
              borderColor:  value === opt.name ? colorBg(opt.color, 0.5)  : 'transparent',
            }}>
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function CreateTaskSheet({
  schema, onSave, onClose,
}: {
  schema:  NotionSchema
  onSave:  (fields: { title: string; status?: string; priority?: string; due?: string }) => void
  onClose: () => void
}) {
  const defaultStatus = schema.statusOptions.find(o => schema.todoStatusNames.includes(o.name))?.name ?? schema.statusOptions[0]?.name
  const [title,    setTitle]    = useState('')
  const [status,   setStatus]   = useState<string | undefined>(defaultStatus)
  const [priority, setPriority] = useState<string | undefined>(undefined)
  const [due,      setDue]      = useState('')
  const [showCal,  setShowCal]  = useState(false)

  function save() {
    const t = title.trim()
    if (!t) return
    onSave({ title: t, status, priority, due: due || undefined })
    onClose()
  }

  const dueLabel = due ? new Date(due + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'No date'

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 overflow-y-auto max-h-[92vh]">
        <div className="px-5 pb-10 pt-3">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />
          <h2 className="text-base font-bold text-white mb-5">New Task</h2>
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-white/35 uppercase tracking-wider font-medium">Title</span>
              <TouchInput value={title} onChange={setTitle} commitOn="change"
                placeholder="Task name…"
                ariaLabel="Task title"
                className="bg-white/10 text-white placeholder-white/20 rounded-xl px-4 py-4 text-sm outline-none focus:ring-2 focus:ring-green-400" />
            </label>
            {schema.statusKey && schema.statusOptions.length > 0 && (
              <ChipRow label="Status" options={schema.statusOptions} value={status ?? null} onChange={v => setStatus(v ?? undefined)} />
            )}
            {schema.priorityKey && schema.priorityOptions.length > 0 && (
              <ChipRow label="Priority" options={schema.priorityOptions} value={priority ?? null} onChange={v => setPriority(v ?? undefined)} allowNone />
            )}
            {schema.dueKey && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] text-white/35 uppercase tracking-wider font-medium">Due date</span>
                <button type="button" onClick={() => setShowCal(v => !v)}
                  className="flex items-center gap-3 bg-white/[0.06] rounded-xl px-4 py-3.5 text-sm w-full active:bg-white/10">
                  <CalendarDays size={18} className="text-white/60" />
                  <span className={due ? 'text-white' : 'text-white/40'}>{dueLabel}</span>
                  <span className="text-white/30 ml-auto">{showCal ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                </button>
                {showCal && <MiniCalendar value={due} onChange={d => { setDue(d); setShowCal(false) }} />}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 mt-1">
              <button type="button" onClick={onClose}
                className="h-14 rounded-2xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
              <button type="button" onClick={save} disabled={!title.trim()}
                className="h-14 rounded-2xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400 transition-colors">Create</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── HomeView ─────────────────────────────────────────────────────────────────

interface Props {
  schema:    NotionSchema | null
  tasks:     NotionTask[]
  projects:  Record<string, ProjectRef>
  loading:   boolean
  error:     string | null
  client:    NotionClient
  onUpdate:  (id: string, fields: TaskFields) => void
  onCreate:  (fields: { title: string; status?: string; priority?: string; due?: string }) => void
  onRefresh: () => void
}

function GroupsAndRecents({
  pins, groups, client,
}: {
  pins:   ReturnType<typeof useNotionPins>
  groups: ReturnType<typeof useNotionGroups>
  client: NotionClient
}) {
  // Show the first two groups inline so the user can jump straight to a group's
  // items without leaving home. More than two would crowd the screen — anything
  // beyond is one tap away via the Groups tab.
  const featured = groups.groups.slice(0, 2)

  return (
    <div className="flex flex-col gap-3">
      {featured.length > 0 && (
        <div className="flex flex-col gap-2">
          {featured.map(g => {
            const fg = colorFg(g.color ?? 'default')
            return (
              <div key={g.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-1">
                  <span className="text-base">{g.icon ?? '📁'}</span>
                  <span className="text-[13px] font-semibold uppercase tracking-wider truncate flex-1" style={{ color: fg }}>{g.name}</span>
                  <span className="text-xs text-white/25 tabular-nums">{g.items.length}</span>
                </div>
                {g.items.length === 0 ? (
                  <p className="text-[13px] text-white/25 italic px-2">empty</p>
                ) : (
                  <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                    {g.items.slice(0, 8).map(it => (
                      <button key={it.refId} type="button"
                        onClick={() => client.navigate(it.kind === 'database' ? { kind: 'database', id: it.refId } : { kind: 'page', id: it.refId })}
                        className="flex-shrink-0 flex items-center gap-2 rounded-lg px-3 py-2 max-w-[180px] active:scale-[0.97]"
                        style={{ background: colorBg(g.color ?? 'default', 0.15) }}>
                        <span className="text-base flex-shrink-0">{it.icon ?? (it.kind === 'database' ? '🗄️' : '📄')}</span>
                        <span className="text-xs text-white/85 truncate">{it.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <button type="button" onClick={() => client.replace({ kind: 'groups' })}
            className="self-start text-[13px] text-white/45 active:text-white/80 px-1 py-1">
            {groups.groups.length > 2 ? `More groups (${groups.groups.length - 2}) →` : 'Manage groups →'}
          </button>
        </div>
      )}
      {groups.groups.length === 0 && (
        <button type="button" onClick={() => client.replace({ kind: 'groups' })}
          className="self-start text-[13px] text-white/35 active:text-white/70 px-1">
          + Create your first group
        </button>
      )}
      {pins.recents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-white/30 px-1">Recent</span>
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
            {pins.recents.slice(0, 6).map(r => (
              <button key={r.id} type="button"
                onClick={() => client.navigate(r.kind === 'database' ? { kind: 'database', id: r.id } : { kind: 'page', id: r.id })}
                className="flex-shrink-0 flex items-center gap-2 bg-white/[0.03] active:bg-white/[0.07] rounded-lg px-3 py-2 max-w-[180px]">
                <span className="text-base flex-shrink-0">{r.icon ?? (r.kind === 'database' ? '🗄️' : '📄')}</span>
                <span className="text-xs text-white/65 truncate">{r.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function HomeView({ schema, tasks, projects, loading, error, client, onUpdate, onCreate, onRefresh }: Props) {
  const [filter,        setFilter]        = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [sort,          setSort]          = useState<SortMode>('priority')
  const [creating,      setCreating]      = useState(false)
  const [showDone,      setShowDone]      = useState(false)
  const pins   = useNotionPins()
  const groups = useNotionGroups()
  const voice  = useVoiceCapture()

  // Project chips — derive from the set of projects actually referenced by
  // the current task list and sort by count desc so the most relevant ones
  // land first. Tasks without any project go under a synthetic "No project".
  const projectsInUse = (() => {
    const counts = new Map<string, number>()
    let unassigned = 0
    for (const t of tasks) {
      if (t.projectIds.length === 0) unassigned++
      for (const id of t.projectIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const list = Array.from(counts.entries())
      .map(([id, count]) => ({ project: projects[id], count, id }))
      .filter(x => !!x.project) as { project: ProjectRef; count: number; id: string }[]
    list.sort((a, b) => b.count - a.count)
    return { list, unassigned }
  })()

  async function dictateTask() {
    if (!voice.supported || !schema) return
    const text = await voice.start()
    if (!text) return
    const defaultStatus = schema.statusOptions.find(o => schema.todoStatusNames.includes(o.name))?.name
    onCreate({ title: text, status: defaultStatus })
  }

  // Filter chain: status → project. Special sentinel "__none__" for tasks
  // with no related project (so "Tasks not yet assigned to a project" stays
  // reachable from the chip strip).
  const filtered  = tasks
    .filter(t => filter        === null ? true : t.status === filter)
    .filter(t => projectFilter === null ? true
              : projectFilter === '__none__' ? t.projectIds.length === 0
              : t.projectIds.includes(projectFilter))
  const pending   = sortedTasks(filtered.filter(t => !t.done), sort)
  const done      = sortedTasks(filtered.filter(t =>  t.done), sort)
  const allSorted = [...pending, ...done]

  function cycleSort() {
    const i = SORT_CYCLE.indexOf(sort)
    setSort(SORT_CYCLE[(i + 1) % SORT_CYCLE.length]!)
  }

  function toggleDone(task: NotionTask) {
    if (!schema) return
    if (task.done) {
      const revert = schema.todoStatusNames[0] ?? null
      onUpdate(task.id, { status: revert })
    } else {
      const doneStatus = schema.doneStatusNames[0] ?? 'Done'
      onUpdate(task.id, { status: doneStatus })
    }
  }

  return (
    <div className="flex flex-col gap-3 px-1 relative">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold font-display text-white">Tasks</h2>
          {!loading && !error && (
            <p className="text-sm text-white/50 mt-0.5 tabular-nums">
              {tasks.filter(t => !t.done).length} pending · {tasks.filter(t => t.done).length} done
            </p>
          )}
        </div>
        <button type="button" onClick={cycleSort}
          className="h-11 px-4 rounded-full bg-glass-2 text-white/60 text-sm font-medium active:bg-white/15 flex items-center gap-1.5">
          <ArrowUpDown size={15} /> {SORT_LABELS[sort]}
        </button>
        <button type="button" onClick={onRefresh} aria-label="Refresh"
          className="w-11 h-11 rounded-full bg-glass-2 text-white/60 flex items-center justify-center active:scale-90"><RotateCw size={18} /></button>
      </div>

      {schema && schema.statusOptions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button type="button" onClick={() => setFilter(null)}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors
              ${filter === null ? 'bg-green-500 text-black' : 'bg-white/[0.07] text-white/50 active:bg-white/15'}`}>All</button>
          {schema.statusOptions.map(opt => (
            <button key={opt.id} type="button" onClick={() => setFilter(opt.name === filter ? null : opt.name)}
              className="flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-all border"
              style={{
                background:  filter === opt.name ? colorBg(opt.color, 0.25) : 'rgba(255,255,255,0.05)',
                color:       filter === opt.name ? colorFg(opt.color)        : 'rgba(255,255,255,0.35)',
                borderColor: filter === opt.name ? colorBg(opt.color, 0.5)   : 'transparent',
              }}>
              {opt.name}
            </button>
          ))}
        </div>
      )}

      {/* Project filter — derived from the active task list. Hidden when
          the task DB has no relation property (projectsInUse is empty and
          there's nothing unassigned either). */}
      {schema?.projectKey && (projectsInUse.list.length > 0 || projectsInUse.unassigned > 0) && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          <button type="button" onClick={() => setProjectFilter(null)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[13px] font-medium
              ${projectFilter === null ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/40 active:bg-white/[0.1]'}`}>
            All projects
          </button>
          {projectsInUse.list.map(({ project, count, id }) => (
            <button key={id} type="button"
              onClick={() => setProjectFilter(projectFilter === id ? null : id)}
              className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium
                ${projectFilter === id ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/55 active:bg-white/[0.1]'}`}>
              {project.icon ? <span>{project.icon}</span> : <span>📁</span>}
              <span className="truncate max-w-[7rem]">{project.title}</span>
              <span className="opacity-50 tabular-nums">{count}</span>
            </button>
          ))}
          {projectsInUse.unassigned > 0 && (
            <button type="button"
              onClick={() => setProjectFilter(projectFilter === '__none__' ? null : '__none__')}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[13px] font-medium
                ${projectFilter === '__none__' ? 'bg-blue-500/40 text-blue-100' : 'bg-white/[0.05] text-white/45 active:bg-white/[0.1]'}`}>
              No project · <span className="opacity-60 tabular-nums">{projectsInUse.unassigned}</span>
            </button>
          )}
        </div>
      )}

      {/* Groups + Recents — populated as the user organizes their workspace */}
      {(groups.groups.length > 0 || pins.recents.length > 0) && (
        <GroupsAndRecents pins={pins} groups={groups} client={client} />
      )}

      <div className="flex flex-col gap-2 pb-20">
        {loading && (
          <div className="flex items-center justify-center h-40">
            <span className="w-9 h-9 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-white/55 text-base">{error}</p>
            <p className="text-white/40 text-sm mt-1">Add NOTION_API_KEY + NOTION_DATABASE_ID to server/.env</p>
          </div>
        )}
        {!loading && !error && allSorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10">
            {filter || projectFilter
              ? <p className="text-white/45 text-base">No tasks match the current filter.</p>
              : <><Check size={40} className="text-green-400" /><p className="text-green-400 font-semibold mt-1">All done!</p></>}
          </div>
        )}
        {!loading && !error && schema && pending.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            schema={schema}
            projects={projects}
            onTap={() => client.navigate({ kind: 'page', id: task.id })}
            onToggleDone={() => toggleDone(task)}
            onTapProject={id => setProjectFilter(projectFilter === id ? null : id)}
          />
        ))}

        {/* Completed tasks live behind a collapsed header so the active queue
            stays short — the count still gives the day's sense of progress. */}
        {!loading && !error && schema && done.length > 0 && (
          <>
            <button type="button" onClick={() => setShowDone(v => !v)}
              className="flex items-center gap-2 px-1 pt-3 pb-1 active:opacity-70">
              {showDone ? <ChevronDown size={15} className="text-white/40" /> : <ChevronRight size={15} className="text-white/40" />}
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/50">Done</span>
              <span className="text-xs text-white/35 tabular-nums">{done.length}</span>
            </button>
            {showDone && done.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                schema={schema}
                projects={projects}
                onTap={() => client.navigate({ kind: 'page', id: task.id })}
                onToggleDone={() => toggleDone(task)}
                onTapProject={id => setProjectFilter(projectFilter === id ? null : id)}
              />
            ))}
          </>
        )}
      </div>

      {!loading && !error && schema && (
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
          <p className="text-xs text-blue-200 uppercase tracking-wider">Listening…</p>
          <p className="text-sm text-white">{voice.interim}</p>
        </div>
      )}

      {creating && schema && (
        <CreateTaskSheet schema={schema} onSave={onCreate} onClose={() => setCreating(false)} />
      )}
    </div>
  )
}
