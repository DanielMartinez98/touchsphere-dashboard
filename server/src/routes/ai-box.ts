import { Router, type Request, type Response } from 'express'
import { aiBoxView, aiBoxesEnabled, probeAll, refreshAgentsIfStale, setAiBoxChoice, setBoxPower } from '../ai-box'

// Settings → AI box: which GPU box the local AI services go to. See ai-box.ts.
// 404s without AI_BOXES, so the tab is absent rather than empty — the rule the
// Server tab and the Plex corner follow.
const router = Router()

router.use((_req, res, next) => {
  if (!aiBoxesEnabled()) { res.status(404).json({ error: 'AI_BOXES is not set' }); return }
  next()
})

// GET /api/ai-box — the boxes, whether each is answering, and where every service goes now.
// A box's agent status is refreshed here when older than a few seconds, so a
// tab watching a PC start up sees it move without waiting for the 30 s probe.
router.get('/', async (_req: Request, res: Response) => {
  await refreshAgentsIfStale(4_000)
  res.json(aiBoxView())
})

// POST /api/ai-box { selected: 'auto' | <box id> }
router.post('/', (req: Request, res: Response) => {
  const selected = (req.body as { selected?: unknown } | undefined)?.selected
  if (typeof selected !== 'string') { res.status(400).json({ error: 'selected is required' }); return }
  try {
    setAiBoxChoice(selected)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json(aiBoxView())
})

// POST /api/ai-box/:id/power { on: boolean } — switch a box's AI on or off
// through its agent. Off unloads the models and frees the box's VRAM.
router.post('/:id/power', async (req: Request, res: Response) => {
  const on = (req.body as { on?: unknown } | undefined)?.on
  if (typeof on !== 'boolean') { res.status(400).json({ error: 'on must be true or false' }); return }
  try {
    await setBoxPower(String(req.params['id']), on)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json(aiBoxView())
})

// POST /api/ai-box/check — probe every box now instead of waiting for the next round.
router.post('/check', async (_req: Request, res: Response) => {
  await probeAll()
  res.json(aiBoxView())
})

export default router
