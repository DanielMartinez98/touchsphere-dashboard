import { useState, useEffect, useCallback } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { Workspace, WorkspaceItem } from './notion-types'

// ── Tile renderer ────────────────────────────────────────────────────────────

function Tile({
  item, kind, onTap,
}: {
  item: WorkspaceItem
  kind: 'page' | 'database'
  onTap: () => void
}) {
  return (
    <button type="button" onClick={onTap}
      className="w-full text-left flex items-center gap-3 bg-white/[0.04] rounded-xl px-3 py-3 active:bg-white/[0.09] active:scale-[0.99] transition-all">
      <span className="text-lg flex-shrink-0">
        {item.icon?.type === 'emoji' ? item.icon.value
          : item.icon?.type === 'url' ? <img src={item.icon.value} alt="" className="w-5 h-5 rounded inline" />
          : kind === 'database' ? '🗄️' : '📄'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{item.title}</p>
        <p className="text-[10px] text-white/30 uppercase tracking-wider">{kind}</p>
      </div>
      <span className="text-white/20 text-sm">›</span>
    </button>
  )
}

export default function BrowseView({ client }: { client: NotionClient }) {
  const [ws,      setWs]      = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [tab,     setTab]     = useState<'all' | 'databases' | 'pages'>('all')

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try { setWs(await client.getWorkspace(force)) }
    catch (e: any) { setError(e.message ?? 'Failed to load workspace') }
    finally { setLoading(false) }
  }, [client])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="flex justify-center py-12"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error || !ws) {
    return <p className="text-sm text-red-400 px-4 py-6">{error ?? 'No workspace data'}</p>
  }

  // Top-level pages only — anything whose parent is a workspace or another
  // accessible page that's also in our list. We surface root pages first; the
  // rest of the tree is reachable via the page's own child blocks.
  const allParentIds = new Set([...ws.pages.map(p => p.id), ...ws.databases.map(d => d.id)])
  const rootPages = ws.pages.filter(p => {
    const parent = p.parent
    if (!parent) return true
    if (parent.type === 'workspace') return true
    if (parent.type === 'page_id'     && parent.page_id     && !allParentIds.has(parent.page_id))     return true
    if (parent.type === 'database_id' && parent.database_id && !allParentIds.has(parent.database_id)) return true
    return false
  })

  const showDbs   = tab === 'all' || tab === 'databases'
  const showPages = tab === 'all' || tab === 'pages'

  return (
    <div className="flex flex-col gap-3 px-1">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold text-white flex-1">Workspace</h2>
        <button type="button" onClick={() => load(true)}
          className="w-9 h-9 rounded-full bg-white/10 text-white/50 text-xl flex items-center justify-center active:scale-90">↺</button>
      </div>

      <div className="flex gap-1.5">
        {(['all', 'databases', 'pages'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded-full text-xs font-medium transition-colors
              ${tab === t ? 'bg-green-500 text-black' : 'bg-white/[0.07] text-white/45 active:bg-white/15'}`}>
            {t === 'all' ? `All (${ws.databases.length + rootPages.length})`
              : t === 'databases' ? `Databases (${ws.databases.length})`
              : `Pages (${rootPages.length})`}
          </button>
        ))}
      </div>

      {showDbs && ws.databases.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {tab === 'all' && <p className="text-[11px] text-white/30 uppercase tracking-wider px-1 mt-2">Databases</p>}
          {ws.databases.map(d => (
            <Tile key={d.id} item={d} kind="database"
                  onTap={() => client.navigate({ kind: 'database', id: d.id })} />
          ))}
        </div>
      )}

      {showPages && rootPages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {tab === 'all' && <p className="text-[11px] text-white/30 uppercase tracking-wider px-1 mt-2">Pages</p>}
          {rootPages.map(p => (
            <Tile key={p.id} item={p} kind="page"
                  onTap={() => client.navigate({ kind: 'page', id: p.id })} />
          ))}
        </div>
      )}

      {showPages && tab === 'pages' && rootPages.length === 0 && (
        <p className="text-sm text-white/30 italic text-center py-6">No top-level pages shared with this integration.</p>
      )}

      <p className="text-[10px] text-white/25 text-center pt-3">
        Share more pages or databases with your integration in Notion to see them here.
      </p>
    </div>
  )
}
