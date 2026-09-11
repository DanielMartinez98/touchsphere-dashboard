import { useState, useEffect, useCallback } from 'react'

// Who the user is, in Notion. The integration authenticates as a bot, so the
// API cannot know which human is "you" — the user picks themselves once and
// the server keeps it (notion-me.json): ONE person for every workspace, since
// a Notion user id is the same in every workspace a person belongs to, with
// a per-workspace override for someone who is a different account in one.
//
// Candidates come from two places: each workspace's member list, and the
// people seen on its boards' rows. The member list can be empty for an
// integration whose workspace has not granted it user information, yet every
// row still names its assignee, so the picker always has the right answer.
//
// Until 2026-09-11 this lived in localStorage per device; the kiosk and the
// phone could disagree about who "me" was.

export interface NotionUser {
  id:         string
  name:       string
  avatarUrl?: string | null
  email?:     string | null
  type?:      string   // 'person' | 'bot'
  conn?:      { id: string; name: string; color: string }
}

export interface NotionIdentity { id: string; name: string; email?: string }

interface MeView {
  me:        NotionIdentity | null
  byConn:    Record<string, NotionIdentity>
  effective: Record<string, NotionIdentity | null>
}

interface UsersView {
  users: NotionUser[]
  seen:  Record<string, NotionUser[]>
}

// Module-level cache so the lists are fetched once and shared by every
// consumer (the corner's picker, the Settings tab, the "Only mine" chip).
let cachedUsers: UsersView | null = null
let inflightUsers: Promise<UsersView> | null = null
let cachedMe: MeView | null = null
const listeners = new Set<() => void>()
function notify() { for (const l of listeners) l() }

const EMPTY_USERS: UsersView = { users: [], seen: {} }

function fetchUsers(force = false): Promise<UsersView> {
  if (cachedUsers && !force) return Promise.resolve(cachedUsers)
  if (inflightUsers) return inflightUsers
  inflightUsers = fetch('/api/notion/users')
    .then(r => (r.ok ? r.json() : EMPTY_USERS))
    .then((d: UsersView) => {
      cachedUsers = {
        // Only real people can be assignees — drop bot/integration users.
        users: (d.users ?? []).filter(u => u.type !== 'bot'),
        seen:  d.seen ?? {},
      }
      return cachedUsers
    })
    .catch(() => EMPTY_USERS)
    .finally(() => { inflightUsers = null })
  return inflightUsers
}

function fetchMe(): Promise<MeView | null> {
  return fetch('/api/notion/me')
    .then(r => (r.ok ? r.json() : null))
    .then((v: MeView | null) => { cachedMe = v; return v })
    .catch(() => null)
}

/**
 * Every distinct person across the workspaces, one entry each, with the
 * workspaces they were found in. Members first, then people only seen on
 * rows; matched up by id, then by email.
 */
export function distinctPeople(view: UsersView): (NotionUser & { conns: { id: string; name: string; color: string }[] })[] {
  const out = new Map<string, NotionUser & { conns: { id: string; name: string; color: string }[] }>()
  const byEmail = new Map<string, string>()
  const add = (u: NotionUser) => {
    const email = u.email?.toLowerCase() ?? ''
    const key = out.has(u.id) ? u.id : (email && byEmail.get(email)) || u.id
    const cur = out.get(key)
    if (cur) {
      if (!cur.name && u.name) cur.name = u.name
      if (!cur.avatarUrl && u.avatarUrl) cur.avatarUrl = u.avatarUrl
      if (!cur.email && u.email) cur.email = u.email
      if (u.conn && !cur.conns.some(c => c.id === u.conn!.id)) cur.conns.push(u.conn)
    } else {
      out.set(key, { ...u, conns: u.conn ? [u.conn] : [] })
      if (email) byEmail.set(email, key)
    }
  }
  for (const u of view.users) add(u)
  for (const list of Object.values(view.seen)) for (const u of list) add(u)
  return Array.from(out.values()).filter(u => u.name || u.email)
}

export function useNotionMe() {
  const [view,    setView]    = useState<UsersView>(cachedUsers ?? EMPTY_USERS)
  const [meView,  setMeView]  = useState<MeView | null>(cachedMe)
  const [loading, setLoading] = useState(!cachedUsers || !cachedMe)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([fetchUsers(), fetchMe()]).then(([u, m]) => {
      if (!alive) return
      setView(u)
      if (m) setMeView(m)
      setLoading(false)
    })
    const l = () => { if (alive) { if (cachedUsers) setView(cachedUsers); if (cachedMe) setMeView(cachedMe) } }
    listeners.add(l)
    return () => { alive = false; listeners.delete(l) }
  }, [])

  const reload = useCallback(async () => {
    const [u, m] = await Promise.all([fetchUsers(true), fetchMe()])
    setView(u)
    if (m) setMeView(m)
    notify()
  }, [])

  /**
   * Pick the one person (`conn` omitted) or a workspace's override. `null`
   * clears. The task list filters server-side, so it refetches after this.
   */
  const setMe = useCallback(async (user: NotionUser | null, conn?: string) => {
    setSaving(true)
    try {
      const r = await fetch('/api/notion/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user
          ? { id: user.id, name: user.name, email: user.email ?? undefined, conn }
          : { id: null, conn }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const v = await r.json() as MeView
      cachedMe = v
      setMeView(v)
      notify()
      window.dispatchEvent(new CustomEvent('ts:task-dbs-changed'))
    } catch (err) {
      console.error('[notion] failed to set who I am:', err)
    } finally {
      setSaving(false)
    }
  }, [])

  const me = meView?.me ?? null
  return {
    users: view.users,
    seen: view.seen,
    people: distinctPeople(view),
    me,
    meId: me?.id ?? null,
    byConn: meView?.byConn ?? {},
    effective: meView?.effective ?? {},
    setMe,
    reload,
    loading,
    saving,
  }
}
