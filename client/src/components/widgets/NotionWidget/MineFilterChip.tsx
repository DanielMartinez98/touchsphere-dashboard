import { useState } from 'react'
import type { FilterModel } from './FilterTree'
import { useNotionMe } from '../../../hooks/useNotionMe'

// One-tap "🙋 Only mine" toggle for a database with a people/assignee property.
// It injects (or removes) a single people-contains-me condition into the shared
// filter model — keyed `mine` so it round-trips without disturbing other
// conditions. First use prompts the user to pick which workspace member they
// are (the Notion integration is a bot and can't infer it); the choice is
// remembered via useNotionMe so subsequent taps are instant.

const MINE_ID = 'mine'

export default function MineFilterChip({
  peopleKey, filter, onChange,
}: {
  peopleKey: string
  filter:    FilterModel
  onChange:  (next: FilterModel) => void
}) {
  const { users, me, meId, setMe, loading } = useNotionMe()
  const [picking, setPicking] = useState(false)

  const active = filter.conditions.some(c => c.id === MINE_ID)

  function applyMine(userId: string) {
    const condition = { id: MINE_ID, property: peopleKey, type: 'people', operator: 'contains', value: userId }
    const without = filter.conditions.filter(c => c.id !== MINE_ID)
    onChange({ ...filter, conditions: [...without, condition] })
  }
  function clearMine() {
    onChange({ ...filter, conditions: filter.conditions.filter(c => c.id !== MINE_ID) })
  }

  function toggle() {
    if (active) { clearMine(); return }
    if (!meId)  { setPicking(true); return }   // first run — ask who "me" is
    applyMine(meId)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle}
          className={`px-3 py-1.5 rounded-full text-xs font-medium ${active ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/60 active:bg-white/10'}`}>
          🙋 Only mine{me && active ? ` · ${me.name}` : ''}
        </button>
        {meId && !picking && (
          <button type="button" onClick={() => setPicking(true)}
            aria-label="Change who 'me' is"
            className="text-[10px] text-white/30 active:text-white/60 px-1">change</button>
        )}
      </div>

      {picking && (
        <div className="flex flex-col gap-1.5 bg-white/[0.025] rounded-xl p-2 border border-white/[0.05]">
          <span className="text-[11px] text-white/45">Who are you?</span>
          <div className="flex flex-wrap gap-1">
            {loading && users.length === 0 && <span className="text-[11px] text-white/30 italic">loading users…</span>}
            {users.map(u => (
              <button key={u.id} type="button"
                onClick={() => { setMe(u.id); setPicking(false); applyMine(u.id) }}
                className={`flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-[11px] ${meId === u.id ? 'bg-green-500 text-black' : 'bg-white/[0.06] text-white/60 active:bg-white/10'}`}>
                {u.avatarUrl
                  ? <img src={u.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                  : <span className="w-4 h-4 rounded-full bg-white/15 flex items-center justify-center text-[8px]">{u.name?.[0] ?? '?'}</span>}
                {u.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
