import type { NotionTask } from '../../../hooks/useNotion'

const PRIORITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 }

const PRIORITY_STYLE: Record<string, string> = {
  High:   'text-red-400   bg-red-500/15',
  Medium: 'text-amber-400 bg-amber-500/15',
  Low:    'text-blue-400  bg-blue-500/15',
}

function fmtDue(due: string): { label: string; overdue: boolean } {
  const d     = new Date(due + 'T12:00')
  const today = new Date()
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diff  = Math.round((d.getTime() - todayMidnight.getTime()) / 86_400_000)

  if (diff < 0)  return { label: `${Math.abs(diff)}d overdue`, overdue: true }
  if (diff === 0) return { label: 'Today', overdue: false }
  if (diff === 1) return { label: 'Tomorrow', overdue: false }
  if (diff < 7)  return { label: `in ${diff}d`, overdue: false }
  return {
    label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    overdue: false,
  }
}

function sortPending(tasks: NotionTask[]): NotionTask[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 99
    const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 99
    if (pa !== pb) return pa - pb
    if (a.due && b.due) return a.due.localeCompare(b.due)
    if (a.due) return -1
    if (b.due) return 1
    return 0
  })
}

// ── TaskRow ───────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task:       NotionTask
  onMarkDone: (t: NotionTask) => void
}

function TaskRow({ task, onMarkDone }: TaskRowProps) {
  const priCls = task.priority ? (PRIORITY_STYLE[task.priority] ?? 'text-white/40 bg-white/10') : null
  const due    = task.due ? fmtDue(task.due) : null

  return (
    <div className="flex items-start gap-3 bg-white/[0.05] rounded-2xl px-4 py-3.5 border border-white/[0.07] active:bg-white/[0.08] transition-colors">
      {/* Mark-done button */}
      <button
        onClick={() => onMarkDone(task)}
        className="flex-shrink-0 w-7 h-7 mt-0.5 rounded-full border-2 border-green-500/50
                   flex items-center justify-center
                   active:scale-90 active:bg-green-500/20 active:border-green-400
                   transition-all"
        aria-label="Mark done"
      />

      {/* Body */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white leading-snug">{task.title}</p>

        {/* Meta chips */}
        {(task.status || task.priority || task.due) && (
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {task.status && (
              <span className="text-[11px] text-white/35 bg-white/[0.06] px-2 py-0.5 rounded-full">
                {task.status}
              </span>
            )}
            {priCls && (
              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${priCls}`}>
                {task.priority}
              </span>
            )}
            {due && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                due.overdue
                  ? 'text-red-400 bg-red-500/15'
                  : 'text-white/35 bg-white/[0.06]'
              }`}>
                {due.label}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── DoneRow ───────────────────────────────────────────────────────────────────

function DoneRow({ task }: { task: NotionTask }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-[11px]">
        ✓
      </div>
      <p className="text-sm text-white/35 line-through truncate">{task.title}</p>
    </div>
  )
}

// ── NotionExpanded ────────────────────────────────────────────────────────────

interface Props {
  tasks:      NotionTask[]
  loading:    boolean
  error:      string | null
  onMarkDone: (t: NotionTask) => void
  onRefresh:  () => void
}

export default function NotionExpanded({ tasks, loading, error, onMarkDone, onRefresh }: Props) {
  const pending = sortPending(tasks.filter(t => !t.done))
  const done    = tasks.filter(t => t.done)

  return (
    <div className="flex flex-col h-full pt-16 pb-4">

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-5 pb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Tasks</h2>
          {!loading && !error && (
            <p className="text-xs text-white/35 mt-0.5">
              {pending.length} pending{done.length > 0 ? ` · ${done.length} done` : ''}
            </p>
          )}
        </div>
        <button
          onClick={onRefresh}
          className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center
                     text-white/50 text-xl active:scale-90 transition-transform"
          aria-label="Refresh"
        >
          ↺
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 space-y-2">

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center h-40">
            <span className="w-9 h-9 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
          </div>
        )}

        {/* Error / not configured */}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-white/40 text-sm">{error}</p>
            <p className="text-white/20 text-xs mt-1">
              Set NOTION_API_KEY and NOTION_DATABASE_ID in server/.env
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && pending.length === 0 && done.length === 0 && (
          <p className="text-white/30 text-sm text-center py-10">No tasks found in database</p>
        )}

        {/* All-done celebration */}
        {!loading && !error && pending.length === 0 && done.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="text-5xl">✓</span>
            <p className="text-green-400 font-semibold text-lg">All done!</p>
          </div>
        )}

        {/* Pending tasks */}
        {!loading && !error && pending.map(task => (
          <TaskRow key={task.id} task={task} onMarkDone={onMarkDone} />
        ))}

        {/* Done section */}
        {!loading && !error && done.length > 0 && (
          <div className="pt-2">
            <p className="text-[10px] text-white/20 uppercase tracking-widest px-1 pb-1">
              Completed
            </p>
            {done.map(task => (
              <DoneRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
