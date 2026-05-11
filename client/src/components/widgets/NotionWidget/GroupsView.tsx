import { useState } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import { useNotionGroups } from '../../../hooks/useNotionGroups'
import type { NotionGroup } from '../../../hooks/useNotionGroups'
import type { NotionColor } from './notion-types'
import { colorBg, colorFg } from './notion-colors'
import { TouchInput } from '../../TouchInput'
import EmojiPicker from './EmojiPicker'

// Palette shown inline in the group settings panel. Matches AddToGroupSheet.
const PALETTE: NotionColor[] = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown', 'gray']

// ── New-group inline form ────────────────────────────────────────────────────

function NewGroupForm({
  onCreate, onCancel,
}: {
  onCreate: (name: string, icon: string, color: NotionColor) => void
  onCancel: () => void
}) {
  const [name,  setName]  = useState('')
  const [icon,  setIcon]  = useState('📁')
  const [color, setColor] = useState<NotionColor>('blue')
  const [pick,  setPick]  = useState(false)

  return (
    <div className="flex flex-col gap-3 bg-white/[0.03] border border-white/[0.05] rounded-2xl p-3 mt-2">
      <div className="flex gap-2 items-center">
        <button type="button" onClick={() => setPick(true)}
          className="flex-shrink-0 w-11 h-11 rounded-lg bg-white/[0.06] active:bg-white/10 text-2xl">
          {icon}
        </button>
        <TouchInput value={name} onChange={setName} commitOn="change"
          placeholder="Group name…" ariaLabel="Group name"
          className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PALETTE.map(c => (
          <button key={c} type="button" onClick={() => setColor(c)}
            aria-label={`color ${c}`}
            className="w-7 h-7 rounded-full border-2 active:scale-90"
            style={{ background: colorBg(c, 0.4), borderColor: color === c ? colorFg(c) : 'transparent' }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel}
          className="h-11 rounded-xl bg-white/10 text-white/60 text-sm font-semibold active:bg-white/15">Cancel</button>
        <button type="button" onClick={() => name.trim() && onCreate(name.trim(), icon, color)} disabled={!name.trim()}
          className="h-11 rounded-xl bg-green-500 text-black text-sm font-bold disabled:opacity-30 active:bg-green-400">Create</button>
      </div>
      {pick && (
        <EmojiPicker current={icon}
          onPick={e => { setIcon(e); setPick(false) }}
          onClear={() => { setIcon('📁'); setPick(false) }}
          onClose={() => setPick(false)} />
      )}
    </div>
  )
}

// ── Group settings panel (shown when 3-dot menu is open) ─────────────────────

function GroupSettings({
  group, api, isFirst, isLast, onClose,
}: {
  group:   NotionGroup
  api:     ReturnType<typeof useNotionGroups>
  isFirst: boolean
  isLast:  boolean
  onClose: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft,    setDraft]    = useState(group.name)
  const [pickIcon, setPickIcon] = useState(false)
  const [confirm,  setConfirm]  = useState(false)

  return (
    <div className="bg-white/[0.025] border border-white/[0.05] rounded-xl p-3 flex flex-col gap-3">
      {renaming ? (
        <div className="flex gap-2">
          <TouchInput value={draft} onChange={setDraft} commitOn="change"
            placeholder="Group name" ariaLabel="Group name"
            className="flex-1 bg-white/10 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-400" />
          <button type="button" onClick={() => { if (draft.trim()) { void api.renameGroup(group.id, draft.trim()); setRenaming(false) } }}
            className="px-3 rounded-lg bg-green-500 text-black text-xs font-bold active:bg-green-400">Save</button>
        </div>
      ) : (
        <button type="button" onClick={() => { setDraft(group.name); setRenaming(true) }}
          className="text-left text-sm text-white/80 px-3 py-2 rounded-lg active:bg-white/[0.06]">✏️ Rename</button>
      )}

      <button type="button" onClick={() => setPickIcon(true)}
        className="text-left text-sm text-white/80 px-3 py-2 rounded-lg active:bg-white/[0.06]">🎨 Change icon</button>

      <div className="flex flex-col gap-1.5 px-1">
        <span className="text-[10px] text-white/35 uppercase tracking-wider">Color</span>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE.map(c => (
            <button key={c} type="button" onClick={() => void api.setColor(group.id, c)}
              aria-label={`color ${c}`}
              className="w-7 h-7 rounded-full border-2 active:scale-90"
              style={{ background: colorBg(c, 0.4), borderColor: group.color === c ? colorFg(c) : 'transparent' }} />
          ))}
          <button type="button" onClick={() => void api.setColor(group.id, null)}
            aria-label="no color"
            className="w-7 h-7 rounded-full border-2 border-white/20 bg-transparent text-white/40 text-[10px] active:scale-90">none</button>
        </div>
      </div>

      <div className="flex gap-2">
        <button type="button" disabled={isFirst} onClick={() => void api.moveGroup(group.id, group.order - 1)}
          className="flex-1 h-10 rounded-lg bg-white/[0.06] text-white/70 text-sm active:bg-white/10 disabled:opacity-25">↑ Up</button>
        <button type="button" disabled={isLast} onClick={() => void api.moveGroup(group.id, group.order + 1)}
          className="flex-1 h-10 rounded-lg bg-white/[0.06] text-white/70 text-sm active:bg-white/10 disabled:opacity-25">↓ Down</button>
      </div>

      {confirm ? (
        <div className="flex gap-2">
          <button type="button" onClick={() => setConfirm(false)}
            className="flex-1 h-10 rounded-lg bg-white/10 text-white/60 text-sm active:bg-white/15">Cancel</button>
          <button type="button" onClick={() => { void api.deleteGroup(group.id); onClose() }}
            className="flex-1 h-10 rounded-lg bg-red-500 text-white text-sm font-bold active:bg-red-600">Delete group</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirm(true)}
          className="h-10 rounded-lg bg-red-500/10 text-red-400/70 text-sm active:bg-red-500/20">Delete group…</button>
      )}

      {pickIcon && (
        <EmojiPicker current={group.icon}
          onPick={e => { void api.setIcon(group.id, e); setPickIcon(false) }}
          onClear={()  => { void api.setIcon(group.id, null); setPickIcon(false) }}
          onClose={() => setPickIcon(false)} />
      )}
    </div>
  )
}

// ── A single group section ───────────────────────────────────────────────────

function GroupSection({
  group, api, isFirst, isLast, client,
}: {
  group:   NotionGroup
  api:     ReturnType<typeof useNotionGroups>
  isFirst: boolean
  isLast:  boolean
  client:  NotionClient
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const fg = colorFg(group.color ?? 'default')
  const bg = colorBg(group.color ?? 'default', 0.18)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1">
        <button type="button" onClick={() => void api.toggleCollapse(group.id)}
          className="flex-1 flex items-center gap-2 py-1.5 active:opacity-70">
          <span className="text-base flex-shrink-0">{group.icon ?? '📁'}</span>
          <span className="text-sm font-semibold flex-1 text-left truncate" style={{ color: fg }}>{group.name}</span>
          <span className="text-[10px] text-white/30 tabular-nums">{group.items.length}</span>
          <span className="text-white/40 text-sm">{group.collapsed ? '▸' : '▾'}</span>
        </button>
        <button type="button" onClick={() => setMenuOpen(o => !o)}
          aria-label="Group settings"
          className={`w-8 h-8 rounded-full flex items-center justify-center active:scale-90
            ${menuOpen ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50'}`}>⋯</button>
      </div>

      {menuOpen && (
        <GroupSettings group={group} api={api} isFirst={isFirst} isLast={isLast} onClose={() => setMenuOpen(false)} />
      )}

      {!group.collapsed && (
        <div className="flex flex-col gap-1.5">
          {group.items.length === 0 ? (
            <p className="text-[11px] text-white/30 italic px-3 py-2">No items. Long-press tiles in Browse to add.</p>
          ) : group.items.map((it, idx) => (
            <div key={it.refId} className="flex items-stretch gap-1.5">
              <button type="button"
                onClick={() => client.navigate(it.kind === 'database' ? { kind: 'database', id: it.refId } : { kind: 'page', id: it.refId })}
                className="flex-1 text-left flex items-center gap-3 rounded-xl px-3 py-3 active:scale-[0.99] transition-all border"
                style={{ background: bg, borderColor: colorBg(group.color ?? 'default', 0.35) }}>
                <span className="text-lg flex-shrink-0">{it.icon ?? (it.kind === 'database' ? '🗄️' : '📄')}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{it.title}</p>
                  <p className="text-[10px] text-white/40 uppercase tracking-wider">{it.kind}</p>
                </div>
                <span className="text-white/30 text-sm">›</span>
              </button>
              <div className="flex flex-col gap-1">
                <button type="button" disabled={idx === 0}
                  onClick={() => {
                    const order = group.items.map(x => x.refId)
                    ;[order[idx - 1], order[idx]] = [order[idx]!, order[idx - 1]!]
                    void api.reorderItems(group.id, order)
                  }}
                  aria-label="Move up"
                  className="w-7 flex-1 rounded-md bg-white/[0.04] text-white/55 text-xs active:bg-white/10 disabled:opacity-25">↑</button>
                <button type="button" disabled={idx === group.items.length - 1}
                  onClick={() => {
                    const order = group.items.map(x => x.refId)
                    ;[order[idx + 1], order[idx]] = [order[idx]!, order[idx + 1]!]
                    void api.reorderItems(group.id, order)
                  }}
                  aria-label="Move down"
                  className="w-7 flex-1 rounded-md bg-white/[0.04] text-white/55 text-xs active:bg-white/10 disabled:opacity-25">↓</button>
              </div>
              <button type="button" onClick={() => void api.removeItem(group.id, it.refId)}
                aria-label="Remove from group"
                className="w-8 rounded-md bg-red-500/10 text-red-300/70 text-xs active:bg-red-500/25">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top-level GroupsView ─────────────────────────────────────────────────────

export default function GroupsView({ client }: { client: NotionClient }) {
  const api = useNotionGroups()
  const [creating, setCreating] = useState(false)

  if (api.loading) {
    return <div className="flex justify-center py-12"><span className="w-8 h-8 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" /></div>
  }

  return (
    <div className="flex flex-col gap-4 px-1">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold text-white flex-1">Groups</h2>
        <button type="button" onClick={() => void api.refresh()}
          className="w-9 h-9 rounded-full bg-white/10 text-white/50 text-xl flex items-center justify-center active:scale-90">↺</button>
      </div>

      {api.groups.length === 0 && !creating && (
        <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
          <span className="text-4xl">📁</span>
          <p className="text-sm text-white/65 font-medium">No groups yet</p>
          <p className="text-xs text-white/40 leading-relaxed">
            Create groups to organize your pages and databases the way you think about them.
            Long-press any tile in Browse to add it to a group.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {api.groups.map((g, i) => (
          <GroupSection key={g.id} group={g} api={api}
            isFirst={i === 0} isLast={i === api.groups.length - 1}
            client={client} />
        ))}
      </div>

      {api.error && <p className="text-xs text-red-400 px-2">{api.error}</p>}

      {creating ? (
        <NewGroupForm
          onCreate={async (name, icon, color) => {
            await api.createGroup(name, icon, color)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)} />
      ) : (
        <button type="button" onClick={() => setCreating(true)}
          className="mt-2 w-full py-3 rounded-xl border-2 border-dashed border-white/15 text-white/55 text-sm font-medium active:bg-white/5 active:border-white/25">
          + New group
        </button>
      )}
    </div>
  )
}
