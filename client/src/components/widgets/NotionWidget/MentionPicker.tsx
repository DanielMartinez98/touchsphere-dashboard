import { useEffect, useState } from 'react'
import type { NotionClient } from '../../../hooks/useNotionClient'
import LinkToPagePicker from './LinkToPagePicker'
import MiniCalendar from './MiniCalendar'

// What the user picked. Translated into Notion rich-text mention shape by the
// caller; we keep this surface narrow.
export type MentionPick =
  | { kind: 'page';     id: string; title: string }
  | { kind: 'date';     iso: string }
  | { kind: 'user';     id: string; name: string; avatarUrl?: string }

export default function MentionPicker({
  client, onPick, onClose,
}: {
  client:  NotionClient
  onPick:  (pick: MentionPick) => void
  onClose: () => void
}) {
  const [tab,   setTab]   = useState<'page' | 'date' | 'user'>('page')
  const [users, setUsers] = useState<{ id: string; name: string; avatarUrl?: string }[]>([])

  // Lazy-fetch users only when the User tab is opened. Notion's user list is
  // small and changes rarely so a one-shot fetch is fine.
  useEffect(() => {
    if (tab !== 'user' || users.length > 0) return
    fetch('/api/notion/users')
      .then(r => r.ok ? r.json() : { users: [] })
      .then(d => setUsers(d.users ?? []))
      .catch(() => {})
  }, [tab, users.length])

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-white/10 rounded-t-3xl px-4 pt-3 pb-8 z-50 max-h-[85vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-white mb-3 px-1">Insert mention</h3>

        <div className="flex gap-1.5 bg-white/[0.04] rounded-lg p-1 mb-3">
          {(['page', 'date', 'user'] as const).map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors
                ${tab === t ? 'bg-white/15 text-white' : 'text-white/45 active:bg-white/[0.07]'}`}>
              {t === 'page' ? '📄 Page' : t === 'date' ? '📅 Date' : '👤 User'}
            </button>
          ))}
        </div>

        {tab === 'page' && (
          // Reuse the page picker inline — it already does debounced search.
          <LinkToPagePicker
            client={client}
            inline
            onPick={r => onPick({ kind: 'page', id: r.id, title: r.title })}
            onClose={onClose} />
        )}

        {tab === 'date' && (
          <div className="flex flex-col gap-2">
            <MiniCalendar value=""
              onChange={iso => { if (iso) onPick({ kind: 'date', iso }); onClose() }} />
            <button type="button"
              onClick={() => { onPick({ kind: 'date', iso: new Date().toISOString().slice(0, 10) }); onClose() }}
              className="self-start text-xs text-white/55 active:text-white/85 px-1">
              📍 Today
            </button>
          </div>
        )}

        {tab === 'user' && (
          <div className="flex flex-col gap-1.5 max-h-[55vh] overflow-y-auto">
            {users.length === 0 && (
              <p className="text-xs text-white/35 italic text-center py-4">Loading users…</p>
            )}
            {users.map(u => (
              <button key={u.id} type="button"
                onClick={() => { onPick({ kind: 'user', id: u.id, name: u.name, avatarUrl: u.avatarUrl }); onClose() }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.04] active:bg-white/[0.09]">
                {u.avatarUrl
                  ? <img src={u.avatarUrl} alt="" className="w-7 h-7 rounded-full" />
                  : <span className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs text-white/65">{u.name?.[0] ?? '?'}</span>}
                <span className="text-sm text-white truncate">{u.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
