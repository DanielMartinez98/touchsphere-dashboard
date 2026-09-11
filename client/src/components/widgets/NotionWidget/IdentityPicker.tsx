import { useNotionMe, type NotionUser } from '../../../hooks/useNotionMe'

// "Who are you?" — inline, wherever the answer is needed (the My work banner,
// the header avatar). One list of distinct people across every workspace:
// members first, then people only seen on rows. Picking one sets the one
// identity on the server, so every device and every team's boards follow.
export default function IdentityPicker({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const { people, me, setMe, loading, saving } = useNotionMe()

  async function pick(u: NotionUser | null) {
    await setMe(u)
    onDone?.()
  }

  return (
    <div className={`flex flex-col gap-2 ${compact ? '' : 'bg-white/[0.03] rounded-2xl p-3 border border-white/[0.05]'}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm text-white/55 flex-1">Who are you in Notion?</span>
        {me && (
          <button type="button" disabled={saving} onClick={() => void pick(null)}
            className="text-sm text-white/35 active:text-white/60 px-2 py-1 disabled:opacity-40">not me</button>
        )}
      </div>
      {loading && people.length === 0 && <span className="text-sm text-white/30 italic">looking through the workspaces…</span>}
      {!loading && people.length === 0 && (
        <span className="text-sm text-white/40">
          No people visible. Share a board that names its assignees with the integration, or grant it user information in Notion.
        </span>
      )}
      <div className="flex flex-wrap gap-1.5">
        {people.map(u => {
          const active = me?.id === u.id || (!!me?.email && !!u.email && me.email === u.email.toLowerCase())
          return (
            <button key={u.id} type="button" disabled={saving}
              onClick={() => void pick(u)}
              className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full text-sm active:scale-95 disabled:opacity-50
                ${active ? 'bg-green-500 text-black font-semibold' : 'bg-white/[0.06] text-white/70 active:bg-white/10'}`}>
              {u.avatarUrl
                ? <img src={u.avatarUrl} alt="" className="w-7 h-7 rounded-full" />
                : <span className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center text-xs">{(u.name || u.email || '?')[0]?.toUpperCase()}</span>}
              <span className="flex flex-col items-start leading-tight">
                <span>{u.name || u.email}</span>
                {u.conns.length > 0 && (
                  <span className={`flex items-center gap-1 text-[11px] ${active ? 'text-black/60' : 'text-white/35'}`}>
                    {u.conns.map(c => <span key={c.id} className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />)}
                    {u.conns.map(c => c.name).join(' · ')}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
