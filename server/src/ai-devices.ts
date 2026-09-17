// Which machine does each piece of AI work.
//
// Every AI service this app talks to — the language model, the picture box,
// the two voices and the ear — is plain HTTP, so *where* it runs is a URL. Those
// URLs used to be five env vars read once at boot, which is the right shape for
// one GPU box that never moves and the wrong shape the day there are two: a
// desktop with a card and a laptop that also has one, or the dashboard box
// itself once scripts/local-ai/install.sh has put the whole stack on it. Moving
// a service between them meant editing .env on the server and restarting the
// container, from a kiosk with no keyboard.
//
// So the URLs are now RESOLVED PER REQUEST from a small store on the cache
// volume (`ai-devices.json`, the image-model.json pattern): a list of devices
// (a name and a host), and per service the device that does it. A service with
// no device assigned falls back to its env var exactly as before, so a box that
// never opens Settings → Devices is unchanged. Read per request rather than
// cached for the same reason the style picker is — picking a device has to take
// effect on the NEXT picture, not after a restart.
//
// The env vars keep their meaning as the fallback, and a device is only ever
// `host` + the service's standard port (overridable per device), because the
// installer starts every service on its standard port and a form with five
// port fields is a form nobody fills in on a touchscreen.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type AiService = 'chat' | 'image' | 'tts' | 'rvc' | 'stt'

export const SERVICE_ORDER: AiService[] = ['chat', 'image', 'tts', 'stt', 'rvc']

export interface ServiceSpec {
  /** Shown in Settings. */
  label:      string
  /** One line under the label saying what depends on it. */
  hint:       string
  /** The env var that configures it when no device is assigned. */
  env:        string
  /** The port the compose files publish it on. */
  port:       number
  /** What the env var means when unset ('' = the service is off). */
  defaultUrl: string
}

export const SERVICES: Record<AiService, ServiceSpec> = {
  chat: {
    label: 'Language model (Ollama)',
    hint:  'the assistant, its tools, the game-guide writer, the prompt improver and the planner',
    env:   'OLLAMA_URL',
    port:  11434,
    // Ollama on the docker host — the app's oldest default, kept.
    defaultUrl: 'http://host.docker.internal:11434',
  },
  image: {
    label: 'Pictures (ComfyUI)',
    hint:  'drawing, redrawing and editing pictures — no device means the assistant cannot draw',
    env:   'COMFYUI_URL',
    port:  8188,
    defaultUrl: '',
  },
  tts: {
    label: 'Voice out (Kokoro)',
    hint:  'the assistants’ spoken replies, before or behind ElevenLabs depending on TTS_PROVIDER',
    env:   'KOKORO_URL',
    port:  8880,
    defaultUrl: '',
  },
  stt: {
    label: 'Voice in (Whisper)',
    hint:  'hearing what was said, tried before ElevenLabs Scribe',
    env:   'WHISPER_URL',
    port:  8000,
    defaultUrl: '',
  },
  rvc: {
    label: 'Miku’s voice (RVC)',
    hint:  'the voice conversion behind Miku — needs Kokoro on some device too',
    env:   'RVC_URL',
    port:  5050,
    defaultUrl: '',
  },
}

export interface AiDevice {
  id:      string
  name:    string
  /** A hostname or IP, optionally with a scheme and/or port; see deviceBase(). */
  host:    string
  /** Per-service port overrides; a service missing here uses its standard port. */
  ports:   Partial<Record<AiService, number>>
  addedAt: string
}

interface Store {
  devices: AiDevice[]
  /** service → device id. Missing or '' = use the env var. */
  assign:  Partial<Record<AiService, string>>
}

export type UrlSource = 'device' | 'env' | 'default' | 'off'

export interface ResolvedService {
  id:      AiService
  label:   string
  hint:    string
  env:     string
  url:     string
  source:  UrlSource
  device?: { id: string; name: string }
  /** What the env var would give, for the "As in .env" chip. '' = off. */
  envUrl:  string
}

// ── Store ────────────────────────────────────────────────────────────────────

function storePath(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  return path.join(dir, 'ai-devices.json')
}

const EMPTY: Store = { devices: [], assign: {} }

function isService(s: unknown): s is AiService {
  return typeof s === 'string' && (SERVICE_ORDER as string[]).includes(s)
}

/** Read the store, tolerating an absent, unreadable or malformed file. */
export function readDevices(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<Store>
    const devices = Array.isArray(raw.devices)
      ? raw.devices.filter((d): d is AiDevice =>
          !!d && typeof d === 'object' && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.host === 'string')
        .map(d => ({ ...d, ports: d.ports && typeof d.ports === 'object' ? d.ports : {} }))
      : []
    const assign: Store['assign'] = {}
    if (raw.assign && typeof raw.assign === 'object') {
      for (const [k, v] of Object.entries(raw.assign)) {
        if (isService(k) && typeof v === 'string' && v) assign[k] = v
      }
    }
    return { devices, assign }
  } catch {
    return { devices: [], assign: {} }
  }
}

function writeDevices(store: Store): void {
  const p = storePath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    throw err
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The base URL a device answers a service on. `host` is what the user typed:
 * an IP or hostname ("192.168.1.20", "gpu-box.local", a Tailscale name), which
 * gets http:// and the service's port; or, for anyone who needs it, a full
 * base with its own scheme and port ("https://gpu.tail.ts.net"), used as-is —
 * that is how a service behind `tailscale serve` or a reverse proxy is reached,
 * and one such device serves one service unless per-service ports are given.
 */
export function deviceBase(device: AiDevice, service: AiService): string {
  const host = device.host.trim().replace(/\/+$/, '')
  const port = device.ports[service] ?? SERVICES[service].port
  if (/^https?:\/\//i.test(host)) {
    // A full URL: honour it. Add the port only if it names none and the user
    // gave a per-service override (a proxy base with no port is deliberate).
    if (device.ports[service] && !/:\d+$/.test(host)) return `${host}:${port}`
    return host
  }
  // A bare host that already carries a port ("box:11434") is taken literally.
  if (/^[^/]+:\d+$/.test(host)) return `http://${host}`
  // IPv6 literal without brackets.
  if (host.includes(':') && !host.startsWith('[')) return `http://[${host}]:${port}`
  return `http://${host}:${port}`
}

function envUrlFor(service: AiService): string {
  const spec = SERVICES[service]
  return (process.env[spec.env] ?? spec.defaultUrl).replace(/\/+$/, '')
}

/** Where a service is, and why: the assigned device, else the env var. */
export function resolveService(service: AiService, store = readDevices()): ResolvedService {
  const spec = SERVICES[service]
  const envUrl = envUrlFor(service)
  const wanted = store.assign[service]
  if (wanted) {
    const device = store.devices.find(d => d.id === wanted)
    if (device) {
      return {
        id: service, label: spec.label, hint: spec.hint, env: spec.env,
        url: deviceBase(device, service), source: 'device',
        device: { id: device.id, name: device.name }, envUrl,
      }
    }
    // The assignment names a device that was deleted: fall through to the
    // env, and say so through `source` rather than pretending it was chosen.
  }
  const explicit = process.env[spec.env] !== undefined
  return {
    id: service, label: spec.label, hint: spec.hint, env: spec.env,
    url: envUrl,
    source: envUrl === '' ? 'off' : explicit ? 'env' : 'default',
    envUrl,
  }
}

/** The URL every caller uses. '' means the service is not configured anywhere. */
export function serviceUrl(service: AiService): string {
  return resolveService(service).url
}

/**
 * The Ollama that a given kind of call goes to. `OLLAMA_GUIDE_URL` and
 * `OLLAMA_IMAGE_URL` exist so the guide writer and the picture-side models can
 * run on a different box from the chat — but once a device is CHOSEN for the
 * language model in Settings, that choice is what "which device generates
 * these things" means, and all three kinds go there. The per-kind env vars
 * remain the way to split them when nothing is assigned.
 */
export function ollamaUrlFor(kind: 'chat' | 'guide' | 'image'): string {
  const chat = resolveService('chat')
  if (chat.source === 'device') return chat.url
  const specific = kind === 'guide' ? process.env['OLLAMA_GUIDE_URL']
    : kind === 'image' ? process.env['OLLAMA_IMAGE_URL']
    : undefined
  if (specific !== undefined && specific.trim() !== '') return specific.replace(/\/+$/, '')
  return chat.url
}

/** Every service, resolved — the Settings tab's and the debug endpoint's table. */
export function resolveAll(): ResolvedService[] {
  const store = readDevices()
  return SERVICE_ORDER.map(s => resolveService(s, store))
}

/** One line per service for the startup log: "chat: http://… (device Office PC)". */
export function describeService(service: AiService): string {
  const r = resolveService(service)
  if (r.source === 'off') return `off (no device, ${r.env} unset)`
  const via = r.source === 'device' ? `device "${r.device!.name}"` : r.source === 'env' ? r.env : `${r.env} default`
  return `${r.url} (${via})`
}

// ── Mutation ─────────────────────────────────────────────────────────────────

const HOST_RE = /^(https?:\/\/)?[a-z0-9._:\-[\]]+(:\d{1,5})?$/i

/** Validate a host the way the form and the installer both send it. */
export function validHost(host: string): boolean {
  const h = host.trim().replace(/\/+$/, '')
  return h.length > 0 && h.length <= 200 && HOST_RE.test(h) && !/\s/.test(h)
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'device'
}

export interface UpsertInput {
  id?:     string
  name:    string
  host:    string
  ports?:  Partial<Record<AiService, number>>
}

/** Add a device, or update one by id. Returns the stored record. */
export function upsertDevice(input: UpsertInput): AiDevice {
  const name = String(input.name ?? '').trim().slice(0, 60)
  const host = String(input.host ?? '').trim().replace(/\/+$/, '')
  if (!name) throw new Error('a device needs a name')
  if (!validHost(host)) throw new Error('host must be an IP or hostname, optionally with a port (e.g. 192.168.1.20 or gpu-box:11434)')
  const ports: AiDevice['ports'] = {}
  if (input.ports && typeof input.ports === 'object') {
    for (const [k, v] of Object.entries(input.ports)) {
      const n = Number(v)
      if (isService(k) && Number.isInteger(n) && n > 0 && n < 65536) ports[k] = n
    }
  }
  const store = readDevices()
  const existing = input.id ? store.devices.find(d => d.id === input.id) : undefined
  if (input.id && !existing) throw new Error('no such device')
  let device: AiDevice
  if (existing) {
    device = { ...existing, name, host, ports }
    store.devices = store.devices.map(d => d.id === device.id ? device : d)
  } else {
    // Same host again is an edit, not a second device: the installer re-run
    // on a box registers it once, and a typo'd name is fixed by re-adding.
    const twin = store.devices.find(d => d.host.toLowerCase() === host.toLowerCase())
    if (twin) {
      device = { ...twin, name, ports }
      store.devices = store.devices.map(d => d.id === device.id ? device : d)
    } else {
      const base = slug(name)
      let id = base
      while (store.devices.some(d => d.id === id)) id = `${base}-${crypto.randomBytes(2).toString('hex')}`
      device = { id, name, host, ports, addedAt: new Date().toISOString() }
      store.devices.push(device)
    }
  }
  writeDevices(store)
  console.log(`[ai-devices] ${existing ? 'updated' : 'added'} "${device.name}" at ${device.host}`)
  return device
}

export function removeDevice(id: string): boolean {
  const store = readDevices()
  const before = store.devices.length
  store.devices = store.devices.filter(d => d.id !== id)
  if (store.devices.length === before) return false
  for (const s of SERVICE_ORDER) if (store.assign[s] === id) delete store.assign[s]
  writeDevices(store)
  console.log(`[ai-devices] removed ${id}`)
  return true
}

/** Point a service at a device, or at '' to go back to the env var. */
export function assignService(service: AiService, deviceId: string): void {
  if (!isService(service)) throw new Error('unknown service')
  const store = readDevices()
  if (deviceId) {
    if (!store.devices.some(d => d.id === deviceId)) throw new Error('no such device')
    store.assign[service] = deviceId
  } else {
    delete store.assign[service]
  }
  writeDevices(store)
  const r = resolveService(service, store)
  console.log(`[ai-devices] ${service} → ${r.url || 'off'} (${r.source}${r.device ? ` "${r.device.name}"` : ''})`)
}

// ── Probing ──────────────────────────────────────────────────────────────────

export interface ProbeResult {
  service: AiService
  url:     string
  ok:      boolean
  ms:      number
  detail:  string
}

async function timedFetch(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask a device what it is running. One cheap GET per service on the device's
 * port for it — the same idle endpoints scripts/check-local-ai.sh uses — with
 * what each answers turned into a line worth reading: the models Ollama has,
 * the card and free VRAM behind ComfyUI, how many voices Kokoro offers.
 * A service that isn't there is a plain "not answering", never an error: the
 * point of the probe is to find out which of the five a device runs.
 */
export async function probeDevice(device: AiDevice, timeoutMs = 5_000): Promise<ProbeResult[]> {
  return Promise.all(SERVICE_ORDER.map(async (service): Promise<ProbeResult> => {
    const base = deviceBase(device, service)
    const t0 = Date.now()
    const done = (ok: boolean, detail: string): ProbeResult => ({ service, url: base, ok, ms: Date.now() - t0, detail })
    try {
      switch (service) {
        case 'chat': {
          const res = await timedFetch(`${base}/api/tags`, timeoutMs)
          if (!res.ok) return done(false, `HTTP ${res.status}`)
          const body = await res.json() as { models?: { name: string }[] }
          const names = (body.models ?? []).map(m => m.name)
          return done(true, names.length ? `models: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}` : 'answering, no models pulled yet')
        }
        case 'image': {
          const res = await timedFetch(`${base}/system_stats`, timeoutMs)
          if (!res.ok) return done(false, `HTTP ${res.status}`)
          const body = await res.json() as { devices?: { name?: string; vram_free?: number; vram_total?: number }[] }
          const d = body.devices?.[0]
          if (!d) return done(true, 'answering')
          const gb = (n?: number) => n ? `${(n / 1024 ** 3).toFixed(1)} GB` : '?'
          return done(true, `${(d.name ?? 'GPU').replace(/^cuda:\d+\s*/, '')} — ${gb(d.vram_free)} of ${gb(d.vram_total)} free`)
        }
        case 'tts': {
          const res = await timedFetch(`${base}/v1/audio/voices`, timeoutMs)
          if (!res.ok) return done(false, `HTTP ${res.status}`)
          const body = await res.json().catch(() => ({})) as { voices?: unknown[] }
          return done(true, Array.isArray(body.voices) ? `${body.voices.length} voices` : 'answering')
        }
        case 'stt': {
          // speaches and faster-whisper-server answer /health; whisper.cpp's
          // server has no idle endpoint but answers 404 on it, which is still
          // a server on that port.
          const res = await timedFetch(`${base}/health`, timeoutMs)
          if (res.ok) return done(true, 'answering')
          if (res.status === 404) {
            const alt = await timedFetch(`${base}/v1/models`, timeoutMs)
            return alt.ok ? done(true, 'answering') : done(true, `answering (HTTP ${alt.status} on /v1/models)`)
          }
          return done(false, `HTTP ${res.status}`)
        }
        case 'rvc': {
          // rvc-python's API has no health route; any HTTP answer on the port
          // is the container. 5xx is the one thing that means "there, but broken".
          const res = await timedFetch(`${base}/`, timeoutMs)
          return res.status < 500 ? done(true, 'answering') : done(false, `HTTP ${res.status}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return done(false, /abort/i.test(msg) ? `no answer within ${(timeoutMs / 1000).toFixed(0)}s` : 'not answering')
    }
    return done(false, 'not answering')
  }))
}
