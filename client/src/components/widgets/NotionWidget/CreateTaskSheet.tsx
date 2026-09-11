import { useState } from 'react'
import { CalendarDays, ChevronUp, ChevronDown } from 'lucide-react'
import type { NotionSchema, NotionBoard, NotionTeam } from '../../../hooks/useNotion'
import MiniCalendar from './MiniCalendar'
import ChipRow from './ChipRow'
import { TouchInput } from '../../TouchInput'
import { isoInDays } from './task-utils'

// The quick-add sheet. The board picker lists the `tasks` boards only — a
// content calendar has a Status too, but a new task must never become a
// content idea — grouped by team, the default (starred) one preselected.
export default function CreateTaskSheet({
  schema, schemas, boards, teams, onSave, onClose,
}: {
  schema:  NotionSchema
  schemas: Record<string, NotionSchema>
  boards:  NotionBoard[]
  teams:   NotionTeam[]
  onSave:  (fields: { title: string; status?: string; priority?: string; due?: string; dbId?: string }) => void
  onClose: () => void
}) {
  const takers = boards.filter(b => b.role === 'tasks' && b.hasStatus && !b.unavailable)
  const [dbId, setDbId] = useState<string | undefined>((takers.find(b => b.isDefault) ?? takers[0])?.id)
  const activeSchema = (dbId && schemas[dbId]) || schema

  const defaultStatus = activeSchema.statusOptions.find(o => activeSchema.todoStatusNames.includes(o.name))?.name ?? activeSchema.statusOptions[0]?.name
  const [title,    setTitle]    = useState('')
  const [status,   setStatus]   = useState<string | undefined>(defaultStatus)
  const [priority, setPriority] = useState<string | undefined>(undefined)
  const [due,      setDue]      = useState('')
  const [showCal,  setShowCal]  = useState(false)

  // Switching board resets status to that board's default (its options differ).
  function pickDb(id: string) {
    setDbId(id)
    const sch = schemas[id]
    setStatus(sch?.statusOptions.find(o => sch.todoStatusNames.includes(o.name))?.name ?? sch?.statusOptions[0]?.name)
  }

  function save() {
    const t = title.trim()
    if (!t) return
    onSave({ title: t, status, priority, due: due || undefined, dbId })
    onClose()
  }

  const dueLabel = due ? new Date(due + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'No date'
  // Boards grouped by team, in team order; boards of no known team last.
  const groups = [...teams.map(t => ({ team: t, boards: takers.filter(b => b.conn?.id === t.id) })), { team: null, boards: takers.filter(b => !b.conn || !teams.some(t => t.id === b.conn!.id)) }]
    .filter(g => g.boards.length > 0)

  return (
    <div className="fixed inset-0 z-[9050] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 overflow-y-auto max-h-[92vh] kb-room max-w-3xl w-full mx-auto">
        <div className="px-5 pb-10 pt-3">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />
          <h2 className="text-base font-bold text-white mb-5">New Task</h2>
          <div className="flex flex-col gap-5">
            {takers.length > 1 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Where</span>
                {groups.map(g => (
                  <div key={g.team?.id ?? 'none'} className="flex items-center gap-2 overflow-x-auto pb-0.5 scrollbar-hide">
                    {g.team && teams.length > 1 && (
                      <span className="flex-shrink-0 inline-flex items-center gap-1.5 text-sm text-white/45 pr-1">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: g.team.color }} />{g.team.name}
                      </span>
                    )}
                    {g.boards.map(db => (
                      <button type="button" key={db.id} onClick={() => pickDb(db.id)}
                        className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95
                          ${dbId === db.id
                            ? 'bg-green-500/20 text-green-200 border-green-500/40'
                            : 'bg-white/[0.04] text-white/40 border-transparent active:bg-white/10'}`}>
                        {db.icon && !/^https?:/.test(db.icon) && <span>{db.icon}</span>}
                        <span className="truncate max-w-[9rem]">{db.title}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <label className="flex flex-col gap-2">
              <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Title</span>
              <TouchInput value={title} onChange={setTitle} commitOn="change"
                placeholder="Task name…"
                ariaLabel="Task title"
                className="bg-white/10 text-white placeholder-white/20 rounded-xl px-4 py-4 text-sm outline-none focus:ring-2 focus:ring-green-400" />
            </label>
            {activeSchema.statusKey && activeSchema.statusOptions.length > 0 && (
              <ChipRow label="Status" options={activeSchema.statusOptions} value={status ?? null} onChange={v => setStatus(v ?? undefined)} />
            )}
            {activeSchema.priorityKey && activeSchema.priorityOptions.length > 0 && (
              <ChipRow label="Priority" options={activeSchema.priorityOptions} value={priority ?? null} onChange={v => setPriority(v ?? undefined)} allowNone />
            )}
            {activeSchema.dueKey && (
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/35 uppercase tracking-wider font-medium">Due date</span>
                <div className="flex gap-2">
                  {[{ label: 'Today', days: 0 }, { label: 'Tomorrow', days: 1 }, { label: 'Next week', days: 7 }].map(({ label, days }) => {
                    const iso = isoInDays(days)
                    const active = due === iso
                    return (
                      <button key={label} type="button"
                        onClick={() => { setDue(active ? '' : iso); setShowCal(false) }}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors
                          ${active ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/60 active:bg-white/10'}`}>
                        {label}
                      </button>
                    )
                  })}
                </div>
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
