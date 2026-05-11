import { useState, useEffect, useRef } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { SearchResult, WorkspaceItem } from './notion-types'
import { TouchInput } from '../../TouchInput'
import Tile from './Tile'
import AddToGroupSheet from './AddToGroupSheet'
import { useNotionGroups } from '../../../hooks/useNotionGroups'

export default function SearchView({ client }: { client: NotionClient }) {
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<'all' | 'page' | 'database'>('all')
  const [adding,  setAdding]  = useState<{ item: WorkspaceItem; kind: 'page' | 'database' } | null>(null)
  const seq = useRef(0)
  const groups = useNotionGroups()

  // Debounce — Notion's search is rate-limited per-integration; 250ms keeps it
  // responsive without flooding. seq guards against out-of-order responses.
  useEffect(() => {
    const q = client.query.trim()
    if (q === '') { setResults([]); setError(null); return }
    const my = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const out = await client.search(q, filter === 'all' ? undefined : filter)
        if (my === seq.current) { setResults(out); setError(null) }
      } catch (e: any) {
        if (my === seq.current) setError(e.message ?? 'Search failed')
      } finally {
        if (my === seq.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [client.query, filter, client])

  return (
    <div className="flex flex-col gap-3 px-1">
      <div className="flex gap-2 items-center">
        <TouchInput
          value={client.query}
          onChange={client.setQuery}
          placeholder="Search workspace…"
          commitOn="change"
          ariaLabel="Search workspace"
          className="flex-1 bg-white/[0.06] text-white text-sm rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-white/20 placeholder-white/30"
        />
        {client.query && (
          <button type="button" onClick={() => client.setQuery('')}
            className="text-xs text-white/40 active:text-white/70 px-2">clear</button>
        )}
      </div>

      <div className="flex gap-1.5">
        {(['all', 'page', 'database'] as const).map(f => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors
              ${filter === f ? 'bg-green-500 text-black' : 'bg-white/[0.07] text-white/45 active:bg-white/15'}`}>
            {f === 'all' ? 'All' : f === 'page' ? 'Pages' : 'Databases'}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-6">
          <span className="w-6 h-6 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
        </div>
      )}
      {error && <p className="text-sm text-red-400 px-1">{error}</p>}

      {!loading && client.query && results.length === 0 && !error && (
        <p className="text-sm text-white/30 italic text-center py-6">No matches.</p>
      )}

      {!client.query && (
        <p className="text-sm text-white/35 italic text-center py-6">Type to search across your workspace.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {results.map(r => {
          const kind = r.object === 'database' ? 'database' : 'page'
          const item: WorkspaceItem = { id: r.id, title: r.title, icon: r.icon, url: r.url, parent: r.parent }
          return (
            <Tile key={r.id} title={r.title} icon={r.icon} kind={kind}
              inGroupCount={groups.groupsContaining(r.id).length}
              onTap={() => client.navigate(kind === 'database' ? { kind: 'database', id: r.id } : { kind: 'page', id: r.id })}
              onLongPress={() => setAdding({ item, kind })} />
          )
        })}
      </div>

      {adding && (
        <AddToGroupSheet
          item={adding.item}
          kind={adding.kind}
          groups={groups}
          onClose={() => setAdding(null)} />
      )}
    </div>
  )
}
