// Game guides — REST surface over the store in ../guides.ts.
//
// The whole guide is one document, fetched in one request: it's a few dozen KB
// of text and the alternative (a request per section) would burn through the
// 60/min data rate limit just opening the view.

import { Router, type Request, type Response } from 'express'
import {
  deleteGuide,
  listGuides,
  loadGuide,
  setSectionDone,
  setStepDone,
} from '../guides'
import { isGenerating, regenerateSection, startGuide } from '../guide-generator'
import { pushGuide } from '../guide-events'

const router = Router()

// A guide changes under the client's feet — the generator fills sections in, and
// a voice command can tick a step while the view is open. With no cache headers
// Chrome is free to reuse a "fresh enough" response without revalidating, which
// it does: the SSE event fired, the client refetched, and the browser handed it
// back the *old* document, so the open guide never moved.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

// GET /api/guides — light summaries, one per guide. Drives the progress bars on
// the media-list rows, so it must stay small even with 40 guides on disk.
router.get('/', (_req: Request, res: Response) => {
  const summaries = listGuides()
  res.json(summaries)
})

// GET /api/guides/:itemId — the full document.
router.get('/:itemId', (req: Request, res: Response) => {
  const guide = loadGuide(String(req.params['itemId'] ?? ''))
  if (!guide) {
    res.status(404).json({ error: 'No guide for that item' })
    return
  }
  res.json(guide)
})

// POST /api/guides/:itemId  { title, order? } — start or regenerate.
// Returns 202: the work happens in the background and the client follows along
// via the `guide` SSE event (see guide-generator.ts).
router.post('/:itemId', (req: Request, res: Response) => {
  const itemId = String(req.params['itemId'] ?? '')
  const body = (req.body ?? {}) as { title?: unknown; order?: unknown }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
  const order = typeof body.order === 'string' ? body.order.trim().slice(0, 200) : ''

  if (!itemId) {
    res.status(400).json({ error: 'itemId is required' })
    return
  }
  if (isGenerating(itemId)) {
    // Not an error the user needs to see — they tapped twice, or asked twice.
    res.status(202).json({ status: 'generating', alreadyRunning: true })
    return
  }
  // Fall back to the title already on the guide so a Retry needs no arguments.
  const effectiveTitle = title || loadGuide(itemId)?.title || ''
  if (!effectiveTitle) {
    res.status(400).json({ error: 'title is required for a new guide' })
    return
  }

  const result = startGuide({ itemId, title: effectiveTitle, ...(order ? { order } : {}) })
  console.log(`[guides] POST /${itemId} "${effectiveTitle}" → ${result}`)
  res.status(202).json({ status: 'generating', started: result === 'started' })
})

// PATCH /api/guides/:itemId/steps/:sectionId/:stepId  { done }
// Returns the whole updated guide: the client needs the recomputed section and
// overall counts anyway, and the document is small enough that a diff isn't
// worth the extra shapes.
router.patch('/:itemId/steps/:sectionId/:stepId', (req: Request, res: Response) => {
  const itemId    = String(req.params['itemId'] ?? '')
  const sectionId = String(req.params['sectionId'] ?? '')
  const stepId    = String(req.params['stepId'] ?? '')
  const body = (req.body ?? {}) as { done?: unknown }
  if (typeof body.done !== 'boolean') {
    res.status(400).json({ error: 'done must be a boolean' })
    return
  }
  const updated = setStepDone(itemId, sectionId, stepId, body.done)
  if (!updated) {
    res.status(404).json({ error: 'No such guide, section, or step' })
    return
  }
  // Other screens (and the AI's view of progress) follow the same event the
  // generator uses, so a tick here shows up everywhere at once.
  pushGuide(updated)
  res.json(updated)
})

// PATCH /api/guides/:itemId/sections/:sectionId  { done }
// Tick or clear a whole chapter in one go — "I already finished that dungeon",
// without opening it and tapping sixty boxes.
router.patch('/:itemId/sections/:sectionId', (req: Request, res: Response) => {
  const itemId    = String(req.params['itemId'] ?? '')
  const sectionId = String(req.params['sectionId'] ?? '')
  const body = (req.body ?? {}) as { done?: unknown }
  if (typeof body.done !== 'boolean') {
    res.status(400).json({ error: 'done must be a boolean' })
    return
  }
  const updated = setSectionDone(itemId, sectionId, body.done)
  if (!updated) {
    res.status(404).json({ error: 'No such guide or section' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// POST /api/guides/:itemId/sections/:sectionId/regenerate
// Re-research one chapter, leaving the other chapters and their ticks intact.
// 202 like the whole-guide POST: the work runs in the background and the client
// follows the same `guide` SSE event.
router.post('/:itemId/sections/:sectionId/regenerate', (req: Request, res: Response) => {
  const itemId    = String(req.params['itemId'] ?? '')
  const sectionId = String(req.params['sectionId'] ?? '')

  const result = regenerateSection(itemId, sectionId)
  if (result === 'missing') {
    res.status(404).json({ error: 'No such guide or section' })
    return
  }
  console.log(`[guides] POST /${itemId}/sections/${sectionId}/regenerate → ${result}`)
  // 'busy' means something is already generating for this guide — the user tapped
  // twice, or asked out loud while a rebuild was running. Not an error to show.
  res.status(202).json({ status: 'generating', started: result === 'started' })
})

// DELETE /api/guides/:itemId
router.delete('/:itemId', (req: Request, res: Response) => {
  const removed = deleteGuide(String(req.params['itemId'] ?? ''))
  if (!removed) {
    res.status(404).json({ error: 'No guide for that item' })
    return
  }
  res.json({ ok: true })
})

export default router
