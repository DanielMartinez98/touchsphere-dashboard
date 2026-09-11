import { useState } from 'react'
import { CalendarDays, ChevronRight, ChevronUp, ChevronDown, UserPlus, UserMinus } from 'lucide-react'
import type { NotionTask, NotionSchema, TaskFields, ProjectRef, NotionIdentity } from '../../../hooks/useNotion'
import MiniCalendar from './MiniCalendar'
import ChipRow from './ChipRow'
import { TouchInput } from '../../TouchInput'
import { fmtDue, isoInDays } from './task-utils'

// A task's own fields, editable from the list.
//
// Tapping a task used to open its Notion PAGE: a title, three chips, an empty
// "+ Add block" box, an "Archive page" bar — and the status, due date and
// project it is a task BECAUSE of, folded away behind a dim 14px "Show 5
// properties" link. On the kiosk that read as "I can't change anything about
// this task", which was the honest description. So a tap opens this: the
// fields the row shows, as controls, saved through the same optimistic update
// the done circle uses. The page is one button away for notes.
//
// "Take it" / "Hand back" (2026-09-11) are the two moves someone managing a
// team's unassigned pile needs: put me on it, or take everyone off it.
export default function TaskSheet({
  task, schema, projects, sourceTitle, team, me, onUpdate, onArchive, onOpenPage, onClose,
}: {
  task:        NotionTask
  schema:      NotionSchema
  projects:    Record<string, ProjectRef>
  sourceTitle: string | null
  team:        { name: string; color: string } | null
  me:          NotionIdentity | null
  onUpdate:    (fields: TaskFields) => void
  onArchive?:  () => void
  onOpenPage:  () => void
  onClose:     () => void
}) {
  const [showCal, setShowCal]   = useState(false)
  const [confirm, setConfirm]   = useState(false)
  const taskProjects = task.projectIds.map(id => projects[id]).filter(Boolean) as ProjectRef[]
  const due = task.due ? fmtDue(task.due) : null
  const quick = [{ label: 'Today', days: 0 }, { label: 'Tomorrow', days: 1 }, { label: 'Next week', days: 7 }]
  const canAssign = !!schema.peopleKey
  const names = task.assignees.map(a => a.name).filter(Boolean)
  return (
    <div className="fixed inset-0 z-[9050] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 overflow-y-auto max-h-[92vh] kb-room max-w-3xl w-full mx-auto">
        <div className="px-5 pb-10 pt-3">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-white/35 uppercase tracking-wider font-medium flex items-center gap-2">
                {team && <span className="w-2.5 h-2.5 rounded-full" style={{ background: team.color }} />}
                {team ? `${team.name} · ` : 'Task'}{sourceTitle ?? ''}
              </span>
              <TouchInput value={task.title} onChange={t => { if (t.trim() && t !== task.title) onUpdate({ title: t.trim() }) }}
                commitOn="done"
                ariaLabel="Task title"
                className="bg-white/10 text-white rounded-xl px-4 py-4 text-base font-medium outline-none focus:ring-2 focus:ring-green-400" />
            </label>
            {schema.statusKey && schema.statusOptions.length > 0 && (
              <ChipRow label="Status" options={schema.statusOptions} value={task.status}
                onChange={v => onUpdate({ status: v })} />
            )}
            {schema.priorityKey && schema.priorityOptions.length > 0 && (
              <ChipRow label="Priority" options={schema.priorityOptions} value={task.priority}
                onChange={v => onUpdate({ priority: v })} allowNone />
            )}
            {schema.dueKey && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Due date</span>
                <div className="flex gap-2">
                  {quick.map(({ label, days }) => {
                    const iso = isoInDays(days)
                    const active = task.due === iso
                    return (
                      <button key={label} type="button"
                        onClick={() => { onUpdate({ due: active ? null : iso }); setShowCal(false) }}
                        className={`flex-1 h-12 rounded-xl text-sm font-semibold transition-colors
                          ${active ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/60 active:bg-white/10'}`}>
                        {label}
                      </button>
                    )
                  })}
                  {task.due && (
                    <button type="button" onClick={() => { onUpdate({ due: null }); setShowCal(false) }}
                      className="h-12 px-4 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/50 active:bg-white/10">
                      None
                    </button>
                  )}
                </div>
                <button type="button" onClick={() => setShowCal(v => !v)}
                  className="flex items-center gap-3 bg-white/[0.06] rounded-xl px-4 py-3.5 text-base w-full active:bg-white/10">
                  <CalendarDays size={18} className="text-white/60" />
                  <span className={due ? (due.overdue ? 'text-red-300' : 'text-white') : 'text-white/40'}>
                    {task.due
                      ? `${new Date(task.due + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${due?.overdue ? ` · ${due.label}` : ''}`
                      : 'No date'}
                  </span>
                  <span className="text-white/30 ml-auto">{showCal ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                </button>
                {showCal && <MiniCalendar value={task.due ?? ''} onChange={d => { onUpdate({ due: d }); setShowCal(false) }} />}
              </div>
            )}
            {canAssign && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Assigned to</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`flex-1 min-w-0 text-base ${names.length ? 'text-white' : 'text-amber-200/70'}`}>
                    {names.length ? names.join(', ') : 'Nobody yet'}
                  </span>
                  {!task.mine && (
                    <button type="button" disabled={!me} onClick={() => onUpdate({ assignee: 'me' })}
                      title={me ? 'Assign this task to me' : 'Pick who you are first'}
                      className="h-11 px-4 rounded-xl bg-green-500/15 border border-green-400/30 text-green-200 text-sm font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
                      <UserPlus size={16} /> Take it
                    </button>
                  )}
                  {task.assignees.length > 0 && (
                    <button type="button" onClick={() => onUpdate({ assignee: null })}
                      className="h-11 px-4 rounded-xl bg-white/[0.06] text-white/60 text-sm font-semibold flex items-center gap-1.5 active:bg-white/10">
                      <UserMinus size={16} /> Hand back
                    </button>
                  )}
                </div>
              </div>
            )}
            {taskProjects.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Project</span>
                <div className="flex gap-2 flex-wrap">
                  {taskProjects.map(p => (
                    <span key={p.id} className="px-3 py-2 rounded-xl text-sm bg-blue-500/15 text-blue-200/85">
                      {p.icon ? `${p.icon} ` : '📁 '}{p.title}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 mt-1">
              <button type="button" onClick={onOpenPage}
                className="h-14 rounded-2xl bg-white/10 text-white/80 text-sm font-semibold active:bg-white/15 flex items-center justify-center gap-2">
                Notes &amp; page <ChevronRight size={16} />
              </button>
              <button type="button" onClick={onClose}
                className="h-14 rounded-2xl bg-green-500 text-black text-sm font-bold active:bg-green-400">Done</button>
            </div>
            {onArchive && (
              confirm ? (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirm(false)}
                    className="flex-1 h-12 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Keep it</button>
                  <button type="button" onClick={() => { onArchive(); onClose() }}
                    className="flex-1 h-12 rounded-xl bg-red-500/80 text-white text-sm font-semibold active:bg-red-500">Archive this task</button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirm(true)}
                  className="h-12 rounded-xl text-sm text-red-300/80 active:bg-red-500/10">Archive…</button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
