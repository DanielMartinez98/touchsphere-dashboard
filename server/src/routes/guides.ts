// Game guides — REST surface over the store in ../guides.ts.
//
// The whole guide is one document, fetched in one request: it's a few dozen KB
// of text and the alternative (a request per section) would burn through the
// 60/min data rate limit just opening the view.

import fs from 'fs'
import { Router, type Request, type Response } from 'express'
import {
  addMapPin,
  deleteGuide,
  listGuides,
  loadGuide,
  removeMapPin,
  setPartDone,
  setSectionDone,
  setStepDone,
  setStepPin,
  setSubStepDone,
  updateMapPin,
} from '../guides'
import { MIME_FOR, guideImagePath } from '../guide-media'
import { enrichSection, isGenerating, regenerateSection, startGuide } from '../guide-generator'
import { normalizeSiteHost } from '../research'
import { pushGuide } from '../guide-events'
import { note, recentActivity } from '../guide-activity'

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

// GET /api/guides/image/:file — serve a cached wiki picture off the volume.
//
// ABOVE GET /:itemId for the same reason /activity is: Express matches in order
// and would otherwise read "image" as a media-item id. This is the trap this
// router has already fallen into once.
router.get('/image/:file', (req: Request, res: Response) => {
  const file = String(req.params['file'] ?? '')
  // sha1 + a known extension, which is exactly what guide-media.ts writes.
  // Anything else is corruption or an attempt to walk out of the cache dir.
  const m = /^[a-f0-9]{40}\.(png|jpe?g|webp|gif)$/i.exec(file)
  if (!m) {
    res.status(400).json({ error: 'invalid image name' })
    return
  }
  const full = guideImagePath(file)
  if (!full) {
    res.status(404).json({ error: 'image not found' })
    return
  }
  res.setHeader('Content-Type', MIME_FOR[m[1]!.toLowerCase()] ?? 'application/octet-stream')
  // The name is a hash of the source URL, so the bytes can never change.
  // Overrides this router's blanket no-store, which is right for the JSON and
  // wrong for an immutable picture the guide re-renders on every ticked box.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  fs.createReadStream(full).pipe(res)
})

// GET /api/guides/activity — what the guide system has been doing, newest last.
// MUST stay above GET /:itemId: Express matches in order and "activity" would
// otherwise be read as a media-item id and 404.
router.get('/activity', (req: Request, res: Response) => {
  const limit = Number(req.query['limit'])
  res.json(recentActivity(Number.isFinite(limit) && limit > 0 ? limit : undefined))
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
  const body = (req.body ?? {}) as { title?: unknown; order?: unknown; source?: unknown }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
  const order = typeof body.order === 'string' ? body.order.trim().slice(0, 200) : ''
  const sourceSite = typeof body.source === 'string' ? normalizeSiteHost(body.source) : null

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

  const result = startGuide({ itemId, title: effectiveTitle, ...(order ? { order } : {}), ...(sourceSite ? { sourceSite } : {}) })
  console.log(`[guides] POST /${itemId} "${effectiveTitle}"${sourceSite ? ` from ${sourceSite}` : ''} → ${result}`)
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
  const section = updated.sections.find(s => s.id === sectionId)
  note({
    itemId, title: updated.title, ...(section ? { section: section.title } : {}),
    stage: 'progress', level: 'info',
    message: `Marked the whole chapter ${body.done ? 'done' : 'not done'} ` +
             `(${section?.steps.length ?? 0} steps) from the dashboard`,
  })
  res.json(updated)
})

// POST /api/guides/:itemId/sections/:sectionId/regenerate
// Re-research one chapter, leaving the other chapters and their ticks intact.
// 202 like the whole-guide POST: the work runs in the background and the client
// follows the same `guide` SSE event.
// POST /api/guides/:itemId/sections/:sectionId/enrich
//
// The additive sibling of /regenerate, and the difference is the reason it
// exists: a rewrite replaces the chapter's steps and can only rescue the ticks
// whose wording survives, while this touches no step text at all — it fills in
// explanations, sub-steps, pictures and map pins on the steps already there.
// For a guide someone is part-way through, that is the difference between a
// safe improvement and a gamble with their progress.
router.post('/:itemId/sections/:sectionId/enrich', (req: Request, res: Response) => {
  const itemId    = String(req.params['itemId'] ?? '')
  const sectionId = String(req.params['sectionId'] ?? '')

  const result = enrichSection(itemId, sectionId)
  if (result === 'missing') {
    res.status(404).json({ error: 'No such guide or section, or it has no steps to enrich' })
    return
  }
  console.log(`[guides] POST /${itemId}/sections/${sectionId}/enrich → ${result}`)
  res.status(202).json({ status: 'generating', started: result === 'started' })
})

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
// PATCH /api/guides/:itemId/steps/:sectionId/:stepId/subs/:subId  { done }
// Tick one sub-step. The step above it follows automatically — see
// setSubStepDone() for why that is settled in the store rather than derived.
router.patch('/:itemId/steps/:sectionId/:stepId/subs/:subId', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { done?: unknown }
  if (typeof body.done !== 'boolean') {
    res.status(400).json({ error: 'done must be a boolean' })
    return
  }
  const updated = setSubStepDone(
    String(req.params['itemId'] ?? ''),
    String(req.params['sectionId'] ?? ''),
    String(req.params['stepId'] ?? ''),
    String(req.params['subId'] ?? ''),
    body.done,
  )
  if (!updated) {
    res.status(404).json({ error: 'No such guide, section, step, or sub-step' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// PATCH /api/guides/:itemId/parts/:sectionId/:fromIndex  { done }
// Tick a whole sub-chapter — the run of steps that starts at `fromIndex`.
// Indexed rather than named because a heading can recur inside one chapter, and
// the client groups by consecutive runs for exactly that reason.
router.patch('/:itemId/parts/:sectionId/:fromIndex', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { done?: unknown }
  const fromIndex = Number(req.params['fromIndex'])
  if (typeof body.done !== 'boolean') {
    res.status(400).json({ error: 'done must be a boolean' })
    return
  }
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    res.status(400).json({ error: 'fromIndex must be a non-negative integer' })
    return
  }
  const updated = setPartDone(
    String(req.params['itemId'] ?? ''),
    String(req.params['sectionId'] ?? ''),
    fromIndex,
    body.done,
  )
  if (!updated) {
    res.status(404).json({ error: 'No such guide, section, or part' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// ── The map ──────────────────────────────────────────────────────────────────
//
// `sectionId` is the chapter whose map is on screen, and "-" means the
// whole-game map. A chapter with no map of its own is looking at the game map,
// and the store resolves that — so the client never has to know which of the two
// it is actually pinning, it just names the chapter it is in.

/** 0..1, and a number. Rejected rather than clamped: a pin off the map is a bug. */
function point(body: { x?: unknown; y?: unknown }): { x: number; y: number } | null {
  const x = Number(body.x), y = Number(body.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

const mapScope = (raw: string): string | null => (raw === '-' ? null : raw)

// POST /api/guides/:itemId/map/:sectionId/pins  { x, y, label }
router.post('/:itemId/map/:sectionId/pins', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { x?: unknown; y?: unknown; label?: unknown }
  const at = point(body)
  if (!at) {
    res.status(400).json({ error: 'x and y must be numbers between 0 and 1' })
    return
  }
  const updated = addMapPin(
    String(req.params['itemId'] ?? ''),
    mapScope(String(req.params['sectionId'] ?? '-')),
    at.x, at.y,
    typeof body.label === 'string' ? body.label : '',
  )
  if (!updated) {
    // Also the answer when the map is full, which is a real outcome rather than
    // an error worth its own status: the client shows the count and the cap.
    res.status(404).json({ error: 'No such guide or map, or the map is full' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// PATCH /api/guides/:itemId/map/:sectionId/pins/:pinId  { x?, y?, label? }
router.patch('/:itemId/map/:sectionId/pins/:pinId', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { x?: unknown; y?: unknown; label?: unknown }
  const patch: { x?: number; y?: number; label?: string } = {}
  if (body.x !== undefined || body.y !== undefined) {
    const at = point(body)
    if (!at) {
      res.status(400).json({ error: 'x and y must be numbers between 0 and 1' })
      return
    }
    patch.x = at.x
    patch.y = at.y
  }
  if (typeof body.label === 'string') patch.label = body.label
  const updated = updateMapPin(
    String(req.params['itemId'] ?? ''),
    mapScope(String(req.params['sectionId'] ?? '-')),
    String(req.params['pinId'] ?? ''),
    patch,
  )
  if (!updated) {
    res.status(404).json({ error: 'No such guide, map, or pin' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// DELETE /api/guides/:itemId/map/:sectionId/pins/:pinId
router.delete('/:itemId/map/:sectionId/pins/:pinId', (req: Request, res: Response) => {
  const updated = removeMapPin(
    String(req.params['itemId'] ?? ''),
    mapScope(String(req.params['sectionId'] ?? '-')),
    String(req.params['pinId'] ?? ''),
  )
  if (!updated) {
    res.status(404).json({ error: 'No such guide, map, or pin' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

// PATCH /api/guides/:itemId/steps/:sectionId/:stepId/pin  { x, y } | { clear: true }
// Move (or drop) the pin the GENERATOR placed on a step. It was positioned from
// a compass phrase in the research notes, so correcting it by dragging is the
// expected first interaction rather than an edge case.
router.patch('/:itemId/steps/:sectionId/:stepId/pin', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { x?: unknown; y?: unknown; clear?: unknown }
  const at = body.clear === true ? null : point(body)
  if (at === null && body.clear !== true) {
    res.status(400).json({ error: 'x and y must be numbers between 0 and 1, or clear must be true' })
    return
  }
  const updated = setStepPin(
    String(req.params['itemId'] ?? ''),
    String(req.params['sectionId'] ?? ''),
    String(req.params['stepId'] ?? ''),
    at,
  )
  if (!updated) {
    res.status(404).json({ error: 'No such guide, section, or step' })
    return
  }
  pushGuide(updated)
  res.json(updated)
})

router.delete('/:itemId', (req: Request, res: Response) => {
  const itemId = String(req.params['itemId'] ?? '')
  // Read before removing, so the feed line can name what was deleted.
  const existing = loadGuide(itemId)
  const removed = deleteGuide(itemId)
  if (!removed) {
    res.status(404).json({ error: 'No guide for that item' })
    return
  }
  note({
    itemId, title: existing?.title ?? itemId, stage: 'deleted', level: 'warn',
    message: `Deleted from the dashboard, along with ${existing?.sections.length ?? 0} chapter(s) of progress`,
  })
  res.json({ ok: true })
})

export default router
