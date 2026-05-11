import { useState, useEffect, useCallback, useMemo } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import type { NotionBlock, RichText } from './notion-types'
import { colorBg, colorStyle, isBackground } from './notion-colors'
import { TouchInput } from '../../TouchInput'
import BlockColorMenu from './BlockColorMenu'
import SlashMenu, { type BlockKindDef } from './SlashMenu'
import LinkToPagePicker from './LinkToPagePicker'
import MentionPicker, { type MentionPick } from './MentionPicker'
import { detectMarkdown } from './markdown'
import { useVoiceCapture } from '../../../hooks/useVoiceCapture'
import { richTextWrite } from './notion-types'

// ── Rich-text rendering (read-only annotations) ──────────────────────────────

function richText(rt: RichText[] | undefined): string {
  if (!rt) return ''
  return rt.map(r => r.plain_text).join('')
}

function RichTextSpan({ rt, client }: { rt: RichText[] | undefined; client?: NotionClient }) {
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

        // Mentions — render as a chip. Page mentions navigate when client is
        // available; date mentions show as a formatted date; user mentions show
        // a tinted name. All fall back to plain text if shape is unfamiliar.
        const raw = r as any
        if (raw.type === 'mention') {
          const m = raw.mention
          if (m?.type === 'page' && m.page?.id) {
            const id = m.page.id as string
            const onTap = client ? () => client.navigate({ kind: 'page', id }) : undefined
            return (
              <button key={i} type="button" onClick={onTap}
                className={`${className} inline-flex items-center gap-1 px-1.5 py-px rounded bg-blue-500/20 text-blue-200 text-[0.95em] active:bg-blue-500/35`}
                style={style}>
                <span>📄</span><span>{r.plain_text || 'Untitled'}</span>
              </button>
            )
          }
          if (m?.type === 'date' && m.date?.start) {
            const d = new Date(m.date.start)
            const label = isNaN(d.getTime()) ? m.date.start : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            return <span key={i} className={`${className} inline-flex items-center gap-1 px-1.5 py-px rounded bg-purple-500/20 text-purple-200 text-[0.95em]`} style={style}>📅 {label}</span>
          }
          if (m?.type === 'user' && m.user?.name) {
            return <span key={i} className={`${className} inline-flex items-center gap-1 px-1.5 py-px rounded bg-yellow-500/20 text-yellow-200 text-[0.95em]`} style={style}>@{m.user.name}</span>
          }
        }
        if (r.href) {
          return <a key={i} href={r.href} target="_blank" rel="noreferrer" className={className + ' text-blue-400 underline'} style={style}>{r.plain_text}</a>
        }
        return <span key={i} className={className.trim()} style={style}>{r.plain_text}</span>
      })}
    </>
  )
}

// ── Inline text editor backed by the on-screen TouchKeyboard ─────────────────

function EditableLine({
  value, placeholder, onSave, multiline = false, className = '',
}: {
  value:        string
  placeholder?: string
  onSave:       (text: string) => void
  multiline?:   boolean
  className?:   string
}) {
  // For multi-line blocks size the textarea by line-count so it grows as the
  // user types. For single-line we let TouchInput render an input.
  const rows = multiline ? Math.min(8, Math.max(1, value.split('\n').length)) : undefined
  return (
    <TouchInput
      value={value}
      onChange={onSave}
      placeholder={placeholder}
      multiline={multiline}
      rows={rows}
      className={`w-full bg-transparent outline-none focus:bg-white/[0.04] focus:ring-1 focus:ring-white/15 rounded px-1.5 py-1 placeholder-white/20 resize-none ${className}`}
    />
  )
}

// (Block-kind catalog moved to ./markdown.ts so it can be reused by the slash
// menu and the markdown-shortcut detector. Insertion is now handled by
// SlashMenu + InsertSheets below.)

// ── Bottom sheets for block types that need extra input ──────────────────────

function UrlPromptSheet({
  title, placeholder, onSubmit, onClose,
}: { title: string; placeholder?: string; onSubmit: (url: string) => void; onClose: () => void }) {
  const [v, setV] = useState('')
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-1">{title}</h3>
        <TouchInput value={v} onChange={setV} commitOn="change"
          placeholder={placeholder ?? 'https://…'}
          ariaLabel={title}
          className="bg-white/[0.06] text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-white/20 placeholder-white/30 mb-3" />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose}
            className="h-11 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
          <button type="button" disabled={!v.trim()} onClick={() => { onSubmit(v.trim()); onClose() }}
            className="h-11 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Insert</button>
        </div>
      </div>
    </div>
  )
}

function TextPromptSheet({
  title, placeholder, multiline, onSubmit, onClose,
}: { title: string; placeholder?: string; multiline?: boolean; onSubmit: (text: string) => void; onClose: () => void }) {
  const [v, setV] = useState('')
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-1">{title}</h3>
        <TouchInput value={v} onChange={setV} commitOn="change"
          placeholder={placeholder}
          multiline={multiline}
          rows={multiline ? 4 : undefined}
          ariaLabel={title}
          className={`bg-white/[0.06] text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-white/20 placeholder-white/30 mb-3 ${multiline ? 'min-h-[6rem]' : ''}`} />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose}
            className="h-11 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
          <button type="button" disabled={!v.trim()} onClick={() => { onSubmit(v.trim()); onClose() }}
            className="h-11 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Create</button>
        </div>
      </div>
    </div>
  )
}

// ── A single block: render + inline edit + child fetching for containers ─────

function BlockView({
  block, client, depth, onUpdate, onDelete, onConvert, onMove, onIndent, onOutdent,
  onInsertAfter, listIndex, headings, canMoveUp, canMoveDown, canOutdent,
}: {
  block:        NotionBlock
  client:       NotionClient
  depth:        number
  onUpdate:     (id: string, patch: any) => void
  onDelete:     (id: string) => void
  onConvert:    (id: string, newType: string, content: string, extra?: Record<string, any>) => void
  onMove:       (id: string, dir: 'up' | 'down') => void
  onIndent:     (id: string) => void
  onOutdent:    (id: string) => void
  onInsertAfter:(id: string) => void
  listIndex?:   number
  // For breadcrumb / table_of_contents derived from the parent page's blocks.
  headings?:    Array<{ id: string; type: string; text: string }>
  canMoveUp:    boolean
  canMoveDown:  boolean
  canOutdent:   boolean
}) {
  const type = block.type
  const data = block[type] ?? {}
  const text = richText(data.rich_text)

  const [showActions, setShowActions] = useState(false)
  const [showColors,  setShowColors]  = useState(false)
  const [toggleOpen,  setToggleOpen]  = useState(false)
  const [children,    setChildren]    = useState<NotionBlock[] | null>(null)
  const [convertOpen, setConvertOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const voice = useVoiceCapture()

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

  // Preserve the first rich_text segment's annotations so re-saving text
  // (after a tap-edit) doesn't blow away bold/italic/code formatting.
  const currentAnnotations = (data.rich_text?.[0]?.annotations) ?? {}

  function saveText(newText: string) {
    // Markdown shortcuts: "# foo" → heading_1, "- foo" → bullet, etc. Detected
    // only on text-bearing blocks; the markdown utility filters by current type
    // so already-formatted lines don't keep re-converting.
    const md = detectMarkdown(newText, type)
    if (md && md.type !== type) {
      onConvert(block.id, md.type, md.content, md.extra)
      return
    }
    onUpdate(block.id, {
      [type]: { rich_text: [{ type: 'text', text: { content: newText }, annotations: currentAnnotations }] },
    })
  }

  // Voice-dictate: append the recognised text to the current block content.
  async function dictate() {
    if (!voice.supported) return
    const result = await voice.start()
    if (!result) return
    const combined = text ? `${text} ${result}` : result
    onUpdate(block.id, {
      [type]: { rich_text: [{ type: 'text', text: { content: combined }, annotations: currentAnnotations }] },
    })
  }

  // Insert a mention rich-text segment after the existing content. Notion
  // mentions can carry a hidden plain_text "@name" placeholder which we omit so
  // the API echoes back whatever the resolver returns.
  function insertMention(pick: MentionPick) {
    const existing = (data.rich_text ?? []) as any[]
    let segment: any
    if (pick.kind === 'page') {
      segment = { type: 'mention', mention: { type: 'page', page: { id: pick.id } } }
    } else if (pick.kind === 'date') {
      segment = { type: 'mention', mention: { type: 'date', date: { start: pick.iso } } }
    } else {
      segment = { type: 'mention', mention: { type: 'user', user: { id: pick.id } } }
    }
    // Insert a separating space so the mention doesn't fuse with prior text.
    const spaced = existing.length > 0 ? [...existing, { type: 'text', text: { content: ' ' } }, segment] : [segment]
    onUpdate(block.id, { [type]: { rich_text: spaced } })
  }
  function saveCheck(checked: boolean) {
    onUpdate(block.id, { [type]: { checked } })
  }

  // Toggle an annotation on the entire block's rich_text. Touch makes
  // selection-based formatting impractical, so block-wide formatting is the
  // pragmatic alternative.
  function toggleAnnotation(key: 'bold' | 'italic' | 'strikethrough' | 'underline' | 'code') {
    const next = { ...currentAnnotations, [key]: !currentAnnotations[key] }
    onUpdate(block.id, {
      [type]: { rich_text: [{ type: 'text', text: { content: text }, annotations: next }] },
    })
  }

  function setColor(color: string) {
    // For text-bearing blocks Notion stores color at the block level, not on
    // individual rich_text spans (where it would also work but is redundant).
    onUpdate(block.id, { [type]: { color } })
  }

  // Re-assemble the render context for nested children. The same handlers
  // apply at every depth — children-of-toggle, columns, synced blocks etc.
  const childCtx: RenderContext = {
    client, onUpdate, onDelete, onConvert, onMove, onIndent, onOutdent, onInsertAfter,
    headings: headings ?? [],
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
              {renderBlockList(children, childCtx, depth + 1)}
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
        ? <div className="space-y-2">{renderBlockList(children, childCtx, depth + 1)}</div>
        : <p className="text-xs text-white/30 italic">Loading columns…</p>
      break

    case 'column':
      editable = false
      body = children
        ? <div className="space-y-1">{renderBlockList(children, childCtx, depth + 1)}</div>
        : <p className="text-xs text-white/30 italic">Loading…</p>
      break

    case 'synced_block':
      editable = false
      body = children
        ? <div className="space-y-1 border-l-2 border-blue-500/30 pl-2">{renderBlockList(children, childCtx, depth + 1)}</div>
        : <p className="text-xs text-white/30 italic">Loading synced block…</p>
      break

    case 'equation':
      // LaTeX is plain text; render as monospace, edit via TouchInput. A future
      // pass will plug KaTeX in for proper math rendering.
      body = (
        <div className="bg-white/[0.06] rounded-lg p-2 border border-white/[0.06]">
          <div className="text-[10px] text-white/35 mb-1 uppercase tracking-wider">LaTeX</div>
          <EditableLine value={data.expression ?? ''} placeholder="\\frac{a}{b}" multiline
            onSave={v => onUpdate(block.id, { equation: { expression: v } })}
            className="font-mono text-sm text-white/85" />
        </div>
      )
      break

    case 'breadcrumb':
      // The actual parent chain requires walking the page hierarchy (async) —
      // PageView is going to render it above the title in a later phase. For
      // now show a clear marker so the block is visible.
      editable = false
      body = <p className="text-xs text-white/45 italic">📍 breadcrumb (parent chain rendered above the page)</p>
      break

    case 'table_of_contents':
      // Build a tappable outline from the page's headings list. Indent by
      // heading level so the visual nesting matches the document outline.
      editable = false
      if (!headings || headings.length === 0) {
        body = <p className="text-xs text-white/30 italic">📋 No headings yet — add a heading to populate the table of contents.</p>
      } else {
        body = (
          <div className="flex flex-col gap-0.5 bg-white/[0.03] rounded-lg p-2 border border-white/[0.05]">
            <div className="text-[10px] text-white/35 mb-1 uppercase tracking-wider">Contents</div>
            {headings.map(h => {
              const indent = h.type === 'heading_2' ? 'pl-3' : h.type === 'heading_3' ? 'pl-6' : ''
              return (
                <a key={h.id} href={`#${h.id}`}
                  className={`text-xs text-blue-300/85 active:text-blue-200 truncate ${indent}`}>
                  {h.text || '—'}
                </a>
              )
            })}
          </div>
        )
      }
      break

    case 'table':
      editable = false
      body = children
        ? <div className="space-y-1 text-xs">{renderBlockList(children, childCtx, depth + 1)}</div>
        : <p className="text-xs text-white/30 italic">Loading table…</p>
      break

    case 'table_row': {
      const cells = (data.cells ?? []) as RichText[][]
      editable = false
      body = (
        <div className="flex gap-2 border-b border-white/[0.06] py-1">
          {cells.map((cell, i) => (
            <div key={i} className="flex-1 min-w-0 text-white/75 truncate"><RichTextSpan rt={cell} client={client} /></div>
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

  // Apply text/background color at the block level for paragraphs/headings/etc.
  const blockColor = data.color
  const hasBgColor = isBackground(blockColor)
  const wrapperStyle: React.CSSProperties = (() => {
    if (!blockColor || blockColor === 'default') return {}
    if (hasBgColor) return { background: colorBg(blockColor, 0.10), borderRadius: 6, padding: '4px 6px' }
    // Foreground color — apply to the wrapper; child inputs inherit `color`.
    return { ...colorStyle(blockColor) }
  })()

  // Block types that support text annotations (bold/italic/etc.) and color.
  const TEXT_BLOCKS = new Set([
    'paragraph', 'heading_1', 'heading_2', 'heading_3',
    'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle',
    'quote', 'callout', 'code',
  ])
  const supportsFormatting = TEXT_BLOCKS.has(type)

  // Apply block-level annotation classes to the body wrapper. Block-wide
  // formatting matches what the toolbar lets you toggle; per-span annotations
  // are still rendered correctly because Notion writes them back into rich_text.
  let annotationClass = ''
  if (supportsFormatting) {
    if (currentAnnotations.bold)          annotationClass += ' [&_textarea]:font-bold [&_input]:font-bold'
    if (currentAnnotations.italic)        annotationClass += ' [&_textarea]:italic [&_input]:italic'
    if (currentAnnotations.strikethrough) annotationClass += ' [&_textarea]:line-through [&_input]:line-through'
    if (currentAnnotations.underline)     annotationClass += ' [&_textarea]:underline [&_input]:underline'
    if (currentAnnotations.code)          annotationClass += ' [&_textarea]:font-mono [&_input]:font-mono'
  }
  const bodyWrapperClass = `relative ${annotationClass}`

  return (
    <div className={`group ${bodyWrapperClass}`} style={wrapperStyle}
         onTouchStart={() => setShowActions(true)}
         onMouseEnter={() => setShowActions(true)}
         onMouseLeave={() => setShowActions(false)}>
      {body}
      {showActions && (
        // Two-row toolbar attached to the right edge of the block. Row 1 is
        // formatting (block-wide bold/italic/etc.); Row 2 is structure (move,
        // indent, convert, mention, voice, insert-after, delete). Splitting
        // the rows keeps tap targets at ≥24 px on the narrow kiosk.
        <div className="absolute -right-1 top-0 flex flex-col items-end gap-0.5 z-10">
          {editable && supportsFormatting && (
            <div className="flex gap-0.5">
              <FormatActions
                annotations={currentAnnotations}
                onToggle={toggleAnnotation}
                onColor={() => setShowColors(true)}
              />
            </div>
          )}
          <div className="flex gap-0.5 flex-wrap justify-end">
            <button type="button" onClick={() => onMove(block.id, 'up')} disabled={!canMoveUp}
              aria-label="Move up"
              className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20 disabled:opacity-25">↑</button>
            <button type="button" onClick={() => onMove(block.id, 'down')} disabled={!canMoveDown}
              aria-label="Move down"
              className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20 disabled:opacity-25">↓</button>
            <button type="button" onClick={() => onIndent(block.id)}
              aria-label="Indent"
              className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20">⇥</button>
            <button type="button" onClick={() => onOutdent(block.id)} disabled={!canOutdent}
              aria-label="Outdent"
              className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20 disabled:opacity-25">⇤</button>
            {editable && (
              <button type="button" onClick={() => setConvertOpen(true)}
                aria-label="Turn into"
                className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20">⇄</button>
            )}
            {editable && (
              <button type="button" onClick={() => setMentionOpen(true)}
                aria-label="Mention"
                className="w-6 h-6 rounded-full bg-white/10 text-white/55 text-xs active:bg-white/20">@</button>
            )}
            {editable && voice.supported && (
              <button type="button" onClick={() => void dictate()}
                aria-label="Dictate"
                className={`w-6 h-6 rounded-full text-xs active:scale-95
                  ${voice.listening ? 'bg-red-500 text-white animate-pulse' : 'bg-white/10 text-white/55 active:bg-white/20'}`}>🎤</button>
            )}
            <button type="button" onClick={() => onInsertAfter(block.id)}
              aria-label="Insert below"
              className="w-6 h-6 rounded-full bg-green-500/30 text-green-200 text-xs active:bg-green-500/50">+</button>
            <button type="button" onClick={() => onDelete(block.id)}
              aria-label="Delete block"
              className="w-6 h-6 rounded-full bg-red-500/20 text-red-300 text-xs active:bg-red-500/40">×</button>
          </div>
        </div>
      )}
      {showColors && (
        <BlockColorMenu
          current={blockColor}
          onPick={c => { setColor(c); setShowColors(false) }}
          onClose={() => setShowColors(false)}
        />
      )}
      {convertOpen && (
        <SlashMenu initialQuery=""
          onPick={k => {
            onConvert(block.id, k.type, text)
            setConvertOpen(false)
          }}
          onClose={() => setConvertOpen(false)} />
      )}
      {mentionOpen && (
        <MentionPicker client={client}
          onPick={p => { insertMention(p); setMentionOpen(false) }}
          onClose={() => setMentionOpen(false)} />
      )}
    </div>
  )
}

// Compact toolbar of annotation toggles. Each is a single-character chip;
// at touch sizes that's still a 24px target, fine for finger taps.
function FormatActions({
  annotations, onToggle, onColor,
}: {
  annotations: Record<string, any>
  onToggle:    (k: 'bold' | 'italic' | 'strikethrough' | 'underline' | 'code') => void
  onColor:     () => void
}) {
  const cls = (active: boolean) =>
    `w-6 h-6 rounded-full text-[11px] flex items-center justify-center
     ${active ? 'bg-blue-500/40 text-white' : 'bg-white/10 text-white/55 active:bg-white/20'}`
  return (
    <>
      <button type="button" onClick={() => onToggle('bold')}          aria-label="Bold"          className={`${cls(!!annotations.bold)} font-bold`}>B</button>
      <button type="button" onClick={() => onToggle('italic')}        aria-label="Italic"        className={`${cls(!!annotations.italic)} italic`}>I</button>
      <button type="button" onClick={() => onToggle('strikethrough')} aria-label="Strikethrough" className={`${cls(!!annotations.strikethrough)} line-through`}>S</button>
      <button type="button" onClick={() => onToggle('underline')}     aria-label="Underline"     className={`${cls(!!annotations.underline)} underline`}>U</button>
      <button type="button" onClick={() => onToggle('code')}          aria-label="Code"          className={`${cls(!!annotations.code)} font-mono text-[10px]`}>{'</>'}</button>
      <button type="button" onClick={onColor}                          aria-label="Color"         className={`${cls(false)}`}>🎨</button>
    </>
  )
}

// Aggregate of handlers + context passed through every recursive render. A
// single object keeps the renderBlockList signature short and the children
// pass-through trivial.
interface RenderContext {
  client:        NotionClient
  onUpdate:      (id: string, patch: any) => void
  onDelete:      (id: string) => void
  onConvert:     (id: string, newType: string, content: string, extra?: Record<string, any>) => void
  onMove:        (id: string, dir: 'up' | 'down') => void
  onIndent:      (id: string) => void
  onOutdent:     (id: string) => void
  onInsertAfter: (id: string) => void
  headings:      Array<{ id: string; type: string; text: string }>
}

// Render a flat list of blocks, tracking the running numbered-list index so
// numbered items show "1. 2. 3." within the same run.
function renderBlockList(
  blocks: NotionBlock[],
  ctx:    RenderContext,
  depth:  number,
): React.ReactNode {
  let numberedRun = 0
  return blocks.map((b, idx) => {
    let listIndex: number | undefined
    if (b.type === 'numbered_list_item') {
      listIndex = numberedRun
      numberedRun++
    } else {
      numberedRun = 0
    }
    return (
      <BlockView key={b.id} block={b}
        client={ctx.client}
        depth={depth}
        onUpdate={ctx.onUpdate}
        onDelete={ctx.onDelete}
        onConvert={ctx.onConvert}
        onMove={ctx.onMove}
        onIndent={ctx.onIndent}
        onOutdent={ctx.onOutdent}
        onInsertAfter={ctx.onInsertAfter}
        listIndex={listIndex}
        headings={ctx.headings}
        canMoveUp={idx > 0}
        canMoveDown={idx < blocks.length - 1}
        canOutdent={depth > 0}
      />
    )
  })
}

// Build a Notion block payload for either creation (with `object: 'block'` +
// `type`) or update/convert (without — Notion infers type from the wrapping
// key). The shape varies per type so we centralize it here.
function buildBlockBody(type: string, content: string, extra?: Record<string, any>): any {
  const rich_text = content ? [{ type: 'text', text: { content } }] : []
  switch (type) {
    case 'divider':           return { divider: {} }
    case 'code':              return { code: { rich_text, language: extra?.['language'] ?? 'plain text' } }
    case 'callout':           return { callout: { rich_text, icon: { type: 'emoji', emoji: extra?.['emoji'] ?? '💡' } } }
    case 'to_do':             return { to_do: { rich_text, checked: extra?.['checked'] ?? false } }
    case 'toggle':            return { toggle: { rich_text } }
    case 'breadcrumb':        return { breadcrumb: {} }
    case 'table_of_contents': return { table_of_contents: {} }
    case 'equation':          return { equation: { expression: content } }
    default:                  return { [type]: { rich_text, ...(extra ?? {}) } }
  }
}

function buildCreatePayload(type: string, content: string, extra?: Record<string, any>): any {
  return { object: 'block', type, ...buildBlockBody(type, content, extra) }
}

// ── Top-level page block editor ──────────────────────────────────────────────

// State for the secondary input sheets — the slash menu hands off to one of
// these when the user picks a block kind that needs more info (URL, LaTeX,
// title, etc.). `afterId` carries the sibling the new block should follow;
// null means "append to the end".
type SheetState =
  | { kind: 'none' }
  | { kind: 'slash';  afterId: string | null; query?: string }
  | { kind: 'image';  afterId: string | null }
  | { kind: 'video';  afterId: string | null }
  | { kind: 'file';   afterId: string | null }
  | { kind: 'bookmark'; afterId: string | null }
  | { kind: 'embed';  afterId: string | null }
  | { kind: 'equation'; afterId: string | null }
  | { kind: 'link_to_page'; afterId: string | null }
  | { kind: 'sub_page'; afterId: string | null }
  | { kind: 'inline_database'; afterId: string | null }

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
  const [sheet,     setSheet]     = useState<SheetState>({ kind: 'none' })

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

  // Headings flattened from the current block list, used by table_of_contents
  // rendering. Top-level only — TOC inside toggles isn't meaningful.
  const headings = useMemo(() => {
    return (blocks ?? [])
      .filter(b => b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3')
      .map(b => ({
        id: b.id,
        type: b.type,
        text: richText(b[b.type]?.rich_text),
      }))
  }, [blocks])

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

  // Convert: change the block's type in-place via PATCH. We also update the
  // local state optimistically so the conversion is instant.
  async function handleConvert(id: string, newType: string, content: string, extra?: Record<string, any>) {
    const body = buildBlockBody(newType, content, extra)
    setBlocks(prev => prev ? prev.map(b => {
      if (b.id !== id) return b
      const next: any = { ...b, type: newType, has_children: false }
      // Strip the old type's payload and apply the new one.
      delete next[b.type]
      Object.assign(next, body)
      return next
    }) : prev)
    try { await client.convertBlock(id, body) }
    catch { void load(false) }
  }

  // Move / indent / outdent — Notion has no native move endpoint so the server
  // clones the block at the target position and archives the original. The
  // block's id changes, so we just reload the page after the call.
  async function handleMove(id: string, dir: 'up' | 'down') {
    if (!blocks) return
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    try {
      if (dir === 'up' && idx > 0) {
        const target = blocks[idx - 1]!
        await client.moveBlock(id, { before: target.id })
      } else if (dir === 'down' && idx < blocks.length - 1) {
        const target = blocks[idx + 1]!
        await client.moveBlock(id, { after: target.id })
      }
      await load(false)
    } catch (e: any) { setError(e.message ?? 'Failed to move block') }
  }
  async function handleIndent(id: string) {
    try { await client.indentBlock(id); await load(false) }
    catch (e: any) { setError(e.message ?? 'Failed to indent block') }
  }
  async function handleOutdent(id: string) {
    try { await client.outdentBlock(id); await load(false) }
    catch (e: any) { setError(e.message ?? 'Failed to outdent block') }
  }

  // Insert a fresh block. `afterId === null` appends to the end of the page.
  async function insertAt(afterId: string | null, payload: any) {
    try {
      // Notion's append-children supports an `after` parameter. The server
      // route doesn't currently parse it, so for "after a specific block" we
      // append then move into place. Append-to-end is the common case.
      const { results } = await client.appendBlocks(pageId, [payload])
      if (afterId && results.length > 0) {
        // Newly appended block lands at the bottom; ask the server to move it.
        try { await client.moveBlock(results[0]!.id, { after: afterId }) }
        catch { /* tolerate */ }
        await load(false)
      } else {
        setBlocks(prev => prev ? [...prev, ...results] : results)
      }
    } catch (e: any) { setError(e.message ?? 'Failed to add block') }
  }

  // Slash-menu pick handler. Branches by `needsInput` to the right input sheet
  // or directly creates the block when no extra input is needed.
  function handleSlashPick(kind: BlockKindDef) {
    const afterId = sheet.kind === 'slash' ? sheet.afterId : null
    setSheet({ kind: 'none' })
    if (!kind.needsInput) {
      void insertAt(afterId, buildCreatePayload(kind.type, ''))
      return
    }
    // Re-open the relevant input sheet, preserving the insertion target.
    setSheet({ kind: kind.needsInput as SheetState['kind'], afterId } as SheetState)
  }

  // ── Sheet submit handlers (one per needsInput kind) ──────────────────────

  async function submitUrlBlock(type: 'image' | 'video' | 'file' | 'embed', url: string, afterId: string | null) {
    const payload: any = {
      object: 'block', type,
      [type]: { type: 'external', external: { url }, caption: [] },
    }
    await insertAt(afterId, payload)
  }
  async function submitBookmark(url: string, afterId: string | null) {
    // Fetch OG preview for caption text. Tolerate failure — the bookmark is
    // still useful with just the URL.
    let caption: any[] = []
    try {
      const og = await client.oembed(url)
      if (og.title && og.title !== url) caption = richTextWrite(og.title)
    } catch { /* tolerate */ }
    await insertAt(afterId, { object: 'block', type: 'bookmark', bookmark: { url, caption } })
  }
  async function submitEquation(expr: string, afterId: string | null) {
    await insertAt(afterId, { object: 'block', type: 'equation', equation: { expression: expr } })
  }
  async function submitLinkToPage(targetId: string, kindOfTarget: 'page' | 'database', afterId: string | null) {
    const payload: any = kindOfTarget === 'database'
      ? { object: 'block', type: 'link_to_page', link_to_page: { type: 'database_id', database_id: targetId } }
      : { object: 'block', type: 'link_to_page', link_to_page: { type: 'page_id',     page_id:     targetId } }
    await insertAt(afterId, payload)
  }
  async function submitSubPage(title: string, afterId: string | null) {
    // Create a new page under this one then refresh — the parent's child_page
    // block will show up in the next load.
    try {
      await client.createPage({
        parent:     { page_id: pageId },
        properties: { title: { title: richTextWrite(title) } },
      })
      void afterId  // ordering: a new sub-page lands at the end anyway
      await load(false)
    } catch (e: any) { setError(e.message ?? 'Failed to create sub-page') }
  }
  async function submitInlineDatabase(_title: string, afterId: string | null) {
    // The Notion API doesn't expose database creation via /pages — we'd need a
    // dedicated /databases POST. For now surface a clear note so the user
    // knows to create the DB in Notion proper.
    void afterId
    setError('Inline database creation is not yet supported via the API. Create the database in Notion and link to it instead.')
  }

  if (loading && !blocks) {
    return <div className="flex items-center justify-center py-10"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2 px-1">
        <p className="text-sm text-red-400">{error}</p>
        <button type="button" onClick={() => { setError(null); void load(false) }}
          className="self-start text-xs text-white/55 active:text-white/85">Retry</button>
      </div>
    )
  }
  if (!blocks) return null

  const ctx: RenderContext = {
    client,
    onUpdate:      handleUpdate,
    onDelete:      handleDelete,
    onConvert:     handleConvert,
    onMove:        handleMove,
    onIndent:      handleIndent,
    onOutdent:     handleOutdent,
    onInsertAfter: id => setSheet({ kind: 'slash', afterId: id }),
    headings,
  }

  return (
    <div className="space-y-1.5 relative">
      {blocks.length === 0 && (
        <p className="text-sm text-white/30 italic px-1">This page is empty. Tap + to add a block.</p>
      )}
      {renderBlockList(blocks, ctx, 0)}

      {hasMore && (
        <button type="button" onClick={() => load(true)}
          className="w-full text-xs text-white/40 py-2 active:text-white/70">
          Load more blocks…
        </button>
      )}

      <button type="button" onClick={() => setSheet({ kind: 'slash', afterId: null })}
        className="w-full mt-3 py-3 rounded-xl border-2 border-dashed border-white/15 text-white/45 text-sm active:bg-white/5 active:border-white/25">
        + Add block
      </button>

      {sheet.kind === 'slash' && (
        <SlashMenu initialQuery={sheet.query ?? ''}
          onPick={handleSlashPick}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'image' && (
        <UrlPromptSheet title="Image URL" placeholder="https://example.com/photo.jpg"
          onSubmit={u => void submitUrlBlock('image', u, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'video' && (
        <UrlPromptSheet title="Video URL" placeholder="https://example.com/clip.mp4"
          onSubmit={u => void submitUrlBlock('video', u, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'file' && (
        <UrlPromptSheet title="File URL"
          onSubmit={u => void submitUrlBlock('file', u, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'bookmark' && (
        <UrlPromptSheet title="Bookmark URL"
          onSubmit={u => void submitBookmark(u, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'embed' && (
        <UrlPromptSheet title="Embed URL" placeholder="YouTube / Loom / Figma / Twitter…"
          onSubmit={u => void submitUrlBlock('embed', u, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'equation' && (
        <TextPromptSheet title="LaTeX equation" placeholder="\\frac{a}{b}" multiline
          onSubmit={e => void submitEquation(e, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'link_to_page' && (
        <LinkToPagePicker client={client}
          onPick={r => void submitLinkToPage(r.id, r.object, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'sub_page' && (
        <TextPromptSheet title="New sub-page" placeholder="Untitled"
          onSubmit={t => void submitSubPage(t, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
      {sheet.kind === 'inline_database' && (
        <TextPromptSheet title="New database (not yet supported)" placeholder="Database title"
          onSubmit={t => void submitInlineDatabase(t, sheet.afterId)}
          onClose={() => setSheet({ kind: 'none' })} />
      )}
    </div>
  )
}
