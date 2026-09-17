// Settings → Devices: which machine does each piece of AI work.
//
//   GET    /api/ai-devices            the devices, and every service resolved
//   POST   /api/ai-devices            add or edit a device { id?, name, host, ports?, assign? }
//   DELETE /api/ai-devices/:id        remove it (services pointing at it fall back to .env)
//   POST   /api/ai-devices/assign     { service, deviceId } — '' puts the service back on .env
//   POST   /api/ai-devices/:id/probe  ask the device which services it answers
//
// The store and the resolution live in ai-devices.ts; this is the wire. The
// installer (scripts/local-ai/install.sh) POSTs to the first of these when it
// finishes on a box, with `assign` naming the services it started, so a
// machine set up for the AI work shows up in Settings already chosen.

import { Router, type Request, type Response } from 'express'
import {
  SERVICE_ORDER, assignService, probeDevice, readDevices, removeDevice, resolveAll, upsertDevice,
  type AiService, type UpsertInput,
} from '../ai-devices'

const router = Router()

function payload() {
  const store = readDevices()
  return {
    devices:  store.devices,
    assign:   store.assign,
    services: resolveAll(),
  }
}

router.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(payload())
})

router.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as UpsertInput & { assign?: unknown; probe?: unknown }
  let device
  try {
    device = upsertDevice({ id: body.id, name: body.name, host: body.host, ports: body.ports })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  // `assign: ["chat","image"]` points those services at the new device in the
  // same call — what the installer sends. `assign: "answering"` assigns
  // whatever the probe finds, for a box whose stack is already running.
  let assigned: AiService[] = []
  if (Array.isArray(body.assign)) {
    assigned = body.assign.filter((s): s is AiService => (SERVICE_ORDER as string[]).includes(String(s)))
  } else if (body.assign === 'answering') {
    const probe = await probeDevice(device)
    assigned = probe.filter(p => p.ok).map(p => p.service)
  }
  for (const s of assigned) assignService(s, device.id)
  res.json({ ...payload(), device, assigned })
})

router.delete('/:id', (req: Request, res: Response) => {
  if (!removeDevice(String(req.params['id']))) {
    res.status(404).json({ error: 'no such device' })
    return
  }
  res.json(payload())
})

router.post('/assign', (req: Request, res: Response) => {
  const { service, deviceId } = (req.body ?? {}) as { service?: unknown; deviceId?: unknown }
  if (!(SERVICE_ORDER as string[]).includes(String(service))) {
    res.status(400).json({ error: `service must be one of ${SERVICE_ORDER.join(', ')}` })
    return
  }
  try {
    assignService(service as AiService, typeof deviceId === 'string' ? deviceId : '')
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json(payload())
})

router.post('/:id/probe', async (req: Request, res: Response) => {
  const device = readDevices().devices.find(d => d.id === String(req.params['id']))
  if (!device) {
    res.status(404).json({ error: 'no such device' })
    return
  }
  const results = await probeDevice(device)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ device, results })
})

export default router
