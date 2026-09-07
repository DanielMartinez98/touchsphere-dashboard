// Gmail, for the work corner: several accounts, read on the device, marked
// read, and filtered by the labels the user already keeps in Gmail.
//
// OAUTH RATHER THAN A STORED PASSWORD. The alternative was IMAP with app
// passwords, which needs no Google Cloud project at all — but it puts a
// password that unlocks the whole mailbox in a file on the volume, and the
// user chose the sign-in that never stores one. What is stored instead is a
// refresh token per account, scoped to `gmail.modify`: enough to read and to
// flip the UNREAD label, and nothing else. Revoking it is one click in the
// Google account page rather than a password change.
//
// FILTERS ARE GMAIL'S OWN. Nothing here invents a taxonomy: the label list
// comes straight from the API, which is the same set the Gmail web interface
// shows — the system ones (INBOX, STARRED, IMPORTANT, the CATEGORY_* tabs)
// and every label the user made. Selecting one is a `labelIds` filter, and
// the search box takes Gmail's own query syntax, so "from:bank is:unread"
// means there what it means in Gmail.
//
// Tokens live in `mail.json` in $CACHE_DIR, written 0600. The client id and
// secret live beside them rather than in the environment, because the user
// pastes them into Settings on a device with no keyboard-friendly shell.

import fs from 'fs'
import path from 'path'

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API       = 'https://gmail.googleapis.com/gmail/v1/users/me'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/**
 * `gmail.modify` is read plus label changes — which is what "mark as read"
 * is, since read/unread is the UNREAD label. It cannot send, and it cannot
 * delete permanently. Deliberately not `gmail.readonly`: that would make the
 * mark-as-read this feature was asked for impossible.
 */
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

export interface MailAccount {
  /** The address, from Gmail's own profile — never typed by the user. */
  email:        string
  refreshToken: string
  addedAt:      string
  /** Hidden from the corner without being signed out. */
  muted?:       boolean
}

interface Store {
  clientId:     string
  clientSecret: string
  accounts:     MailAccount[]
}

const EMPTY: Store = { clientId: '', clientSecret: '', accounts: [] }

function file(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'mail.json')
}

function read(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return {
      clientId:     typeof raw.clientId === 'string' ? raw.clientId : '',
      clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : '',
      accounts: Array.isArray(raw.accounts)
        ? raw.accounts.filter((a): a is MailAccount =>
            !!a && typeof a.email === 'string' && typeof a.refreshToken === 'string')
        : [],
    }
  } catch {
    return { ...EMPTY, accounts: [] }
  }
}

function write(next: Store): void {
  const dir = path.dirname(file())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = file()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    // 0600 before anything is in it: refresh tokens are credentials, and a
    // world-readable moment between write and chmod is a real one.
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, p)
    fs.chmodSync(p, 0o600)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[mail] failed to save:', err)
  }
}

/** Whether the corner should exist at all: an app registered and at least one account. */
export function mailEnabled(): boolean {
  const s = read()
  return !!(s.clientId && s.clientSecret && s.accounts.length > 0)
}

/** Whether the Google app is registered — the half the user does once. */
export function mailConfigured(): boolean {
  const s = read()
  return !!(s.clientId && s.clientSecret)
}

export function mailAccounts(): { email: string; addedAt: string; muted: boolean }[] {
  return read().accounts.map(a => ({ email: a.email, addedAt: a.addedAt, muted: a.muted === true }))
}

/**
 * Store the Google app, refusing anything that plainly is not one.
 *
 * The three fields on that Settings page are a redirect URI to copy OUT and
 * two to paste IN, and the first thing that happened in the wild was the
 * redirect URI landing in the client id box. Google's answer to that is an
 * error page whose only detail is "flowName=GeneralOAuthFlow", which tells
 * nobody anything — so the shape is checked here, where a real sentence can
 * be said about it. A client id always ends in .apps.googleusercontent.com
 * and a secret never looks like a URL.
 */
export function setClientApp(clientId: string, clientSecret: string): void {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (id && !/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error(
      /^https?:/i.test(id)
        ? 'That looks like the redirect URI, not the client ID. The redirect URI is the one to ' +
          'copy OUT of here and paste INTO Google. The client ID comes back from Google and ' +
          'ends in .apps.googleusercontent.com'
        : 'That is not a Google client ID — it should end in .apps.googleusercontent.com',
    )
  }
  if (secret && /^https?:/i.test(secret)) {
    throw new Error('That looks like a URL, not the client secret. The secret is the short random string Google shows beside the client ID.')
  }
  const s = read()
  s.clientId = id
  s.clientSecret = secret
  write(s)
  console.log(`[mail] Google app ${s.clientId ? 'set' : 'cleared'}`)
}

export function clientIdOnly(): string {
  return read().clientId
}

export function setMuted(email: string, muted: boolean): void {
  const s = read()
  const a = s.accounts.find(x => x.email === email)
  if (!a) return
  a.muted = muted
  write(s)
}

/**
 * Forget an account, and tell Google to forget us too.
 *
 * Revoking rather than only deleting the row: a refresh token that is dropped
 * from a file but never revoked keeps working forever, and the point of
 * "remove this account" is that it stops working.
 */
export async function removeAccount(email: string): Promise<boolean> {
  const s = read()
  const a = s.accounts.find(x => x.email === email)
  if (!a) return false
  s.accounts = s.accounts.filter(x => x.email !== email)
  write(s)
  tokens.delete(email)
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: a.refreshToken }),
    })
  } catch (err) {
    console.warn('[mail] revoke failed (the row is gone anyway):', err instanceof Error ? err.message : err)
  }
  console.log(`[mail] removed ${email}`)
  return true
}

// ── The sign-in dance ────────────────────────────────────────────────────────

/**
 * Where to send the browser, and the state to check on the way back.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * REFRESH token: without both, a second sign-in for the same account returns
 * an access token only, and the account works until it silently expires an
 * hour later.
 */
export function authUrl(redirectUri: string, state: string): string {
  const s = read()
  if (!s.clientId) throw new Error('no Google app is registered yet')
  const qs = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${qs}`
}

/** Finish the dance: swap the code for tokens, ask who it is, and store it. */
export async function completeSignIn(code: string, redirectUri: string): Promise<string> {
  const s = read()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: s.clientId, client_secret: s.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  })
  const j = await res.json() as { access_token?: string; refresh_token?: string; error_description?: string; error?: string }
  if (!res.ok || !j.access_token) {
    throw new Error(j.error_description ?? j.error ?? `Google answered ${res.status}`)
  }
  if (!j.refresh_token) {
    throw new Error(
      'Google returned no refresh token. Remove this app from your account\'s third-party ' +
      'access list and sign in again, so the consent screen is shown afresh.',
    )
  }
  const profile = await fetch(`${API}/profile`, {
    headers: { authorization: `Bearer ${j.access_token}` },
  }).then(r => r.json() as Promise<{ emailAddress?: string }>)
  const email = profile.emailAddress
  if (!email) throw new Error('signed in, but Gmail would not say which address it was')

  const store = read()
  store.accounts = store.accounts.filter(a => a.email !== email)
  store.accounts.push({ email, refreshToken: j.refresh_token, addedAt: new Date().toISOString() })
  write(store)
  tokens.set(email, { token: j.access_token, until: Date.now() + 55 * 60_000 })
  console.log(`[mail] signed in ${email} (${store.accounts.length} account(s))`)
  return email
}

// ── Talking to Gmail ─────────────────────────────────────────────────────────

/** Access tokens live an hour; keep them until five minutes before that. */
const tokens = new Map<string, { token: string; until: number }>()

async function accessToken(email: string): Promise<string> {
  const cached = tokens.get(email)
  if (cached && cached.until > Date.now()) return cached.token
  const s = read()
  const acct = s.accounts.find(a => a.email === email)
  if (!acct) throw new Error(`${email} is not signed in`)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.clientId, client_secret: s.clientSecret,
      refresh_token: acct.refreshToken, grant_type: 'refresh_token',
    }),
  })
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !j.access_token) {
    // A refresh token that Google has stopped honouring (revoked, password
    // changed, six months idle) is not a transient failure — say which account
    // needs signing in again rather than retrying forever.
    throw new Error(`${email} needs signing in again (${j.error_description ?? j.error ?? res.status})`)
  }
  const until = Date.now() + Math.max(60, (j.expires_in ?? 3600) - 300) * 1000
  tokens.set(email, { token: j.access_token, until })
  return j.access_token
}

async function api<T>(email: string, pathname: string, init?: RequestInit): Promise<T> {
  const token = await accessToken(email)
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let detail = body.slice(0, 200)
    try {
      const j = JSON.parse(body) as { error?: { message?: string } }
      if (j.error?.message) detail = j.error.message
    } catch { /* not JSON */ }
    throw new Error(`Gmail answered ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export interface MailLabel {
  id:     string
  name:   string
  /** 'system' for INBOX, STARRED, the CATEGORY_* tabs; 'user' for the user's own. */
  type:   string
  unread: number
  total:  number
}

/**
 * The label list, which IS the filter list.
 *
 * Sorted the way Gmail's own sidebar reads rather than alphabetically: the
 * places you go first, then the category tabs, then everything the user made.
 * Names are prettied only for the system ones, whose API ids are shouty
 * (`CATEGORY_PERSONAL`).
 */
const SYSTEM_ORDER = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH']
const PRETTY: Record<string, string> = {
  INBOX: 'Inbox', UNREAD: 'Unread', STARRED: 'Starred', IMPORTANT: 'Important',
  SENT: 'Sent', DRAFT: 'Drafts', SPAM: 'Spam', TRASH: 'Bin',
  CATEGORY_PERSONAL: 'Primary', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums',
}

export async function listLabels(email: string): Promise<MailLabel[]> {
  const j = await api<{ labels?: { id: string; name: string; type?: string }[] }>(email, '/labels')
  const labels = j.labels ?? []
  // Counts come one call each, so only for the ones worth a badge: everything
  // except the noisy archives.
  const wanted = labels.filter(l => l.id !== 'CHAT' && l.id !== 'SENT' && l.id !== 'DRAFT' && l.id !== 'TRASH')
  const detailed = await Promise.all(wanted.map(async l => {
    try {
      const d = await api<{ messagesTotal?: number; messagesUnread?: number }>(email, `/labels/${encodeURIComponent(l.id)}`)
      return { ...l, unread: d.messagesUnread ?? 0, total: d.messagesTotal ?? 0 }
    } catch {
      return { ...l, unread: 0, total: 0 }
    }
  }))
  const rank = (l: { id: string; type?: string }) => {
    const sys = SYSTEM_ORDER.indexOf(l.id)
    if (sys >= 0) return sys
    if (l.id.startsWith('CATEGORY_')) return 100 + Object.keys(PRETTY).indexOf(l.id)
    return 1000
  }
  return detailed
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(l => ({
      id: l.id,
      name: PRETTY[l.id] ?? l.name,
      type: l.type === 'system' ? 'system' : 'user',
      unread: l.unread,
      total: l.total,
    }))
}

export interface MailSummary {
  id:       string
  threadId: string
  account:  string
  from:     string
  fromName: string
  subject:  string
  snippet:  string
  date:     string
  unread:   boolean
  starred:  boolean
  labels:   string[]
}

function header(headers: { name?: string; value?: string }[] | undefined, want: string): string {
  return headers?.find(h => (h.name ?? '').toLowerCase() === want)?.value ?? ''
}

/** "Jane Doe <jane@x.com>" → the two halves, without a MIME parser for one line. */
function splitFrom(raw: string): { name: string; address: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw)
  if (m) return { name: (m[1] ?? '').replace(/^"|"$/g, '').trim() || m[2]!, address: m[2]! }
  return { name: raw.trim(), address: raw.trim() }
}

export async function listMessages(
  email: string,
  opts: { labelIds?: string[]; q?: string; limit?: number; pageToken?: string } = {},
): Promise<{ messages: MailSummary[]; nextPageToken?: string }> {
  const qs = new URLSearchParams({ maxResults: String(Math.min(50, Math.max(1, opts.limit ?? 25))) })
  for (const id of opts.labelIds ?? []) qs.append('labelIds', id)
  if (opts.q) qs.set('q', opts.q)
  if (opts.pageToken) qs.set('pageToken', opts.pageToken)

  const list = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
    email, `/messages?${qs}`)
  const ids = (list.messages ?? []).map(m => m.id)
  // Metadata only: the list needs a sender, a subject and a date, and asking
  // for the body of twenty-five messages to draw a list is most of a second
  // per message for bytes nobody reads.
  const messages = await Promise.all(ids.map(async id => {
    const m = await api<{
      id: string; threadId: string; snippet?: string; internalDate?: string
      labelIds?: string[]; payload?: { headers?: { name?: string; value?: string }[] }
    }>(email, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
    const from = splitFrom(header(m.payload?.headers, 'from'))
    return {
      id: m.id,
      threadId: m.threadId,
      account: email,
      from: from.address,
      fromName: from.name,
      subject: header(m.payload?.headers, 'subject') || '(no subject)',
      snippet: (m.snippet ?? '').slice(0, 300),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
      unread: (m.labelIds ?? []).includes('UNREAD'),
      starred: (m.labelIds ?? []).includes('STARRED'),
      labels: m.labelIds ?? [],
    }
  }))
  return { messages, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) }
}

export interface MailBody extends MailSummary {
  to:   string
  cc:   string
  /** Plain text if the message has any, else text flattened out of the HTML. */
  text: string
  /** True when the original was HTML and this is the flattening of it. */
  fromHtml: boolean
  attachments: { filename: string; mimeType: string; size: number }[]
}

interface Part {
  mimeType?: string
  filename?: string
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: Part[]
  headers?: { name?: string; value?: string }[]
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/** Walk the MIME tree for the first part of a type. Gmail nests multipart/alternative inside mixed. */
function findPart(part: Part | undefined, mime: string): Part | undefined {
  if (!part) return undefined
  if (part.mimeType === mime && part.body?.data) return part
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime)
    if (hit) return hit
  }
  return undefined
}

function collectAttachments(part: Part | undefined, out: MailBody['attachments'] = []): MailBody['attachments'] {
  if (!part) return out
  if (part.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 })
  }
  for (const p of part.parts ?? []) collectAttachments(p, out)
  return out
}

/**
 * HTML to something readable on a 7" screen.
 *
 * Not a renderer and not trying to be: marketing mail is tables of tracking
 * pixels, and putting arbitrary remote HTML on a kiosk would load every one of
 * them. Scripts, styles and tags come out, entities are decoded, block edges
 * become line breaks, and what is left is the words.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim()
}

export async function getMessage(email: string, id: string): Promise<MailBody> {
  const m = await api<{
    id: string; threadId: string; snippet?: string; internalDate?: string
    labelIds?: string[]; payload?: Part
  }>(email, `/messages/${encodeURIComponent(id)}?format=full`)

  const headers = m.payload?.headers
  const from = splitFrom(header(headers, 'from'))
  const plain = findPart(m.payload, 'text/plain')
  const html = plain ? undefined : findPart(m.payload, 'text/html')
  const text = plain?.body?.data ? decode(plain.body.data)
    : html?.body?.data ? htmlToText(decode(html.body.data))
    : (m.snippet ?? '')

  return {
    id: m.id,
    threadId: m.threadId,
    account: email,
    from: from.address,
    fromName: from.name,
    to: header(headers, 'to'),
    cc: header(headers, 'cc'),
    subject: header(headers, 'subject') || '(no subject)',
    snippet: m.snippet ?? '',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
    starred: (m.labelIds ?? []).includes('STARRED'),
    labels: m.labelIds ?? [],
    text: text.slice(0, 40_000),
    fromHtml: !plain && !!html,
    attachments: collectAttachments(m.payload),
  }
}

/** Read/unread and starred are both labels, so both are the same call. */
export async function setFlags(
  email: string, id: string, flags: { read?: boolean; starred?: boolean },
): Promise<void> {
  const add: string[] = []
  const remove: string[] = []
  if (flags.read === true)  remove.push('UNREAD')
  if (flags.read === false) add.push('UNREAD')
  if (flags.starred === true)  add.push('STARRED')
  if (flags.starred === false) remove.push('STARRED')
  if (!add.length && !remove.length) return
  await api(email, `/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  })
}

/** Mark every message a filter matches, for "mark all read" on a label. */
export async function markAllRead(email: string, labelIds: string[]): Promise<number> {
  const { messages } = await listMessages(email, { labelIds, q: 'is:unread', limit: 50 })
  if (messages.length === 0) return 0
  await api(email, '/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({ ids: messages.map(m => m.id), removeLabelIds: ['UNREAD'] }),
  })
  return messages.length
}

/** One number per account for the collapsed corner. Never throws for one bad account. */
export async function unreadCounts(): Promise<{ email: string; unread: number; error?: string }[]> {
  const accounts = read().accounts.filter(a => a.muted !== true)
  return Promise.all(accounts.map(async a => {
    try {
      const d = await api<{ messagesUnread?: number }>(a.email, '/labels/INBOX')
      return { email: a.email, unread: d.messagesUnread ?? 0 }
    } catch (err) {
      return { email: a.email, unread: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }))
}
