import type { NotionTask } from '../../../hooks/useNotion'

const PRIORITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 }

function nextPending(tasks: NotionTask[]): NotionTask | null {
  return [...tasks.filter(t => !t.done)].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 99
    const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 99
    if (pa !== pb) return pa - pb
    if (a.due && b.due) return a.due.localeCompare(b.due)
    if (a.due) return -1
    if (b.due) return 1
    return 0
  })[0] ?? null
}

interface Props {
  tasks:   NotionTask[]
  loading: boolean
  error:   string | null
}

export function NotionCollapsed({ tasks, loading, error }: Props) {
  const pending = tasks.filter(t => !t.done)
  const next    = nextPending(tasks)

  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Tasks</span>

      {loading ? (
        <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
      ) : error ? (
        <span className="text-sm text-ink-dim leading-tight">Not configured</span>
      ) : pending.length === 0 ? (
        <span className="text-sm font-semibold text-green-400">All done!</span>
      ) : (
        <>
          <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">{pending.length}</span>
          {next && (
            <span className="text-[13px] text-ink-mid leading-snug truncate w-full">
              {next.title}
            </span>
          )}
        </>
      )}
    </>
  )
}
