// /api/host — Settings → Server. See host.ts for the design; this is the HTTP
// shape of it. Absent-not-empty when HOST_UPDATE_SSH is unset: every route
// answers 404 with the reason, so a client that asks can tell "not set up"
// from "broken".

import { Router, type Request, type Response } from 'express'
import {
  CONFIRM_TASKS, HOST_TASKS, hostEnabled, hostLog, hostState, hostStatus, hostTarget,
  isHostTask, publicKey, startTask,
} from '../host'

const router = Router()

router.use((_req: Request, res: Response, next) => {
  if (!hostEnabled()) {
    res.status(404).json({ error: 'HOST_UPDATE_SSH is not set — see scripts/host/install.sh' })
    return
  }
  next()
})

// GET /api/host — what the tab needs before it asks the host anything: the
// target, the public key to install there, the task list, and the state.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    enabled:   true,
    target:    hostTarget(),
    publicKey: publicKey(),
    tasks:     HOST_TASKS,
    confirm:   [...CONFIRM_TASKS],
    state:     hostState(),
  })
})

// GET /api/host/status — ask the host about itself. A few seconds; the tab
// calls it on open, on demand, and after every task.
router.get('/status', async (_req: Request, res: Response) => {
  const r = await hostStatus()
  res.json(r)
})

// GET /api/host/log — the backlog, for a tab opened mid-task.
router.get('/log', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ lines: hostLog(), state: hostState() })
})

// POST /api/host/run { task, confirm? } — start one. The two that take the
// screen or the box down need confirm:true, which the tab only sends after a
// second tap.
router.post('/run', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined
  const task = body?.['task']
  if (!isHostTask(task)) {
    res.status(400).json({ error: `task must be one of ${Object.keys(HOST_TASKS).join(', ')}` })
    return
  }
  if (CONFIRM_TASKS.has(task) && body?.['confirm'] !== true) {
    res.status(400).json({ error: `${HOST_TASKS[task]} needs confirm:true` })
    return
  }
  const r = startTask(task)
  if (!r.ok) {
    res.status(409).json({ error: r.error, state: hostState() })
    return
  }
  res.status(202).json({ ok: true, state: hostState() })
})

export default router
