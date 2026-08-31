// Image generation through ComfyUI, in the background.
//
// Same deal as the voice pipeline: the app only ever talks HTTP, so WHERE
// ComfyUI runs is a `.env` decision (COMFYUI_URL). In practice it runs on the
// box with the GPU — see docker-compose.voice.yml, which is already the file
// that means "the heavy stuff runs here".
//
// The one structural difference from TTS: there is NO fallback. tts.ts can fall
// through kokoro → elevenlabs → espeak and always produce *something*, because
// espeak is local and cannot fail. Image generation has no espeak. If the GPU
// box is off, the honest answer is "the image machine is offline", not a
// degraded picture — so nothing here silently substitutes anything, and the
// tool layer is written to say so out loud.
//
// Generation is a background JOB, not a request, for the same reason guides are:
// a cold ComfyUI pays 20-40 s to load a checkpoint into VRAM before it draws a
// single step, and the assistant cannot hold the conversation open that long.
// startImage() registers the job and returns; the overlay fills in over SSE.
//
// Jobs run ONE AT A TIME. Two SDXL renders on one card don't go twice as fast,
// they thrash VRAM and both get slower — and on a kiosk there is only ever one
// person asking.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { broadcast } from './routes/system'

// ── Config ───────────────────────────────────────────────────────────────────

// No sibling-container default, unlike KOKORO_URL. There is no CPU variant of
// this worth running: SDXL on the dashboard box is minutes per image, which
// isn't a fallback, it's a hang. Unset means the feature is off.
const COMFY_URL = (process.env['COMFYUI_URL'] ?? '').replace(/\/$/, '')

/** Whether image generation is configured at all. */
export function imagesEnabled(): boolean {
  return COMFY_URL !== ''
}

export function comfyUrl(): string {
  return COMFY_URL
}

// A whole render, not a single HTTP call: queue wait + checkpoint load + steps.
const TIMEOUT_MS = Number(process.env['COMFYUI_TIMEOUT_MS'] ?? 180_000)
// How often we ask /history whether it's done. ComfyUI's real per-step progress
// only comes over its WebSocket, which would mean a new dependency for a
// prettier bar; polling gets us the finished image just as fast.
const POLL_MS = 700
// Plain HTTP calls (queueing, downloading the result) — these are fast or broken.
const HTTP_MS = 20_000

// Checkpoint override. Leave unset to use whatever the workflow was saved with,
// which is the right default when someone drops in their own graph.
const MODEL = (process.env['COMFYUI_MODEL'] ?? '').trim()
const STEPS = Number(process.env['COMFYUI_STEPS'] ?? 0) || 0
const DEFAULT_W = Number(process.env['COMFYUI_WIDTH'] ?? 768)
const DEFAULT_H = Number(process.env['COMFYUI_HEIGHT'] ?? 768)
// The kiosk screen is 720×1280 portrait, so a tall default frames better than a
// square — but the model decides per request and this is only the fallback.
const DEFAULT_NEGATIVE = process.env['COMFYUI_NEGATIVE']
  ?? 'text, watermark, signature, blurry, lowres, deformed, extra limbs'

// Unlike cover art — bounded by the length of the Watch/Play list — generated
// images grow without limit, and this is a Docker volume on a Pi. Oldest out.
const MAX_STORED = Number(process.env['IMAGE_MAX_STORED'] ?? 60)

// Guard rails on what the model is allowed to ask for. A model that emits
// width: 8192 would OOM the card and take the container down with it.
const MIN_DIM = 256
const MAX_DIM = 1536
const MAX_PROMPT = 900

// ── Disk ─────────────────────────────────────────────────────────────────────

function imagesDir(): string {
  const dir = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'images')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[image] created images directory: ${dir}`)
  }
  return dir
}

export interface StoredImage {
  /** 32 hex chars. Also the filename stem, so `${id}.png` is the file. */
  id:      string
  prompt:  string
  file:    string
  width:   number
  height:  number
  seed:    number
  /** ISO timestamp. */
  at:      string
}

const indexPath = () => path.join(imagesDir(), 'index.json')

/**
 * The gallery, newest first.
 *
 * Kept as its own small index rather than by listing the directory, because the
 * prompt is the only thing that makes an image identifiable later and a PNG
 * filename is a hash. Corrupt or missing reads as empty — losing the index
 * costs the captions, not the pictures.
 */
export function listImages(): StoredImage[] {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is StoredImage =>
        !!e && typeof e === 'object' &&
        typeof (e as StoredImage).id === 'string' &&
        typeof (e as StoredImage).file === 'string')
      .slice(0, MAX_STORED)
  } catch {
    return []
  }
}

/** Write-then-rename, the memory.ts pattern: a crash mid-write can't truncate it. */
function saveIndex(entries: StoredImage[]): void {
  const p = indexPath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image] failed to write index:', err)
  }
}

/** Add to the gallery and drop the oldest over the cap, files and all. */
function remember(entry: StoredImage): void {
  const kept = [entry, ...listImages().filter(e => e.id !== entry.id)]
  const dropped = kept.splice(MAX_STORED)
  saveIndex(kept)
  for (const old of dropped) {
    try {
      fs.unlinkSync(path.join(imagesDir(), old.file))
      console.log(`[image] pruned ${old.file} ("${old.prompt.slice(0, 40)}")`)
    } catch { /* already gone */ }
  }
}

export function forgetImage(id: string): boolean {
  const all = listImages()
  const hit = all.find(e => e.id === id)
  if (!hit) return false
  saveIndex(all.filter(e => e.id !== id))
  try { fs.unlinkSync(path.join(imagesDir(), hit.file)) } catch { /* already gone */ }
  console.log(`[image] deleted ${hit.file}`)
  return true
}

/** Absolute path of a stored image, or null. Filename is validated by the route. */
export function imagePath(file: string): string | null {
  const full = path.join(imagesDir(), file)
  return fs.existsSync(full) ? full : null
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'running' | 'ready' | 'failed'

export interface ImageJob {
  id:       string
  prompt:   string
  negative: string
  width:    number
  height:   number
  seed:     number
  status:   JobStatus
  /** Human phrase for the overlay — "waiting for the GPU", "drawing"… */
  phase:    string
  /** Set once status is 'ready'. Serve via /api/image/file/<file>. */
  file?:    string
  error?:   string
  startedAt: number
  endedAt?:  number
}

const jobs = new Map<string, ImageJob>()
// Serialized, not parallel — see the header. Same shape as guide-generator's.
let queue: Promise<void> = Promise.resolve()

// A rolling memory of how long renders actually take on THIS box, so the
// overlay can show a real estimate instead of a spinner with no end in sight.
// Seeded at zero: with no history the UI just shows elapsed time.
let lastDurationMs = 0

export function getJob(id: string): ImageJob | undefined {
  return jobs.get(id)
}

/** The job currently queued or drawing, if any. Drives the overlay on reconnect. */
export function activeJob(): ImageJob | undefined {
  for (const j of jobs.values()) {
    if (j.status === 'queued' || j.status === 'running') return j
  }
  return undefined
}

/** What a job looks like on the wire — jobs and stored images share a shape. */
function wire(job: ImageJob) {
  return {
    id:       job.id,
    prompt:   job.prompt,
    status:   job.status,
    phase:    job.phase,
    width:    job.width,
    height:   job.height,
    seed:     job.seed,
    ...(job.file  ? { file: job.file, url: `/api/image/file/${job.file}` } : {}),
    ...(job.error ? { error: job.error } : {}),
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    // Zero until this server has finished one render. The client shows elapsed
    // only in that case rather than inventing a percentage.
    etaMs:     lastDurationMs,
  }
}

function push(job: ImageJob, phase?: string): void {
  if (phase) job.phase = phase
  broadcast('image', wire(job))
}

export interface ImageRequest {
  prompt:    string
  negative?: string
  width?:    number
  height?:   number
  seed?:     number
}

const clampDim = (n: number, fallback: number): number => {
  if (!Number.isFinite(n) || n <= 0) return fallback
  // ComfyUI's latent space is 8px-aligned; a stray 777 errors inside the graph.
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n / 8) * 8))
}

/**
 * Queue a render and return immediately.
 *
 * Never throws and never waits: the caller is usually a chat tool with a person
 * waiting to be spoken to. Everything after this point is reported over SSE and
 * readable from GET /api/image/job/:id.
 */
export function startImage(req: ImageRequest): ImageJob {
  const job: ImageJob = {
    id:        crypto.randomBytes(16).toString('hex'),
    prompt:    req.prompt.slice(0, MAX_PROMPT),
    negative:  (req.negative ?? DEFAULT_NEGATIVE).slice(0, MAX_PROMPT),
    width:     clampDim(req.width  ?? DEFAULT_W, DEFAULT_W),
    height:    clampDim(req.height ?? DEFAULT_H, DEFAULT_H),
    // A fixed seed makes every image of "a cat" identical, which reads as the
    // feature being broken when someone asks twice.
    seed:      Number.isFinite(req.seed) ? Number(req.seed) : crypto.randomInt(0, 2 ** 31),
    status:    'queued',
    phase:     'waiting for the GPU',
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  console.log(`[image] queued ${job.id} "${job.prompt.slice(0, 60)}" ${job.width}×${job.height} seed=${job.seed}`)
  push(job)

  queue = queue.then(() => run(job)).catch(err => {
    // run() handles its own failures; this only catches a bug in run() itself,
    // and must not poison the queue for every later job.
    console.error('[image] job runner crashed:', err)
  })
  return job
}

async function run(job: ImageJob): Promise<void> {
  if (!COMFY_URL) {
    return fail(job, 'COMFYUI_URL is not set — no image server is configured')
  }
  job.status = 'running'
  job.startedAt = Date.now()   // reset: queue wait isn't render time
  push(job, 'drawing')

  try {
    const graph = buildGraph(job)
    const promptId = await queuePrompt(graph)
    console.log(`[image] ${job.id} → comfy prompt ${promptId}`)

    const output = await awaitOutput(promptId, job)
    push(job, 'saving')

    const bytes = await downloadOutput(output)
    const file = `${job.id}.png`
    const dest = path.join(imagesDir(), file)
    const tmp = `${dest}.tmp-${process.pid}`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, dest)

    job.file = file
    job.status = 'ready'
    job.endedAt = Date.now()
    lastDurationMs = job.endedAt - job.startedAt
    remember({
      id: job.id, prompt: job.prompt, file,
      width: job.width, height: job.height, seed: job.seed,
      at: new Date().toISOString(),
    })
    console.log(
      `[image] ${job.id} ready in ${(lastDurationMs / 1000).toFixed(1)}s ` +
      `(${(bytes.length / 1024).toFixed(0)} KB)`,
    )
    push(job, 'ready')
  } catch (err) {
    fail(job, err instanceof Error ? err.message : String(err))
  }
}

function fail(job: ImageJob, message: string): void {
  job.status = 'failed'
  job.error = message
  job.endedAt = Date.now()
  console.error(`[image] ${job.id} failed — ${message}`)
  push(job, 'failed')
}

// ── The ComfyUI graph ────────────────────────────────────────────────────────
//
// ComfyUI's /prompt takes the "API format" export, which is a flat map of
// node id → { class_type, inputs }, NOT the workflow JSON the Save button
// produces. Feeding it the latter is the single most common way this fails, and
// it fails with a bare 400.
//
// The built-in template below is ComfyUI's own default txt2img graph. Anyone
// who wants a different one (SDXL, a LoRA stack, a refiner pass) drops their own
// API-format export at $CACHE_DIR/workflows/txt2img.json — on the Docker volume,
// so it survives a container rebuild — and it is used instead.

type ComfyNode = { class_type: string; inputs: Record<string, unknown> }
type ComfyGraph = Record<string, ComfyNode>

const BUILTIN_GRAPH: ComfyGraph = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 768, height: 768, batch_size: 1 },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['8', 0] } },
}

function workflowPath(): string {
  return process.env['COMFYUI_WORKFLOW']
    ?? path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'workflows', 'txt2img.json')
}

/** The user's workflow if they've supplied one, else the built-in default. */
function baseGraph(): ComfyGraph {
  const p = workflowPath()
  try {
    if (!fs.existsSync(p)) return structuredClone(BUILTIN_GRAPH)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    const graph = parsed as ComfyGraph
    // The UI's "Save" export is nested under `nodes`/`links`; the API export is
    // flat. Catching it here turns a bare 400 from ComfyUI into a sentence that
    // says what to do.
    if ('nodes' in graph || 'links' in graph) {
      throw new Error('this looks like a UI workflow — re-export it with "Save (API Format)"')
    }
    console.log(`[image] using custom workflow ${p} (${Object.keys(graph).length} nodes)`)
    return graph
  } catch (err) {
    console.error(`[image] ignoring ${p}: ${err instanceof Error ? err.message : err}`)
    return structuredClone(BUILTIN_GRAPH)
  }
}

/** First node id whose class_type is in `classes`, or null. */
function findNode(graph: ComfyGraph, classes: string[]): string | null {
  for (const [id, node] of Object.entries(graph)) {
    if (node && typeof node === 'object' && classes.includes(node.class_type)) return id
  }
  return null
}

/**
 * Patch the prompt, size and seed into whatever graph we've got.
 *
 * Located by CLASS, not by hardcoded node id, so a workflow someone exported
 * themselves keeps working — their KSampler is rarely node "3". The two text
 * boxes are the interesting case: both are CLIPTextEncode and nothing in the
 * node says which is the negative one, so they're resolved through the
 * sampler's own `positive`/`negative` links, which is the only place that
 * distinction actually exists.
 */
function buildGraph(job: ImageJob): ComfyGraph {
  const graph = baseGraph()

  const samplerId = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  if (!samplerId) throw new Error('workflow has no KSampler node')
  const sampler = graph[samplerId]!

  // KSamplerAdvanced calls it noise_seed; SamplerCustom too. Set whichever
  // key the node actually declares rather than adding a bogus one.
  if ('seed' in sampler.inputs) sampler.inputs['seed'] = job.seed
  if ('noise_seed' in sampler.inputs) sampler.inputs['noise_seed'] = job.seed
  if (STEPS > 0 && 'steps' in sampler.inputs) sampler.inputs['steps'] = STEPS

  const link = (key: string): string | null => {
    const v = sampler.inputs[key]
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
  }
  const posId = link('positive')
  const negId = link('negative')
  if (posId && graph[posId] && 'text' in graph[posId]!.inputs) {
    graph[posId]!.inputs['text'] = job.prompt
  } else {
    throw new Error("workflow's positive prompt does not reach a text node")
  }
  if (negId && graph[negId] && 'text' in graph[negId]!.inputs) {
    graph[negId]!.inputs['text'] = job.negative
  }

  const latentId = findNode(graph, ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImageAdvanced'])
  if (latentId) {
    graph[latentId]!.inputs['width'] = job.width
    graph[latentId]!.inputs['height'] = job.height
    graph[latentId]!.inputs['batch_size'] = 1
  }

  if (MODEL) {
    const ckptId = findNode(graph, ['CheckpointLoaderSimple', 'CheckpointLoader'])
    if (ckptId) graph[ckptId]!.inputs['ckpt_name'] = MODEL
  }

  // Without a SaveImage the render happens and produces nothing we can fetch —
  // a PreviewImage lands in `temp` and is not listed in history outputs.
  if (!findNode(graph, ['SaveImage'])) {
    throw new Error('workflow has no SaveImage node — a preview-only graph produces nothing to download')
  }
  return graph
}

// ── Talking to ComfyUI ───────────────────────────────────────────────────────

async function comfyFetch(pathname: string, init?: RequestInit, timeoutMs = HTTP_MS): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(`${COMFY_URL}${pathname}`, { ...init, signal: ctrl.signal })
  } catch (err) {
    // A dead GPU box is the expected failure here, and "fetch failed" tells
    // nobody anything. Name the host that didn't answer.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /abort/i.test(msg)
        ? `${COMFY_URL} did not respond within ${(timeoutMs / 1000).toFixed(0)}s`
        : `cannot reach ComfyUI at ${COMFY_URL} (${msg})`,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function queuePrompt(graph: ComfyGraph): Promise<string> {
  const res = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // client_id is what ComfyUI keys its WebSocket channel on. We don't listen,
    // but sending one keeps the job attributable in ComfyUI's own UI.
    body: JSON.stringify({ prompt: graph, client_id: 'touchsphere' }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // ComfyUI reports a bad graph as a structured node_errors blob. The useful
    // part is buried; surface it rather than "HTTP 400".
    let detail = body.slice(0, 400)
    try {
      const j = JSON.parse(body) as { error?: { message?: string }; node_errors?: unknown }
      if (j.error?.message) detail = j.error.message
      if (j.node_errors && Object.keys(j.node_errors as object).length > 0) {
        detail += ` — ${JSON.stringify(j.node_errors).slice(0, 300)}`
      }
    } catch { /* non-JSON body */ }
    throw new Error(`ComfyUI rejected the workflow (${res.status}): ${detail}`)
  }
  const json = await res.json() as { prompt_id?: string }
  if (!json.prompt_id) throw new Error('ComfyUI accepted the workflow but returned no prompt_id')
  return json.prompt_id
}

interface OutputRef { filename: string; subfolder: string; type: string }

/** Poll /history until the render appears, or we run out of patience. */
async function awaitOutput(promptId: string, job: ImageJob): Promise<OutputRef> {
  const deadline = Date.now() + TIMEOUT_MS
  let announcedRunning = false

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))

    const res = await comfyFetch(`/history/${encodeURIComponent(promptId)}`)
    if (!res.ok) continue                   // transient; keep waiting
    const hist = await res.json() as Record<string, {
      status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
      outputs?: Record<string, { images?: OutputRef[] }>
    }>
    const entry = hist[promptId]
    if (!entry) {
      // Not in history yet = still queued or mid-render. The first checkpoint
      // load is 20-40s of this, which is why the phase text matters.
      if (!announcedRunning && Date.now() - job.startedAt > 5000) {
        announcedRunning = true
        push(job, 'loading the model')
      }
      continue
    }
    if (entry.status?.status_str === 'error') {
      const msg = JSON.stringify(entry.status.messages ?? []).slice(0, 400)
      throw new Error(`ComfyUI errored while rendering: ${msg}`)
    }
    for (const out of Object.values(entry.outputs ?? {})) {
      const img = out.images?.[0]
      // `temp` is a PreviewImage — it exists but gets swept, so it isn't a result.
      if (img?.filename && img.type !== 'temp') return img
    }
    if (entry.status?.completed) {
      throw new Error('ComfyUI finished but produced no saved image')
    }
  }
  throw new Error(`render did not finish within ${(TIMEOUT_MS / 1000).toFixed(0)}s`)
}

async function downloadOutput(ref: OutputRef): Promise<Buffer> {
  const qs = new URLSearchParams({
    filename:  ref.filename,
    subfolder: ref.subfolder ?? '',
    type:      ref.type ?? 'output',
  })
  const res = await comfyFetch(`/view?${qs.toString()}`, undefined, 60_000)
  if (!res.ok) throw new Error(`could not download the image (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** Is ComfyUI actually there? Used by the Debug tab's connection checks. */
export async function comfyStats(): Promise<{ ok: boolean; detail: string }> {
  if (!COMFY_URL) return { ok: false, detail: 'COMFYUI_URL not set — image generation is disabled' }
  try {
    const res = await comfyFetch('/system_stats', undefined, 8000)
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${COMFY_URL}` }
    const j = await res.json() as {
      devices?: { name?: string; vram_total?: number; vram_free?: number }[]
    }
    const dev = j.devices?.[0]
    const gb = (n?: number) => (n ? `${(n / 1024 ** 3).toFixed(1)} GB` : '?')
    return {
      ok: true,
      detail: dev
        ? `${dev.name ?? 'device'} — ${gb(dev.vram_free)} free of ${gb(dev.vram_total)}`
        : `reachable at ${COMFY_URL}`,
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export { wire as jobWire }
