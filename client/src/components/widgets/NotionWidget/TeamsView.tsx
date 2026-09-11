import { useMemo } from 'react'
import { ChevronRight, TriangleAlert, ClipboardCheck, CalendarDays } from 'lucide-react'
import type {
  NotionTask, NotionSchema, ProjectRef, NotionBoard, NotionTeam, CalendarItem, NotionIdentity,
} from '../../../hooks/useNotion'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { byUrgency, fmtDue, fmtDay, isoInDays, todayKey, kindGlyph } from './task-utils'
import { buildEntries, ALL_LAYERS } from './agenda'

// ── Teams ────────────────────────────────────────────────────────────────────
// How each team is doing, one card per workspace: what I owe it, what is
// coming up on its boards, what nobody has picked up, its boards, and its
// projects where it has them. Every number is a door into My work or the
// Calendar narrowed to that team.

interface Props {
  schemas:  Record<string, NotionSchema>
  boards:   NotionBoard[]
  teams:    NotionTeam[]
  tasks:    NotionTask[]
  items:    CalendarItem[]
  projects: Record<string, ProjectRef>
  me:       NotionIdentity | null
  client:   NotionClient
  onOpenWork: (teamId: string, opts?: { project?: string; scope?: 'unassigned' | 'everyone' }) => void
  onOpenCalendar: (teamId: string) => void
}

export default function TeamsView({ schemas, boards, teams, tasks, items, projects, me, client, onOpenWork, onOpenCalendar }: Props) {
  const today = todayKey()
  const horizon = isoInDays(14)
  const entries = useMemo(() => buildEntries({ tasks, items, boards, teams, google: [], layers: ALL_LAYERS, onlyMine: !!me, team: null }), [tasks, items, boards, teams, me])

  if (teams.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-1">
        <h2 className="text-xl font-bold font-display text-white">Teams</h2>
        <p className="text-sm text-white/45">No Notion workspace connected. Add one in Settings → Notion.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-1 pb-6">
      <h2 className="text-xl font-bold font-display text-white">Teams</h2>
      {teams.map(tm => {
        const own = boards.filter(b => b.conn?.id === tm.id)
        const ownIds = new Set(own.map(b => b.id))
        const teamTasks = tasks.filter(t => ownIds.has(t.dbId))
        const open = teamTasks.filter(t => !t.done)
        const mine = open.filter(t => t.mine).sort(byUrgency)
        const overdue = mine.filter(t => t.due && t.due < today).length
        const unassigned = open.filter(t => t.unassigned).length
        const upcoming = entries.filter(e => e.teamId === tm.id && e.day >= today && e.day <= horizon && !e.done).slice(0, 5)
        const hasProjects = own.some(b => schemas[b.id]?.projectKey)
        const projectCounts = new Map<string, number>()
        if (hasProjects) for (const t of open) for (const id of t.projectIds) projectCounts.set(id, (projectCounts.get(id) ?? 0) + 1)
        const projectList = Array.from(projectCounts.entries()).map(([id, n]) => ({ p: projects[id], n, id })).filter(x => !!x.p).sort((a, b) => b.n - a.n)

        return (
          <div key={tm.id} className="rounded-2xl bg-white/[0.04] border border-white/[0.06] overflow-hidden">
            <div className="h-1.5" style={{ background: tm.color }} />
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-lg font-bold text-white truncate">{tm.name}</p>
                  {tm.workspace && tm.workspace !== tm.name && <p className="text-sm text-white/40 truncate">{tm.workspace}</p>}
                  {!tm.ok && (
                    <p className="text-sm text-red-300/90 mt-1 flex items-center gap-1.5"><TriangleAlert size={14} /> {tm.error ?? 'This workspace did not answer'}</p>
                  )}
                </div>
                <button type="button" onClick={() => onOpenWork(tm.id)}
                  className="h-11 px-3.5 rounded-full bg-glass-2 text-white/80 text-sm font-semibold flex items-center gap-1 active:scale-95 shrink-0">
                  <ClipboardCheck size={16} /> {mine.length}{overdue > 0 && <span className="text-red-300"> · {overdue} late</span>}
                </button>
                <button type="button" onClick={() => onOpenCalendar(tm.id)} aria-label="Calendar"
                  className="w-11 h-11 rounded-full bg-glass-2 text-white/70 flex items-center justify-center active:scale-95 shrink-0">
                  <CalendarDays size={18} />
                </button>
              </div>

              {/* My tasks here: the top five. */}
              {mine.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/45">{me ? 'My tasks' : 'Open tasks'}</span>
                  {mine.slice(0, 5).map(t => {
                    const due = t.due ? fmtDue(t.due) : null
                    return (
                      <button key={t.id} type="button" onClick={() => client.navigate({ kind: 'page', id: t.id })}
                        className="flex items-center gap-2 text-left rounded-lg px-2 py-1.5 active:bg-white/[0.07]">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tm.color }} />
                        <span className="flex-1 min-w-0 text-[15px] text-white/85 truncate">{t.title}</span>
                        {due && <span className={`text-sm shrink-0 ${due.overdue ? 'text-red-300' : 'text-white/40'}`}>{due.label}</span>}
                      </button>
                    )
                  })}
                  {mine.length > 5 && (
                    <button type="button" onClick={() => onOpenWork(tm.id)} className="self-start text-sm text-white/45 px-2 py-1 active:text-white/80">
                      See all {mine.length} →
                    </button>
                  )}
                </div>
              )}
              {mine.length === 0 && open.length > 0 && me && (
                <p className="text-sm text-white/40">Nothing assigned to you here · {open.length} open for the team.</p>
              )}

              {/* Coming up on its calendars. */}
              {upcoming.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/45">Coming up</span>
                  {upcoming.map(e => (
                    <button key={e.key} type="button" onClick={() => e.task ? onOpenWork(tm.id) : e.item && client.navigate({ kind: 'page', id: e.item.id })}
                      className="flex items-center gap-2 text-left rounded-lg px-2 py-1.5 active:bg-white/[0.07]">
                      <span className="text-base leading-none">{kindGlyph(e.kind)}</span>
                      <span className="flex-1 min-w-0 text-[15px] text-white/85 truncate">{e.title}</span>
                      <span className="text-sm text-white/40 shrink-0">{e.dateLabel} · {fmtDay(e.day)}</span>
                    </button>
                  ))}
                </div>
              )}

              {unassigned > 0 && (
                <button type="button" onClick={() => onOpenWork(tm.id, { scope: 'unassigned' })}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 bg-amber-500/10 border border-amber-400/20 text-amber-100/90 text-sm active:bg-amber-500/20">
                  <span className="flex-1 text-left">{unassigned} task{unassigned === 1 ? '' : 's'} nobody has picked up</span>
                  <ChevronRight size={16} className="opacity-60" />
                </button>
              )}

              {/* Projects, where the team has a projects relation. */}
              {projectList.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/45">Projects</span>
                  <div className="flex gap-1.5 flex-wrap">
                    {projectList.map(({ p, n, id }) => (
                      <button key={id} type="button" onClick={() => onOpenWork(tm.id, { project: id, scope: 'everyone' })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-blue-500/15 text-blue-200/85 active:bg-blue-500/30">
                        <span>{p!.icon ?? '📁'}</span><span className="truncate max-w-[9rem]">{p!.title}</span><span className="opacity-60 tabular-nums">{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Boards. */}
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/45">Boards</span>
                {own.length === 0 && <p className="text-sm text-white/35">No boards yet — add one in Settings → Notion.</p>}
                {own.map(b => (
                  <button key={b.id} type="button" onClick={() => client.navigate({ kind: 'database', id: b.id })}
                    className="flex items-center gap-2 text-left rounded-lg px-2 py-2 active:bg-white/[0.07]">
                    <span className="text-base w-6 text-center">{b.icon && !/^https?:/.test(b.icon) ? b.icon : b.role === 'calendar' ? '📆' : '📋'}</span>
                    <span className="flex-1 min-w-0 text-[15px] text-white/85 truncate">{b.title}</span>
                    <span className={`text-[12px] px-2 py-0.5 rounded-full ${b.role === 'calendar' ? 'bg-purple-500/15 text-purple-200/80' : 'bg-green-500/15 text-green-200/80'}`}>
                      {b.role === 'calendar' ? 'calendar' : 'tasks'}{b.isDefault ? ' · default' : ''}
                    </span>
                    {b.unavailable
                      ? <span className="text-[12px] text-red-300/80">unavailable</span>
                      : <span className="text-sm text-white/35 tabular-nums w-8 text-right">{b.openCount}</span>}
                    <ChevronRight size={14} className="text-white/20" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
