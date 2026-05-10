import type { CSSProperties } from 'react'
import type { NotionColor } from './notion-types'

// Notion's named colors → hex. Background variants are rendered with low alpha
// over the base hue so they read as tints, not solid fills.
const FG: Record<string, string> = {
  default: '#94a3b8', gray:   '#9ca3af', brown:  '#a16207',
  orange:  '#ea580c', yellow: '#ca8a04', green:  '#16a34a',
  blue:    '#2563eb', purple: '#7c3aed', pink:   '#db2777', red: '#dc2626',
}

export function colorFg(color: string | undefined | null): string {
  if (!color) return FG['default']!
  const base = color.replace('_background', '')
  return FG[base] ?? FG['default']!
}

export function colorBg(color: string | undefined | null, alpha = 0.15): string {
  const hex = colorFg(color)
  // Convert hex to rgba — quick and small.
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function isBackground(color: string | undefined | null): boolean {
  return !!color && color.endsWith('_background')
}

// Apply a Notion color to a piece of text. Background colors style as a tinted
// pill, foreground colors style as colored text. Default returns no styling.
export function colorStyle(color: NotionColor | string | undefined | null): CSSProperties {
  if (!color || color === 'default') return {}
  if (isBackground(color)) {
    return { background: colorBg(color, 0.18), color: colorFg(color), padding: '0 4px', borderRadius: 4 }
  }
  return { color: colorFg(color) }
}
