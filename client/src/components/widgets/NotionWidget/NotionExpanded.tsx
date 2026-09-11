import { useEffect, useState, useCallback, useRef } from 'react'
import { ChevronLeft, Search, LayoutList, ClipboardCheck, CalendarDays, Users } from 'lucide-react'
import type {
  NotionTask, NotionSchema, TaskFields, ProjectRef, NotionBoard, NotionTeam, CalendarItem, NotionErrorKind, NotionIdentity,
} from '../../../hooks/useNotion'
import { useNotionClient } from '../../../hooks/useNotionClient'
import MyWorkView   from './MyWorkView'
import AgendaView   from './AgendaView'
import TeamsView    from './TeamsView'
import BrowseView   from './BrowseView'
import SearchView   from './SearchView'
import PageView     from './PageView'
import DatabaseView from './DatabaseView'
import GroupsView   from './GroupsView'

interface Props {
  schema:     NotionSchema | null
  schemas:    Record<string, NotionSchema>
  boards:     NotionBoard[]
  teams:      NotionTeam[]
  tasks:      NotionTask[]
  items:      CalendarItem[]
  projects:   Record<string, ProjectRef>
  loading:    boolean
  error:      string | null
  errorKind:  NotionErrorKind | null
  me:         NotionIdentity | null
  onUpdate:   (id: string, fields: TaskFields) => void
  onCreate:   (fields: { title: string; status?: string; priority?: string; due?: string; dbId?: string }) => void
  onArchive?: (id: string) => void
  onRefresh:  () => void
  onRefreshSilent?: () => void
}

// The five tabs. Groups moved inside Browse (2026-09-11): it is a way of
// organising pages, which is what Browse is for, and the slot went to the
// Calendar and Teams. Labels drop below `sm` (a phone) and the icons stay —
// the rule Widget.tsx uses for the pills.
const TABS: { kind: 'home' | 'calendar' | 'teams' | 'browse' | 'search'; label: string; icon: React.ReactElement }[] = [
  { kind: 'home',     label: 'My work',  icon: <ClipboardCheck size={16} /> },
  { kind: 'calendar', label: 'Calendar', icon: <CalendarDays size={16} /> },
  { kind: 'teams',    label: 'Teams',    icon: <Users size={16} /> },
  { kind: 'browse',   label: 'Browse',   icon: <LayoutList size={16} /> },
  { kind: 'search',   label: 'Search',   icon: <Search size={16} /> },
]

const LS_TEAM = 'notion.team'

export default function NotionExpanded({
  schema, schemas, boards, teams, tasks, items, projects, loading, error, errorKind, me, onUpdate, onCreate, onArchive, onRefresh, onRefreshSilent,
}: Props) {
  const client = useNotionClient()
  const view   = client.current

  // Real title of the drilled-into page/database, reported up by the view once
  // its data loads. Reset on every navigation so a stale title never lingers.
  const [headerTitle, setHeaderTitle] = useState<string | null>(null)
  useEffect(() => { setHeaderTitle(null) }, [view])

  // The team filter every work view shares. Per device (localStorage): the
  // kiosk on the wall and the phone in a pocket can be looking at different
  // teams. A remembered team that no longer exists reads as "all".
  const [teamRaw, setTeamRaw] = useState<string | null>(() => { try { return localStorage.getItem(LS_TEAM) } catch { return null } })
  const team = teamRaw && teams.some(t => t.id === teamRaw) ? teamRaw : null
  const setTeam = useCallback((id: string | null) => {
    setTeamRaw(id)
    try { if (id) localStorage.setItem(LS_TEAM, id); else localStorage.removeItem(LS_TEAM) } catch { /* quota */ }
  }, [])

  // Where the Calendar opens (a day tapped on My work's strip) and how My
  // work opens when reached from a team card. Keys, so the views remount
  // with the new starting point rather than syncing state in an effect.
  const [agendaDay, setAgendaDay] = useState<string | null>(null)
  const [workFocus, setWorkFocus] = useState<{ project?: string; scope?: 'unassigned' | 'everyone'; key: number } | null>(null)

  // Each tab starts at its top. The views share one scroll container, and a
  // Calendar opened from the bottom of a long task list used to open scrolled
  // to its own bottom.
  const scroller = useRef<HTMLDivElement>(null)
  const viewId = view.kind === 'page' || view.kind === 'database' ? view.id : ''
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [view.kind, viewId])

  const openDay = useCallback((day: string) => { setAgendaDay(day); client.replace({ kind: 'calendar' }) }, [client])

  const drilled = view.kind === 'page' || view.kind === 'database'
  const title =
    view.kind === 'page'     ? (headerTitle ?? 'Page') :
    view.kind === 'database' ? (headerTitle ?? 'Database') : ''

  return (
    <div className="flex flex-col h-full pt-16 relative">
      {/* Title row — appears when drilled into a page/database */}
      {(drilled || client.canGoBack) && (
        <div className="flex-shrink-0 px-4 pb-2 flex items-center gap-2">
          {client.canGoBack ? (
            <button type="button" onClick={client.back}
              className="w-11 h-11 rounded-full bg-glass-2 text-white/70 flex items-center justify-center active:scale-90 shrink-0"
              aria-label="Back"><ChevronLeft size={22} /></button>
          ) : (
            <div className="w-11 h-11 shrink-0" />
          )}
          <span className="text-base font-semibold text-white flex-1 truncate">{title}</span>
        </div>
      )}

      {/* Main navigation — labeled segmented tabs */}
      <div className="flex-shrink-0 px-4 pb-3">
        <div className="flex gap-1 bg-white/[0.04] rounded-xl p-1">
          {TABS.map(t => {
            const active = view.kind === t.kind || (t.kind === 'browse' && view.kind === 'groups')
            return (
              <button key={t.kind} type="button"
                onClick={() => t.kind === 'home' ? client.goHome() : client.replace({ kind: t.kind })}
                aria-label={t.label}
                className={`flex-1 h-11 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors
                  ${active ? 'bg-green-500/25 text-green-200' : 'text-white/50 active:bg-white/[0.07]'}`}>
                {t.icon}<span className="hidden sm:inline">{t.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Active view */}
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-4 pb-6 scroll-fade-y">
        {view.kind === 'home' && (
          <MyWorkView
            key={workFocus?.key ?? 0}
            schema={schema}
            schemas={schemas}
            boards={boards}
            teams={teams}
            tasks={tasks}
            items={items}
            projects={projects}
            loading={loading}
            error={error}
            errorKind={errorKind}
            me={me}
            team={team}
            setTeam={setTeam}
            initialProject={workFocus?.project ?? null}
            initialScope={workFocus?.scope ?? 'mine'}
            client={client}
            onUpdate={onUpdate}
            onCreate={onCreate}
            onArchive={onArchive}
            onRefresh={onRefresh}
            onRefreshSilent={onRefreshSilent}
            onOpenDay={openDay}
          />
        )}
        {view.kind === 'calendar' && (
          <AgendaView
            key={agendaDay ?? 'today'}
            schema={schema}
            schemas={schemas}
            boards={boards}
            teams={teams}
            tasks={tasks}
            items={items}
            projects={projects}
            me={me}
            team={team}
            setTeam={setTeam}
            initialDay={agendaDay}
            client={client}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        )}
        {view.kind === 'teams' && (
          <TeamsView
            schemas={schemas}
            boards={boards}
            teams={teams}
            tasks={tasks}
            items={items}
            projects={projects}
            me={me}
            client={client}
            onOpenWork={(teamId, opts) => { setTeam(teamId); setWorkFocus({ ...opts, key: Date.now() }); client.goHome() }}
            onOpenCalendar={teamId => { setTeam(teamId); setAgendaDay(null); client.replace({ kind: 'calendar' }) }}
          />
        )}
        {view.kind === 'browse'   && <BrowseView   client={client} />}
        {view.kind === 'search'   && <SearchView   client={client} />}
        {view.kind === 'groups'   && <GroupsView   client={client} />}
        {view.kind === 'page'     && <PageView     pageId={view.id} client={client} onTitle={setHeaderTitle} />}
        {view.kind === 'database' && <DatabaseView dbId={view.id} client={client} onTitle={setHeaderTitle} />}
      </div>
    </div>
  )
}
