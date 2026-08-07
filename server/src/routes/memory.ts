// GET/POST/DELETE /api/memory — the user's own view of what the assistant knows.
//
// Everything under here already existed, reachable only by talking to the
// assistant: you asked what it remembered and trusted the answer, and corrected
// it by saying "forget that". For the one feature where being wrong is most
// annoying, that's a bad deal — so the store gets a plain window and an
// off switch that don't involve the microphone.

import { Router, type Request, type Response } from 'express'
import {
  loadMemories, addMemory, removeMemoryById,
  type MemoryKind,
} from '../memory'
import { loadSession, clearSession, sessionAgeMinutes } from '../session'

const router = Router()

const MAX_CONTENT = 500

// GET /api/memory → everything, plus the 12h conversation window.
router.get('/', (_req: Request, res: Response) => {
  const store = loadMemories()
  const session = loadSession()
  res.json({
    facts:       store.longTerm.filter(m => m.kind !== 'preference'),
    preferences: store.longTerm.filter(m => m.kind === 'preference'),
    shortTerm:   store.shortTerm.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    session: session
      ? {
          endedAt:    session.endedAt,
          ageMinutes: sessionAgeMinutes(session),
          turns:      session.turns.length,
          summary:    session.summary ?? null,
          keywords:   session.keywords.slice(0, 12),
          // The opening user line is the most recognisable handle on "which
          // conversation was that" when there's no summary yet.
          opener:     session.turns.find(t => t.role === 'user')?.content ?? null,
        }
      : null,
  })
})

// POST /api/memory { content, kind?, scope? } → add by hand.
router.post('/', (req: Request, res: Response) => {
  const body = req.body as { content?: unknown; kind?: unknown; scope?: unknown }
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) return res.status(400).json({ error: 'content is required' })
  if (content.length > MAX_CONTENT) return res.status(400).json({ error: `content must be ${MAX_CONTENT} chars or fewer` })

  const kind: MemoryKind = body.kind === 'preference' ? 'preference' : 'fact'
  // Anything typed in by hand defaults to permanent — the user went to the
  // trouble of opening Settings, they don't mean "for the next 24 hours".
  const scope: 'short' | 'long' = body.scope === 'short' ? 'short' : 'long'
  const mem = addMemory(content, scope, 'user', kind)
  return res.status(201).json(mem)
})

// DELETE /api/memory/session → drop the carried-over conversation only.
router.delete('/session', (_req: Request, res: Response) => {
  clearSession()
  res.json({ ok: true })
})

// DELETE /api/memory/:id
router.delete('/:id', (req: Request, res: Response) => {
  const raw = req.params['id']
  const id = typeof raw === 'string' ? raw : ''
  if (!removeMemoryById(id)) return res.status(404).json({ error: 'no such memory' })
  return res.json({ ok: true })
})

export default router
