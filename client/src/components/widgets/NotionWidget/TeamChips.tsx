import type { NotionTeam } from '../../../hooks/useNotion'

// "All · Dolce Piquant · DanGoodGame's · indy" — the one filter every work
// view shares. A chip carries the team's colour dot, its name and a count of
// whatever the view is about (open tasks, agenda entries). Hidden entirely
// with a single team: there is nothing to choose.
export default function TeamChips({
  teams, value, onChange, counts,
}: {
  teams:   NotionTeam[]
  value:   string | null           // null = all
  onChange: (id: string | null) => void
  counts?: Record<string, number>  // by team id; 'all' for the All chip
}) {
  if (teams.length < 2) return null
  const chip = (id: string | null, label: string, color: string | null, count: number | undefined, ok = true) => {
    const active = value === id
    return (
      <button key={id ?? 'all'} type="button" onClick={() => onChange(id)}
        title={!ok ? 'This workspace did not answer' : undefined}
        className={`flex-shrink-0 inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full text-sm font-semibold transition-colors border
          ${active ? 'bg-white/[0.14] text-white border-white/20' : 'bg-white/[0.05] text-white/55 border-transparent active:bg-white/10'}`}>
        {color && <span className={`w-2.5 h-2.5 rounded-full ${!ok ? 'ring-2 ring-red-400/70' : ''}`} style={{ background: color }} />}
        <span className="truncate max-w-[9rem]">{label}</span>
        {count !== undefined && count > 0 && <span className="text-sm tabular-nums opacity-60">{count}</span>}
      </button>
    )
  }
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
      {chip(null, 'All', null, counts?.['all'])}
      {teams.map(t => chip(t.id, t.name, t.color, counts?.[t.id], t.ok))}
    </div>
  )
}
