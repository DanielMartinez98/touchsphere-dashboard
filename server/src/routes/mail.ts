// /api/mail — the Gmail corner's REST half, and the OAuth round trip.

import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import {
  authUrl, clientIdOnly, completeSignIn, getAttachment, getMessage, listLabels, listMessages,
  mailAccounts, mailConfigured, mailEnabled, markAllRead, removeAccount, sendReply,
  setClientApp, setFlags, setMuted, unreadCounts,
} from '../mail'

const router = Router()

/**
 * Where Google sends the browser back.
 *
 * Derived from the request rather than configured, because the dashboard is
 * reached on a tailnet name that the server itself has no other way to know —
 * and getting it wrong is a redirect_uri_mismatch, the single most confusing
 * error in this whole flow. PUBLIC_URL overrides it for anyone behind a proxy
 * that rewrites Host.
 */
function redirectUri(req: Request): string {
  const base = (process.env['PUBLIC_URL'] ?? '').trim().replace(/\/$/, '')
  if (base) return `${base}/api/mail/oauth/callback`
  return `${req.protocol}://${req.get('host')}/api/mail/oauth/callback`
}

/** Short-lived one-time states, so a stray callback cannot add an account. */
const pending = new Map<string, number>()
function newState(): string {
  const s = crypto.randomBytes(16).toString('hex')
  pending.set(s, Date.now() + 10 * 60_000)
  for (const [k, until] of pending) if (until < Date.now()) pending.delete(k)
  return s
}

// GET /api/mail/status — everything Settings needs to draw itself.
router.get('/status', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    configured: mailConfigured(),
    enabled:    mailEnabled(),
    clientId:   clientIdOnly(),
    accounts:   mailAccounts(),
    // Shown so it can be pasted into the Google Cloud console verbatim; a
    // mismatched redirect is the usual reason a first sign-in fails.
    redirectUri: redirectUri(req),
  })
})

// POST /api/mail/app { clientId, clientSecret } — register the Google app.
router.post('/app', (req: Request, res: Response) => {
  const b = req.body as { clientId?: unknown; clientSecret?: unknown } | undefined
  if (typeof b?.clientId !== 'string' || typeof b?.clientSecret !== 'string') {
    res.status(400).json({ error: 'clientId and clientSecret are required' })
    return
  }
  try {
    setClientApp(b.clientId, b.clientSecret)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json({ ok: true, configured: mailConfigured() })
})

// GET /api/mail/oauth/start — begin adding an account.
router.get('/oauth/start', (req: Request, res: Response) => {
  if (!mailConfigured()) {
    res.status(409).json({ error: 'register the Google app first (Settings → Mail)' })
    return
  }
  try {
    res.redirect(authUrl(redirectUri(req), newState()))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/** A finished sign-in, as a page rather than JSON: a browser is looking at it. */
function done(res: Response, ok: boolean, message: string): void {
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Signed in' : 'Sign-in failed'}</title>
<style>
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#0e1113;
         color:#e7ebee; font:16px/1.5 system-ui, sans-serif; padding:24px; }
  .card { max-width:26rem; text-align:center; }
  h1 { font-size:22px; margin:0 0 8px; color:${ok ? '#3ad9b2' : '#ff8b8b'}; }
  p { margin:0; color:#98a2a9; }
</style>
<div class="card">
  <h1>${ok ? 'Signed in' : 'That did not work'}</h1>
  <p>${message}</p>
</div>`)
}

// GET /api/mail/oauth/callback — Google sends the browser back here.
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) { done(res, false, `Google said: ${error}. Nothing was added.`); return }
  if (!code || !state || !pending.has(state)) {
    done(res, false, 'That sign-in link was not one this dashboard started, or it has expired. Try again from Settings.')
    return
  }
  pending.delete(state)
  try {
    const email = await completeSignIn(code, redirectUri(req))
    done(res, true, `${email} is now on the dashboard. You can close this tab.`)
  } catch (err) {
    done(res, false, err instanceof Error ? err.message : String(err))
  }
})

// DELETE /api/mail/accounts/:email — sign out and revoke.
router.delete('/accounts/:email', async (req: Request, res: Response) => {
  const ok = await removeAccount(String(req.params['email'] ?? ''))
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'no such account' })
})

// POST /api/mail/accounts/:email/mute { muted }
router.post('/accounts/:email/mute', (req: Request, res: Response) => {
  const muted = (req.body as { muted?: unknown })?.muted === true
  setMuted(String(req.params['email'] ?? ''), muted)
  res.json({ ok: true })
})

// ── Reading ──────────────────────────────────────────────────────────────────

function accountOf(req: Request): string {
  const q = typeof req.query['account'] === 'string' ? req.query['account'] : ''
  return q || (mailAccounts()[0]?.email ?? '')
}

// GET /api/mail/unread — one number per account, for the collapsed corner.
router.get('/unread', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ accounts: await unreadCounts() })
})

// GET /api/mail/labels?account= — Gmail's own labels, which are the filters.
router.get('/labels', async (req: Request, res: Response) => {
  const account = accountOf(req)
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ account, labels: await listLabels(account) })
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /api/mail/messages?account=&label=&q=&unread=1&limit=&pageToken=
router.get('/messages', async (req: Request, res: Response) => {
  const account = accountOf(req)
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  const label = typeof req.query['label'] === 'string' ? req.query['label'] : ''
  // A switch rather than a search term: "unread only" is the one filter used
  // on every visit, and typing "is:unread" on a kiosk is not a filter.
  const unreadOnly = req.query['unread'] === '1' || req.query['unread'] === 'true'
  const typed = typeof req.query['q'] === 'string' ? req.query['q'] : ''
  const q = [typed, unreadOnly ? 'is:unread' : ''].filter(Boolean).join(' ')
  const limit = Number(req.query['limit']) || 25
  const pageToken = typeof req.query['pageToken'] === 'string' ? req.query['pageToken'] : ''
  try {
    const out = await listMessages(account, {
      ...(label ? { labelIds: [label] } : {}),
      ...(q ? { q } : {}),
      limit,
      ...(pageToken ? { pageToken } : {}),
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ account, ...out })
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /api/mail/messages/:id?account= — one message, readable.
router.get('/messages/:id', async (req: Request, res: Response) => {
  const account = accountOf(req)
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await getMessage(account, String(req.params['id'] ?? '')))
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /api/mail/messages/:id/attachments/:attId?account=&name=&type= — the bytes,
// served inline so a picture shows in the panel and a PDF opens in a frame.
router.get('/messages/:id/attachments/:attId', async (req: Request, res: Response) => {
  const account = accountOf(req)
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  const name = (typeof req.query['name'] === 'string' ? req.query['name'] : 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 120)
  const type = typeof req.query['type'] === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(req.query['type'])
    ? req.query['type'] : 'application/octet-stream'
  try {
    const bytes = await getAttachment(account, String(req.params['id'] ?? ''), String(req.params['attId'] ?? ''))
    // Never let a mail's attachment run as a page on this origin: HTML and
    // SVG are handed over as files rather than rendered.
    const safeType = /^(text\/html|image\/svg)/i.test(type) ? 'application/octet-stream' : type
    res.setHeader('Content-Type', safeType)
    res.setHeader('Content-Disposition', `${safeType === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${name}"`)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// POST /api/mail/messages/:id/reply { account, text }
router.post('/messages/:id/reply', async (req: Request, res: Response) => {
  const b = req.body as { account?: string; text?: unknown } | undefined
  const account = b?.account || (mailAccounts()[0]?.email ?? '')
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  const text = typeof b?.text === 'string' ? b.text.trim() : ''
  if (!text) { res.status(400).json({ error: 'text is required' }); return }
  try {
    res.json({ ok: true, ...(await sendReply(account, String(req.params['id'] ?? ''), text.slice(0, 20_000))) })
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// POST /api/mail/messages/:id/flags { account, read?, starred? }
router.post('/messages/:id/flags', async (req: Request, res: Response) => {
  const b = req.body as { account?: string; read?: unknown; starred?: unknown } | undefined
  const account = b?.account || (mailAccounts()[0]?.email ?? '')
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  try {
    await setFlags(account, String(req.params['id'] ?? ''), {
      ...(typeof b?.read === 'boolean' ? { read: b.read } : {}),
      ...(typeof b?.starred === 'boolean' ? { starred: b.starred } : {}),
    })
    res.json({ ok: true })
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// POST /api/mail/read-all { account, label }
router.post('/read-all', async (req: Request, res: Response) => {
  const b = req.body as { account?: string; label?: string } | undefined
  const account = b?.account || (mailAccounts()[0]?.email ?? '')
  if (!account) { res.status(409).json({ error: 'no account signed in' }); return }
  try {
    const n = await markAllRead(account, b?.label ? [b.label] : ['INBOX'])
    res.json({ ok: true, marked: n })
  } catch (err) {
    console.warn(`[mail] ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`)
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

export default router
