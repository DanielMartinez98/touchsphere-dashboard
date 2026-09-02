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
import { estimateRender, humanMs, recordRender } from './image-timing'

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
 * The values one loader node will accept for one of its inputs.
 *
 * Every "what is installed?" question this file asks is the same question:
 * ComfyUI is the one that knows where its models directory is, and the list it
 * reports for a node's input IS the list that node validates against — so a
 * name taken from here can never come back as "value not in list".
 */
async function loaderOptions(nodeClass: string, input: string): Promise<string[]> {
  const res = await comfyFetch(`/object_info/${nodeClass}`, undefined, 10_000)
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${input}`)
  const j = await res.json() as Record<string, {
    input?: { required?: Record<string, unknown[]> }
  }>
  const raw = j[nodeClass]?.input?.required?.[input]?.[0]
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : []
}

/** Which checkpoints the server actually has installed. */
export async function listModels(): Promise<string[]> {
  return loaderOptions('CheckpointLoaderSimple', 'ckpt_name')
}

/**
 * Which LoRAs the server has installed.
 *
 * The turbo LoRA's filename is a thing that lives on the GPU box's disk, and
 * hardcoding a guess at it here would fail as a bare "value not in list" naming
 * a file nobody chose. The picker offers what is actually there — and when this
 * comes back empty, as it does on a box where no LoRA was ever downloaded, the
 * Turbo toggle has nothing to turn on and says so instead of pretending.
 */
export async function listLoras(): Promise<string[]> {
  return loaderOptions('LoraLoaderModelOnly', 'lora_name')
}

// Which loader input answers for each folder named in a style's `needs`.
// `needs` is written as `<folder>/<filename>` because that is where the user has
// to physically put the file; this maps that back to the node that reports it.
const NEEDS_LOADER: Record<string, [node: string, input: string]> = {
  diffusion_models: ['UNETLoader', 'unet_name'],
  text_encoders:    ['CLIPLoader', 'clip_name'],
  vae:              ['VAELoader', 'vae_name'],
  checkpoints:      ['CheckpointLoaderSimple', 'ckpt_name'],
  loras:            ['LoraLoaderModelOnly', 'lora_name'],
}

/**
 * Which of a style's required files are NOT on the image server.
 *
 * This is the half of `needs` that was missing. A workflow style names three
 * files it cannot run without, and offering it in the picker regardless meant
 * choosing it looked fine, queued fine, and then failed twenty seconds later
 * with ComfyUI's own "value not in list" naming a file the user had never heard
 * of. Checking up front turns that into a greyed row that says which file to go
 * and download.
 *
 * One request per distinct folder, and the caller is expected to do this once
 * for the whole list rather than per style.
 */
export async function missingFiles(needs: string[]): Promise<string[]> {
  const wanted = new Map<string, string[]>()      // folder → filenames
  for (const n of needs) {
    const slash = n.indexOf('/')
    if (slash < 0) continue
    const folder = n.slice(0, slash)
    if (!(folder in NEEDS_LOADER)) continue
    wanted.set(folder, [...(wanted.get(folder) ?? []), n.slice(slash + 1)])
  }

  const missing: string[] = []
  for (const [folder, files] of wanted) {
    const [node, input] = NEEDS_LOADER[folder]!
    let installed: string[]
    try {
      installed = await loaderOptions(node, input)
    } catch {
      // A box we can't reach is a different problem, already reported by
      // /api/image/check. Don't paint every style as "missing files" over it.
      continue
    }
    // ComfyUI reports names relative to the folder, which may include a
    // subdirectory the user made — match on the tail so `anima/x.safetensors`
    // still satisfies a need for `x.safetensors`.
    const have = new Set(installed.map(f => f.split(/[\\/]/).pop()!))
    for (const f of files) if (!have.has(f)) missing.push(`${folder}/${f}`)
  }
  return missing
}

/** What a style needs on disk. Empty for a checkpoint or an unknown workflow. */
export function styleNeeds(style: string): string[] {
  if (!style.startsWith(WORKFLOW_PREFIX)) return []
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.needs ?? []
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

/**
 * How a picture was actually drawn.
 *
 * Recorded rather than recomputed, and recorded from the graph that was SENT
 * rather than from the job's own fields, because most of the job's numbers are
 * zeros meaning "leave it alone": steps 0 falls through to the quality preset,
 * cfg 0 to whatever the style's graph specifies, and the sampler and scheduler
 * are never in the job at all. A gallery caption built from those would say
 * "cfg 0, sampler unknown" for every picture Anima ever drew.
 *
 * It is also a snapshot on purpose. The style's saved knobs are edited between
 * renders and a `wf:` style's graph can be replaced on the volume, so asking
 * the live config what drew a three-week-old picture answers for today's
 * settings — which is precisely the question this is meant to settle.
 */
export interface ImageSettings {
  /** Style id as it was chosen: a checkpoint filename, or `wf:<id>`. */
  style:      string
  /** Its label at the time — a `wf:` id is not a name anyone recognises. */
  styleLabel: string
  /** Sampling steps the sampler node actually received. */
  steps:      number
  /** Guidance. 0 for a sampler that has no cfg input at all (SamplerCustom). */
  cfg:        number
  sampler:    string
  scheduler:  string
  /** What it was told to avoid — a style's own, or the house default. */
  negative:   string
  /** Turbo LoRA spliced in ahead of the sampler, if any. */
  lora?:         string
  loraStrength?: number
  /** Redraw: the gallery id it started from, and how much of it was thrown away. */
  source?:  string
  denoise?: number
  /** Wall-clock render time, so "which settings" can be weighed against "how long". */
  tookMs:   number
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
  /** Everything else about how it was drawn. Absent on anything drawn before this existed. */
  settings?: ImageSettings
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
  /** Short label for a chip or a narrow row — "drawing", "loading the model". */
  phase:    string
  /**
   * The same status in full sentences: what is happening, to what, with which
   * style and settings, and how long it should take.
   *
   * A second field rather than a longer `phase` because the two are read in
   * different places. `phase` goes in the queue strip's rows and the collapsed
   * corner, which are a hundred pixels wide; this goes in the full-screen frame,
   * which is otherwise an empty rectangle for half a minute and has room for the
   * whole story. Neither one can do both jobs.
   */
  detail:   string
  /**
   * How long this render should take, from the history of ones like it.
   *
   * Per JOB, resolved when the job is queued and again when it starts, rather
   * than one number for the whole box — see image-timing.ts for why the old
   * single `lastDurationMs` was wrong for every render that wasn't a repeat of
   * the previous one.
   */
  etaMs:     number
  /** Where that number came from, in words. '' when there is no history to use. */
  etaBasis:  string
  /**
   * Whether this style was already on the GPU when the render began.
   *
   * Best-effort: ComfyUI is a separate process and can evict a checkpoint under
   * VRAM pressure without telling us. Assumed false after a restart of this
   * server, which errs towards over-estimating — the safe direction.
   */
  warm:      boolean
  /**
   * Steps the sampler will actually run, including the graph's own number when
   * the job doesn't override it. `steps` above is the OVERRIDE and is usually 0.
   */
  plannedSteps: number
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

// The style the GPU last drew with, which is the only signal this process has
// for whether the next render pays the checkpoint load. In memory rather than on
// disk on purpose: ComfyUI is a separate process on another machine, so what it
// had loaded before this server restarted is genuinely unknown, and guessing
// 'cold' over-estimates rather than under-estimates. See image-timing.ts.
let lastStyleDrawn = ''

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
  push(job, 'cancelled',
    'Taken out of the queue before the GPU started it, so no time was spent on it. ' +
    'Asking again puts it back at the end of the line.')
  refreshQueue()
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

// ── Saying what is going on ──────────────────────────────────────────────────
//
// The frame goes up ten to thirty seconds before the picture exists, and for
// most of that time it is an empty rectangle with one word in it. "Drawing" is
// true and tells nobody anything: it can't say which of four styles is being
// used, whether the 40s wait is the checkpoint loading or the render itself,
// whether this job is even at the front of the queue, or when it will be done.
// Every one of those is knowable here, and every one of them was being thrown
// away. So each transition below writes a short `phase` for the narrow places
// and a full `detail` for the frame.

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Steps the sampler really runs.
 *
 * A redraw starts partway through the schedule, so 30 steps at 0.65 denoise is
 * about 20 — which is both what the estimate has to be built on and what the
 * status line should say, since "30 steps" over a render that takes two thirds
 * of 30 steps' time is the same kind of quiet lie as the old global ETA.
 */
function effectiveSteps(job: ImageJob): number {
  const base = job.plannedSteps > 0 ? job.plannedSteps : 20
  return job.source ? Math.max(1, Math.round(base * job.denoise)) : base
}

/** "Anima Aesthetic v1.1, 30 steps at 1024×1536" — the job in one clause. */
function jobShape(job: ImageJob): string {
  const bits = [
    styleLabel(job.model) || 'the default style',
    `${effectiveSteps(job)} steps`,
    `${job.width}×${job.height}`,
  ]
  if (job.cfg > 0) bits.push(`cfg ${job.cfg}`)
  if (job.lora) bits.push(`the ${job.lora} LoRA at ${job.loraStrength}`)
  return bits.join(', ')
}

/** The estimate as a sentence, or an honest admission that there isn't one. */
function etaSentence(job: ImageJob): string {
  if (job.etaMs <= 0) {
    return 'Nothing like this has been drawn on this box yet, so there is no estimate — ' +
      'this render is the one that sets the baseline.'
  }
  return `Renders like this take about ${humanMs(job.etaMs)} — ${job.etaBasis}.`
}

/** Re-read the estimate for a job whose warmth or step count has just settled. */
function refreshEstimate(job: ImageJob): void {
  const est = estimateRender(
    job.model, effectiveSteps(job), job.width * job.height, job.warm,
  )
  job.etaMs = est.ms
  job.etaBasis = est.basis
}

/** How long before the GPU even reaches this job. 0 for the one already on it. */
function waitAheadMs(job: ImageJob): number {
  const pending = pendingJobs()
  const idx = pending.findIndex(j => j.id === job.id)
  if (idx <= 0) return 0
  return pending.slice(0, idx).reduce((total, ahead) => {
    // A job already drawing has burned some of its own estimate; count what is
    // left of it rather than the whole thing, or the number a queued picture
    // shows would stall instead of counting down.
    const spent = ahead.status === 'running' ? Date.now() - ahead.startedAt : 0
    return total + Math.max(0, ahead.etaMs - spent)
  }, 0)
}

/** The full status line for a job that is waiting its turn. */
function queuedDetail(job: ImageJob): { phase: string; detail: string } {
  const pending = pendingJobs()
  const idx = pending.findIndex(j => j.id === job.id)
  const ahead = Math.max(0, idx)
  if (ahead === 0) {
    return {
      phase: 'waiting for the GPU',
      detail: `Next in line. Drawing with ${jobShape(job)}. ${etaSentence(job)}`,
    }
  }
  const wait = waitAheadMs(job)
  return {
    phase: `${ordinal(idx + 1)} in the queue`,
    detail:
      `${count(ahead, 'picture')} to finish first${wait > 0 ? `, about ${humanMs(wait)} before this one starts` : ''}. ` +
      `Then ${jobShape(job)}. ${etaSentence(job)} ` +
      'Pictures are drawn one at a time — two at once on one card is slower, not faster.',
  }
}

/** What a job looks like on the wire — jobs and stored images share a shape. */
function wire(job: ImageJob) {
  return {
    id:       job.id,
    prompt:   job.prompt,
    status:   job.status,
    phase:    job.phase,
    detail:   job.detail,
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
    // THIS job's estimate, from the history of renders that resemble it —
    // not the duration of whatever the box happened to draw last. Still 0 when
    // there is no usable history, and the client draws no bar for a 0.
    etaMs:     job.etaMs,
    etaBasis:  job.etaBasis,
    // How long before the GPU reaches this one. Recomputed per frame rather than
    // stored, because it changes when any job AHEAD of this one moves.
    waitMs:    waitAheadMs(job),
    /** Steps the sampler runs, redraw discount included. */
    plannedSteps: effectiveSteps(job),
    warm:      job.warm,
  }
}

/**
 * Broadcast a change, optionally moving the job to a new phase.
 *
 * Both strings move together on purpose: the short label and the sentence are
 * two renderings of one fact, and letting a caller update one without the other
 * is how a frame ends up saying "saving" over an explanation of the queue.
 */
function push(job: ImageJob, phase?: string, detail?: string): void {
  if (phase) job.phase = phase
  if (detail !== undefined) job.detail = detail
  broadcast('image', wire(job))
}

/** Move a queued job to whatever its position in the line now says. */
function pushQueued(job: ImageJob): void {
  const { phase, detail } = queuedDetail(job)
  push(job, phase, detail)
}

/**
 * Re-tell every waiting job where it now stands.
 *
 * A frame is normally pushed when ONE job changes — which was fine while the
 * status was the word "drawing", and isn't now that it says "3rd in the queue,
 * about 2m before this one starts". Both halves of that go stale the moment
 * anything AHEAD of it leaves the line, and the job it happened to is the one
 * job that gets no frame. So the jobs behind are re-announced whenever one
 * finishes, fails or is cancelled. At most MAX_QUEUED of them, and only at the
 * handful of moments the line actually moves.
 */
function refreshQueue(): void {
  for (const job of pendingJobs()) {
    if (job.status === 'queued') pushQueued(job)
  }
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
    negative:  (req.negative ?? (styleNegative(style) || DEFAULT_NEGATIVE)).slice(0, MAX_PROMPT),
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
    detail:    '',
    // Filled in immediately below, once the job exists to be measured. The
    // planned step count needs the STYLE'S OWN graph when the job doesn't
    // override steps, which is the usual case — `steps: 0` means "whatever the
    // graph says", and an estimate built on 0 steps is no estimate at all.
    etaMs:     0,
    etaBasis:  '',
    warm:      lastStyleDrawn === style,
    plannedSteps: 0,
    queuedAt:  Date.now(),
    startedAt: Date.now(),
  }
  job.plannedSteps = job.steps > 0 ? job.steps : styleDefaults(style).steps
  refreshEstimate(job)
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
    push(job, 'failed',
      'The picture this was meant to redraw is no longer in the gallery — it was ' +
      'deleted, or pushed out by newer ones. Drawing it from scratch instead would ' +
      'produce a different kind of picture, so nothing was drawn.')
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
    const booked = pendingJobs().reduce((t, j) => t + Math.max(0, j.etaMs), 0)
    push(job, 'failed',
      `The render queue already holds ${MAX_QUEUED} pictures` +
      (booked > 0 ? `, which is about ${humanMs(booked)} of GPU time` : '') +
      '. Let one finish, or drop one with its × in the queue strip, and ask again.')
    return job
  }

  pruneJobs()
  console.log(
    `[image] queued ${job.id} "${job.prompt.slice(0, 60)}" ${job.width}×${job.height} ` +
    `seed=${job.seed} steps=${job.steps || 'graph'} cfg=${job.cfg || 'graph'}` +
    `${job.turbo ? ' turbo' : ''}${job.source ? ` redraw of ${job.source} denoise=${job.denoise}` : ''}` +
    `${waiting > 0 ? ` (${waiting} ahead of it)` : ''}`,
  )
  pushQueued(job)

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
  // Warmth is only knowable HERE. It was guessed at queue time from whatever the
  // box had drawn last, and by the time a job reaches the front of the queue the
  // three renders ahead of it may have swapped the checkpoint twice — so the
  // estimate is taken again against the truth before the bar is drawn against it.
  job.warm = lastStyleDrawn === job.model
  refreshEstimate(job)
  push(job, 'drawing',
    `Drawing ${jobShape(job)}. ${etaSentence(job)}` +
    (job.warm ? '' : ' This style is not on the GPU yet, so loading it comes first.'))

  // Claimed the moment the render starts rather than when it finishes: every
  // job queued behind this one is asking "will the checkpoint already be there",
  // and the answer is yes as soon as this one has asked for it.
  lastStyleDrawn = job.model

  try {
    // Turbo with no LoRA named: ask ComfyUI what it has and pick the one that
    // belongs to this style. Done here rather than in startImage() because it
    // needs the network and startImage() is called from a chat tool with a
    // person waiting to be spoken to.
    //
    // A miss FAILS the render. It used to proceed without the LoRA, on the
    // reasoning that a wrong LoRA silently changes the picture — but so does
    // dropping the one that was asked for, and that is the failure this whole
    // file is written against. On a box with no LoRAs installed at all, the old
    // behaviour meant the Turbo switch did nothing, said nothing, and produced
    // a normal picture; saying which file is missing is the only honest answer.
    if (job.turbo && !job.lora) {
      const installed = await listLoras()      // a dead box throws, and should
      job.lora = pickLora(installed, turboHints(job.model))
      if (!job.lora) {
        throw new Error(
          installed.length === 0
            ? 'Turbo is on but the image server has no LoRAs installed — put the turbo ' +
              'LoRA in ComfyUI/models/loras, or switch Turbo off in Advanced'
            : `Turbo is on but none of the installed LoRAs look like this style's ` +
              `(${installed.join(', ')}) — pick one by hand in Advanced, or switch Turbo off`,
        )
      }
    }

    // A redraw needs its source on the GPU box before the graph can name it.
    // ComfyUI's LoadImage reads from its own input/ directory, and that machine
    // is on the other end of a tailnet with no shared filesystem — so the bytes
    // go up over /upload/image and come back as a filename to put in the node.
    let sourceName = ''
    if (job.source) {
      push(job, 'sending the picture over',
        'Uploading the picture this one is redrawing to the GPU box. There is no ' +
        'shared disk between the two machines, so the bytes have to travel before ' +
        'ComfyUI can load them.')
      sourceName = await uploadSource(job)
    }

    const graph = buildGraph(job, sourceName)
    // The graph is where the real step count finally lives — until now it was
    // the style's default, read out of the same graph but before the job's own
    // overrides were patched into it. Re-estimating against it costs nothing and
    // keeps the bar honest for a job that overrode steps or cfg.
    const sampled = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
    const realSteps = sampled ? graph[sampled]!.inputs['steps'] : undefined
    if (typeof realSteps === 'number' && realSteps > 0 && realSteps !== job.plannedSteps) {
      job.plannedSteps = realSteps
      refreshEstimate(job)
    }
    const promptId = await queuePrompt(graph)
    console.log(`[image] ${job.id} → comfy prompt ${promptId}`)

    const output = await awaitOutput(promptId, job)
    push(job, 'saving',
      'The GPU is done. Fetching the finished picture back and writing it to the ' +
      'dashboard, which is where the gallery reads it from.')

    const bytes = await downloadOutput(output)
    const file = `${job.id}.png`
    const dest = path.join(imagesDir(), file)
    const tmp = `${dest}.tmp-${process.pid}`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, dest)

    job.file = file
    job.status = 'ready'
    job.endedAt = Date.now()
    const took = job.endedAt - job.startedAt
    // Filed against the style, the workload and the warmth, so the NEXT render
    // like this one can be estimated from it — see image-timing.ts. The step
    // count carries the redraw discount, or a style would look faster than it is
    // every time someone redrew a picture with it.
    recordRender({
      style:  job.model,
      steps:  effectiveSteps(job),
      pixels: job.width * job.height,
      warm:   job.warm,
      ms:     took,
      at:     job.endedAt,
    })
    remember({
      id: job.id, prompt: job.prompt, file,
      width: job.width, height: job.height, seed: job.seed,
      ...(job.model ? { model: job.model } : {}),
      // Recorded from the graph that was sent, not from the job's overrides —
      // see renderedWith(). Written AFTER endedAt so the render time is real.
      settings: renderedWith(job, graph),
      at: new Date().toISOString(),
    })
    console.log(
      `[image] ${job.id} ready in ${(took / 1000).toFixed(1)}s ` +
      `(${(bytes.length / 1024).toFixed(0)} KB, ` +
      `${job.warm ? 'warm' : 'cold'}, estimated ${job.etaMs ? humanMs(job.etaMs) : 'n/a'})`,
    )
    // How the estimate did, said out loud. It is the only feedback anyone gets
    // on whether the number above the bar is worth reading, and the answer
    // improves on its own as the history fills in.
    const miss = job.etaMs > 0 ? took - job.etaMs : 0
    push(job, 'ready',
      `Done in ${humanMs(took)} — ${jobShape(job)}.` +
      (job.etaMs > 0 && Math.abs(miss) >= 2000
        ? ` That is ${humanMs(Math.abs(miss))} ${miss > 0 ? 'longer' : 'quicker'} than the ${humanMs(job.etaMs)} estimated.`
        : job.etaMs > 0 ? ' About as long as estimated.' : ''))
    // This render has just become history — every job behind it moves up a place
    // AND gets a better estimate out of the sample just filed.
    refreshQueue()
  } catch (err) {
    fail(job, err instanceof Error ? err.message : String(err))
  }
}

function fail(job: ImageJob, message: string): void {
  job.status = 'failed'
  job.error = message
  job.endedAt = Date.now()
  console.error(`[image] ${job.id} failed — ${message}`)
  push(job, 'failed', `${message} Nothing was drawn, and the queue has moved on to the next one.`)
  refreshQueue()
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
 * this in a frontend "subgraph"; the flattening below is only about that switch
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

/**
 * NetaYume Lumina v3.5 — an anime fine-tune of Lumina-Image-2.0 (Next-DiT).
 *
 * Transcribed from ComfyUI's own bundled `image_netayume_lumina_t2i` template,
 * with its frontend subgraphs flattened away exactly as Anima's were.
 *
 * Unlike Anima this ships as ONE all-in-one checkpoint, so it loads through
 * CheckpointLoaderSimple like an SDXL model — but it is not drop-in as a plain
 * checkpoint style, for three reasons the template makes plain:
 *
 *   • a `ModelSamplingAuraFlow` patch (shift 4) sits between the loader and the
 *     sampler. Without it the sampler runs on the wrong sigma schedule;
 *   • the sampler is `res_multistep`/`simple` at 30 steps, cfg 4 — not the
 *     euler/normal the default SDXL graph uses;
 *   • Lumina is instruction-tuned, so both prompts are prefixed with a system
 *     line ending in `<Prompt Start>`. See NETAYUME_PREFIXES — quality collapses
 *     without it, which is the kind of failure that looks like a bad model
 *     rather than a missing string.
 *
 * EmptySD3LatentImage rather than EmptyLatentImage, which findNode() already
 * knows about, so the megapixel sizing in image-params applies unchanged.
 */
function netaYumeGraph(ckpt: string): ComfyGraph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 4, model: ['1', 0] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '5': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 30, cfg: 4, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
        model: ['2', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0],
      },
    },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['7', 0] } },
  }
}

/**
 * Lumina's instruction prefixes, verbatim from the ComfyUI template.
 *
 * The model was trained to be told what job it is doing before it is told what
 * to draw, and `<Prompt Start>` is the separator it learned. buildGraph()
 * prepends these rather than baking them into the graph above, because it
 * overwrites the text of both CLIPTextEncode nodes with the job's own prompt —
 * so anything written into the graph would be thrown away on every render.
 */
const NETAYUME_PREFIXES = {
  positive: 'You are an assistant designed to generate high quality anime images based on textual prompts. <Prompt Start> ',
  negative: 'You are an assistant designed to generate low-quality images based on textual prompts <Prompt Start> ',
}

/**
 * NoobAI-XL — an SDXL fine-tune, so the same node shape as BUILTIN_GRAPH.
 *
 * It gets its own graph rather than riding the default one for a single
 * reason: the default is tuned for stock SDXL at cfg 8 / euler, and NoobAI's
 * model card asks for cfg 5-6 and euler_ancestral. Rendered at cfg 8 it comes
 * out scorched and over-contrasted, which reads as "this model is bad" rather
 * than "this model is being driven wrong" — see the prefixes below for the
 * other half of that story.
 */
function noobaiGraph(ckpt: string): ComfyGraph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    // 832x1216 is one of the buckets NoobAI lists as trained resolutions; the
    // job overwrites this anyway, it is only the shape of the default.
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 28, cfg: 5.5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['6', 0] } },
  }
}

/**
 * FLUX.1 dev - a guidance-distilled 12B flow transformer, and the third shape
 * of "style" this app has to carry.
 *
 * Transcribed from ComfyUI's own bundled `flux_dev_full_text_to_image` template
 * (subgraph flattened away, as Anima's and Lumina's were). Three things in it
 * are not decoration and are the reason FLUX cannot ride the default graph:
 *
 *   - **cfg is 1, and must stay 1.** FLUX.1 dev is guidance-DISTILLED: the
 *     guidance scale is a conditioning input the model was trained on, not
 *     classifier-free guidance over a negative prompt. Sampling it at cfg 5 the
 *     way SDXL wants turns on true CFG against a negative it was never trained
 *     to use - twice the time for a worse picture. The number a FLUX user
 *     means by "guidance" is the FluxGuidance node below, which is where
 *     buildGraph sends the Advanced panel's Guidance knob.
 *   - **there is no negative prompt.** The template feeds the sampler's
 *     negative a `ConditioningZeroOut` of the POSITIVE rather than a second
 *     text encode, which is why this graph has one CLIPTextEncode and not two.
 *     Encoding a negative through T5-XXL would cost real time to produce
 *     conditioning the sampler discards at cfg 1.
 *   - **two text encoders**, loaded by `DualCLIPLoader` with type 'flux':
 *     CLIP-L for the short tag-ish signal and T5-XXL for the sentence. T5 is
 *     why prompts here are written as prose - see promptStyle below.
 *
 * `weight_dtype` is the one deliberate departure from the template, which ships
 * 'default'. The published weights are bf16 and 23.8 GB; at full precision they
 * do not fit a 24 GB card alongside the text encoder, and ComfyUI's answer to
 * that is to stream the model from system RAM every render - which is not a
 * slower picture but a stalled one, the same reason there is no CPU twin for
 * ComfyUI in docker-compose.voice.yml. `fp8_e4m3fn` casts on load to ~12 GB and
 * is what ComfyUI's own docs recommend at this VRAM. The matching fp8 T5 is
 * paired with it for the same reason.
 */
function fluxGraph(unet: string, weightDtype: string, t5: string): ComfyGraph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: weightDtype } },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: 'clip_l.safetensors', clip_name2: t5, type: 'flux', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    // The real guidance dial. 3.5 is the published default and ComfyUI's own.
    '5': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['4', 0] } },
    // The "negative": the positive, zeroed. Not a prompt - see above.
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '7': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['9', 0] } },
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
   * Text glued in front of the job's prompt and negative before they reach the
   * text encoders. For an instruction-tuned model (Lumina) this is not
   * decoration — it is the format the model was trained to be addressed in;
   * for a booru model it carries the quality tags that model expects.
   */
  prefixes?: { positive: string; negative: string }
  /**
   * The negative this style wants when the caller didn't supply one, replacing
   * DEFAULT_NEGATIVE. A booru model wants booru terms ("worst quality, lowres")
   * — feeding it the house English prose wastes the slot.
   */
  negative?: string
  /**
   * A checkpoint filename this style REPLACES in the picker.
   *
   * An all-in-one checkpoint shows up twice otherwise: once as the raw file
   * ComfyUI reports, and once as this style. The raw entry renders through the
   * default SDXL graph with none of the settings below, so it is the same model
   * quietly set up to disappoint — hiding it is the point.
   */
  supersedes?: string
  /**
   * How the ASSISTANT should write prompts for this style. 'tags' means booru
   * tags with the character tag itself (`hatsune_miku, vocaloid`); 'prose'
   * means an English description. Getting this wrong is what makes a
   * tag-trained model refuse to draw a character it demonstrably knows.
   */
  promptStyle?: 'tags' | 'prose'
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
  'flux1-dev': {
    label: 'FLUX.1 dev',
    graph: fluxGraph('flux1-dev.safetensors', 'fp8_e4m3fn', 't5xxl_fp8_e4m3fn.safetensors'),
    // T5-XXL reads sentences. Feeding a booru tag list to the model with the
    // best prose comprehension of anything installed here is the inverse of
    // the mistake promptStyle exists to stop.
    promptStyle: 'prose',
    // No `negative`: this style has nowhere to put one (ConditioningZeroOut),
    // and buildGraph/renderedWith both know not to invent one for it.
    // No `turboHints`: the distilled sibling is FLUX.1 schnell, a different
    // model rather than a LoRA over this one, so the toggle stays hidden.
    // No `supersedes`: FLUX ships as split files, so there is no all-in-one
    // checkpoint appearing twice in the picker to hide.
    needs: [
      'diffusion_models/flux1-dev.safetensors',
      'text_encoders/clip_l.safetensors',
      'text_encoders/t5xxl_fp8_e4m3fn.safetensors',
      'vae/ae.safetensors',
    ],
  },
  'noobai-xl-v11': {
    label: 'NoobAI XL v1.1',
    graph: noobaiGraph('NoobAI-XL-v1.1.safetensors'),
    // Straight off the model card: quality ladder in front, booru terms behind.
    // `safe` is doing real work on a kiosk the assistant draws on unprompted.
    prefixes: {
      positive: 'masterpiece, best quality, newest, absurdres, highres, safe, ',
      negative: '',
    },
    negative: 'nsfw, worst quality, old, early, low quality, lowres, signature, ' +
      'username, logo, bad hands, mutated hands',
    promptStyle: 'tags',
    supersedes: 'NoobAI-XL-v1.1.safetensors',
    needs: ['checkpoints/NoobAI-XL-v1.1.safetensors'],
  },
  'netayume-lumina-v35': {
    label: 'NetaYume Lumina v3.5',
    graph: netaYumeGraph('NetaYumev35_pretrained_all_in_one.safetensors'),
    prefixes: NETAYUME_PREFIXES,
    // The template's own negative list, which sits after the instruction line.
    negative: 'blurry, worst quality, low quality, jpeg artifacts, signature, ' +
      'watermark, username, bad anatomy, extra limbs, poorly drawn hands, ' +
      'fused fingers, bad proportions, cropped',
    // Fine-tuned on Danbooru, so it answers to the same character tags NoobAI
    // does — it drew the Byakugō seal on Sakura from the tag alone.
    promptStyle: 'tags',
    supersedes: 'NetaYumev35_pretrained_all_in_one.safetensors',
    // One file, unlike Anima's three — it is an all-in-one checkpoint.
    needs: ['checkpoints/NetaYumev35_pretrained_all_in_one.safetensors'],
  },
  'anima-aesthetic-v1-1': {
    label: 'Anima Aesthetic v1.1',
    promptStyle: 'prose',
    graph: animaGraph('anima-aesthetic-v1.1.safetensors', 30, 4),
    turboHints: ['anima', 'turbo'],
    needs: ['diffusion_models/anima-aesthetic-v1.1.safetensors', ...ANIMA_SHARED],
  },
  'anima-turbo-v1-1': {
    label: 'Anima Turbo v1.1',
    promptStyle: 'prose',
    // No turboHints: this IS the distilled model, and stacking a turbo LoRA on
    // top of a turbo checkpoint is how a picture comes out flat and over-baked.
    // Leaving them off is also what makes the Advanced panel hide the toggle.
    graph: animaGraph('anima-turbo-v1.1.safetensors', 10, 1),
    ignoresQuality: true,
    needs: ['diffusion_models/anima-turbo-v1.1.safetensors', ...ANIMA_SHARED],
  },
  'anima-base-v1': {
    label: 'Anima Base v1',
    promptStyle: 'prose',
    graph: animaGraph('anima-base-v1.0.safetensors', 30, 4),
    // Anima ships turbo TWO ways, and both are real:
    //
    //   • anima-turbo-v1.x, a separate distilled CHECKPOINT — the style above,
    //     and the better option when you want turbo for a whole session;
    //   • anima-turbo-lora-v0.2, a LoRA that speeds up THIS model without
    //     swapping it — what the Advanced toggle splices in.
    //
    // The LoRA is not in the circlestone-labs/Anima repo (which publishes no
    // loras/ folder), which is why it briefly looked like it didn't exist. It
    // does; these hints are how it gets found. Matched rather than hardcoded —
    // the filename is a thing on the GPU box's disk and its version moves, so
    // listLoras() stays the only honest source for it.
    // Surfaced in the picker when they're missing, because the alternative is a
    // render that fails with a bare "value not in list" naming a file the user
    // has never heard of.
    needs: ['diffusion_models/anima-base-v1.0.safetensors', ...ANIMA_SHARED],
  },
}

export const WORKFLOW_PREFIX = 'wf:'

/** A style's prompt prefixes, or empty strings for one that needs none. */
function stylePrefixes(style: string): { positive: string; negative: string } {
  const none = { positive: '', negative: '' }
  if (!style.startsWith(WORKFLOW_PREFIX)) return none
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.prefixes ?? none
}

/** The negative a style wants by default, or '' to fall back to DEFAULT_NEGATIVE. */
function styleNegative(style: string): string {
  if (!style.startsWith(WORKFLOW_PREFIX)) return ''
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.negative ?? ''
}

/**
 * How the assistant should write prompts for a style.
 *
 * Defaults to 'prose', which is what every plain SDXL checkpoint and the whole
 * pre-existing app assumed — so a style that says nothing behaves exactly as
 * before.
 */
export function stylePromptStyle(style: string): 'tags' | 'prose' {
  if (!style.startsWith(WORKFLOW_PREFIX)) return 'prose'
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.promptStyle ?? 'prose'
}

/** Checkpoint filenames that a `wf:` style replaces and the picker should hide. */
export function supersededCheckpoints(): Set<string> {
  return new Set(
    Object.values(BUILTIN_WORKFLOWS)
      .map(w => w.supersedes)
      .filter((n): n is string => !!n),
  )
}

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

/**
 * A style's human name — "Anima Turbo v1.1" rather than `wf:anima-turbo-v1.1`.
 *
 * Falls back to the id, which for a plain checkpoint IS the name anyone would
 * recognise (the .safetensors filename they installed), and for an unknown
 * `wf:` id is at least the truth rather than a blank.
 */
export function styleLabel(style: string): string {
  if (!style) return ''
  if (!style.startsWith(WORKFLOW_PREFIX)) return style
  const id = style.slice(WORKFLOW_PREFIX.length)
  return BUILTIN_WORKFLOWS[id]?.label ?? id.replace(/[_-]+/g, ' ')
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
 * Follow a sampler's conditioning link back to the text node it came from.
 *
 * A sampler's `positive` does not always land straight on a CLIPTextEncode.
 * Any model family that carries guidance IN the conditioning puts a node in
 * between - FLUX has `FluxGuidance`, and its negative is a
 * `ConditioningZeroOut` of the positive rather than a second prompt at all.
 * Stopping at the first hop, which is what this used to do, made every FLUX
 * graph fail with "positive prompt does not reach a text node", and meant no
 * FLUX workflow anyone exported themselves could be dropped on the volume.
 *
 * Depth-limited because a workflow is user-supplied data: a cycle in one must
 * come back as null rather than hang the render thread.
 */
function conditioningText(graph: ComfyGraph, startId: string | null): string | null {
  let id = startId
  for (let hop = 0; id && hop < 8; hop++) {
    const node = graph[id]
    if (!node) return null
    if ('text' in node.inputs) return id
    // Every conditioning passthrough names its upstream input `conditioning`.
    const up = node.inputs['conditioning']
    id = Array.isArray(up) && typeof up[0] === 'string' ? up[0] : null
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
  //
  // For a guidance-distilled style that number is NOT the sampler's cfg. FLUX
  // samples at cfg 1 and carries its guidance in the conditioning, so the knob
  // labelled Guidance has to land on the FluxGuidance node; writing it to the
  // sampler instead would switch on true classifier-free guidance against a
  // negative the model never had, which costs twice the time for a worse
  // picture. Same principle as `ignoresQuality`: a control must drive the thing
  // its label names, or say it doesn't apply.
  const guidanceId = findNode(graph, ['FluxGuidance'])
  if (job.cfg > 0) {
    if (guidanceId) graph[guidanceId]!.inputs['guidance'] = job.cfg
    else if ('cfg' in sampler.inputs) sampler.inputs['cfg'] = job.cfg
  }

  const link = (key: string): string | null => {
    const v = sampler.inputs[key]
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
  }
  const posId = conditioningText(graph, link('positive'))
  const negId = conditioningText(graph, link('negative'))
  // An instruction-tuned style (Lumina) has to be addressed in the format it
  // was trained on, so its system line goes in front of what the user asked
  // for. Empty for every other style, which is why this is a plain concat
  // rather than a branch.
  const pre = stylePrefixes(job.model)
  if (posId && graph[posId] && 'text' in graph[posId]!.inputs) {
    graph[posId]!.inputs['text'] = pre.positive + job.prompt
  } else {
    throw new Error("workflow's positive prompt does not reach a text node")
  }
  // `negId !== posId` is load-bearing, not defensive. A style whose negative is
  // a ConditioningZeroOut of the POSITIVE (FLUX) resolves both links to the one
  // text node, and writing the negative there would replace the prompt with the
  // negative and draw a picture of everything the user didn't want. A negative
  // that is inert in the graph stays inert.
  if (negId && negId !== posId && graph[negId] && 'text' in graph[negId]!.inputs) {
    graph[negId]!.inputs['text'] = pre.negative + job.negative
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

/**
 * What a finished render was actually made of, read back off the graph that was
 * sent to the GPU.
 *
 * The graph is the only place the whole answer exists at once. The job carries
 * the OVERRIDES — and most of them are zeros meaning "don't override" — while
 * the sampler node carries the resolved numbers, including the two (sampler and
 * scheduler) that the job never had an opinion about in the first place.
 */
function renderedWith(job: ImageJob, graph: ComfyGraph): ImageSettings {
  const samplerId = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  const inputs = samplerId ? graph[samplerId]!.inputs : {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const t = (v: unknown) => (typeof v === 'string' ? v : '')

  // Guidance and the negative are both read the way buildGraph wrote them,
  // which for a distilled style is not where a plain SDXL graph keeps them:
  // the number that steered the picture is on the FluxGuidance node, and the
  // sampler's cfg 1 beside it would be a true statement that answers the wrong
  // question. And a style whose negative never reaches a text node of its own
  // had no negative - recording the house default against a picture it took no
  // part in is the same silent lie the per-style params exist to avoid.
  const linked = (key: string): string | null => {
    const v = inputs[key]
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
  }
  const posId = conditioningText(graph, linked('positive'))
  const negId = conditioningText(graph, linked('negative'))
  const guidanceId = findNode(graph, ['FluxGuidance'])
  const guidance = guidanceId ? n(graph[guidanceId]!.inputs['guidance']) : 0

  return {
    style:      job.model,
    styleLabel: styleLabel(job.model),
    steps:      n(inputs['steps']),
    cfg:        guidance || n(inputs['cfg']),
    sampler:    t(inputs['sampler_name']),
    scheduler:  t(inputs['scheduler']),
    negative:   negId && negId !== posId ? job.negative : '',
    ...(job.lora ? { lora: job.lora, loraStrength: job.loraStrength } : {}),
    ...(job.source ? { source: job.source, denoise: job.denoise } : {}),
    tookMs:     Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt),
  }
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

  // Same substitution as renderedWith: for a style with a FluxGuidance node the
  // number behind "Auto" on the Guidance row is that node's, not the sampler's
  // cfg 1. An Advanced panel whose "Auto" names the wrong number is worse than
  // one that names none, because it invites correcting a value that was right.
  const guidanceId = findNode(graph, ['FluxGuidance'])
  const guidance = guidanceId ? graph[guidanceId]!.inputs['guidance'] : undefined

  return {
    steps:     n(inputs['steps'], fallback.steps),
    cfg:       n(guidance, n(inputs['cfg'], fallback.cfg)),
    width:     n(latent['width'], fallback.width),
    height:    n(latent['height'], fallback.height),
    sampler:   s(inputs['sampler_name'], fallback.sampler),
    scheduler: s(inputs['scheduler'], fallback.scheduler),
    hasCfg:    guidanceId !== null || 'cfg' in inputs,
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
        // Carefully NOT a claim about which part of the work is running.
        //
        // ComfyUI's /history gains an entry when a prompt FINISHES, so `!entry`
        // covers the checkpoint load and the sampling alike — real per-step
        // progress only comes over a WebSocket this server doesn't hold open.
        // The old text said "loading the model" for the whole render, which is
        // right for the first twenty seconds of a cold one and a plain untruth
        // for the two minutes after it. Warmth is the one thing we do know, so
        // that is the only thing asserted.
        const style = styleLabel(job.model) || 'this style'
        push(job, job.warm ? 'drawing' : 'loading the model',
          job.warm
            ? `${style} is already in the graphics card's memory, so this is the render ` +
              `itself — ${effectiveSteps(job)} steps at ${job.width}×${job.height}. ComfyUI ` +
              `reports nothing between accepting a job and finishing it, which is why the ` +
              `bar is measured against history rather than against real progress. ` +
              etaSentence(job)
            : `ComfyUI has taken the job. ${style} is not in the graphics card's memory ` +
              `yet, so 20-40s of this is loading it before a single step is drawn — once ` +
              `per style, and the next picture with it skips that entirely. ` +
              etaSentence(job))
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
