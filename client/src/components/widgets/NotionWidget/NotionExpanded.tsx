import { ChevronLeft, Search, Folders, LayoutList, Home } from 'lucide-react'
import type { NotionTask, NotionSchema, TaskFields, ProjectRef } from '../../../hooks/useNotion'
import { useNotionClient } from '../../../hooks/useNotionClient'
import HomeView     from './HomeView'
import BrowseView   from './BrowseView'
import SearchView   from './SearchView'
import PageView     from './PageView'
import DatabaseView from './DatabaseView'
import GroupsView   from './GroupsView'

interface Props {
  schema:     NotionSchema | null
  tasks:      NotionTask[]
  projects:   Record<string, ProjectRef>
  loading:    boolean
  error:      string | null
  onUpdate:   (id: string, fields: TaskFields) => void
  onCreate:   (fields: { title: string; status?: string; priority?: string; due?: string }) => void
  onRefresh:  () => void
}

export default function NotionExpanded({
  schema, tasks, projects, loading, error, onUpdate, onCreate, onRefresh,
}: Props) {
  const client = useNotionClient()
  const view   = client.current

  // ── Top toolbar — context-aware back/search/home buttons ────────────────────

  const title =
    view.kind === 'home'     ? 'Notion' :
    view.kind === 'browse'   ? 'Browse' :
    view.kind === 'search'   ? 'Search' :
    view.kind === 'groups'   ? 'Groups' :
    view.kind === 'page'     ? 'Page'   :
    view.kind === 'database' ? 'Database' : ''

  return (
    <div className="flex flex-col h-full pt-16 relative">
      {/* Top bar — back, title, navigation icons. Tap home to reset. */}
      <div className="flex-shrink-0 px-4 pb-3 flex items-center gap-2">
        {client.canGoBack ? (
          <button type="button" onClick={client.back}
            className="w-11 h-11 rounded-full bg-glass-2 text-white/70 flex items-center justify-center active:scale-90"
            aria-label="Back"><ChevronLeft size={22} /></button>
        ) : (
          <div className="w-11 h-11" />
        )}
        <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/50 flex-1 truncate">{title}</span>
        <button type="button" onClick={() => client.replace({ kind: 'search' })}
          className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90
            ${view.kind === 'search' ? 'bg-green-500/30 text-green-300' : 'bg-glass-2 text-white/60'}`}
          aria-label="Search"><Search size={19} /></button>
        <button type="button" onClick={() => client.replace({ kind: 'groups' })}
          className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90
            ${view.kind === 'groups' ? 'bg-green-500/30 text-green-300' : 'bg-glass-2 text-white/60'}`}
          aria-label="Groups"><Folders size={19} /></button>
        <button type="button" onClick={() => client.replace({ kind: 'browse' })}
          className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90
            ${view.kind === 'browse' ? 'bg-green-500/30 text-green-300' : 'bg-glass-2 text-white/60'}`}
          aria-label="Browse"><LayoutList size={19} /></button>
        <button type="button" onClick={client.goHome}
          className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-90
            ${view.kind === 'home' ? 'bg-green-500/30 text-green-300' : 'bg-glass-2 text-white/60'}`}
          aria-label="Home"><Home size={19} /></button>
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
        {view.kind === 'home' && (
          <HomeView
            schema={schema}
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
        {view.kind === 'page'     && <PageView     pageId={view.id} client={client} />}
        {view.kind === 'database' && <DatabaseView dbId={view.id} client={client} />}
      </div>
    </div>
  )
}
