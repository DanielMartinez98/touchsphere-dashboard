import { useState, useEffect, useRef, useCallback } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { NotionBlock, RichText } from './notion-types'
import { colorBg, colorStyle, isBackground } from './notion-colors'

// ── Rich-text rendering (read-only annotations) ──────────────────────────────

function richText(rt: RichText[] | undefined): string {
  if (!rt) return ''
  return rt.map(r => r.plain_text).join('')
}

function RichTextSpan({ rt }: { rt: RichText[] | undefined }) {
  if (!rt || rt.length === 0) return null
  return (
    <>
      {rt.map((r, i) => {
        const a = r.annotations ?? {}
        const style: React.CSSProperties = { ...colorStyle(a.color), }
        let className = ''
        if (a.bold)          className += ' font-bold'
        if (a.italic)        className += ' italic'
        if (a.strikethrough) className += ' line-through'
        if (a.underline)     className += ' underline'
        if (a.code)          className += ' font-mono bg-white/10 px-1 rounded'
        if (r.href) {
          return <a key={i} href={r.href} target="_blank" rel="noreferrer" className={className + ' text-blue-400 underline'} style={style}>{r.plain_text}</a>
        }
        return <span key={i} className={className.trim()} style={style}>{r.plain_text}</span>
      })}
    </>
  )
}

// ── Inline text editor — single-line autosave on blur or Enter ───────────────

function EditableLine({
  value, placeholder, onSave, multiline = false, className = '', autoFocus = false,
}: {
  value:        string
  placeholder?: string
  onSave:       (text: string) => void
  multiline?:   boolean
  className?:   string
  autoFocus?:   boolean
}) {
  const [draft,   setDraft]   = useState(value)
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  // Sync external value updates when not editing.
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  function commit() {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }

  function autoSize() {
    if (multiline && ref.current && 'scrollHeight' in ref.current) {
      const el = ref.current as HTMLTextAreaElement
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }

  useEffect(() => { if (editing) autoSize() }, [editing, draft])

  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      ref={ref as any}
      autoFocus={autoFocus}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={e => { setDraft(e.target.value); if (multiline) autoSize() }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); (e.target as HTMLElement).blur() }
        if (e.key === 'Escape') { setDraft(value); setEditing(false); (e.target as HTMLElement).blur() }
      }}
      rows={multiline ? 1 : undefined}
      className={`w-full bg-transparent outline-none focus:bg-white/[0.04] focus:ring-1 focus:ring-white/15 rounded px-1.5 py-1 placeholder-white/20 resize-none ${className}`}
    />
  )
}

// ── Block-type metadata — what's editable, what icon to show in the picker ───

interface BlockKindDef { type: string; label: string; icon: string }

const BLOCK_KINDS: BlockKindDef[] = [
  { type: 'paragraph',          label: 'Text',         icon: '¶' },
  { type: 'heading_1',          label: 'Heading 1',    icon: 'H1' },
  { type: 'heading_2',          label: 'Heading 2',    icon: 'H2' },
  { type: 'heading_3',          label: 'Heading 3',    icon: 'H3' },
  { type: 'bulleted_list_item', label: 'Bulleted',     icon: '•' },
  { type: 'numbered_list_item', label: 'Numbered',     icon: '1.' },
  { type: 'to_do',              label: 'To-do',        icon: '☐' },
  { type: 'toggle',             label: 'Toggle',       icon: '▸' },
  { type: 'quote',              label: 'Quote',        icon: '"' },
  { type: 'callout',            label: 'Callout',      icon: '💡' },
  { type: 'divider',            label: 'Divider',      icon: '—' },
  { type: 'code',               label: 'Code',         icon: '</>' },
]

// ── Block insertion picker ────────────────────────────────────────────────────

function InsertMenu({ onPick, onClose }: { onPick: (type: string) => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-40"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-2">Insert block</h3>
        <div className="grid grid-cols-3 gap-2">
          {BLOCK_KINDS.map(k => (
            <button key={k.type} onClick={() => { onPick(k.type); onClose() }}
              className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-white/[0.05] active:bg-white/[0.12] active:scale-95 transition-all">
              <span className="text-lg text-white/80">{k.icon}</span>
              <span className="text-[11px] text-white/50">{k.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── A single block: render + inline edit + child fetching for containers ─────

function BlockView({
  block, client, depth, onUpdate, onDelete, listIndex,
}: {
  block:     NotionBlock
  client:    NotionClient
  depth:     number
  onUpdate:  (id: string, patch: any) => void
  onDelete:  (id: string) => void
  listIndex?: number
}) {
  const type = block.type
  const data = block[type] ?? {}
  const text = richText(data.rich_text)

  const [showActions, setShowActions] = useState(false)
  const [toggleOpen,  setToggleOpen]  = useState(false)
  const [children,    setChildren]    = useState<NotionBlock[] | null>(null)

  // Lazy-load children for containers (toggle, column, synced) when expanded.
  const loadChildren = useCallback(async () => {
    if (children !== null) return
    try {
      const page = await client.getBlocks(block.id)
      setChildren(page.results)
    } catch { setChildren([]) }
  }, [block.id, children, client])

  useEffect(() => {
    if (toggleOpen) void loadChildren()
  }, [toggleOpen, loadChildren])

  // Eagerly load children for non-toggle containers (column lists etc.).
  useEffect(() => {
    if (!block.has_children) return
    if (type === 'column_list' || type === 'column' || type === 'synced_block' || type === 'table' || type === 'child_database') return
    if (type === 'toggle') return
    void loadChildren()
  }, [block.has_children, type, loadChildren])

  // ── Helpers for save handlers ───────────────────────────────────────────────

  function saveText(newText: string) {
    onUpdate(block.id, { [type]: { rich_text: [{ type: 'text', text: { content: newText } }] } })
  }
  function saveCheck(checked: boolean) {
    onUpdate(block.id, { [type]: { checked } })
  }

  // ── Renderers per block type ────────────────────────────────────────────────

  let body: React.ReactNode = null
  let editable = true

  switch (type) {
    case 'paragraph':
      body = <EditableLine value={text} placeholder=" " multiline onSave={saveText} className="text-sm text-white/85 leading-relaxed" />
      break

    case 'heading_1':
      body = <EditableLine value={text} placeholder="Heading 1" onSave={saveText} className="text-2xl font-bold text-white" />
      break
    case 'heading_2':
      body = <EditableLine value={text} placeholder="Heading 2" onSave={saveText} className="text-xl font-bold text-white" />
      break
    case 'heading_3':
      body = <EditableLine value={text} placeholder="Heading 3" onSave={saveText} className="text-lg font-semibold text-white" />
      break

    case 'bulleted_list_item':
      body = (
        <div className="flex items-start gap-2">
          <span className="text-white/55 mt-1.5 select-none">•</span>
          <div className="flex-1"><EditableLine value={text} placeholder="List item" multiline onSave={saveText} className="text-sm text-white/85" /></div>
        </div>
      )
      break

    case 'numbered_list_item':
      body = (
        <div className="flex items-start gap-2">
          <span className="text-white/55 mt-1 select-none text-sm tabular-nums">{(listIndex ?? 0) + 1}.</span>
          <div className="flex-1"><EditableLine value={text} placeholder="List item" multiline onSave={saveText} className="text-sm text-white/85" /></div>
        </div>
      )
      break

    case 'to_do': {
      const checked = !!data.checked
      body = (
        <div className="flex items-start gap-2">
          <button type="button" onClick={() => saveCheck(!checked)}
            className={`flex-shrink-0 w-6 h-6 mt-0.5 rounded-md border-2 flex items-center justify-center text-xs transition-all
              ${checked ? 'bg-green-500/30 border-green-500/60 text-green-300' : 'border-white/30 active:bg-white/10'}`}>
            {checked && '✓'}
          </button>
          <div className="flex-1">
            <EditableLine value={text} placeholder="To-do" multiline onSave={saveText}
              className={`text-sm ${checked ? 'line-through text-white/35' : 'text-white/85'}`} />
          </div>
        </div>
      )
      break
    }

    case 'toggle':
      body = (
        <div>
          <div className="flex items-start gap-2">
            <button type="button" onClick={() => setToggleOpen(o => !o)} className="text-white/55 mt-0.5 w-5 select-none">
              {toggleOpen ? '▾' : '▸'}
            </button>
            <div className="flex-1"><EditableLine value={text} placeholder="Toggle" multiline onSave={saveText} className="text-sm text-white/85" /></div>
          </div>
          {toggleOpen && children && (
            <div className="ml-7 mt-2 space-y-1">
              {renderBlockList(children, client, depth + 1, onUpdate, onDelete)}
            </div>
          )}
          {toggleOpen && children === null && <p className="ml-7 text-xs text-white/30 mt-1">Loading…</p>}
        </div>
      )
      break

    case 'quote':
      body = (
        <div className="border-l-2 border-white/30 pl-3">
          <EditableLine value={text} placeholder="Quote" multiline onSave={saveText} className="text-sm text-white/75 italic" />
        </div>
      )
      break

    case 'callout': {
      const icon = data.icon?.emoji ?? data.icon?.external?.url ?? '💡'
      const colorBgVal = colorBg(data.color, 0.12)
      body = (
        <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: colorBgVal }}>
          <span className="text-lg flex-shrink-0">{typeof icon === 'string' && icon.length <= 4 ? icon : '💡'}</span>
          <div className="flex-1"><EditableLine value={text} placeholder="Callout" multiline onSave={saveText} className="text-sm text-white/85" /></div>
        </div>
      )
      break
    }

    case 'divider':
      editable = false
      body = <hr className="border-white/15" />
      break

    case 'code': {
      const lang = data.language ?? 'plain'
      body = (
        <div className="bg-black/40 rounded-lg p-3 border border-white/[0.06]">
          <div className="text-[10px] text-white/35 mb-1 uppercase tracking-wider">{lang}</div>
          <EditableLine value={text} placeholder="Code" multiline onSave={saveText}
            className="font-mono text-xs text-white/85" />
        </div>
      )
      break
    }

    case 'image': {
      const src = data.file?.url ?? data.external?.url
      const caption = richText(data.caption)
      editable = false
      body = src ? (
        <figure>
          <img src={src} alt={caption || 'Image'} className="rounded-lg max-h-72 w-auto" />
          {caption && <figcaption className="text-xs text-white/40 mt-1">{caption}</figcaption>}
        </figure>
      ) : <p className="text-xs text-white/30 italic">[image]</p>
      break
    }

    case 'video':
    case 'pdf':
    case 'file':
    case 'audio': {
      const src = data.file?.url ?? data.external?.url
      const name = data.name ?? richText(data.caption) ?? type
      editable = false
      body = src ? (
        <a href={src} target="_blank" rel="noreferrer"
           className="flex items-center gap-2 p-2 bg-white/[0.05] rounded-lg active:bg-white/10">
          <span>📎</span>
          <span className="text-sm text-blue-400 underline truncate">{name}</span>
        </a>
      ) : <p className="text-xs text-white/30 italic">[{type}]</p>
      break
    }

    case 'bookmark':
    case 'embed':
    case 'link_preview':
    case 'link_to_page': {
      const url = data.url ?? data.page_id
      editable = false
      body = url ? (
        <a href={typeof url === 'string' ? url : '#'} target="_blank" rel="noreferrer"
           className="block p-2 bg-white/[0.05] rounded-lg active:bg-white/10 text-sm text-blue-400 underline truncate">
          {typeof url === 'string' ? url : 'Link'}
        </a>
      ) : <p className="text-xs text-white/30 italic">[link]</p>
      break
    }

    case 'child_page':
      editable = false
      body = (
        <button type="button" onClick={() => client.navigate({ kind: 'page', id: block.id })}
          className="flex items-center gap-2 w-full text-left p-2 bg-white/[0.04] active:bg-white/10 rounded-lg">
          <span>📄</span>
          <span className="text-sm text-white/85 truncate">{data.title || 'Untitled'}</span>
        </button>
      )
      break

    case 'child_database':
      editable = false
      body = (
        <button type="button" onClick={() => client.navigate({ kind: 'database', id: block.id })}
          className="flex items-center gap-2 w-full text-left p-2 bg-white/[0.04] active:bg-white/10 rounded-lg">
          <span>🗄️</span>
          <span className="text-sm text-white/85 truncate">{data.title || 'Untitled database'}</span>
        </button>
      )
      break

    case 'column_list':
      editable = false
      // Stack columns vertically on the kiosk's narrow screen rather than render
      // them side-by-side (would be unreadable at 720px).
      body = children
        ? <div className="space-y-2">{renderBlockList(children, client, depth + 1, onUpdate, onDelete)}</div>
        : <p className="text-xs text-white/30 italic">Loading columns…</p>
      break

    case 'column':
      editable = false
      body = children
        ? <div className="space-y-1">{renderBlockList(children, client, depth + 1, onUpdate, onDelete)}</div>
        : <p className="text-xs text-white/30 italic">Loading…</p>
      break

    case 'synced_block':
      editable = false
      body = children
        ? <div className="space-y-1 border-l-2 border-blue-500/30 pl-2">{renderBlockList(children, client, depth + 1, onUpdate, onDelete)}</div>
        : <p className="text-xs text-white/30 italic">Loading synced block…</p>
      break

    case 'equation':
      editable = false
      body = <code className="bg-white/[0.06] rounded px-2 py-1 text-sm text-white/85 font-mono">{data.expression}</code>
      break

    case 'table_of_contents':
    case 'breadcrumb':
      editable = false
      body = <p className="text-xs text-white/35 italic">[{type.replace('_', ' ')}]</p>
      break

    case 'table':
      editable = false
      body = children
        ? <div className="space-y-1 text-xs">{renderBlockList(children, client, depth + 1, onUpdate, onDelete)}</div>
        : <p className="text-xs text-white/30 italic">Loading table…</p>
      break

    case 'table_row': {
      const cells = (data.cells ?? []) as RichText[][]
      editable = false
      body = (
        <div className="flex gap-2 border-b border-white/[0.06] py-1">
          {cells.map((cell, i) => (
            <div key={i} className="flex-1 min-w-0 text-white/75 truncate"><RichTextSpan rt={cell} /></div>
          ))}
        </div>
      )
      break
    }

    default:
      body = (
        <div className="text-xs text-white/40 italic">
          [{type}{text && `: ${text.slice(0, 40)}`}]
        </div>
      )
      editable = false
  }

  // Apply background color tint at the block level for paragraphs/headings/etc.
  const blockColor = data.color
  const hasBgColor = isBackground(blockColor)
  const wrapperStyle: React.CSSProperties = hasBgColor
    ? { background: colorBg(blockColor, 0.10), borderRadius: 6, padding: '4px 6px' }
    : {}

  return (
    <div className="group relative" style={wrapperStyle}
         onTouchStart={() => setShowActions(true)}
         onMouseEnter={() => setShowActions(true)}
         onMouseLeave={() => setShowActions(false)}>
      {body}
      {editable && showActions && (
        <button type="button" onClick={() => onDelete(block.id)}
          className="absolute -right-1 top-0 w-6 h-6 rounded-full bg-red-500/20 text-red-300 text-xs active:bg-red-500/40"
          aria-label="Delete block">×</button>
      )}
    </div>
  )
}

// Render a flat list of blocks, tracking the running numbered-list index so
// numbered items show "1. 2. 3." within the same run.
function renderBlockList(
  blocks: NotionBlock[],
  client: NotionClient,
  depth: number,
  onUpdate: (id: string, patch: any) => void,
  onDelete: (id: string) => void,
): React.ReactNode {
  let numberedRun = 0
  return blocks.map(b => {
    let listIndex: number | undefined
    if (b.type === 'numbered_list_item') {
      listIndex = numberedRun
      numberedRun++
    } else {
      numberedRun = 0
    }
    return <BlockView key={b.id} block={b} client={client} depth={depth} onUpdate={onUpdate} onDelete={onDelete} listIndex={listIndex} />
  })
}

// ── Top-level page block editor ──────────────────────────────────────────────

export default function BlockEditor({
  pageId, client,
}: {
  pageId: string
  client: NotionClient
}) {
  const [blocks,    setBlocks]    = useState<NotionBlock[] | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [hasMore,   setHasMore]   = useState(false)
  const [cursor,    setCursor]    = useState<string | null>(null)
  const [picker,    setPicker]    = useState(false)

  const load = useCallback(async (append = false) => {
    if (!append) setLoading(true)
    setError(null)
    try {
      const data = await client.getBlocks(pageId, append ? cursor ?? undefined : undefined)
      setBlocks(prev => append && prev ? [...prev, ...data.results] : data.results)
      setHasMore(data.has_more)
      setCursor(data.next_cursor)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load blocks')
    } finally {
      setLoading(false)
    }
  }, [pageId, client, cursor])

  useEffect(() => { void load(false) }, [pageId])

  async function handleUpdate(id: string, patch: any) {
    // Optimistic merge — the patch is shaped exactly like a block update body,
    // so we deep-merge into the matching block. This keeps the UI instant.
    setBlocks(prev => prev ? prev.map(b => {
      if (b.id !== id) return b
      const next = { ...b }
      for (const k of Object.keys(patch)) {
        next[k] = { ...next[k], ...patch[k] }
      }
      return next
    }) : prev)
    try { await client.updateBlock(id, patch) }
    catch { void load(false) }
  }

  async function handleDelete(id: string) {
    setBlocks(prev => prev ? prev.filter(b => b.id !== id) : prev)
    try { await client.deleteBlock(id) }
    catch { void load(false) }
  }

  async function handleInsert(type: string) {
    const block = type === 'divider'
      ? { object: 'block', type: 'divider', divider: {} }
      : type === 'code'
        ? { object: 'block', type: 'code', code: { rich_text: [], language: 'plain text' } }
        : type === 'callout'
          ? { object: 'block', type: 'callout', callout: { rich_text: [], icon: { type: 'emoji', emoji: '💡' } } }
          : type === 'to_do'
            ? { object: 'block', type: 'to_do', to_do: { rich_text: [], checked: false } }
            : client.textBlock(type, '')
    try {
      const { results } = await client.appendBlocks(pageId, [block])
      setBlocks(prev => prev ? [...prev, ...results] : results)
    } catch (e: any) {
      setError(e.message ?? 'Failed to add block')
    }
  }

  if (loading && !blocks) {
    return <div className="flex items-center justify-center py-10"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error) {
    return <p className="text-sm text-red-400 px-1">{error}</p>
  }
  if (!blocks) return null

  return (
    <div className="space-y-1.5 relative">
      {blocks.length === 0 && (
        <p className="text-sm text-white/30 italic px-1">This page is empty. Tap + to add a block.</p>
      )}
      {renderBlockList(blocks, client, 0, handleUpdate, handleDelete)}

      {hasMore && (
        <button type="button" onClick={() => load(true)}
          className="w-full text-xs text-white/40 py-2 active:text-white/70">
          Load more blocks…
        </button>
      )}

      <button type="button" onClick={() => setPicker(true)}
        className="w-full mt-3 py-3 rounded-xl border-2 border-dashed border-white/15 text-white/45 text-sm active:bg-white/5 active:border-white/25">
        + Add block
      </button>

      {picker && <InsertMenu onPick={handleInsert} onClose={() => setPicker(false)} />}
    </div>
  )
}
