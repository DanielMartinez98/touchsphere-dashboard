import { Router, type Request, type Response } from 'express'
import { appStoreView, clearAppStoreConfig, setAppStoreConfig, syncNow } from '../app-store'

// Settings → Apps: the user's own apps on the App Store — downloads, earnings,
// impressions. See app-store.ts. Unlike the Server and AI box tabs this one is
// always present, because the key is pasted into it: there is nothing in .env
// to make it appear. The view says `configured: false` until then.
const router = Router()

// GET /api/app-store — every app with its periods and series, plus the sync state.
router.get('/', (_req: Request, res: Response) => {
  res.json(appStoreView())
})

// POST /api/app-store/config { issuerId, keyId, vendorNumber, privateKey? }
// Proves the key against Apple before saving it, so a typo fails here with a
// sentence rather than silently at the next sync.
router.post('/config', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
  try {
    await setAppStoreConfig({ issuerId: s('issuerId'), keyId: s('keyId'), vendorNumber: s('vendorNumber'), privateKey: s('privateKey') || undefined })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json(appStoreView())
})

// DELETE /api/app-store/config — forget the key. The numbers already gathered stay.
router.delete('/config', (_req: Request, res: Response) => {
  clearAppStoreConfig()
  res.json(appStoreView())
})

// POST /api/app-store/sync — read whatever Apple has published since the last
// run, now. Kicked off, not awaited: the first run reads three months of files
// and a request held open that long is what proxies time out on. The answer
// says `syncing: true`, and the `app-store` SSE frame at the end refreshes
// the tab.
router.post('/sync', (_req: Request, res: Response) => {
  void syncNow()
  res.json(appStoreView())
})

export default router
