import type { NotionTask, NotionErrorKind } from '../../../hooks/useNotion'

const PRIORITY_ORDER: Record<string, number> = { High: 0, 'High Priority': 0, Urgent: 0, Medium: 1, Normal: 1, Low: 2 }

function isOverdue(due: string): boolean {
  return new Date(due + 'T00:00').getTime() < new Date().setHours(0, 0, 0, 0)
}

// Priority first when the database has one; otherwise the nearest due date,
// with undated tasks last. Overdue sorts ahead of everything either way — it
// is the task the pill should be naming.
function nextPending(tasks: NotionTask[]): NotionTask | null {
  return [...tasks.filter(t => !t.done)].sort((a, b) => {
    const oa = a.due && isOverdue(a.due) ? 0 : 1
    const ob = b.due && isOverdue(b.due) ? 0 : 1
    if (oa !== ob) return oa - ob
    const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 99
    const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 99
    if (pa !== pb) return pa - pb
    if (a.due && b.due) return a.due.localeCompare(b.due)
    if (a.due) return -1
    if (b.due) return 1
    return 0
  })[0] ?? null
}

/** The one line the pill has for a failure: what is wrong, not "not configured" for everything. */
function shortError(kind: NotionErrorKind | null): string {
  switch (kind) {
    case 'unconfigured': return 'Not configured'
    case 'auth':         return 'Token rejected'
    case 'access':       return 'No access'
    case 'rate':         return 'Rate-limited'
    case 'timeout':      return 'Notion slow'
    case 'network':      return 'Notion unreachable'
    case 'offline':      return 'Server offline'
    default:             return 'Notion error'
  }
}

interface Props {
  tasks:     NotionTask[]
  loading:   boolean
  error:     string | null
  errorKind: NotionErrorKind | null
}

export function NotionCollapsed({ tasks, loading, error, errorKind }: Props) {
  const pending = tasks.filter(t => !t.done)
  const overdue = pending.filter(t => t.due && isOverdue(t.due)).length
  const today   = pending.filter(t => t.due && !isOverdue(t.due) && new Date(t.due + 'T00:00').getTime() === new Date().setHours(0, 0, 0, 0)).length
  const next    = nextPending(tasks)
  // A failure with a list already on screen keeps the list — it is the last
  // good answer — and only flags that it may be stale.
  const stale = !!error && tasks.length > 0

  return (
    <>
      <span className="text-sm font-medium text-white/50 uppercase tracking-[0.14em]">Tasks</span>

      {loading && tasks.length === 0 ? (
        <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-green-400 animate-spin" />
      ) : error && tasks.length === 0 ? (
        <span className="text-sm text-ink-dim leading-tight">{shortError(errorKind)}</span>
      ) : pending.length === 0 ? (
        <span className="text-base font-semibold text-green-400">All done!</span>
      ) : (
        <>
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">{pending.length}</span>
            {overdue > 0 && (
              <span className="text-sm font-semibold text-red-300 tabular-nums leading-none">{overdue} overdue</span>
            )}
            {overdue === 0 && today > 0 && (
              <span className="text-sm font-semibold text-amber-200/90 tabular-nums leading-none">{today} today</span>
            )}
          </span>
          {next && (
            <span className={`text-sm leading-snug truncate w-full ${next.due && isOverdue(next.due) ? 'text-red-200/90' : 'text-ink-mid'}`}>
              {next.title}
            </span>
          )}
          {stale && <span className="text-sm text-amber-200/70 leading-tight">{shortError(errorKind)} · showing last list</span>}
        </>
      )}
    </>
  )
}
