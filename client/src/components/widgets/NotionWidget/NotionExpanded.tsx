import { useEffect, useState } from 'react'
import { ChevronLeft, Search, Folders, LayoutList, Home } from 'lucide-react'
import type { NotionTask, NotionSchema, TaskFields, ProjectRef, TaskDbRef } from '../../../hooks/useNotion'
import { useNotionClient } from '../../../hooks/useNotionClient'
import HomeView     from './HomeView'
import BrowseView   from './BrowseView'
import SearchView   from './SearchView'
import PageView     from './PageView'
import DatabaseView from './DatabaseView'
import GroupsView   from './GroupsView'

interface Props {
  schema:     NotionSchema | null
  schemas:    Record<string, NotionSchema>
  taskDbs:    TaskDbRef[]
  tasks:      NotionTask[]
  projects:   Record<string, ProjectRef>
  loading:    boolean
  error:      string | null
  onUpdate:   (id: string, fields: TaskFields) => void
  onCreate:   (fields: { title: string; status?: string; priority?: string; due?: string; dbId?: string }) => void
  onRefresh:  () => void
}

const TABS: { kind: 'home' | 'groups' | 'browse' | 'search'; label: string; icon: React.ReactElement }[] = [
  { kind: 'home',   label: 'Home',   icon: <Home size={16} /> },
  { kind: 'groups', label: 'Groups', icon: <Folders size={16} /> },
  { kind: 'browse', label: 'Browse', icon: <LayoutList size={16} /> },
  { kind: 'search', label: 'Search', icon: <Search size={16} /> },
]

export default function NotionExpanded({
  schema, schemas, taskDbs, tasks, projects, loading, error, onUpdate, onCreate, onRefresh,
}: Props) {
  const client = useNotionClient()
  const view   = client.current

  // Real title of the drilled-into page/database, reported up by the view once
  // its data loads. Reset on every navigation so a stale title never lingers.
  const [headerTitle, setHeaderTitle] = useState<string | null>(null)
  useEffect(() => { setHeaderTitle(null) }, [view])

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
            const active = view.kind === t.kind
            return (
              <button key={t.kind} type="button"
                onClick={() => t.kind === 'home' ? client.goHome() : client.replace({ kind: t.kind })}
                className={`flex-1 h-11 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition-colors
                  ${active ? 'bg-green-500/25 text-green-200' : 'text-white/50 active:bg-white/[0.07]'}`}>
                {t.icon}{t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6 scroll-fade-y">
        {view.kind === 'home' && (
          <HomeView
            schema={schema}
            schemas={schemas}
            taskDbs={taskDbs}
            tasks={tasks}
            projects={projects}
            loading={loading}
            error={error}
            client={client}
            onUpdate={onUpdate}
            onCreate={onCreate}
            onRefresh={onRefresh}
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
