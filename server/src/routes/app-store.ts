import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import { clearAppStoreConfig, setAppHidden, setAppStoreConfig, setDisplayCurrency, syncNow } from '../app-store'
import { appStoreView, buildReport, type Group } from '../app-report'
import {
  admobAuthUrl, completeAdmobSignIn, forgetAdmob, forgetUnity, setGoogleApp, setUnityConfig, syncAdsNow,
} from '../ads'

// The Apps corner and Settings → App Store: the user's own apps on the App
// Store (app-store.ts), what their ads earned on AdMob and Unity Ads (ads.ts),
// and the report that joins them (app-report.ts). Unlike the Server and AI box
// tabs this one is always present, because the keys are pasted into it: there
// is nothing in .env to make it appear. The view says `configured: false`
// until then.
const router = Router()

/**
 * Where Google sends the browser back after the AdMob sign-in. Derived from
 * the request, the Mail corner's rule: the dashboard is reached on a tailnet
 * name the server has no other way to know. PUBLIC_URL overrides it.
 */
function redirectUri(req: Request): string {
  const base = (process.env['PUBLIC_URL'] ?? '').trim().replace(/\/$/, '')
  return `${base || `${req.protocol}://${req.get('host')}`}/api/app-store/admob/oauth/callback`
}

function view(req: Request) {
  return { ...appStoreView(), admobRedirectUri: redirectUri(req) }
}

const fail = (res: Response, err: unknown) => {
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
}

// GET /api/app-store — the keys' state, every app (hidden ones too), yesterday for the pill.
router.get('/', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(view(req))
})

// GET /api/app-store/report?from=&to=&group=day|week|month&apps=a,b&countries=US,MX&networks=admob&units=admob:…
// Every measure over the range and the range before it, per day/week/month,
// per app, per country, per source and per ad unit. See app-report.ts.
router.get('/report', (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>
  const list = (k: string) => (q[k] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  res.setHeader('Cache-Control', 'no-store')
  res.json(buildReport({
    from: q['from'] ?? '', to: q['to'] ?? '', group: q['group'] as Group | undefined,
    apps: list('apps'), countries: list('countries'), networks: list('networks'), units: list('units'),
  }))
})

// POST /api/app-store/config { issuerId, keyId, vendorNumber, privateKey? }
// Proves the key against Apple before saving it, so a typo fails here with a
// sentence rather than silently at the next sync.
router.post('/config', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
  try {
    await setAppStoreConfig({ issuerId: s('issuerId'), keyId: s('keyId'), vendorNumber: s('vendorNumber'), privateKey: s('privateKey') || undefined })
  } catch (err) { fail(res, err); return }
  res.json(view(req))
})

// DELETE /api/app-store/config — forget the key. The numbers already gathered stay.
router.delete('/config', (req: Request, res: Response) => {
  clearAppStoreConfig()
  res.json(view(req))
})

// POST /api/app-store/sync — read whatever Apple and the ad networks have
// published since the last run, now. Kicked off, not awaited: the first run
// reads a year of files and a request held open that long is what proxies time
// out on. The `app-store` SSE frame at the end refreshes the screen.
router.post('/sync', (req: Request, res: Response) => {
  void syncNow()
  void syncAdsNow()
  res.json(view(req))
})

// POST /api/app-store/apps/:id/hidden { hidden } — leave an app out of the
// list, the totals and the assistant's answers (one not released yet), or put it back.
router.post('/apps/:id/hidden', (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '')
  if (!id || id.length > 200) { res.status(400).json({ error: 'no such app' }); return }
  setAppHidden(id, (req.body as { hidden?: unknown } | undefined)?.hidden === true)
  res.json(view(req))
})

// POST /api/app-store/currency { currency } — the currency every amount is shown in.
router.post('/currency', (req: Request, res: Response) => {
  try {
    setDisplayCurrency(String((req.body as { currency?: unknown } | undefined)?.currency ?? ''))
  } catch (err) { fail(res, err); return }
  res.json(view(req))
})

// ── AdMob: a Google sign-in ──────────────────────────────────────────────────

/** Short-lived one-time states, so a stray callback cannot connect an account. */
const pending = new Map<string, number>()
function newState(): string {
  const s = crypto.randomBytes(16).toString('hex')
  pending.set(s, Date.now() + 10 * 60_000)
  for (const [k, until] of pending) if (until < Date.now()) pending.delete(k)
  return s
}

// POST /api/app-store/admob/app { clientId, clientSecret } — a Google app for
// this sign-in, for a dashboard whose Mail corner has none to share.
router.post('/admob/app', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { clientId?: unknown; clientSecret?: unknown }
  try {
    setGoogleApp(String(b.clientId ?? ''), String(b.clientSecret ?? ''))
  } catch (err) { fail(res, err); return }
  res.json(view(req))
})

// GET /api/app-store/admob/oauth/start — off to Google. A browser navigates here.
router.get('/admob/oauth/start', (req: Request, res: Response) => {
  try {
    res.redirect(admobAuthUrl(redirectUri(req), newState()))
  } catch (err) {
    done(res, false, err instanceof Error ? err.message : String(err))
  }
})

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** A finished sign-in, as a page rather than JSON: a browser is looking at it. */
function done(res: Response, ok: boolean, message: string): void {
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'AdMob connected' : 'Sign-in failed'}</title>
<style>
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#0e1113;
         color:#e7ebee; font:16px/1.5 system-ui, sans-serif; padding:24px; }
  .card { max-width:26rem; text-align:center; }
  h1 { font-size:22px; margin:0 0 8px; color:${ok ? '#3ad9b2' : '#ff8b8b'}; }
  p { margin:0; color:#98a2a9; }
</style>
<div class="card">
  <h1>${ok ? 'AdMob connected' : 'That did not work'}</h1>
  <p>${esc(message)}</p>
</div>`)
}

// GET /api/app-store/admob/oauth/callback — Google sends the browser back here.
router.get('/admob/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) { done(res, false, `Google said: ${error}. Nothing was connected.`); return }
  if (!code || !state || !pending.has(state)) {
    done(res, false, 'That sign-in link was not one this dashboard started, or it has expired. Try again from Settings.')
    return
  }
  pending.delete(state)
  try {
    const publisher = await completeAdmobSignIn(code, redirectUri(req))
    done(res, true, `Account ${publisher} is connected. The first read takes a minute; you can close this tab.`)
  } catch (err) {
    done(res, false, err instanceof Error ? err.message : String(err))
  }
})

// DELETE /api/app-store/admob — forget the sign-in. The figures already read stay.
router.delete('/admob', (req: Request, res: Response) => {
  forgetAdmob()
  res.json(view(req))
})

// ── Unity Ads: an organization id and a key ──────────────────────────────────

// POST /api/app-store/unity { orgId, apiKey? } — proven with a one-day request before it is saved.
router.post('/unity', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { orgId?: unknown; apiKey?: unknown }
  try {
    await setUnityConfig(String(b.orgId ?? ''), typeof b.apiKey === 'string' ? b.apiKey : '')
  } catch (err) { fail(res, err); return }
  res.json(view(req))
})

router.delete('/unity', (req: Request, res: Response) => {
  forgetUnity()
  res.json(view(req))
})

export default router
