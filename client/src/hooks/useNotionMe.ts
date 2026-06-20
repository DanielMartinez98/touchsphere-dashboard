import { useState, useEffect, useCallback } from 'react'

// Workspace user list + the persisted "me" identity. The Notion integration
// authenticates as a bot, so the API can't know which human is "you" — the user
// picks themselves once (★) and we remember it for one-tap "assigned to me"
// filters. Persisted in localStorage so the kiosk survives reboots.

export interface NotionUser {
  id:         string
  name:       string
  avatarUrl?: string
  type?:      string   // 'person' | 'bot'
}

const ME_KEY = 'notion.me'

// Module-level cache so the user list is fetched once and shared by every
// consumer (filter picker, "Only mine" chip) instead of refetching per mount.
let cachedUsers: NotionUser[] | null = null
let inflight: Promise<NotionUser[]> | null = null

function fetchUsers(): Promise<NotionUser[]> {
  if (cachedUsers) return Promise.resolve(cachedUsers)
  if (inflight)    return inflight
  inflight = fetch('/api/notion/users')
    .then(r => (r.ok ? r.json() : { users: [] }))
    // Only real people can be assignees — drop bot/integration users.
    .then(d => { cachedUsers = ((d.users ?? []) as NotionUser[]).filter(u => u.type !== 'bot'); return cachedUsers })
    .catch(() => [] as NotionUser[])
    .finally(() => { inflight = null })
  return inflight
}

export function useNotionMe() {
  const [users,   setUsers]   = useState<NotionUser[]>(cachedUsers ?? [])
  const [meId,    setMeId]    = useState<string | null>(() => localStorage.getItem(ME_KEY))
  const [loading, setLoading] = useState(!cachedUsers)

  useEffect(() => {
    let alive = true
    void fetchUsers().then(u => { if (alive) { setUsers(u); setLoading(false) } })
    return () => { alive = false }
  }, [])

  // Keep "me" in sync across widget instances / tabs sharing localStorage.
  useEffect(() => {
    function onStorage(e: StorageEvent) { if (e.key === ME_KEY) setMeId(localStorage.getItem(ME_KEY)) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setMe = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(ME_KEY, id)
      else    localStorage.removeItem(ME_KEY)
    } catch { /* quota / private mode — ignore */ }
    setMeId(id)
  }, [])

  const me = users.find(u => u.id === meId) ?? null
  return { users, me, meId, setMe, loading }
}
