import { motion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import type { NotionTask, NotionSchema, ProjectRef } from '../../../hooks/useNotion'
import { colorFg, colorBg } from './notion-colors'
import { fmtDue } from './task-utils'

// One task on the list. The chips under the title: the team dot + board name
// (only when several boards are in play — with one there is nothing to tell
// apart), status, priority, due, up to two projects. The team colour is the
// one thing that says "this is indy's" at a glance, so it is the first chip.
export default function TaskRow({
  task, schema, projects, sourceTitle, team, onTap, onToggleDone, onTapProject,
}: {
  task:         NotionTask
  schema:       NotionSchema
  projects:     Record<string, ProjectRef>
  // Source board name, shown as a chip only when several boards are aggregated.
  sourceTitle:  string | null
  team:         { name: string; color: string } | null
  onTap:        () => void
  onToggleDone: () => void
  onTapProject: (projectId: string) => void
}) {
  const due       = task.due ? fmtDue(task.due) : null
  const priOpt    = schema.priorityOptions.find(o => o.name === task.priority)
  const statusOpt = schema.statusOptions.find(o => o.name === task.status)
  // Resolve project chips — tasks can belong to multiple projects, but on the
  // narrow row we render at most two to keep the layout scannable.
  const taskProjects = task.projectIds.map(id => projects[id]).filter(Boolean) as ProjectRef[]
  const others = task.assignees.filter(a => a.name).map(a => a.name)

  return (
    <motion.div onClick={onTap}
      layoutId={task.id}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        layout:  { type: 'spring', stiffness: 420, damping: 34 },
        opacity: { duration: 0.2 },
        y:       { duration: 0.2 },
      }}
      className={`flex items-start gap-3 rounded-2xl px-4 py-3.5 border transition-all cursor-pointer
        ${task.done
          ? 'bg-white/[0.025] border-white/[0.04] opacity-45'
          : 'bg-white/[0.05] border-white/[0.08] active:bg-white/[0.09] active:scale-[0.985]'}`}>
      <button type="button"
        onClick={e => { e.stopPropagation(); onToggleDone() }}
        className={`flex-shrink-0 w-10 h-10 mt-0 rounded-full border-2 flex items-center justify-center text-sm
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
          {sourceTitle && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium px-2 py-0.5 rounded-full bg-white/[0.06] text-white/45 max-w-[11rem] truncate">
              {team && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: team.color }} />}
              <span className="truncate">{sourceTitle}</span>
            </span>
          )}
          {statusOpt && (
            <span className="text-sm font-medium px-2 py-0.5 rounded-full"
              style={{ color: colorFg(statusOpt.color), background: colorBg(statusOpt.color, 0.25) }}>
              {statusOpt.name}
            </span>
          )}
          {priOpt && (
            <span className="text-sm font-medium px-2 py-0.5 rounded-full"
              style={{ color: colorFg(priOpt.color), background: colorBg(priOpt.color, 0.25) }}>
              {priOpt.name}
            </span>
          )}
          {due && (
            <span className={`text-sm px-2 py-0.5 rounded-full
              ${due.overdue ? 'text-red-400 bg-red-500/15' : 'text-white/35 bg-white/[0.06]'}`}>
              {due.label}
            </span>
          )}
          {taskProjects.slice(0, 2).map(p => (
            <button key={p.id} type="button"
              onClick={e => { e.stopPropagation(); onTapProject(p.id) }}
              className="text-sm px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-200/85 active:bg-blue-500/30 max-w-[10rem] truncate">
              {p.icon ? `${p.icon} ` : '📁 '}{p.title}
            </button>
          ))}
          {taskProjects.length > 2 && (
            <span className="text-sm text-white/30">+{taskProjects.length - 2}</span>
          )}
          {/* Someone else's, or nobody's — said on the row, since the list can show a team's whole board. */}
          {!task.mine && others.length > 0 && (
            <span className="text-sm px-2 py-0.5 rounded-full bg-white/[0.04] text-white/40 max-w-[9rem] truncate">👤 {others.join(', ')}</span>
          )}
          {task.unassigned && (
            <span className="text-sm px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-200/70">Unassigned</span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="text-white/20 mt-1 flex-shrink-0" />
    </motion.div>
  )
}
