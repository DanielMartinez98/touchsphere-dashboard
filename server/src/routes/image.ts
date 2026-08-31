// REST surface for ComfyUI image generation. The engine is in ../image.ts.
//
// Everything here is thin on purpose: POST kicks off a background job and hands
// back its id immediately, and the interesting part — progress — arrives on the
// existing SSE bus as `image` events rather than by polling this route. The GET
// endpoints exist for the case SSE can't cover: a screen that was closed while a
// render was running and needs to catch up when it reopens.

import { Router, Request, Response } from 'express'
import fs from 'fs'
import {
  activeJob,
  comfyStats,
  comfyUrl,
  forgetImage,
  getJob,
  imagePath,
  imagesEnabled,
  jobWire,
  listImages,
  startImage,
} from '../image'

const router = Router()

// GET /api/image/check — is the GPU box actually there?
//
// The sibling of /api/system/check/elevenlabs, but it lives here rather than in
// the system router to avoid a require cycle: image.ts already imports
// broadcast() from routes/system, and having system import image back would
// close the loop for no gain.
//
// /system_stats is ComfyUI's cheapest authenticated-free endpoint and it returns
// the VRAM figures, which is the number you actually want when a render fails —
// "reachable" and "has room to load a checkpoint" are different questions.
router.get('/check', async (_req: Request, res: Response) => {
  const { ok, detail } = await comfyStats()
  if (!ok) {
    res.status(502).json({ error: detail, url: comfyUrl() || null })
    return
  }
  res.json({ ok: true, detail, url: comfyUrl() })
})

// GET /api/image/file/:file — serve a generated PNG off the volume.
//
// Registered FIRST: Express matches in order, and `GET /:id` below would
// otherwise swallow "file" as an image id. Same trap the guides router hit with
// its activity endpoint.
router.get('/file/:file', (req: Request, res: Response) => {
  const file = String(req.params['file'] ?? '')
  // Filenames are always the job id (16 random bytes) + .png. Reject anything
  // else rather than let a crafted name walk out of the images directory.
  if (!/^[a-f0-9]{32}\.png$/.test(file)) {
    res.status(400).json({ error: 'invalid image name' })
    return
  }
  const full = imagePath(file)
  if (!full) {
    res.status(404).json({ error: 'image not found' })
    return
  }
  res.setHeader('Content-Type', 'image/png')
  // The filename embeds a one-shot random id, so the bytes behind it never change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  fs.createReadStream(full).pipe(res)
})

// GET /api/image/job/:id — one job's state, for a client that reconnected.
router.get('/job/:id', (req: Request, res: Response) => {
  const job = getJob(String(req.params['id'] ?? ''))
  if (!job) {
    res.status(404).json({ error: 'no such job' })
    return
  }
  res.json(jobWire(job))
})

// GET /api/image/active — whatever is rendering right now, or null.
// This is what lets the overlay show a live job after a page reload.
router.get('/active', (_req: Request, res: Response) => {
  const job = activeJob()
  res.json(job ? jobWire(job) : null)
})

// POST /api/image/generate  { prompt, negative?, width?, height?, seed? }
// Returns the queued job — NOT the finished image. Renders take seconds to
// minutes and holding the request open for that would tie up the Pi's socket
// and time out behind Caddy.
router.post('/generate', (req: Request, res: Response) => {
  if (!imagesEnabled()) {
    res.status(503).json({ error: 'COMFYUI_URL is not set — no image server is configured' })
    return
  }
  const body = req.body as Record<string, unknown> | undefined
  const prompt = typeof body?.['prompt'] === 'string' ? body['prompt'].trim() : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' })
    return
  }
  const num = (k: string): number | undefined => {
    const v = body?.[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const job = startImage({
    prompt,
    ...(typeof body?.['negative'] === 'string' ? { negative: body['negative'] } : {}),
    ...(num('width')  !== undefined ? { width:  num('width')!  } : {}),
    ...(num('height') !== undefined ? { height: num('height')! } : {}),
    ...(num('seed')   !== undefined ? { seed:   num('seed')!   } : {}),
  })
  res.status(202).json(jobWire(job))
})

// GET /api/image — the gallery, newest first.
router.get('/', (_req: Request, res: Response) => {
  // Freshly generated images are the whole point of asking, and a heuristically
  // cached list means the newest one is missing from it — the same trap
  // /api/guides hit before it started sending no-store.
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    enabled: imagesEnabled(),
    images: listImages().map(e => ({ ...e, url: `/api/image/file/${e.file}` })),
  })
})

// DELETE /api/image/:id — drop one image and its file.
router.delete('/:id', (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '')
  if (!/^[a-f0-9]{32}$/.test(id)) {
    res.status(400).json({ error: 'invalid image id' })
    return
  }
  if (!forgetImage(id)) {
    res.status(404).json({ error: 'no such image' })
    return
  }
  res.json({ ok: true })
})

export default router
