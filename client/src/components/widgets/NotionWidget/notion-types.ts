// Shared types for the Notion universal client. Lightly mirrored from the
// Notion API where it matters and kept loose (`any` for raw blocks/properties)
// where the surface is too wide to type usefully on the client.

export type NotionColor =
  | 'default' | 'gray'   | 'brown'  | 'orange' | 'yellow'
  | 'green'   | 'blue'   | 'purple' | 'pink'   | 'red'
  | 'gray_background'   | 'brown_background'  | 'orange_background'
  | 'yellow_background' | 'green_background'  | 'blue_background'
  | 'purple_background' | 'pink_background'   | 'red_background'

export interface NotionIcon {
  type:  'emoji' | 'url'
  value: string
}

export interface WorkspaceItem {
  id:     string
  title:  string
  icon:   NotionIcon | null
  url?:   string
  parent?: { type: string; database_id?: string; page_id?: string; workspace?: boolean }
}

export interface Workspace {
  databases: WorkspaceItem[]
  pages:     WorkspaceItem[]
}

export interface SearchResult {
  id:     string
  object: 'page' | 'database'
  title:  string
  icon:   NotionIcon | null
  parent: any
  url?:   string
}

export interface DatabaseSchema {
  id:          string
  title:       string
  description: string
  icon:        NotionIcon | null
  properties:  Record<string, any>     // raw Notion property schema
  url?:        string
}

export interface NotionPage {
  id:               string
  title:            string
  icon:             NotionIcon | null
  cover:            any
  parent:           any
  properties:       Record<string, any>  // raw Notion property values
  url?:             string
  created_time:     string
  last_edited_time: string
  archived:         boolean
}

export interface RichText {
  type:        string
  plain_text:  string
  href?:       string | null
  annotations: {
    bold?:          boolean
    italic?:        boolean
    strikethrough?: boolean
    underline?:     boolean
    code?:          boolean
    color?:         NotionColor
  }
}

// Raw Notion block. `type` is the discriminator and the block's content lives
// at `block[block.type]`. Keeping this loose so we can render any block type
// without a 1500-line union.
export interface NotionBlock {
  id:               string
  type:             string
  has_children:     boolean
  archived:         boolean
  parent:           any
  created_time:     string
  last_edited_time: string
  [key: string]:    any
}

export interface BlocksPage {
  results:     NotionBlock[]
  has_more:    boolean
  next_cursor: string | null
}

// ── Navigation state for the in-widget client ────────────────────────────────

export type NavView =
  | { kind: 'home' }
  | { kind: 'browse' }
  | { kind: 'search' }
  | { kind: 'database', id: string }
  | { kind: 'page',     id: string }

// Build the actual Notion API write payload for a single line of text. The
// `RichText` interface above is shaped for read-side rendering.
export function richTextWrite(text: string): any[] {
  if (!text) return []
  return [{ type: 'text', text: { content: text } }]
}
