import { useEffect, useRef, useState } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { SearchResult } from './notion-types'
import { TouchInput } from '../../TouchInput'

// Workspace search picker — used by both link_to_page block creation and the
// @mention "Page" tab. Renders as a bottom sheet so it can layer over any
// surface, but the caller can also embed it inline by passing inline=true.

export default function LinkToPagePicker({
  client, kindFilter, onPick, onClose, inline = false, title = 'Pick a page',
}: {
  client:      NotionClient
  // Restrict results to page or database only — default is both.
  kindFilter?: 'page' | 'database'
  onPick:      (result: SearchResult) => void
  onClose:     () => void
  inline?:     boolean
  title?:      string
}) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const my = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const out = await client.search(query, kindFilter)
        if (my === seq.current) setResults(out)
      } catch { /* surface no error UI — search is best-effort */ }
      finally  { if (my === seq.current) setLoading(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [query, kindFilter, client])

  const list = (
    <div className="flex flex-col gap-3">
      <TouchInput value={query} onChange={setQuery} commitOn="change"
        placeholder="Search workspace…"
        ariaLabel="Search pages"
        className="bg-white/[0.06] text-white rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-white/20 placeholder-white/30" />
      {loading && (
        <div className="flex justify-center py-4">
          <span className="w-6 h-6 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
        </div>
      )}
      <div className="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto">
        {results.map(r => (
          <button key={r.id} type="button"
            onClick={() => { onPick(r); onClose() }}
            className="w-full text-left flex items-center gap-3 bg-white/[0.04] rounded-xl px-3 py-2.5 active:bg-white/[0.09]">
            <span className="text-base flex-shrink-0">
              {r.icon?.type === 'emoji' ? r.icon.value : r.object === 'database' ? '🗄️' : '📄'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{r.title}</p>
              <p className="text-[10px] text-white/35 uppercase tracking-wider">{r.object}</p>
            </div>
          </button>
        ))}
        {!loading && results.length === 0 && (
          <p className="text-xs text-white/35 italic text-center py-4">
            {query ? 'No matches.' : 'Type to search.'}
          </p>
        )}
      </div>
    </div>
  )

  if (inline) return list

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50 max-h-[85vh] overflow-hidden flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-1">{title}</h3>
        {list}
      </div>
    </div>
  )
}
