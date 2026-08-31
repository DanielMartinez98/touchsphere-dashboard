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
import { advanceSeed, paramsFor, type ImageParams } from './image-params'

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

// Checkpoint. Env default ONLY — the live choice is whatever the user picked in
// the Draw panel (see selectedModel() below). Unset and unchosen means the
// workflow's own checkpoint, which is right when someone supplies their graph.
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

// How much of the source picture a REDRAW is allowed to throw away.
//
// denoise is the img2img dial: 1.0 ignores the source entirely (which is just
// txt2img with extra steps), and 0 returns it untouched. The model authors'
// own guidance is 0.5-0.6 for a small edit and 0.75-0.85 for a creative
// reinterpretation, which is the range the three strength chips sit in.
//
// The floor is not 0: below about 0.05 the sampler has nothing to do and the
// answer is a copy of the input, which reads as the feature being broken rather
// than as a very light touch.
const MIN_DENOISE = 0.05
const MAX_DENOISE = 1
// The megapixel budget in the Advanced panel is OPERATOR config, not something
// the LLM can reach, so it gets a higher ceiling than MAX_DIM — the same
// distinction COMFYUI_URL makes against isPublicHttpUrl(). 3 MP in portrait is
// already 1408×2112, which a 2B model like Anima renders happily on a 4090.
//
// Raised from 2048 when the panel's megapixel field became typeable. The
// number is chosen so this clamp is a GUARD rather than a second, hidden cap:
// the longest side any of the three orientations needs at the panel's 16 MP
// ceiling is 4899 (2:3 portrait), so nothing reachable from the panel ever
// meets it. At 2048 someone could set 12 MP and quietly be rendered 8, with
// nothing on screen saying the setting had been overruled — which is the one
// failure this whole file is trying not to have. Whether the card can hold a
// render this size is the operator's business, and a visible one: the panel's
// resolution readout is live, so what is about to be asked of the GPU is on
// screen before the button is tapped.
const MAX_USER_DIM = 6144

// ── Checkpoint selection ─────────────────────────────────────────────────────

/**
 * The checkpoint the user selected, if any.
 *
 * Read from disk per request rather than cached, the same as the voice-pitch
 * slider in routes/tts.ts and for the same reason: picking a model has to take
 * effect on the NEXT picture, not after a container restart.
 *
 * This is deliberately shared with the assistant. Someone who switches to an
 * anime checkpoint means "draw in this style" — having `generate_image` keep
 * using the realistic one because it came in by voice would be absurd. The user
 * picks the style; the assistant picks the subject.
 */
function savedModel(): string {
  try {
    const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
    const raw = fs.readFileSync(path.join(dir, 'image-model.json'), 'utf8')
    const v = (JSON.parse(raw) as { model?: string }).model
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''            // never chosen, or unreadable — fall back to the env
  }
}

// ── Quality ──────────────────────────────────────────────────────────────────
//
// Sampling steps, which is the one honest quality/time lever here. cfg and
// sampler are left to whatever the graph specifies, because those are per-model
// TUNING, not quality — Anima wants cfg 4 where SDXL wants 8, and overriding
// that from a "quality" button would quietly wreck one of them.
export const QUALITY_STEPS: Record<string, number> = {
  draft:    12,   // rough idea, fastest
  standard: 26,
  high:     44,   // diminishing returns past here on most models
}
export const DEFAULT_QUALITY = 'standard'

function qualityFile(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'image-quality.json')
}

/** The quality preset in effect. Own file, like voice-pitch.json — one concern each. */
export function selectedQuality(): string {
  try {
    const v = (JSON.parse(fs.readFileSync(qualityFile(), 'utf8')) as { quality?: string }).quality
    return typeof v === 'string' && v in QUALITY_STEPS ? v : DEFAULT_QUALITY
  } catch {
    return DEFAULT_QUALITY
  }
}

export function setSelectedQuality(quality: string): void {
  if (!(quality in QUALITY_STEPS)) throw new Error(`unknown quality: ${quality}`)
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = qualityFile()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ quality }, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    console.log(`[image] quality set to ${quality} (${QUALITY_STEPS[quality]} steps)`)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image] failed to save quality:', err)
  }
}

/** The checkpoint currently in effect, by precedence. '' = whatever the workflow says. */
export function selectedModel(): string {
  return savedModel() || MODEL
}

/** Persist the user's checkpoint choice. Written atomically, like every other store. */
export function setSelectedModel(model: string): void {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'image-model.json')
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ model }, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    console.log(`[image] checkpoint set to ${model || '(workflow default)'}`)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image] failed to save checkpoint choice:', err)
  }
}

/**
 * Which checkpoints the server actually has installed.
 *
 * Asked of ComfyUI rather than listed off disk: ComfyUI is the one that knows
 * where its models directory is, and it's the same list the graph is validated
 * against — so a name from here can never come back as "value not in list".
 */
export async function listModels(): Promise<string[]> {
  const res = await comfyFetch('/object_info/CheckpointLoaderSimple', undefined, 10_000)
  if (!res.ok) throw new Error(`HTTP ${res.status} listing checkpoints`)
  const j = await res.json() as Record<string, {
    input?: { required?: { ckpt_name?: unknown[] } }
  }>
  const raw = j['CheckpointLoaderSimple']?.input?.required?.ckpt_name?.[0]
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : []
}

/**
 * Which LoRAs the server has installed.
 *
 * Asked of ComfyUI for exactly the reason listModels() is: the turbo LoRA's
 * filename is a thing that lives on the GPU box's disk, and hardcoding a guess
 * at it here would fail as a bare "value not in list" naming a file nobody
 * chose. The picker offers what is actually there.
 */
export async function listLoras(): Promise<string[]> {
  const res = await comfyFetch('/object_info/LoraLoaderModelOnly', undefined, 10_000)
  if (!res.ok) throw new Error(`HTTP ${res.status} listing LoRAs`)
  const j = await res.json() as Record<string, {
    input?: { required?: { lora_name?: unknown[] } }
  }>
  const raw = j['LoraLoaderModelOnly']?.input?.required?.lora_name?.[0]
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : []
}

/**
 * The LoRA to insert when turbo is on and the user hasn't named one.
 *
 * Hints come from the style itself (Anima's are ['anima', 'turbo']), so the
 * guess is "the turbo LoRA that belongs to the model you picked" rather than
 * "whatever LoRA sorts first". Falls back to any turbo-ish name, then to
 * nothing at all — an unresolvable LoRA is skipped rather than guessed at,
 * because a wrong one silently changes the picture instead of failing.
 */
export function pickLora(installed: string[], hints: string[]): string {
  const low = installed.map(n => ({ n, l: n.toLowerCase() }))
  if (hints.length > 0) {
    const all = low.find(x => hints.every(h => x.l.includes(h)))
    if (all) return all.n
  }
  return low.find(x => x.l.includes('turbo'))?.n ?? ''
}

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
  /** Checkpoint that drew it — the answer to "which model made that good one?". */
  model?:  string
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

export type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'

export interface ImageJob {
  id:       string
  prompt:   string
  negative: string
  width:    number
  height:   number
  seed:     number
  /** Style this picture was drawn with — a checkpoint filename, or `wf:<id>`. */
  model:    string
  /** Sampling steps. 0 = leave whatever the graph specifies. */
  steps:    number
  /** Guidance scale. 0 = leave whatever the graph specifies. */
  cfg:      number
  /** Turbo mode: splice a model-only LoRA in ahead of the sampler. */
  turbo:    boolean
  /** LoRA to splice in ahead of the sampler. '' = none (turbo off, or none found). */
  lora:     string
  /** Strength of that LoRA. Only meaningful when `lora` is set. */
  loraStrength: number
  /**
   * REDRAW: the id of the stored picture this one starts from. '' = from
   * scratch. An id out of the gallery rather than a path or a URL, because it
   * is reachable by the assistant and the gallery is the only closed set of
   * images this app is willing to hand to the GPU box.
   */
  source:   string
  /** The source's file on the volume, resolved at queue time. '' when none. */
  sourceFile: string
  /** How much of the source to throw away, 0.05-1. Meaningless without a source. */
  denoise:  number
  status:   JobStatus
  /** Human phrase for the overlay — "waiting for the GPU", "drawing"… */
  phase:    string
  /** When it was asked for. Distinct from startedAt, which run() resets. */
  queuedAt: number
  /** Set once status is 'ready'. Serve via /api/image/file/<file>. */
  file?:    string
  error?:   string
  startedAt: number
  endedAt?:  number
}

const jobs = new Map<string, ImageJob>()
// Serialized, not parallel — see the header. Same shape as guide-generator's.
let queue: Promise<void> = Promise.resolve()

// How many renders may be waiting at once.
//
// The queue exists because asking for four pictures is one thought, and making
// someone stand at the kiosk for ninety seconds between them isn't a design,
// it's a missing feature. The cap exists because the other failure is a queue
// nobody can see the end of: eight high-quality renders is already ten minutes
// of GPU, which is longer than anyone stands in a hallway.
const MAX_QUEUED = 8

// Finished jobs are kept so a reopened overlay can still find out how one ended,
// but not forever — this is a Map in a process that runs for months, and the
// queue makes entries arrive in bursts. Well past what any UI asks for.
const MAX_TRACKED_JOBS = 40

// A rolling memory of how long renders actually take on THIS box, so the
// overlay can show a real estimate instead of a spinner with no end in sight.
// Seeded at zero: with no history the UI just shows elapsed time.
let lastDurationMs = 0

export function getJob(id: string): ImageJob | undefined {
  return jobs.get(id)
}

/**
 * Everything waiting or drawing, in the order it will be drawn.
 *
 * The Map's insertion order IS the queue order — the same order the promise
 * chain in startImage() was built in — so nothing here needs to sort.
 */
export function pendingJobs(): ImageJob[] {
  return [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running')
}

/** How many more renders may be queued right now. */
export function queueSpace(): number {
  return Math.max(0, MAX_QUEUED - pendingJobs().length)
}

export { MAX_QUEUED }

/** The job currently queued or drawing, if any. Drives the overlay on reconnect. */
export function activeJob(): ImageJob | undefined {
  return pendingJobs()[0]
}

/**
 * Drop a job that hasn't started yet.
 *
 * Only a QUEUED one. A running render is already on the GPU, and ComfyUI's
 * /interrupt would abandon a picture that is usually seconds from existing —
 * the thing worth being able to undo is the four you queued behind it, which is
 * exactly what a mis-tap on "Draw it" produces.
 *
 * The promise chain was built when the job was queued and can't be unlinked, so
 * this only marks it; run() checks the mark and returns without drawing.
 */
export function cancelJob(id: string): ImageJob | undefined {
  const job = jobs.get(id)
  if (!job || job.status !== 'queued') return undefined
  job.status = 'cancelled'
  job.endedAt = Date.now()
  console.log(`[image] cancelled ${job.id} "${job.prompt.slice(0, 60)}"`)
  push(job, 'cancelled')
  return job
}

/**
 * Forget old finished jobs.
 *
 * Never touches anything queued or running, and walks oldest-first because the
 * Map is in insertion order — so what goes is what nobody is still looking at.
 */
function pruneJobs(): void {
  if (jobs.size <= MAX_TRACKED_JOBS) return
  for (const [id, j] of jobs) {
    if (jobs.size <= MAX_TRACKED_JOBS) break
    if (j.status === 'queued' || j.status === 'running') continue
    jobs.delete(id)
  }
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
    model:    job.model,
    steps:    job.steps,
    cfg:      job.cfg,
    ...(job.lora ? { lora: job.lora, loraStrength: job.loraStrength } : {}),
    // Only on a redraw, so a client can tell the two kinds of job apart without
    // having to know that denoise 1 means "from scratch".
    ...(job.source ? {
      source:    job.source,
      sourceUrl: `/api/image/file/${job.sourceFile}`,
      denoise:   job.denoise,
    } : {}),
    ...(job.file  ? { file: job.file, url: `/api/image/file/${job.file}` } : {}),
    ...(job.error ? { error: job.error } : {}),
    // The client orders its own copy of the queue by this. Position can't be
    // sent instead: a frame is pushed when ONE job changes, and every other
    // job's position moves when the one in front of it finishes.
    queuedAt: job.queuedAt,
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
  /** Checkpoint override for this one picture. Omit to use the user's choice. */
  model?:    string
  /** Sampling steps override. Omit to use the selected quality preset. */
  steps?:    number
  /** Guidance override. Omit to use the style's saved cfg, then the graph's. */
  cfg?:      number
  /**
   * REDRAW: the id of a picture in the gallery to start from. The size comes
   * from that picture and `width`/`height` are ignored — an img2img latent is
   * the source's own shape, and quietly rendering a different one would be the
   * silent-override failure this file keeps trying not to have.
   */
  source?:   string
  /** How much of the source to throw away, 0.05-1. Ignored without a source. */
  denoise?:  number
}

// The middle chip in the Draw panel, and what the assistant gets when it asks
// for a redraw without saying how much to change. 0.65 keeps the composition
// and the palette while genuinely repainting the subject, which is what "change
// this picture" almost always means.
const DEFAULT_DENOISE = 0.65

const clampDenoise = (n: number): number =>
  Number.isFinite(n) ? Math.max(MIN_DENOISE, Math.min(MAX_DENOISE, n)) : DEFAULT_DENOISE

const clampDim = (n: number, fallback: number): number => {
  if (!Number.isFinite(n) || n <= 0) return fallback
  // ComfyUI's latent space is 8px-aligned; a stray 777 errors inside the graph.
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n / 8) * 8))
}

/**
 * Re-size a requested shape to a megapixel budget.
 *
 * The orientation buttons (and the assistant's `orientation` argument) decide
 * the ASPECT; this decides how big that shape is. Keeping the two separate is
 * what makes one megapixel setting apply to all three orientations instead of
 * needing nine fixed sizes — and it's how ComfyUI's own Anima template works,
 * where a megapixel widget and a "multiple of" widget feed the empty latent.
 *
 * `multipleOf` matters because models are trained at particular grid sizes:
 * SDXL is happy at any multiple of 8, but several newer models produce seams
 * unless each side lands on 64.
 */
function sizeForMegapixels(
  width: number, height: number, megapixels: number, multipleOf: number,
): { width: number; height: number } {
  // Snapped, not just floored, so a stored value that predates the 8px rule (or
  // one hand-edited into the JSON) can't produce a side ComfyUI rejects.
  const mult = multipleOf >= 8 ? Math.round(multipleOf / 8) * 8 : 8
  const aspect = width / height
  const target = megapixels * 1_000_000
  // Solve w*h = target with w/h = aspect, then snap both sides to the grid.
  const raw = { w: Math.sqrt(target * aspect), h: Math.sqrt(target / aspect) }
  const snap = (n: number) =>
    Math.max(MIN_DIM, Math.min(MAX_USER_DIM, Math.max(mult, Math.round(n / mult) * mult)))
  return { width: snap(raw.w), height: snap(raw.h) }
}

/**
 * The seed for a render nobody passed one for.
 *
 * 'increment' advances the stored value as a side effect, which is why it goes
 * through image-params.ts rather than being computed here: the store is the
 * only thing that knows what the last one was, and it's the only thing that
 * writes it.
 */
function nextSeed(style: string, p: ImageParams): number {
  if (p.seedMode === 'fixed') return p.seed
  if (p.seedMode === 'increment') {
    advanceSeed(style, p.seed)
    return p.seed
  }
  return crypto.randomInt(0, 2 ** 31)
}

/**
 * Queue a render and return immediately.
 *
 * Never throws and never waits: the caller is usually a chat tool with a person
 * waiting to be spoken to. Everything after this point is reported over SSE and
 * readable from GET /api/image/job/:id.
 *
 * Several may be in flight at once from here — they are drawn one at a time
 * (two SDXL renders on one card thrash VRAM rather than going twice as fast),
 * but asking for four in a row is one thought and shouldn't need four visits to
 * the kiosk. A full queue comes back as a job that is already `failed` rather
 * than as a throw, so both callers — the REST route and the chat tool — get one
 * shape back and neither has to grow an error path of its own.
 */
export function startImage(req: ImageRequest): ImageJob {
  // Resolved at QUEUE time, not render time: the picture should be drawn with
  // the style that was selected when it was asked for, even if the user
  // switches while it sits in the queue. Everything below hangs off it, because
  // the knobs are stored PER STYLE — see image-params.ts.
  const style = (req.model ?? '').trim() || selectedModel()
  const p = paramsFor(style)

  // A redraw starts from a picture already in the gallery. Resolved here rather
  // than in run() so a bad id is refused while someone is still looking at the
  // button they pressed, and so the job carries the file it will need.
  const sourceId = (req.source ?? '').trim()
  const source = sourceId ? listImages().find(e => e.id === sourceId) : undefined

  const asked = {
    width:  clampDim(req.width  ?? DEFAULT_W, DEFAULT_W),
    height: clampDim(req.height ?? DEFAULT_H, DEFAULT_H),
  }
  // The orientation gives the shape; the megapixel budget, when set, gives the
  // size. Unset (0) leaves the fixed orientation sizes exactly as they were.
  //
  // A redraw overrides both. VAEEncode produces a latent the shape of the image
  // it was given, so the source's own size IS the output size — asking for
  // anything else here would put a number on screen that the render then
  // ignores. Orientation and the megapixel budget simply don't apply, and the
  // Draw panel says so rather than showing controls that do nothing.
  const size = source
    ? { width: source.width, height: source.height }
    : p.megapixels > 0
      ? sizeForMegapixels(asked.width, asked.height, p.megapixels, p.multipleOf)
      : asked

  const job: ImageJob = {
    id:        crypto.randomBytes(16).toString('hex'),
    prompt:    req.prompt.slice(0, MAX_PROMPT),
    negative:  (req.negative ?? DEFAULT_NEGATIVE).slice(0, MAX_PROMPT),
    width:     size.width,
    height:    size.height,
    // Random by default: a fixed seed makes every image of "a cat" identical,
    // which reads as the feature being broken when someone asks twice. 'fixed'
    // and 'increment' exist for the opposite job — iterating on one picture by
    // changing a word and holding everything else still.
    seed:      Number.isFinite(req.seed) ? Number(req.seed) : nextSeed(style, p),
    model:     style,
    // Same reasoning as the style: resolved when the picture is ASKED for, so
    // changing quality mid-queue doesn't retroactively change what's waiting.
    // Precedence: this request → the style's own steps → the quality preset.
    // Precedence: this request → the style's own saved steps → the quality
    // preset. A distilled style skips the last of those and keeps the number in
    // its graph: 44 steps at cfg 1 is not a better picture, it is the same
    // picture four times slower.
    steps:     Number.isFinite(req.steps) && Number(req.steps) > 0
      ? Math.max(1, Math.min(150, Math.round(Number(req.steps))))
      : p.steps > 0 ? p.steps
      : styleIgnoresQuality(style) ? 0
      : (QUALITY_STEPS[selectedQuality()] ?? 0),
    // cfg has no quality-preset layer on purpose — it is per-model tuning, not
    // a speed/quality dial. 0 all the way down means "whatever the graph says".
    cfg:       Number.isFinite(req.cfg) && Number(req.cfg) > 0 ? Number(req.cfg) : p.cfg,
    turbo:     p.turbo,
    source:     source?.id ?? '',
    sourceFile: source?.file ?? '',
    // Clamped here so the number the UI shows and the number the sampler gets
    // are the same one. Without a source it stays 1 — a full render — which is
    // also exactly what the sampler wants for txt2img.
    denoise:    source
      ? clampDenoise(Number.isFinite(req.denoise) ? Number(req.denoise) : DEFAULT_DENOISE)
      : 1,
    // May be '' here and filled in by run(), which can ask ComfyUI what LoRAs
    // exist; startImage must stay synchronous for the chat tool that calls it.
    lora:      p.turbo ? p.lora : '',
    loraStrength: p.loraStrength,
    status:    'queued',
    phase:     'waiting for the GPU',
    queuedAt:  Date.now(),
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)

  // Asked to redraw something that isn't there any more — pruned past the cap,
  // deleted, or a model that invented an id. Refused rather than quietly drawn
  // from scratch: "redraw this" and "draw this" produce very different pictures
  // and substituting one for the other silently is the failure this file's
  // header is about.
  if (sourceId && !source) {
    job.status = 'failed'
    job.error = 'the picture to redraw is no longer in the gallery'
    job.endedAt = Date.now()
    console.warn(`[image] refused ${job.id}: no stored image ${sourceId}`)
    push(job, 'failed')
    return job
  }

  // Refused, not enqueued — but still a real job with a real id, so whoever
  // asked gets the reason on the same channel every other outcome arrives on.
  const waiting = pendingJobs().length - 1
  if (waiting >= MAX_QUEUED) {
    job.status = 'failed'
    job.error = `the render queue is full (${MAX_QUEUED} waiting) — let one finish first`
    job.endedAt = Date.now()
    console.warn(`[image] refused ${job.id}: queue full`)
    push(job, 'failed')
    return job
  }

  pruneJobs()
  console.log(
    `[image] queued ${job.id} "${job.prompt.slice(0, 60)}" ${job.width}×${job.height} ` +
    `seed=${job.seed} steps=${job.steps || 'graph'} cfg=${job.cfg || 'graph'}` +
    `${job.turbo ? ' turbo' : ''}${job.source ? ` redraw of ${job.source} denoise=${job.denoise}` : ''}` +
    `${waiting > 0 ? ` (${waiting} ahead of it)` : ''}`,
  )
  push(job, waiting > 0 ? `waiting behind ${waiting} more` : 'waiting for the GPU')

  queue = queue.then(() => run(job)).catch(err => {
    // run() handles its own failures; this only catches a bug in run() itself,
    // and must not poison the queue for every later job.
    console.error('[image] job runner crashed:', err)
  })
  return job
}

async function run(job: ImageJob): Promise<void> {
  // Dropped while it waited. cancelJob() can only mark the job — its link in
  // the promise chain was forged when it was queued — so the chain still calls
  // us and this is where the mark is honoured.
  if (job.status === 'cancelled') return
  if (!COMFY_URL) {
    return fail(job, 'COMFYUI_URL is not set — no image server is configured')
  }
  job.status = 'running'
  job.startedAt = Date.now()   // reset: queue wait isn't render time
  push(job, 'drawing')

  try {
    // Turbo with no LoRA named: ask ComfyUI what it has and pick the one that
    // belongs to this style. Done here rather than in startImage() because it
    // needs the network and startImage() is called from a chat tool with a
    // person waiting to be spoken to. A miss leaves `lora` empty and the render
    // proceeds without it — a wrong LoRA silently changes the picture, which is
    // worse than turbo quietly not engaging.
    if (job.turbo && !job.lora) {
      try {
        job.lora = pickLora(await listLoras(), turboHints(job.model))
        if (!job.lora) console.warn(`[image] ${job.id}: turbo is on but no LoRA matched ${job.model}`)
      } catch (err) {
        console.warn('[image] could not list LoRAs:', err instanceof Error ? err.message : err)
      }
    }

    // A redraw needs its source on the GPU box before the graph can name it.
    // ComfyUI's LoadImage reads from its own input/ directory, and that machine
    // is on the other end of a tailnet with no shared filesystem — so the bytes
    // go up over /upload/image and come back as a filename to put in the node.
    let sourceName = ''
    if (job.source) {
      push(job, 'sending the picture over')
      sourceName = await uploadSource(job)
    }

    const graph = buildGraph(job, sourceName)
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
      ...(job.model ? { model: job.model } : {}),
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

/**
 * Anima — a family of WORKFLOW styles, not checkpoints.
 *
 * Anima doesn't ship as one .safetensors the way SDXL does; it's three files
 * (a 2B diffusion model, a Qwen-3 0.6B text encoder, a VAE) loaded by three
 * separate nodes. There is no ckpt_name to swap, so it cannot be offered in the
 * same list as the checkpoints without the "style" idea covering both.
 *
 * Transcribed from ComfyUI's own bundled template (image_anima_base_v1.json) —
 * the sampler settings are the model author's, not guesses. The template wraps
 * this in a frontend "subgraph" and offers an optional turbo LoRA behind switch
 * nodes; both are flattened away here, because /prompt takes a flat API graph.
 *
 * The three published variants share this graph exactly and differ only in the
 * unet filename and the numbers their author recommends, so they are one
 * factory rather than three transcriptions:
 *
 *   base      v1.0  the pretrained model — most diversity and style adherence
 *   aesthetic v1.1  fine-tuned on high-quality images only; the best default
 *   turbo     v1.1  distilled: ~8-12 steps at cfg 1, no negative prompt
 *
 * euler/simple is kept for all three rather than the author's newer `er_sde`
 * suggestion, deliberately: a sampler_name ComfyUI doesn't have fails as a bare
 * "value not in list" naming a sampler the user never chose, and er_sde is
 * recent enough that the GPU box may predate it. Anyone who wants it can put it
 * in a workflow of their own on the volume.
 */
function animaGraph(unet: string, steps: number, cfg: number): ComfyGraph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps, cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['8', 0] } },
  }
}

/** The text encoder and VAE every Anima variant shares. */
const ANIMA_SHARED = [
  'text_encoders/qwen_3_06b_base.safetensors',
  'vae/qwen_image_vae.safetensors',
]

/**
 * Styles that are a whole graph rather than a checkpoint name.
 *
 * Keyed by the id used on the wire as `wf:<id>`. A user-supplied API-format
 * graph at $CACHE_DIR/workflows/<name>.json joins this list at runtime, so
 * "bring your own workflow" and "pick Anima" are the same mechanism.
 */
const BUILTIN_WORKFLOWS: Record<string, {
  label: string
  graph: ComfyGraph
  needs: string[]
  /** Substrings that identify this style's turbo LoRA among the installed ones. */
  turboHints?: string[]
  /**
   * True for a style whose step count is a property of the MODEL rather than a
   * quality dial — a distilled one, trained to land in ~10 steps and gaining
   * nothing from 44. The draft/standard/high preset is skipped for these and
   * the graph's own number is used, which is what stops "High" reading as four
   * times the wait for an identical picture. The Draw panel greys the Quality
   * row and says so, the same way it already does when Advanced's Steps
   * overrides it — a preset that isn't in effect must never look like it is.
   */
  ignoresQuality?: boolean
}> = {
  'anima-aesthetic-v1-1': {
    label: 'Anima Aesthetic v1.1',
    graph: animaGraph('anima-aesthetic-v1.1.safetensors', 30, 4),
    turboHints: ['anima', 'turbo'],
    needs: ['diffusion_models/anima-aesthetic-v1.1.safetensors', ...ANIMA_SHARED],
  },
  'anima-turbo-v1-1': {
    label: 'Anima Turbo v1.1',
    // No turboHints: this IS the distilled model, and stacking a turbo LoRA on
    // top of a turbo checkpoint is how a picture comes out flat and over-baked.
    // Leaving them off is also what makes the Advanced panel hide the toggle.
    graph: animaGraph('anima-turbo-v1.1.safetensors', 10, 1),
    ignoresQuality: true,
    needs: ['diffusion_models/anima-turbo-v1.1.safetensors', ...ANIMA_SHARED],
  },
  'anima-base-v1': {
    label: 'Anima Base v1',
    graph: animaGraph('anima-base-v1.0.safetensors', 30, 4),
    // The bundled template offers this LoRA behind a switch node; flattening
    // the switch away is what the Advanced panel's Turbo toggle puts back.
    // Matched rather than hardcoded — the filename is a thing on the GPU box's
    // disk, and listLoras() is the only honest source for it.
    turboHints: ['anima', 'turbo'],
    // Surfaced in the picker when they're missing, because the alternative is a
    // render that fails with a bare "value not in list" naming a file the user
    // has never heard of.
    needs: ['diffusion_models/anima-base-v1.0.safetensors', ...ANIMA_SHARED],
  },
}

export const WORKFLOW_PREFIX = 'wf:'

/** Hints for auto-picking a style's turbo LoRA. Empty for anything unknown. */
function turboHints(style: string): string[] {
  if (!style.startsWith(WORKFLOW_PREFIX)) return []
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.turboHints ?? []
}

/** True for a distilled style, whose step count is the model's, not a preference. */
export function styleIgnoresQuality(style: string): boolean {
  if (!style.startsWith(WORKFLOW_PREFIX)) return false
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.ignoresQuality === true
}

/** Workflow styles available: the built-ins plus any JSON on the cache volume. */
export function listWorkflowStyles(): { id: string; label: string }[] {
  const out = Object.entries(BUILTIN_WORKFLOWS).map(([id, w]) => ({ id: WORKFLOW_PREFIX + id, label: w.label }))
  try {
    const dir = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'workflows')
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const id = f.replace(/\.json$/, '')
      // txt2img.json is the OVERRIDE for the default checkpoint graph, not a
      // style of its own — listing it would offer the same thing twice.
      if (id === 'txt2img' || id in BUILTIN_WORKFLOWS) continue
      out.push({ id: WORKFLOW_PREFIX + id, label: id.replace(/[_-]+/g, ' ') })
    }
  } catch { /* no workflows directory */ }
  return out
}

/** The graph for a `wf:` style, or null if there isn't one by that name. */
function workflowGraph(id: string): ComfyGraph | null {
  const builtin = BUILTIN_WORKFLOWS[id]
  if (builtin) return structuredClone(builtin.graph)
  try {
    const p = path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'workflows', `${id}.json`)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ComfyGraph
    if ('nodes' in parsed || 'links' in parsed) {
      throw new Error('this looks like a UI workflow — re-export it with "Save (API Format)"')
    }
    return parsed
  } catch (err) {
    console.error(`[image] workflow "${id}" unusable: ${err instanceof Error ? err.message : err}`)
    return null
  }
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
function buildGraph(job: ImageJob, sourceName = ''): ComfyGraph {
  // A `wf:` style brings its own whole graph (Anima, or one the user dropped in);
  // anything else is a checkpoint name patched into the default txt2img graph.
  const isWorkflow = job.model.startsWith(WORKFLOW_PREFIX)
  const graph = isWorkflow
    ? workflowGraph(job.model.slice(WORKFLOW_PREFIX.length))
    : baseGraph()
  if (!graph) throw new Error(`the "${job.model}" style is not installed on this server`)

  const samplerId = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  if (!samplerId) throw new Error('workflow has no KSampler node')
  const sampler = graph[samplerId]!

  // KSamplerAdvanced calls it noise_seed; SamplerCustom too. Set whichever
  // key the node actually declares rather than adding a bogus one.
  if ('seed' in sampler.inputs) sampler.inputs['seed'] = job.seed
  if ('noise_seed' in sampler.inputs) sampler.inputs['noise_seed'] = job.seed
  // Job steps win; COMFYUI_STEPS is the fallback for a server with no UI choice.
  const steps = job.steps > 0 ? job.steps : STEPS
  if (steps > 0 && 'steps' in sampler.inputs) sampler.inputs['steps'] = steps
  // cfg is only ever set when someone explicitly asked for one. Left alone the
  // graph keeps its own value, which for a style like Anima is the model
  // author's number and not something to overwrite with a house default.
  if (job.cfg > 0 && 'cfg' in sampler.inputs) sampler.inputs['cfg'] = job.cfg

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

  // ── Redraw: start from a picture instead of from noise ──
  //
  // This is plain img2img, and it works on every model this app can select
  // rather than being an Anima feature: the source is encoded to a latent, the
  // sampler starts from that instead of from an empty one, and `denoise` says
  // how much of it to throw away. ComfyUI's own Anima template ships the same
  // thing behind a "Load Image" switch node — the same kind of switch the turbo
  // LoRA was behind, and flattened away for the same reason.
  //
  // Spliced by REWIRING, exactly like the turbo LoRA: whatever fed the sampler's
  // `latent_image` is replaced, and the empty latent above is left in place but
  // unreferenced, so ComfyUI never executes it. The VAE is found by following
  // the VAEDecode's own `vae` link rather than by hunting for a loader class,
  // because that link is the only place in a graph that says which VAE this
  // pipeline actually uses — the same reasoning as resolving the two
  // CLIPTextEncode boxes through the sampler's positive/negative links.
  if (sourceName) {
    const decodeId = findNode(graph, ['VAEDecode', 'VAEDecodeTiled'])
    const vae = decodeId ? graph[decodeId]!.inputs['vae'] : undefined
    if (!Array.isArray(vae)) {
      throw new Error("workflow's VAE could not be found, so it cannot redraw an existing picture")
    }
    // Names, not numbers: node ids are object keys and a numeric one could
    // collide with a node in someone's own workflow.
    const loadId = 'touchsphere_source_image'
    const encId  = 'touchsphere_source_latent'
    // `image` is LoadImage's only real input — the `upload` key ComfyUI's own
    // exports carry is a frontend widget hint, not something /prompt reads.
    graph[loadId] = { class_type: 'LoadImage', inputs: { image: sourceName } }
    graph[encId]  = { class_type: 'VAEEncode', inputs: { pixels: [loadId, 0], vae } }
    sampler.inputs['latent_image'] = [encId, 0]

    // KSamplerAdvanced has no denoise input — it expresses the same idea as
    // start_at_step over a step count, which is a different conversation. Say so
    // rather than letting the render come back as an untouched copy.
    if ('denoise' in sampler.inputs) {
      sampler.inputs['denoise'] = job.denoise
    } else {
      throw new Error(
        `this workflow's ${sampler.class_type} has no denoise setting, so it cannot redraw a picture`,
      )
    }
  }

  // Only a checkpoint style names a ckpt_name; a workflow style already has its
  // loaders wired and must not have a .safetensors filename forced into them.
  if (job.model && !isWorkflow) {
    const ckptId = findNode(graph, ['CheckpointLoaderSimple', 'CheckpointLoader'])
    if (ckptId) graph[ckptId]!.inputs['ckpt_name'] = job.model
  }

  // ── Turbo: splice a model-only LoRA in front of the sampler ──
  //
  // ComfyUI's Anima template ships this as a switch node the user flips in the
  // graph; flattening the graph for /prompt threw the switch away, so the
  // toggle rebuilds it. Inserted by REWIRING rather than by editing a loader:
  // whatever currently feeds the sampler's `model` input becomes the LoRA's
  // input, and the LoRA becomes the sampler's. That works the same whether the
  // model comes from a UNETLoader (Anima), a CheckpointLoaderSimple (SDXL) or
  // an existing LoRA stack in someone's own workflow.
  //
  // LoraLoaderModelOnly, not LoraLoader, because a text encoder that isn't CLIP
  // — Anima's is Qwen-3 — has no `clip` output to hand it, and the turbo LoRAs
  // these models ship are UNet-side anyway.
  if (job.lora) {
    const src = sampler.inputs['model']
    if (Array.isArray(src)) {
      // A name, not a number: node ids are object keys and a numeric one could
      // collide with a node the user's own workflow already has.
      const loraId = 'touchsphere_turbo_lora'
      graph[loraId] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: job.lora, strength_model: job.loraStrength, model: src },
      }
      sampler.inputs['model'] = [loraId, 0]
    } else {
      console.warn(`[image] ${job.id}: sampler model input isn't a link, skipping the turbo LoRA`)
    }
  }

  // Without a SaveImage the render happens and produces nothing we can fetch —
  // a PreviewImage lands in `temp` and is not listed in history outputs.
  if (!findNode(graph, ['SaveImage'])) {
    throw new Error('workflow has no SaveImage node — a preview-only graph produces nothing to download')
  }
  return graph
}

export interface StyleDefaults {
  /** What the graph's own sampler says, so the UI's "Auto" can name a number. */
  steps:     number
  cfg:       number
  width:     number
  height:    number
  sampler:   string
  scheduler: string
  /** False for a graph whose sampler has no cfg input at all (SamplerCustom). */
  hasCfg:    boolean
  /** Whether a turbo LoRA is even a sensible offer for this style. */
  turboKnown: boolean
  /** False for a distilled style, whose steps come from the model, not the preset. */
  qualityApplies: boolean
}

/**
 * What a style's own graph specifies, before any of the user's knobs.
 *
 * This is what makes the Advanced panel honest: a control whose "off" position
 * says "Auto" is useless if you can't see what auto IS — and auto is cfg 8 for
 * SDXL and cfg 4 for Anima. Read straight from the graph rather than tabulated
 * here, so a workflow the user dropped on the volume describes itself too.
 */
export function styleDefaults(style: string): StyleDefaults {
  const fallback: StyleDefaults = {
    steps: 20, cfg: 8, width: DEFAULT_W, height: DEFAULT_H,
    sampler: 'euler', scheduler: 'normal', hasCfg: true,
    turboKnown: turboHints(style).length > 0,
    qualityApplies: !styleIgnoresQuality(style),
  }
  const graph = style.startsWith(WORKFLOW_PREFIX)
    ? workflowGraph(style.slice(WORKFLOW_PREFIX.length))
    : baseGraph()
  if (!graph) return fallback

  const samplerId = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  const inputs = samplerId ? graph[samplerId]!.inputs : {}
  const latentId = findNode(graph, ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImageAdvanced'])
  const latent = latentId ? graph[latentId]!.inputs : {}
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

  return {
    steps:     n(inputs['steps'], fallback.steps),
    cfg:       n(inputs['cfg'], fallback.cfg),
    width:     n(latent['width'], fallback.width),
    height:    n(latent['height'], fallback.height),
    sampler:   s(inputs['sampler_name'], fallback.sampler),
    scheduler: s(inputs['scheduler'], fallback.scheduler),
    hasCfg:    'cfg' in inputs,
    turboKnown: fallback.turboKnown,
    qualityApplies: fallback.qualityApplies,
  }
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

/**
 * Put a stored picture into ComfyUI's input directory and return the name a
 * LoadImage node can use.
 *
 * Named after the image id with overwrite on, so redrawing the same picture
 * five times leaves one file on the GPU box rather than five. There is no
 * cleanup pass and deliberately so: these are the same PNGs the gallery already
 * caps at MAX_STORED, ComfyUI's input directory is the operator's disk, and a
 * dashboard that deletes files out of someone else's ComfyUI install is a worse
 * idea than a few megabytes.
 */
async function uploadSource(job: ImageJob): Promise<string> {
  const full = path.join(imagesDir(), job.sourceFile)
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(full)
  } catch {
    throw new Error('the picture to redraw is missing from this server')
  }

  const name = `touchsphere-src-${job.source}.png`
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name)
  form.append('type', 'input')
  form.append('overwrite', 'true')

  // No Content-Type header: fetch sets it with the multipart boundary, and
  // setting it by hand is the classic way to get a 400 with an empty body.
  const res = await comfyFetch('/upload/image', { method: 'POST', body: form }, 60_000)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ComfyUI would not accept the source picture (${res.status}): ${body.slice(0, 200)}`)
  }
  const j = await res.json().catch(() => ({})) as { name?: string; subfolder?: string }
  // ComfyUI may rename on collision, so its answer wins over the name we sent.
  const saved = j.name ?? name
  const ref = j.subfolder ? `${j.subfolder}/${saved}` : saved
  console.log(`[image] ${job.id} uploaded source as ${ref} (${(bytes.length / 1024).toFixed(0)} KB)`)
  return ref
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
