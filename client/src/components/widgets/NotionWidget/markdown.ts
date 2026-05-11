// Markdown shortcuts: detect leading sigils in a freshly-edited line and
// produce the resulting Notion block type. Returns null when nothing matches,
// in which case the caller leaves the block alone.
//
// Anything matching here strips the prefix from the saved content — that's the
// Notion behavior the user expects (typing `# foo` should not leave a literal
// `#` in the heading).

export interface MarkdownConvert {
  type:    string
  content: string
  // Some block types want extra fields at insertion time, e.g. a fresh to-do
  // needs `checked: false`. We attach those here.
  extra?:  Record<string, any>
}

export function detectMarkdown(text: string, currentType: string): MarkdownConvert | null {
  // Don't re-trigger on already-typed lines or on types we shouldn't touch
  // (code/divider/image, etc.).
  if (currentType === 'code' || currentType === 'divider') return null

  if (text.startsWith('# '))   return { type: 'heading_1', content: text.slice(2) }
  if (text.startsWith('## '))  return { type: 'heading_2', content: text.slice(3) }
  if (text.startsWith('### ')) return { type: 'heading_3', content: text.slice(4) }
  if (text.startsWith('- ') || text.startsWith('* ')) return { type: 'bulleted_list_item', content: text.slice(2) }
  if (/^\d+\.\s/.test(text)) {
    const stripped = text.replace(/^\d+\.\s/, '')
    return { type: 'numbered_list_item', content: stripped }
  }
  if (text.startsWith('[] ')  || text.startsWith('[ ] ')) {
    return { type: 'to_do', content: text.replace(/^\[\s?\]\s/, ''), extra: { checked: false } }
  }
  if (text.startsWith('[x] ') || text.startsWith('[X] ')) {
    return { type: 'to_do', content: text.slice(4), extra: { checked: true } }
  }
  if (text.startsWith('> '))     return { type: 'quote', content: text.slice(2) }
  if (text.startsWith('"'))      return { type: 'quote', content: text.slice(1) }
  if (text.startsWith('```'))    return { type: 'code', content: text.replace(/^```\s*/, '') }
  if (text === '---' || text === '***') return { type: 'divider', content: '' }
  // Slash command for sub-page / callout — these are typed lone and converted.
  if (text === '/divider')       return { type: 'divider', content: '' }
  return null
}

// Block-kind catalog used by both the slash menu and the Turn-into menu.
// `keywords` powers the slash menu's substring filter — "td" or "todo" both
// match the to-do entry.

export interface BlockKindDef {
  type:        string
  label:       string
  icon:        string
  keywords:    string[]
  // Some kinds are not insertable directly (image needs a URL prompt etc.).
  needsInput?: 'image' | 'video' | 'file' | 'bookmark' | 'embed' | 'equation' | 'link_to_page' | 'sub_page' | 'inline_database' | 'synced_block'
}

export const BLOCK_KINDS: BlockKindDef[] = [
  { type: 'paragraph',          label: 'Text',          icon: '¶',  keywords: ['text', 'paragraph', 'p'] },
  { type: 'heading_1',          label: 'Heading 1',     icon: 'H1', keywords: ['heading', 'h1', 'title'] },
  { type: 'heading_2',          label: 'Heading 2',     icon: 'H2', keywords: ['heading', 'h2'] },
  { type: 'heading_3',          label: 'Heading 3',     icon: 'H3', keywords: ['heading', 'h3'] },
  { type: 'bulleted_list_item', label: 'Bulleted list', icon: '•',  keywords: ['list', 'bulleted', 'ul', 'bullet'] },
  { type: 'numbered_list_item', label: 'Numbered list', icon: '1.', keywords: ['list', 'numbered', 'ol', 'number'] },
  { type: 'to_do',              label: 'To-do',         icon: '☐',  keywords: ['todo', 'task', 'checkbox', 'td'] },
  { type: 'toggle',             label: 'Toggle',        icon: '▸',  keywords: ['toggle', 'collapse'] },
  { type: 'quote',              label: 'Quote',         icon: '"',  keywords: ['quote'] },
  { type: 'callout',            label: 'Callout',       icon: '💡', keywords: ['callout', 'info'] },
  { type: 'divider',            label: 'Divider',       icon: '—',  keywords: ['divider', 'separator', 'hr'] },
  { type: 'code',               label: 'Code',          icon: '</>',keywords: ['code', 'monospace', 'pre'] },
  { type: 'image',              label: 'Image',         icon: '🖼️', keywords: ['image', 'photo', 'picture'], needsInput: 'image' },
  { type: 'video',              label: 'Video',         icon: '🎬', keywords: ['video', 'movie'],            needsInput: 'video' },
  { type: 'file',               label: 'File',          icon: '📎', keywords: ['file', 'attachment'],        needsInput: 'file' },
  { type: 'bookmark',           label: 'Bookmark',      icon: '🔖', keywords: ['bookmark', 'link', 'url'],    needsInput: 'bookmark' },
  { type: 'embed',              label: 'Embed',         icon: '🪟', keywords: ['embed', 'iframe', 'youtube'], needsInput: 'embed' },
  { type: 'equation',           label: 'Equation',      icon: 'fx', keywords: ['equation', 'math', 'latex'],  needsInput: 'equation' },
  { type: 'link_to_page',       label: 'Link to page',  icon: '🔗', keywords: ['link', 'page'],               needsInput: 'link_to_page' },
  { type: 'child_page',         label: 'Sub-page',      icon: '📄', keywords: ['page', 'subpage', 'child'],   needsInput: 'sub_page' },
  { type: 'child_database',     label: 'Inline DB',     icon: '🗄️', keywords: ['database', 'db', 'inline'],   needsInput: 'inline_database' },
  { type: 'synced_block',       label: 'Synced block',  icon: '🔁', keywords: ['synced', 'mirror'],            needsInput: 'synced_block' },
  { type: 'breadcrumb',         label: 'Breadcrumb',    icon: '🧭', keywords: ['breadcrumb', 'path'] },
  { type: 'table_of_contents',  label: 'Table of contents', icon: '📋', keywords: ['toc', 'table of contents', 'outline'] },
]

// Filter against the slash query — keep ranking simple: exact-prefix on label
// or any keyword beats substring matches.
export function filterBlockKinds(query: string): BlockKindDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return BLOCK_KINDS
  const score = (k: BlockKindDef): number => {
    if (k.label.toLowerCase().startsWith(q)) return 0
    if (k.keywords.some(w => w.startsWith(q))) return 1
    if (k.label.toLowerCase().includes(q)) return 2
    if (k.keywords.some(w => w.includes(q))) return 3
    return 99
  }
  return BLOCK_KINDS
    .map(k => [k, score(k)] as const)
    .filter(([, s]) => s < 99)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k)
}
