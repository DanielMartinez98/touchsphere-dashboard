import { useState, useEffect, useCallback } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { NotionPage } from './notion-types'
import BlockEditor from './BlockEditor'
import PropertyEditor from './PropertyEditor'

// Title input that commits on blur. The page title is a special property in
// Notion (always type='title'), edited inline at the top of the page.
function TitleInput({ value, onSave }: { value: string; onSave: (t: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      value={draft}
      placeholder="Untitled"
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft) }}
      className="w-full bg-transparent text-2xl font-bold text-white outline-none placeholder-white/20 focus:bg-white/[0.04] rounded px-1 py-1"
    />
  )
}

export default function PageView({ pageId, client }: { pageId: string; client: NotionClient }) {
  const [page,       setPage]       = useState<NotionPage | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [propsOpen,  setPropsOpen]  = useState(false)
  const [archConfirm, setArchConfirm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setPage(await client.getPage(pageId, true)) }
    catch (e: any) { setError(e.message ?? 'Failed to load page') }
    finally { setLoading(false) }
  }, [pageId, client])

  useEffect(() => { void load() }, [load])

  // Find the title-property key. Every Notion page has exactly one.
  const titleKey = page ? Object.keys(page.properties).find(k => page.properties[k]?.type === 'title') : null

  async function saveTitle(t: string) {
    if (!titleKey) return
    setPage(prev => prev ? { ...prev, title: t } : prev)
    await client.updatePage(pageId, {
      properties: { [titleKey]: { title: [{ type: 'text', text: { content: t } }] } },
    })
  }

  async function saveProperty(name: string, payload: any) {
    setPage(prev => prev ? {
      ...prev,
      properties: { ...prev.properties, [name]: { ...prev.properties[name], ...payload } },
    } : prev)
    await client.updatePage(pageId, { properties: { [name]: payload } })
  }

  async function archive() {
    await client.archivePage(pageId)
    client.back()
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20"><span className="w-9 h-9 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error || !page) {
    return <p className="text-sm text-red-400 px-4 py-6">{error ?? 'Page not found'}</p>
  }

  // Property entries to show in the collapsible "properties" section. We
  // exclude the title property because it's already rendered as the page title.
  const propEntries = Object.entries(page.properties).filter(([key]) => key !== titleKey)

  // Cover image — pulled to a thin band so the page header doesn't dominate.
  const cover = page.cover?.file?.url ?? page.cover?.external?.url

  return (
    <div className="flex flex-col gap-4 px-1">
      {cover && (
        <div className="-mx-4 h-24 overflow-hidden">
          <img src={cover} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      {/* Title row — emoji icon + editable title */}
      <div className="flex items-center gap-3 px-1">
        {page.icon?.type === 'emoji' && <span className="text-3xl flex-shrink-0">{page.icon.value}</span>}
        {page.icon?.type === 'url'   && <img src={page.icon.value} alt="" className="w-9 h-9 rounded flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <TitleInput value={page.title} onSave={saveTitle} />
        </div>
      </div>

      {/* Properties — collapsed by default. Database rows often have many. */}
      {propEntries.length > 0 && (
        <div className="px-1">
          <button type="button" onClick={() => setPropsOpen(o => !o)}
            className="text-xs text-white/45 active:text-white flex items-center gap-1.5">
            {propsOpen ? '▾' : '▸'} {propsOpen ? 'Hide' : 'Show'} {propEntries.length} propert{propEntries.length === 1 ? 'y' : 'ies'}
          </button>
          {propsOpen && (
            <div className="mt-3 flex flex-col gap-3.5 bg-white/[0.025] rounded-xl p-3 border border-white/[0.05]">
              {propEntries.map(([name, val]) => (
                <PropertyEditor
                  key={name}
                  name={name}
                  schema={val}
                  value={val}
                  onSave={payload => saveProperty(name, payload)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-white/[0.06]" />

      {/* Page body */}
      <BlockEditor pageId={pageId} client={client} />

      {/* Footer actions */}
      <div className="pt-4 border-t border-white/[0.06] flex flex-col gap-2 px-1">
        {page.url && (
          <a href={page.url} target="_blank" rel="noreferrer"
             className="text-center text-xs text-blue-400/70 active:text-blue-400">Open in Notion ↗</a>
        )}
        {archConfirm ? (
          <div className="flex gap-2">
            <button type="button" onClick={() => setArchConfirm(false)}
              className="flex-1 h-11 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
            <button type="button" onClick={archive}
              className="flex-1 h-11 rounded-xl bg-red-500 text-white text-sm font-bold active:bg-red-600">Archive</button>
          </div>
        ) : (
          <button type="button" onClick={() => setArchConfirm(true)}
            className="h-11 w-full rounded-xl bg-red-500/10 text-red-400/60 text-sm active:bg-red-500/20 active:text-red-400">
            Archive page…
          </button>
        )}
      </div>
    </div>
  )
}
