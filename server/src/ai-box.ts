// ── Which GPU box the local AI runs on ───────────────────────────────────────
//
// Kokoro, RVC, Whisper, ComfyUI and the local Ollama models are reached over
// plain HTTP, so "where the AI runs" has always been a set of URLs in .env —
// and switching boxes meant editing all of them and recreating the container.
// With two machines that can carry the load (loklo-pc and lokloComputer, both
// a 4090) that is the wrong shape: which one is on, or free, changes by the
// evening. So the URLs keep saying WHICH services are remote, and this module
// decides which box they go to.
//
//   AI_BOXES=loklo-pc=100.98.235.63, lokloComputer=100.112.40.40
//
// Every AI URL whose host is one of those boxes is "box-bound": at call time
// its host is swapped for the chosen box's, keeping the port and path. A URL
// pointing anywhere else (ollama.com, the `whisper` compose service) is left
// alone, so nothing changes for a service that isn't on a GPU box.
//
// The choice is Settings → AI box, saved as `ai-box.json` in $CACHE_DIR:
//   • a box by id — everything box-bound goes there, answering or not; the
//     user asked for that box and a silent redirect would hide that it is off
//   • `auto` — per service, the first box in AI_BOXES order that answers on
//     that service's port. Sticky: a service stays on the box it is using for
//     as long as that box keeps answering, so a render or a Miku sentence
//     half-way through is never moved because the other box came back.
//
// Liveness is a HEAD on each box-bound port every 30 s. Any HTTP answer counts
// as up (Kokoro 404s on /, a FastAPI app 405s a HEAD) — what is being asked is
// "is something listening", and whether that something works is what the
// Debug tab's round-trip checks are for.

import fs from 'fs'
import path from 'path'

export interface AiBox { id: string; name: string; host: string }

export type AiBoxChoice = 'auto' | string

/** The URLs that can be box-bound, with the label the Settings tab shows. */
const SERVICES: { env: string; label: string; fallbackEnv?: string }[] = [
  { env: 'KOKORO_URL',          label: 'Speech (Kokoro)' },
  { env: 'RVC_URL',             label: 'Miku voice (RVC)' },
  { env: 'WHISPER_URL',         label: 'Hearing (Whisper)' },
  { env: 'COMFYUI_URL',         label: 'Drawing (ComfyUI)' },
  { env: 'OLLAMA_URL',          label: 'Chat model' },
  { env: 'OLLAMA_FALLBACK_URL', label: 'Chat fallback model' },
  { env: 'OLLAMA_IMAGE_URL',    label: 'Picture-side models', fallbackEnv: 'OLLAMA_URL' },
  { env: 'OLLAMA_GUIDE_URL',    label: 'Guide writer',        fallbackEnv: 'OLLAMA_URL' },
]

const PROBE_EVERY_MS = 30_000
const PROBE_TIMEOUT_MS = 4_000

let boxesCache: AiBox[] | null = null
let boxesRaw = ''

/** The boxes named in AI_BOXES, in preference order. Empty = the feature is off. */
export function aiBoxes(): AiBox[] {
  // Keyed on the raw value rather than parsed once: `npm run dev` loads
  // server/.env after the modules that call this have been imported.
  const raw = process.env['AI_BOXES'] ?? ''
  if (boxesCache && raw === boxesRaw) return boxesCache
  boxesRaw = raw
  const seen = new Set<string>()
  boxesCache = raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).flatMap(entry => {
    const eq = entry.indexOf('=')
    const name = (eq > 0 ? entry.slice(0, eq) : entry).trim()
    const host = (eq > 0 ? entry.slice(eq + 1) : entry).trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '')
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!id || !host || seen.has(id)) return []
    seen.add(id)
    return [{ id, name, host }]
  })
  return boxesCache
}

export function aiBoxesEnabled(): boolean {
  return aiBoxes().length > 0
}

// ── The saved choice ─────────────────────────────────────────────────────────

function choiceFile(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'ai-box.json')
}

let choice: AiBoxChoice | null = null

export function aiBoxChoice(): AiBoxChoice {
  if (choice !== null) return choice
  try {
    const v = (JSON.parse(fs.readFileSync(choiceFile(), 'utf8')) as { selected?: unknown }).selected
    choice = typeof v === 'string' && (v === 'auto' || aiBoxes().some(b => b.id === v)) ? v : 'auto'
  } catch {
    choice = 'auto'
  }
  return choice
}

export function setAiBoxChoice(next: AiBoxChoice): void {
  if (next !== 'auto' && !aiBoxes().some(b => b.id === next)) throw new Error(`no AI box called "${next}"`)
  const p = choiceFile()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ selected: next }, null, 2), 'utf8')
  fs.renameSync(tmp, p)
  const before = snapshot()
  choice = next
  console.log(`[ai-box] selected ${next === 'auto' ? 'auto' : aiBoxes().find(b => b.id === next)!.name}`)
  announce(before)
  void probeAll()
}

// ── Liveness ─────────────────────────────────────────────────────────────────

interface PortState { up: boolean; at: number; ms: number; error?: string; fails: number }

/** `${boxId}:${port}` → the last probe of that port. */
const health = new Map<string, PortState>()
/** port → the box `auto` is using for it (sticky, see the header). */
const autoPick = new Map<number, string>()

function parse(raw: string): URL | null {
  try { return new URL(raw) } catch { return null }
}

function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
}

function rawUrl(env: string, fallbackEnv?: string): string {
  return (process.env[env] ?? (fallbackEnv ? process.env[fallbackEnv] : undefined) ?? '').trim()
}

/** The ports that at least one box-bound URL uses. */
function boundPorts(): number[] {
  const hosts = new Set(aiBoxes().map(b => b.host))
  const ports = new Set<number>()
  for (const s of SERVICES) {
    const u = parse(rawUrl(s.env, s.fallbackEnv))
    if (u && hosts.has(u.hostname)) ports.add(portOf(u))
  }
  return [...ports].sort((a, b) => a - b)
}

function upAt(box: AiBox, port: number): boolean | undefined {
  // A box switched off from the dashboard is down from that moment, not from
  // the next probe: auto moves off it, and the voice chains skip it, at once.
  if (agentStatus.get(box.id)?.status?.desired === 'off') return false
  return health.get(`${box.id}:${port}`)?.up
}

// ── Power (the box's own agent) ──────────────────────────────────────────────
// A box can run a small agent (E:\ai\agent on lokloComputer) that switches its
// AI on and off: off unloads the models and stops every process holding VRAM,
// so a PC that is also a gaming PC gets its memory back. Declared per box:
//   AI_BOX_AGENTS=lokloComputer=http://100.112.40.40:8190
//   AI_BOX_AGENT_TOKEN=<the agent's token.txt>
// A box without an agent simply has no switch.

export interface AgentStatus {
  desired: 'on' | 'off'
  phase: 'on' | 'off' | 'starting' | 'stopping'
  since: string
  detail: string
  services: Record<string, boolean>
  gpu: { name: string; usedMb: number; totalMb: number } | null
  ollamaLoaded: { name: string; vramMb: number }[]
  models: { total: number; done: number; current: string | null; failed: string[] }
}

/** Why an agent could not be asked: the PC is off or asleep, or it is on and the agent is not running. */
export type AgentReach = 'ok' | 'offline' | 'agent-down' | 'error'

class AgentError extends Error {
  constructor(message: string, readonly reach: AgentReach) { super(message) }
}

const agentStatus = new Map<string, { at: number; status: AgentStatus | null; error?: string; reach: AgentReach }>()

function agentUrl(box: AiBox): string {
  for (const entry of (process.env['AI_BOX_AGENTS'] ?? '').split(/[,;\n]/)) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq).trim().toLowerCase()
    if (name === box.name.toLowerCase() || name === box.id) return entry.slice(eq + 1).trim().replace(/\/+$/, '')
  }
  return ''
}

async function agentCall(box: AiBox, method: 'GET' | 'POST', pathname: string, body?: unknown, timeoutMs = 20_000): Promise<AgentStatus> {
  const url = agentUrl(box)
  if (!url) throw new Error(`${box.name} has no power agent`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}${pathname}`, {
      method,
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${process.env['AI_BOX_AGENT_TOKEN'] ?? ''}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => null) as (AgentStatus & { error?: string }) | null
    if (!res.ok || !json) throw new AgentError(json?.error ?? `HTTP ${res.status}`, 'error')
    return json
  } catch (err) {
    if (err instanceof AgentError) throw err
    // A timeout is a PC that is off or asleep. A refused or dropped connection
    // is a PC that answered — `tailscale serve` accepts and then finds nothing
    // behind the port — so the machine is on and only the agent is missing.
    const code = (err as { cause?: { code?: string } }).cause?.code ?? ''
    if (err instanceof Error && /abort/i.test(err.message)) throw new AgentError(`${box.name} did not answer`, 'offline')
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ECONNREFUSED') throw new AgentError(`${box.name}'s agent is not running`, 'agent-down')
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') throw new AgentError(`${box.name} is unreachable`, 'offline')
    throw new AgentError(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    clearTimeout(timer)
  }
}

async function refreshAgent(box: AiBox): Promise<void> {
  if (!agentUrl(box)) return
  try {
    agentStatus.set(box.id, { at: Date.now(), status: await agentCall(box, 'GET', '/status', undefined, 6_000), reach: 'ok' })
  } catch (err) {
    // Unreachable is not "off": keep the last known wish so an asleep PC that
    // was switched off stays off in the auto picks.
    const prev = agentStatus.get(box.id)?.status ?? null
    agentStatus.set(box.id, {
      at: Date.now(), status: prev,
      error: err instanceof Error ? err.message : String(err),
      reach: err instanceof AgentError ? err.reach : 'error',
    })
  }
}

/** Switch a box's AI on or off through its agent. Resolves once the agent has accepted it. */
export async function setBoxPower(id: string, on: boolean): Promise<void> {
  const box = aiBoxes().find(b => b.id === id)
  if (!box) throw new Error(`no AI box called "${id}"`)
  const before = snapshot()
  const status = await agentCall(box, 'POST', '/power', { on })
  agentStatus.set(box.id, { at: Date.now(), status, reach: 'ok' })
  console.log(`[ai-box] ${box.name} switched ${on ? 'on' : 'off'} from the dashboard`)
  recomputeAuto()
  announce(before)
  // Starting takes a minute or two; look again soon rather than in 30 s.
  for (const ms of [5_000, 20_000, 45_000, 90_000]) setTimeout(() => { void probeAll() }, ms).unref()
}

/** Refresh agent statuses older than `maxAgeMs` — for a Settings tab watching a switch. */
export async function refreshAgentsIfStale(maxAgeMs: number): Promise<void> {
  await Promise.all(aiBoxes().filter(b => {
    const a = agentStatus.get(b.id)
    // A PC that did not answer last time is left to the 30 s probe, or every
    // open tab would wait out a timeout on each refresh.
    const age = a ? Date.now() - a.at : Infinity
    return agentUrl(b) && age > (a?.error ? PROBE_EVERY_MS : maxAgeMs)
  }).map(refreshAgent))
}

/**
 * True when a box-bound URL is going to a box known not to answer on that port
 * right now — switched off, or failing its last probe. Callers with a fallback
 * (the voice chains, the chat fallback) skip it rather than spend a timeout.
 */
export function aiBoxDown(raw: string): boolean {
  if (!raw || !aiBoxesEnabled()) return false
  const u = parse(boxUrl(raw))
  if (!u) return false
  const box = aiBoxes().find(b => b.host === u.hostname)
  return box ? upAt(box, portOf(u)) === false : false
}

async function probe(box: AiBox, port: number): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  const t0 = Date.now()
  const key = `${box.id}:${port}`
  try {
    await fetch(`http://${box.host}:${port}/`, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' })
    health.set(key, { up: true, at: Date.now(), ms: Date.now() - t0, fails: 0 })
  } catch (err) {
    // Node's fetch says "fetch failed" for everything; the reason is on `cause`.
    const code = (err as { cause?: { code?: string } }).cause?.code ?? ''
    const msg = err instanceof Error && /abort/i.test(err.message) ? 'no answer'
      // Refused, or accepted and dropped by `tailscale serve` with nothing behind
      // it: either way the PC answered and the service is what is missing.
      : code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'not running'
      : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'unreachable'
      : code || (err instanceof Error ? err.message : String(err))
    // Down only on the second miss in a row. RVC's server is single-threaded
    // and does not answer while it converts a sentence, so one missed probe is
    // as likely "busy" as "gone" — and a port marked down is skipped by the
    // voice chain, which would cost Miku her voice for the next half minute.
    const prev = health.get(key)
    const fails = (prev?.fails ?? 0) + 1
    const up = fails >= 2 ? false : prev?.up ?? false
    health.set(key, { up, at: Date.now(), ms: Date.now() - t0, error: msg, fails })
  } finally {
    clearTimeout(timer)
  }
}

function recomputeAuto(): void {
  const boxes = aiBoxes()
  for (const port of boundPorts()) {
    const current = boxes.find(b => b.id === autoPick.get(port))
    if (current && upAt(current, port) !== false) continue
    const first = boxes.find(b => upAt(b, port) === true)
    if (first) autoPick.set(port, first.id)
  }
}

let probing: Promise<void> | null = null

/** Probe every box on every box-bound port now. Concurrent calls share one run. */
export function probeAll(): Promise<void> {
  if (probing) return probing
  probing = (async () => {
    const before = snapshot()
    const upBefore = upSignature()
    await Promise.all([
      ...aiBoxes().flatMap(b => boundPorts().map(p => probe(b, p))),
      ...aiBoxes().map(refreshAgent),
    ])
    recomputeAuto()
    // Every 30 s is a lot of frames for a screen nobody is looking at, so the
    // tab is only told when a box went up or down or a service moved.
    announce(before, upSignature() !== upBefore)
  })().finally(() => { probing = null })
  return probing
}

let timer: NodeJS.Timeout | null = null

// The first round of probes, and whether it has finished. Until it has, Auto
// has picked nothing and every box-bound URL still names whichever box .env
// does — so a request in the first seconds after a restart went there. The one
// that showed it: a picture asked for a second after a deploy had its prompt
// improver sent to loklo-pc, switched off, while the render itself (a few
// seconds later) went to the box that was on.
let firstProbe: Promise<void> | null = null
let firstDone = false

/** Resolves once the first probe round is done — at once when AI_BOXES is unset or it already has. */
export function aiBoxSettled(): Promise<void> {
  if (firstDone || !aiBoxesEnabled() || !firstProbe) return Promise.resolve()
  return firstProbe
}

/** boxUrl(), after the first probe round: for the async paths that actually make the call. */
export async function boxUrlSettled(raw: string): Promise<string> {
  await aiBoxSettled()
  return boxUrl(raw)
}

export function startAiBoxProbe(): void {
  if (timer || !aiBoxesEnabled()) return
  const names = aiBoxes().map(b => `${b.name} (${b.host})`).join(', ')
  console.log(`[ai-box] boxes: ${names}; selected: ${aiBoxChoice()}; watching ports ${boundPorts().join(', ') || 'none'}`)
  firstProbe = probeAll().catch(() => {}).finally(() => { firstDone = true })
  timer = setInterval(() => { void probeAll() }, PROBE_EVERY_MS)
  timer.unref()
}

// ── Resolving a URL ──────────────────────────────────────────────────────────

function targetFor(u: URL): AiBox | undefined {
  const boxes = aiBoxes()
  const selected = aiBoxChoice()
  if (selected !== 'auto') return boxes.find(b => b.id === selected)
  return boxes.find(b => b.id === autoPick.get(portOf(u)))
}

/**
 * The URL to actually call. A URL whose host is one of AI_BOXES is re-pointed
 * at the chosen box; anything else, and every URL when AI_BOXES is unset, comes
 * back exactly as given.
 */
export function boxUrl(raw: string): string {
  if (!raw || !aiBoxesEnabled()) return raw
  const u = parse(raw)
  if (!u || !aiBoxes().some(b => b.host === u.hostname)) return raw
  const target = targetFor(u)
  if (!target || target.host === u.hostname) return raw
  return raw.replace(`//${u.host}`, `//${target.host}${u.port ? `:${u.port}` : ''}`)
}

/** Which box a URL resolves to, for logs and the Settings tab. */
export function boxNameFor(raw: string): string | null {
  const u = parse(boxUrl(raw))
  return u ? aiBoxes().find(b => b.host === u.hostname)?.name ?? null : null
}

// ── Change notification ──────────────────────────────────────────────────────

const listeners = new Set<() => void>()

/**
 * Called whenever any box-bound URL now resolves somewhere else — a manual
 * switch, or `auto` moving a service off a box that stopped answering. For the
 * per-box state callers keep: which RVC model is loaded, what ComfyUI has.
 */
export function onAiBoxChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function snapshot(): string {
  return SERVICES.map(s => boxUrl(rawUrl(s.env, s.fallbackEnv))).join('|')
}

function upSignature(): string {
  return [
    ...[...health.entries()].map(([k, v]) => `${k}=${v.up ? 1 : 0}`),
    ...[...agentStatus.entries()].map(([k, v]) => `${k}:${v.status?.phase ?? '?'}:${v.error ? 1 : 0}:${v.status?.models.done ?? ''}`),
  ].sort().join(',')
}

// routes/system imports the voice routes, which import this module, so the
// broadcaster is fetched when it is needed rather than at load.
function broadcast(event: string, data: unknown): void {
  void import('./routes/system').then(m => m.broadcast(event, data)).catch(() => {})
}

function announce(before: string, notify = true): void {
  const after = snapshot()
  if (after === before) {
    if (notify) broadcast('ai-box', { changed: false })
    return
  }
  for (const s of SERVICES) {
    const raw = rawUrl(s.env, s.fallbackEnv)
    const was = before.split('|')[SERVICES.indexOf(s)]
    const now = boxUrl(raw)
    if (raw && was !== now) console.log(`[ai-box] ${s.label}: ${was} → ${now}`)
  }
  for (const cb of listeners) {
    try { cb() } catch (err) { console.warn('[ai-box] change listener failed:', err instanceof Error ? err.message : err) }
  }
  broadcast('ai-box', { changed: true })
}

// ── The view the Settings tab draws ──────────────────────────────────────────

export interface AiBoxView {
  enabled: boolean
  selected: AiBoxChoice
  boxes: {
    id: string; name: string; host: string
    ports: { port: number; up: boolean | null; ms: number | null; checkedAt: string | null; error: string | null }[]
    /** Null when the box has no agent, i.e. no on/off switch. */
    power: { status: AgentStatus | null; checkedAt: string | null; error: string | null; reach: AgentReach | null } | null
  }[]
  services: { key: string; label: string; port: number; box: string | null; url: string }[]
}

export function aiBoxView(): AiBoxView {
  const boxes = aiBoxes()
  const hosts = new Set(boxes.map(b => b.host))
  const ports = boundPorts()
  return {
    enabled: boxes.length > 0,
    selected: aiBoxChoice(),
    boxes: boxes.map(b => ({
      id: b.id, name: b.name, host: b.host,
      ports: ports.map(port => {
        const h = health.get(`${b.id}:${port}`)
        return {
          port,
          up: upAt(b, port) ?? null,
          ms: h ? h.ms : null,
          checkedAt: h ? new Date(h.at).toISOString() : null,
          error: h?.error ?? null,
        }
      }),
      power: agentUrl(b)
        ? (() => {
            const a = agentStatus.get(b.id)
            return { status: a?.status ?? null, checkedAt: a ? new Date(a.at).toISOString() : null, error: a?.error ?? null, reach: a?.reach ?? null }
          })()
        : null,
    })),
    services: SERVICES.flatMap(s => {
      if (s.fallbackEnv && !process.env[s.env]) return []
      const raw = rawUrl(s.env)
      const u = parse(raw)
      if (!u || !hosts.has(u.hostname)) return []
      const url = boxUrl(raw)
      const target = parse(url)
      return [{
        key: s.env,
        label: s.label,
        port: portOf(u),
        box: target ? boxes.find(b => b.host === target.hostname)?.id ?? null : null,
        url,
      }]
    }),
  }
}
