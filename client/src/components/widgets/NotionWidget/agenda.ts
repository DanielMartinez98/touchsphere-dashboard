import { useEffect, useState } from 'react'
import type { NotionTask, CalendarItem, NotionBoard, NotionTeam, DateKind } from '../../../hooks/useNotion'
import type { CalendarEvent } from '../../../types'
import { fetchMonthEvents } from '../../../hooks/useCalendar'
import { GOOGLE_COLOR } from './task-utils'

// One agenda across everything dated: task due dates, calendar boards' dates
// (a content piece's film date and publish date are two entries), and the
// Google calendar the Time corner shows. Every entry has a day, a colour (the
// team's, or Google's cyan) and what it is, so the month grid, the day list,
// the "coming up" strip and the team cards all draw from the same list.

export interface AgendaEntry {
  key:        string
  day:        string                 // YYYY-MM-DD
  kind:       DateKind | 'google'
  dateLabel:  string                 // "Due", "Film", "Publish", the property name, or "Event"
  title:      string
  color:      string
  teamId:     string | null
  boardId:    string | null
  boardTitle: string | null
  status:     string | null
  done:       boolean
  mine:       boolean
  time:       string | null          // "09:00" when the date has a time
  endDay:     string | null          // for ranges, the last day
  task?:      NotionTask
  item?:      CalendarItem
  google?:    CalendarEvent
}

export interface Layers { tasks: boolean; content: boolean; google: boolean }
export const ALL_LAYERS: Layers = { tasks: true, content: true, google: true }

function timeOf(iso: string): string | null {
  if (iso.length <= 10) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function localDay(iso: string): string {
  if (iso.length <= 10) return iso
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildEntries(opts: {
  tasks:    NotionTask[]
  items:    CalendarItem[]
  boards:   NotionBoard[]
  teams:    NotionTeam[]
  google:   CalendarEvent[]
  layers:   Layers
  onlyMine: boolean
  team:     string | null
}): AgendaEntry[] {
  const { tasks, items, boards, teams, google, layers, onlyMine, team } = opts
  const boardById = new Map(boards.map(b => [b.id, b]))
  const teamById  = new Map(teams.map(t => [t.id, t]))
  const out: AgendaEntry[] = []

  const teamOf = (boardId: string) => { const b = boardById.get(boardId); return b?.conn ? teamById.get(b.conn.id) ?? null : null }
  const wanted = (boardId: string, mine: boolean) => {
    const t = teamOf(boardId)
    if (team && t?.id !== team) return false
    if (onlyMine && !mine) return false
    return true
  }

  if (layers.tasks) {
    for (const t of tasks) {
      if (t.done || !t.due) continue
      if (!wanted(t.dbId, t.mine)) continue
      const tm = teamOf(t.dbId)
      out.push({
        key: `task:${t.id}`, day: t.due.slice(0, 10), kind: 'due', dateLabel: 'Due', title: t.title,
        color: tm?.color ?? '#9ca3af', teamId: tm?.id ?? null, boardId: t.dbId, boardTitle: boardById.get(t.dbId)?.title ?? null,
        status: t.status, done: t.done, mine: t.mine, time: timeOf(t.due), endDay: null, task: t,
      })
    }
  }
  if (layers.content) {
    for (const it of items) {
      if (!wanted(it.boardId, it.mine)) continue
      const tm = teamOf(it.boardId)
      for (const d of it.dates) {
        out.push({
          key: `item:${it.id}:${d.key}`, day: d.start.slice(0, 10), kind: d.kind,
          dateLabel: d.kind === 'due' ? 'Due' : d.kind === 'film' ? 'Film' : d.kind === 'publish' ? 'Publish' : d.key,
          title: it.title, color: tm?.color ?? '#9ca3af', teamId: tm?.id ?? null, boardId: it.boardId,
          boardTitle: boardById.get(it.boardId)?.title ?? null, status: it.status, done: it.done, mine: it.mine,
          time: timeOf(d.start), endDay: d.end ? d.end.slice(0, 10) : null, item: it,
        })
      }
    }
  }
  if (layers.google && !team) {
    for (const ev of google) {
      out.push({
        key: `google:${ev.id}`, day: localDay(ev.start), kind: 'google', dateLabel: 'Event', title: ev.title,
        color: GOOGLE_COLOR, teamId: null, boardId: null, boardTitle: 'Google Calendar', status: null, done: false, mine: true,
        time: ev.allDay ? null : timeOf(ev.start), endDay: null, google: ev,
      })
    }
  }
  // Timed entries first within a day, by time; then the rest by kind order.
  const kindRank: Record<string, number> = { google: 0, due: 1, film: 2, publish: 3, date: 4 }
  out.sort((a, b) => a.day.localeCompare(b.day)
    || (a.time && b.time ? a.time.localeCompare(b.time) : a.time ? -1 : b.time ? 1 : 0)
    || (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
    || a.title.localeCompare(b.title))
  return out
}

export function groupByDay(entries: AgendaEntry[]): Map<string, AgendaEntry[]> {
  const m = new Map<string, AgendaEntry[]>()
  for (const e of entries) { const l = m.get(e.day); if (l) l.push(e); else m.set(e.day, [e]) }
  return m
}

// Google events for whole months, cached for the session. A month that fails
// (no CALENDAR_ICAL_URL, or the feed is down) is an empty month, and
// `available` says whether Google is there at all, so the layer toggle can
// disappear rather than sit there doing nothing.
const monthCache = new Map<string, CalendarEvent[]>()
let googleAvailable: boolean | null = null

export function useGoogleMonths(keys: string[]): { events: CalendarEvent[]; available: boolean } {
  const [, bump] = useState(0)
  const joined = keys.join(',')
  useEffect(() => {
    let alive = true
    const missing = joined.split(',').filter(k => k && !monthCache.has(k))
    if (missing.length === 0) return
    void Promise.all(missing.map(async k => {
      const [y, m] = k.split('-').map(Number)
      try {
        const evs = await fetchMonthEvents(y!, m!)
        monthCache.set(k, evs)
        googleAvailable = true
      } catch {
        monthCache.set(k, [])
        if (googleAvailable === null) googleAvailable = false
      }
    })).then(() => { if (alive) bump(n => n + 1) })
    return () => { alive = false }
  }, [joined])
  const events: CalendarEvent[] = []
  const seen = new Set<string>()
  for (const k of joined.split(',')) for (const ev of monthCache.get(k) ?? []) { if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev) } }
  return { events, available: googleAvailable !== false }
}

/** "YYYY-M" keys for the months touching a day range. */
export function monthKeys(fromDay: string, toDay: string): string[] {
  const out: string[] = []
  const a = new Date(fromDay + 'T12:00'), b = new Date(toDay + 'T12:00')
  for (let y = a.getFullYear(), m = a.getMonth(); y < b.getFullYear() || (y === b.getFullYear() && m <= b.getMonth()); m++) {
    if (m > 11) { m = 0; y++ }
    out.push(`${y}-${m}`)
  }
  return out
}
