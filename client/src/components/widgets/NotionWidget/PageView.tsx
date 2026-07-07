import { useState, useEffect, useCallback } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { NotionPage, WorkspaceItem } from './notion-types'
import BlockEditor from './BlockEditor'
import PropertyEditor from './PropertyEditor'
import { TouchInput } from '../../TouchInput'
import EmojiPicker from './EmojiPicker'
import CommentsSheet from './CommentsSheet'
import AddToGroupSheet from './AddToGroupSheet'
import { useNotionPins } from '../../../hooks/useNotionPins'
import { useNotionGroups } from '../../../hooks/useNotionGroups'

// Title input — opens TouchKeyboard on tap. Commits on Done.
function TitleInput({ value, onSave }: { value: string; onSave: (t: string) => void }) {
  return (
    <TouchInput
      value={value}
      onChange={onSave}
      placeholder="Untitled"
      ariaLabel="Page title"
      className="w-full bg-transparent text-2xl font-bold text-white outline-none placeholder-white/20 focus:bg-white/[0.04] rounded px-1 py-1"
    />
  )
}

export default function PageView({ pageId, client, onTitle }: { pageId: string; client: NotionClient; onTitle?: (t: string) => void }) {
  const [page,        setPage]        = useState<NotionPage | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [propsOpen,   setPropsOpen]   = useState(false)
  const [archConfirm, setArchConfirm] = useState(false)
  const [showIcon,    setShowIcon]    = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [moreOpen,    setMoreOpen]    = useState(false)
  const [showGroups,   setShowGroups]   = useState(false)
  const pins   = useNotionPins()
  const groups = useNotionGroups()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setPage(await client.getPage(pageId, true)) }
    catch (e: any) { setError(e.message ?? 'Failed to load page') }
    finally { setLoading(false) }
  }, [pageId, client])

  useEffect(() => { void load() }, [load])

  // Surface the real title in the widget's fixed header.
  useEffect(() => {
    if (page) onTitle?.(page.title || 'Untitled')
  }, [page?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  // Record visit in recents once the page is loaded.
  useEffect(() => {
    if (!page) return
    pins.recordVisit({
      id:    page.id,
      title: page.title,
      icon:  page.icon?.type === 'emoji' ? page.icon.value : null,
      kind:  'page',
    })
  }, [page?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  async function setIcon(emoji: string | null) {
    setPage(prev => prev ? { ...prev, icon: emoji ? { type: 'emoji', value: emoji } : null } : prev)
    await client.updatePage(pageId, { icon: emoji ? { type: 'emoji', emoji } : null })
  }

  async function archive() {
    await client.archivePage(pageId)
    client.back()
  }

  async function duplicate() {
    setMoreOpen(false)
    const { id } = await client.duplicatePage(pageId)
    client.replace({ kind: 'page', id })
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20"><span className="w-9 h-9 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error || !page) {
    return <p className="text-sm text-red-400 px-4 py-6">{error ?? 'Page not found'}</p>
  }

  const propEntries = Object.entries(page.properties).filter(([key]) => key !== titleKey)
  const cover = page.cover?.file?.url ?? page.cover?.external?.url
  // Number of groups this page belongs to — drives the "📁 In N groups" chip.
  const groupCount = groups.groupsContaining(page.id).length
  const pageAsItem: WorkspaceItem = {
    id:    page.id,
    title: page.title,
    icon:  page.icon,
    url:   page.url,
    parent: page.parent,
  }

  return (
    <div className="flex flex-col gap-4 px-1">
      {cover && (
        <div className="-mx-4 h-24 overflow-hidden">
          <img src={cover} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      {/* Title row — emoji icon (tappable to change), editable title, action chips */}
      <div className="flex items-start gap-2 px-1">
        <button type="button" onClick={() => setShowIcon(true)}
          className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-white/[0.04] active:bg-white/10 text-2xl"
          aria-label="Change page icon">
          {page.icon?.type === 'emoji' ? page.icon.value
            : page.icon?.type === 'url' ? <img src={page.icon.value} alt="" className="w-7 h-7 rounded" />
            : '📄'}
        </button>
        <div className="flex-1 min-w-0">
          <TitleInput value={page.title} onSave={saveTitle} />
        </div>
      </div>

      <div className="flex gap-1.5 px-1">
        <button type="button" onClick={() => setShowGroups(true)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium ${groupCount > 0 ? 'bg-yellow-500/25 text-yellow-300' : 'bg-white/[0.06] text-white/55 active:bg-white/10'}`}>
          {groupCount > 0 ? `📁 In ${groupCount} group${groupCount === 1 ? '' : 's'}` : '📁 Add to group'}
        </button>
        <button type="button" onClick={() => setShowComments(true)}
          className="px-3 py-1.5 rounded-full bg-white/[0.06] text-white/55 text-xs font-medium active:bg-white/10">
          💬 Comments
        </button>
        <button type="button" onClick={() => setMoreOpen(o => !o)}
          className="px-3 py-1.5 rounded-full bg-white/[0.06] text-white/55 text-xs font-medium active:bg-white/10">
          More…
        </button>
      </div>

      {moreOpen && (
        <div className="flex flex-col gap-1.5 bg-white/[0.025] rounded-xl p-2 border border-white/[0.05] mx-1">
          <button type="button" onClick={duplicate}
            className="text-left text-sm text-white/80 px-3 py-2 rounded-lg active:bg-white/[0.06]">📋 Duplicate page</button>
          {page.url && (
            <a href={page.url} target="_blank" rel="noreferrer"
               className="text-left text-sm text-blue-400 px-3 py-2 rounded-lg active:bg-white/[0.06]">↗ Open in Notion</a>
          )}
        </div>
      )}

      {/* Properties — collapsed by default */}
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

      {/* Footer — archive */}
      <div className="pt-4 border-t border-white/[0.06] flex flex-col gap-2 px-1">
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

      {showIcon && (
        <EmojiPicker
          current={page.icon?.type === 'emoji' ? page.icon.value : null}
          onPick={e => setIcon(e)}
          onClear={() => setIcon(null)}
          onClose={() => setShowIcon(false)}
        />
      )}
      {showComments && <CommentsSheet pageId={pageId} client={client} onClose={() => setShowComments(false)} />}
      {showGroups && (
        <AddToGroupSheet
          item={pageAsItem}
          kind="page"
          groups={groups}
          onClose={() => setShowGroups(false)} />
      )}
    </div>
  )
}
