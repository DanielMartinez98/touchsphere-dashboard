// Gmail, as the work corner sees it.
//
// Polled rather than pushed: Gmail has no webhook we could receive on a
// tailnet, and the alternative — a watch subscription through Cloud Pub/Sub —
// is a second Google product to configure for a mailbox that is checked when
// someone walks past. One unread count per account every couple of minutes is
// enough for a pill, and opening the corner refetches straight away.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface MailAccountInfo { email: string; addedAt: string; muted: boolean }
export interface MailStatus {
  configured:  boolean
  enabled:     boolean
  clientId:    string
  accounts:    MailAccountInfo[]
  redirectUri: string
}
export interface MailLabel { id: string; name: string; type: 'system' | 'user'; unread: number; total: number }
export interface MailSummary {
  id: string; threadId: string; account: string
  from: string; fromName: string; subject: string; snippet: string
  date: string; unread: boolean; starred: boolean; labels: string[]
}
export interface MailBody extends MailSummary {
  to: string; cc: string; text: string; fromHtml: boolean
  attachments: { filename: string; mimeType: string; size: number }[]
}

const EMPTY_STATUS: MailStatus = {
  configured: false, enabled: false, clientId: '', accounts: [], redirectUri: '',
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const j = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
  return j
}

/** The pill's half: how much unread there is, per account. Cheap and polled. */
export function useMailUnread(active: boolean) {
  const [counts, setCounts] = useState<{ email: string; unread: number; error?: string }[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await json<MailStatus>('/api/mail/status')
      setEnabled(s.enabled)
      if (!s.enabled) { setCounts([]); return }
      const u = await json<{ accounts: { email: string; unread: number; error?: string }[] }>('/api/mail/unread')
      setCounts(u.accounts)
    } catch {
      setEnabled(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // Deferred a tick rather than called straight out of the effect: the work
    // is a fetch either way, and starting it here synchronously is the
    // cascading-render pattern the lint rule exists to catch.
    const first = setTimeout(() => { void refresh() }, 0)
    // Two minutes: a mailbox glanced at from across a room, not a client.
    const t = setInterval(() => { void refresh() }, 120_000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [active, refresh])

  const total = counts.reduce((n, c) => n + c.unread, 0)
  return { counts, total, enabled, refresh }
}

/** The panel's half: labels, a list, and one open message. */
export function useMailbox(open: boolean) {
  const [status, setStatus] = useState<MailStatus>(EMPTY_STATUS)
  const [account, setAccount] = useState('')
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [label, setLabel] = useState('INBOX')
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<MailSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [body, setBody] = useState<MailBody | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  // Bumped by every refetch, so a slow answer for a filter the user has since
  // left cannot overwrite the one they are looking at.
  const seq = useRef(0)

  const loadStatus = useCallback(async () => {
    try {
      const s = await json<MailStatus>('/api/mail/status')
      setStatus(s)
      setAccount(a => a || s.accounts.find(x => !x.muted)?.email || s.accounts[0]?.email || '')
    } catch { setStatus(EMPTY_STATUS) }
  }, [])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(t)
  }, [open, loadStatus])

  const loadLabels = useCallback(async (who: string) => {
    if (!who) return
    try {
      const j = await json<{ labels: MailLabel[] }>(`/api/mail/labels?account=${encodeURIComponent(who)}`)
      setLabels(j.labels)
    } catch (e) { setError(e instanceof Error ? e.message : 'could not read the labels') }
  }, [])

  const loadMessages = useCallback(async (who: string, lbl: string, q: string) => {
    if (!who) return
    const mine = ++seq.current
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ account: who, limit: '25' })
      if (lbl) qs.set('label', lbl)
      if (q.trim()) qs.set('q', q.trim())
      const j = await json<{ messages: MailSummary[] }>(`/api/mail/messages?${qs}`)
      if (mine === seq.current) setMessages(j.messages)
    } catch (e) {
      if (mine === seq.current) { setMessages([]); setError(e instanceof Error ? e.message : 'could not read the mail') }
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !account) return
    const t = setTimeout(() => {
      void loadLabels(account)
      void loadMessages(account, label, query)
    }, 0)
    return () => clearTimeout(t)
  }, [open, account, label, query, loadLabels, loadMessages])

  const refresh = useCallback(() => {
    void loadLabels(account)
    void loadMessages(account, label, query)
  }, [account, label, query, loadLabels, loadMessages])

  /**
   * Open a message, and mark it read the way every mail client does.
   *
   * The list row is flipped locally first: the round trip to Google is most of
   * a second, and a message that stays bold after you have opened it reads as
   * the tap having missed.
   */
  const openMessage = useCallback(async (id: string) => {
    setBodyLoading(true)
    setBody(null)
    try {
      const m = await json<MailBody>(`/api/mail/messages/${id}?account=${encodeURIComponent(account)}`)
      setBody(m)
      if (m.unread) {
        setMessages(prev => prev.map(x => (x.id === id ? { ...x, unread: false } : x)))
        setLabels(prev => prev.map(l => (m.labels.includes(l.id) ? { ...l, unread: Math.max(0, l.unread - 1) } : l)))
        void fetch(`/api/mail/messages/${id}/flags`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, read: true }),
        }).catch(() => { /* the next refresh tells the truth */ })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not open that message')
    } finally {
      setBodyLoading(false)
    }
  }, [account])

  const closeMessage = useCallback(() => setBody(null), [])

  const setFlag = useCallback(async (id: string, flags: { read?: boolean; starred?: boolean }) => {
    setMessages(prev => prev.map(m => (m.id === id ? {
      ...m,
      ...(flags.read !== undefined ? { unread: !flags.read } : {}),
      ...(flags.starred !== undefined ? { starred: flags.starred } : {}),
    } : m)))
    setBody(b => (b && b.id === id ? {
      ...b,
      ...(flags.read !== undefined ? { unread: !flags.read } : {}),
      ...(flags.starred !== undefined ? { starred: flags.starred } : {}),
    } : b))
    try {
      await fetch(`/api/mail/messages/${id}/flags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, ...flags }),
      })
    } catch { /* optimistic; refresh corrects it */ }
  }, [account])

  const markAllRead = useCallback(async () => {
    setMessages(prev => prev.map(m => ({ ...m, unread: false })))
    try {
      await fetch('/api/mail/read-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, label }),
      })
    } catch { /* refresh corrects it */ }
    refresh()
  }, [account, label, refresh])

  return {
    status, account, setAccount,
    labels, label, setLabel,
    query, setQuery,
    messages, loading, error, refresh,
    body, bodyLoading, openMessage, closeMessage,
    setFlag, markAllRead,
  }
}

/** Settings' half: register the Google app, and manage the signed-in accounts. */
export function useMailSettings() {
  const [status, setStatus] = useState<MailStatus>(EMPTY_STATUS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try { setStatus(await json<MailStatus>('/api/mail/status')) }
    catch (e) { setError(e instanceof Error ? e.message : 'could not read the mail settings') }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void refresh() }, 0)
    return () => clearTimeout(t)
  }, [refresh])

  const saveApp = useCallback(async (clientId: string, clientSecret: string) => {
    setBusy(true); setError('')
    try {
      await json('/api/mail/app', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      })
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'could not save that') }
    finally { setBusy(false) }
  }, [refresh])

  const remove = useCallback(async (email: string) => {
    setBusy(true)
    try { await fetch(`/api/mail/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' }) }
    catch { /* refresh tells the truth */ }
    await refresh()
    setBusy(false)
  }, [refresh])

  const setMuted = useCallback(async (email: string, muted: boolean) => {
    try {
      await fetch(`/api/mail/accounts/${encodeURIComponent(email)}/mute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted }),
      })
    } catch { /* refresh tells the truth */ }
    await refresh()
  }, [refresh])

  return { status, busy, error, refresh, saveApp, remove, setMuted }
}
