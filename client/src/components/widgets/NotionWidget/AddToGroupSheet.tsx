import { useState } from 'react'
import type { WorkspaceItem, NotionColor } from './notion-types'
import type { NotionGroupsApi } from '../../../hooks/useNotionGroups'
import { TouchInput } from '../../TouchInput'
import { colorBg, colorFg } from './notion-colors'

// Bottom sheet to add the given item to (or remove from) any of the user's
// groups, with an inline "+ New group" shortcut.

interface Props {
  item:    WorkspaceItem
  kind:    'page' | 'database'
  groups:  NotionGroupsApi
  onClose: () => void
}

// Curated palette for new groups — small enough to fit in a single row.
const PALETTE: NotionColor[] = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown', 'gray']

export default function AddToGroupSheet({ item, kind, groups, onClose }: Props) {
  const [creating, setCreating] = useState(false)
  const [name,     setName]     = useState('')
  const [icon,     setIcon]     = useState('📁')
  const [color,    setColor]    = useState<NotionColor>('blue')

  // The icon we cache with the item — a string (emoji or url) the home/groups
  // views can render without re-resolving the WorkspaceItem.
  const itemIconStr =
    item.icon?.type === 'emoji' ? item.icon.value :
    item.icon?.type === 'url'   ? item.icon.value : null

  function toggle(groupId: string, isMember: boolean) {
    if (isMember) {
      void groups.removeItem(groupId, item.id)
    } else {
      void groups.addItem(groupId, {
        refId: item.id,
        kind,
        title: item.title,
        icon:  itemIconStr,
      })
    }
  }

  async function createAndAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    const g = await groups.createGroup(trimmed, icon, color)
    if (g) {
      await groups.addItem(g.id, {
        refId: item.id,
        kind,
        title: item.title,
        icon:  itemIconStr,
      })
    }
    setCreating(false)
    setName('')
    setIcon('📁')
    setColor('blue')
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl z-40 max-h-[85vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-8">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-white mb-1">Add to group</h3>
          <p className="text-xs text-white/45 mb-4 truncate">{item.title}</p>

          <div className="flex flex-col gap-1.5 mb-4">
            {groups.groups.length === 0 && !creating && (
              <p className="text-xs text-white/40 italic py-3 text-center">No groups yet. Create one below.</p>
            )}
            {groups.groups.map(g => {
              const isMember = g.items.some(it => it.refId === item.id)
              return (
                <button key={g.id} type="button" onClick={() => toggle(g.id, isMember)}
                  className="flex items-center gap-3 px-3 py-3 rounded-xl bg-white/[0.04] active:bg-white/[0.08]">
                  <span className="text-lg flex-shrink-0">{g.icon ?? '📁'}</span>
                  <span className="flex-1 text-left text-sm text-white truncate">{g.name}</span>
                  <span className="text-[10px] text-white/30 mr-1">{g.items.length}</span>
                  <span className={`flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center text-xs
                    ${isMember ? 'bg-green-500/30 border-green-500/60 text-green-300' : 'border-white/30'}`}>
                    {isMember && '✓'}
                  </span>
                </button>
              )
            })}
          </div>

          {creating ? (
            <div className="flex flex-col gap-3 bg-white/[0.03] border border-white/[0.05] rounded-2xl p-3">
              <div className="flex gap-2 items-center">
                <button type="button"
                  onClick={() => {
                    // Cycle through a few common folder emojis. For a full picker
                    // open EmojiPicker in a future iteration.
                    const cycle = ['📁', '📌', '⭐', '🎯', '💡', '🏠', '💼', '🧠', '🎨', '📚']
                    const i = cycle.indexOf(icon)
                    setIcon(cycle[(i + 1) % cycle.length]!)
                  }}
                  className="flex-shrink-0 w-11 h-11 rounded-lg bg-white/[0.06] active:bg-white/10 text-2xl">
                  {icon}
                </button>
                <TouchInput value={name} onChange={setName} commitOn="change"
                  placeholder="Group name…"
                  ariaLabel="Group name"
                  className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PALETTE.map(c => (
                  <button key={c} type="button" onClick={() => setColor(c)}
                    aria-label={`color ${c}`}
                    className="w-7 h-7 rounded-full border-2 active:scale-90"
                    style={{
                      background:  colorBg(c, 0.4),
                      borderColor: color === c ? colorFg(c) : 'transparent',
                    }} />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setCreating(false)}
                  className="h-11 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
                <button type="button" onClick={createAndAdd} disabled={!name.trim()}
                  className="h-11 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Create & add</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setCreating(true)}
              className="w-full py-3 rounded-xl border-2 border-dashed border-white/15 text-white/45 text-sm active:bg-white/5">
              + New group
            </button>
          )}

          <button type="button" onClick={onClose}
            className="mt-4 w-full h-11 rounded-xl bg-white/[0.04] text-white/65 text-sm font-semibold active:bg-white/10">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
