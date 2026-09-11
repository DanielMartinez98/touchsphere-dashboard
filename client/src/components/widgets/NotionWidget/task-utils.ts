import type { NotionTask, NotionTeam, NotionBoard } from '../../../hooks/useNotion'

// Shared date and ordering helpers for the work views. Every date here is a
// local YYYY-MM-DD; Notion dates are day-granular and the kiosk lives in one
// timezone, so the day string is the unit and nothing goes through UTC.

export const PRI_ORDER: Record<string, number> = { High: 0, 'High Priority': 0, Urgent: 0, Medium: 1, Normal: 1, Low: 2 }

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayKey(): string { return dayKey(new Date()) }

// Local-date ISO string N days from today (toISOString would shift across UTC).
export function isoInDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return dayKey(d)
}

// Whole days from today to `day`. Both anchored at local midnight, Math.round
// absorbs the ±1h DST wobble. Anchoring the due date at noon while today sits
// at midnight would skew every label half a day.
export function dayDiff(day: string): number {
  const d = new Date(day.slice(0, 10) + 'T00:00')
  const todayMs = new Date().setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - todayMs) / 86_400_000)
}

export function isOverdueDate(due: string): boolean { return dayDiff(due) < 0 }

export function fmtDue(due: string): { label: string; overdue: boolean } {
  const diff = dayDiff(due)
  if (diff < 0)   return { label: `${Math.abs(diff)}d overdue`, overdue: true }
  if (diff === 0) return { label: 'Today', overdue: false }
  if (diff === 1) return { label: 'Tomorrow', overdue: false }
  if (diff < 7)   return { label: `${diff}d`, overdue: false }
  return { label: new Date(due.slice(0, 10) + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' }), overdue: false }
}

/** "Today", "Tomorrow", "Yesterday", else "Mon, Sep 14". */
export function fmtDay(day: string): string {
  const diff = dayDiff(day)
  if (diff === 0)  return 'Today'
  if (diff === 1)  return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return new Date(day.slice(0, 10) + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

// Where a task sits on the My work screen. Overdue, today, the next seven
// days, later, or no date at all — the groups a person scanning a wall wants,
// in the order they want them.
export type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'nodate'
export const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'week', 'later', 'nodate']
export const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: 'Overdue', today: 'Today', week: 'Next 7 days', later: 'Later', nodate: 'No date',
}

export function bucketOf(due: string | null): Bucket {
  if (!due) return 'nodate'
  const diff = dayDiff(due)
  if (diff < 0)  return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= 7) return 'week'
  return 'later'
}

// Urgency order inside a group: the most overdue first, then priority, then
// the nearest due date, undated last, newest first among equals.
export function byUrgency(a: NotionTask, b: NotionTask): number {
  const oa = a.due && isOverdueDate(a.due) ? 0 : 1
  const ob = b.due && isOverdueDate(b.due) ? 0 : 1
  if (oa !== ob) return oa - ob
  if (oa === 0 && a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due)
  const pa = PRI_ORDER[a.priority ?? ''] ?? 99
  const pb = PRI_ORDER[b.priority ?? ''] ?? 99
  if (pa !== pb) return pa - pb
  if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due)
  if (a.due && !b.due) return -1
  if (!a.due && b.due) return 1
  return b.createdAt.localeCompare(a.createdAt)
}

/** The team a board belongs to, by the board's id. */
export function teamOfBoard(boardId: string, boards: NotionBoard[], teams: NotionTeam[]): NotionTeam | null {
  const b = boards.find(x => x.id === boardId)
  return (b?.conn && teams.find(t => t.id === b.conn!.id)) || null
}

// The Time corner's colour for Google events — so an event on the agenda
// reads as the same thing it is on the calendar tab of that corner.
export const GOOGLE_COLOR = '#22d3ee'

// The kind icon for an agenda entry: what a date on a calendar board means.
export function kindGlyph(kind: 'due' | 'publish' | 'film' | 'date' | 'google'): string {
  switch (kind) {
    case 'due':     return '⏰'
    case 'publish': return '📣'
    case 'film':    return '🎬'
    case 'google':  return '📅'
    default:        return '📌'
  }
}

export function kindLabel(kind: 'due' | 'publish' | 'film' | 'date', key: string): string {
  switch (kind) {
    case 'due':     return 'Due'
    case 'publish': return 'Publish'
    case 'film':    return 'Film'
    default:        return key
  }
}
