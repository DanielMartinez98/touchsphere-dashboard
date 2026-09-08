// Gmail, as the work corner sees it.
//
// Polled rather than pushed: Gmail has no webhook we could receive on a
// tailnet, and the alternative — a watch subscription through Cloud Pub/Sub —
// is a second Google product to configure for a mailbox that is checked when
// someone walks past. One unread count per account every couple of minutes is
// enough for a pill, and opening the corner refetches straight away.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useServerEvent } from './useServerEvents'

export interface MailAccountInfo { email: string; addedAt: string; muted: boolean; canSend: boolean }
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
  /** Machine-sent to a list (marketing, newsletters). Hidden in the people tabs. */
  bulk: boolean
}

/**
 * The tabs, decided from what this mailbox actually holds rather than from
 * Gmail's full label list:
 *
 *   Primary   the mail from people and the services one signed up to hear
 *             from — 44 unread on the day this was measured
 *   Updates   bank alerts, security warnings, receipts, App Store mail; also
 *             where the bulk filter earns its keep, since sale countdowns land
 *             here too
 *   Starred   what was kept on purpose
 *
 * Everything else sits behind "More": Social was 39 LinkedIn notifications
 * out of 40, Promotions was 26,000 unread advertisements, Forums was empty,
 * and Spam is spam. They are one tap away, not on the wall.
 */
export const MAIN_TABS = ['CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'STARRED'] as const
export const HIDDEN_TABS = ['CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_FORUMS', 'SPAM'] as const
/** Where the bulk filter applies: the tabs meant for people, never the ad tab itself. */
export const PEOPLE_TABS = new Set<string>(['CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'INBOX', 'IMPORTANT', 'STARRED'])

const LS_TAB = 'ts_mail_tab'
const LS_UNREAD = 'ts_mail_unread_only'
function remembered(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}
export interface MailAttachment {
  id: string; filename: string; mimeType: string; size: number; cid?: string; inline: boolean
}
export interface MailBody extends MailSummary {
  to: string; cc: string; text: string; html: string; fromHtml: boolean
  attachments: MailAttachment[]
  messageId: string; references: string; replyTo: string
}

/** Where an attachment's bytes are, for an <img>, a frame, or a tap. */
export function attachmentUrl(account: string, messageId: string, a: MailAttachment): string {
  const qs = new URLSearchParams({ account, name: a.filename, type: a.mimeType })
  return `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}?${qs}`
}

/** What the server broadcasts when mail changes on any screen. */
interface MailEvent { account?: string; kind?: 'flags' | 'sent'; ids?: string[]; read?: boolean; starred?: boolean }

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
  const [counts, setCounts] = useState<{ email: string; unread: number; inbox: number; error?: string }[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await json<MailStatus>('/api/mail/status')
      setEnabled(s.enabled)
      if (!s.enabled) { setCounts([]); return }
      const u = await json<{ accounts: { email: string; unread: number; inbox: number; error?: string }[] }>('/api/mail/unread')
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

  // A message read on the phone is no longer unread on the wall: the server
  // announces every flag change, and the count follows it at once.
  useServerEvent('mail', useCallback(() => { if (active) void refresh() }, [active, refresh]))

  const total = counts.reduce((n, c) => n + c.unread, 0)
  return { counts, total, enabled, refresh }
}

/** The panel's half: labels, a list, and one open message. */
export function useMailbox(open: boolean) {
  const [status, setStatus] = useState<MailStatus>(EMPTY_STATUS)
  const [account, setAccount] = useState('')
  const [labels, setLabels] = useState<MailLabel[]>([])
  // Primary by default, and the last tab used after that — a wall display is
  // opened to the same place every time.
  const [label, setLabelState] = useState(() => remembered(LS_TAB, 'CATEGORY_PERSONAL'))
  const [unreadOnly, setUnreadOnlyState] = useState(() => remembered(LS_UNREAD, '0') === '1')
  const [showBulk, setShowBulk] = useState(false)
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<MailSummary[]>([])
  const [nextPage, setNextPage] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
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

  const loadMessages = useCallback(async (who: string, lbl: string, q: string, unread: boolean) => {
    if (!who) return
    const mine = ++seq.current
    setLoading(true)
    setError('')
    setNextPage('')
    try {
      const qs = new URLSearchParams({ account: who, limit: '25' })
      if (lbl) qs.set('label', lbl)
      if (q.trim()) qs.set('q', q.trim())
      if (unread) qs.set('unread', '1')
      const j = await json<{ messages: MailSummary[]; nextPageToken?: string }>(`/api/mail/messages?${qs}`)
      if (mine === seq.current) { setMessages(j.messages); setNextPage(j.nextPageToken ?? '') }
    } catch (e) {
      if (mine === seq.current) { setMessages([]); setError(e instanceof Error ? e.message : 'could not read the mail') }
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  /** The next page, appended. Gmail pages by token, so this is the only way down. */
  const loadMore = useCallback(async () => {
    if (!account || !nextPage || loadingMore) return
    const mine = seq.current
    setLoadingMore(true)
    try {
      const qs = new URLSearchParams({ account, limit: '25', pageToken: nextPage })
      if (label) qs.set('label', label)
      if (query.trim()) qs.set('q', query.trim())
      if (unreadOnly) qs.set('unread', '1')
      const j = await json<{ messages: MailSummary[]; nextPageToken?: string }>(`/api/mail/messages?${qs}`)
      if (mine === seq.current) {
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id))
          return [...prev, ...j.messages.filter(m => !seen.has(m.id))]
        })
        setNextPage(j.nextPageToken ?? '')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not read more mail')
    } finally {
      setLoadingMore(false)
    }
  }, [account, label, query, unreadOnly, nextPage, loadingMore])

  useEffect(() => {
    if (!open || !account) return
    const t = setTimeout(() => {
      void loadLabels(account)
      void loadMessages(account, label, query, unreadOnly)
    }, 0)
    return () => clearTimeout(t)
  }, [open, account, label, query, unreadOnly, loadLabels, loadMessages])

  const refresh = useCallback(() => {
    void loadLabels(account)
    void loadMessages(account, label, query, unreadOnly)
  }, [account, label, query, unreadOnly, loadLabels, loadMessages])

  const setLabel = useCallback((id: string) => {
    setLabelState(id)
    setShowBulk(false)
    remember(LS_TAB, id)
  }, [])

  // Another screen changed something: flip the rows it names right away, and
  // refetch the counts and the list so a filter (Unread) is right again.
  const onMailEvent = useCallback((raw: unknown) => {
    if (!open || !account) return
    const ev = (raw ?? {}) as MailEvent
    if (ev.account && ev.account !== account) return
    if (ev.kind === 'flags' && ev.ids?.length) {
      const ids = new Set(ev.ids)
      setMessages(prev => prev.map(m => (ids.has(m.id) ? {
        ...m,
        ...(ev.read !== undefined ? { unread: !ev.read } : {}),
        ...(ev.starred !== undefined ? { starred: ev.starred } : {}),
      } : m)))
      setBody(b => (b && ids.has(b.id) ? {
        ...b,
        ...(ev.read !== undefined ? { unread: !ev.read } : {}),
        ...(ev.starred !== undefined ? { starred: ev.starred } : {}),
      } : b))
    }
    void loadLabels(account)
    void loadMessages(account, label, query, unreadOnly)
  }, [open, account, label, query, unreadOnly, loadLabels, loadMessages])
  useServerEvent('mail', onMailEvent)

  /** Answer the open message. Resolves with an error sentence rather than throwing. */
  const reply = useCallback(async (id: string, text: string): Promise<string> => {
    try {
      const r = await fetch(`/api/mail/messages/${encodeURIComponent(id)}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, text }),
      })
      const j = await r.json().catch(() => ({})) as { error?: string }
      if (!r.ok) return j.error ?? `HTTP ${r.status}`
      return ''
    } catch (e) {
      return e instanceof Error ? e.message : 'could not send'
    }
  }, [account])

  const canSend = status.accounts.find(a => a.email === account)?.canSend ?? false

  const setUnreadOnly = useCallback((v: boolean) => {
    setUnreadOnlyState(v)
    remember(LS_UNREAD, v ? '1' : '0')
  }, [])

  // The bulk filter: in the tabs meant for people, machine-sent marketing is
  // folded away behind one line that says how much was hidden. Never in
  // Promotions, where bulk is the whole point of the tab.
  const hideBulk = PEOPLE_TABS.has(label) && !showBulk && !query.trim()
  const visible = hideBulk ? messages.filter(m => !m.bulk) : messages
  const hiddenBulk = hideBulk ? messages.length - visible.length : 0

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
    unreadOnly, setUnreadOnly,
    query, setQuery,
    messages: visible, hiddenBulk, showBulk, setShowBulk,
    loading, error, refresh,
    nextPage, loadingMore, loadMore,
    body, bodyLoading, openMessage, closeMessage,
    setFlag, markAllRead,
    reply, canSend,
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
