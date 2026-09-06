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
import zlib from 'zlib'
import { readStructure, CANNY, type HoldMode } from './image-structure'
import path from 'path'
import { broadcast } from './routes/system'
import { advanceSeed, paramsFor, type ImageParams } from './image-params'
import { estimateRender, humanMs, recordRender } from './image-timing'
import { composeRedrawPrompt, visionModel, improvePrompt, prompterModel, readPrompter, locateBox } from './image-prompt'

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
// How long ONE render may take once the GPU is actually working on it. Raised
// from 180s because that no longer had to cover queue wait — and because a cold
// FLUX is 23.8 GB of weights to page in before a single step is drawn, which on
// its own can pass three minutes.
const TIMEOUT_MS = Number(process.env['COMFYUI_TIMEOUT_MS'] ?? 600_000)

// The outer bound, covering queue wait as well. Generous on purpose: the whole
// point is that being tenth in line is not an error, and a kiosk asking for four
// pictures of an evening should still get the fourth. It exists only so a box
// that has wedged entirely is eventually given up on rather than holding this
// server's render chain forever.
const QUEUE_WAIT_MS = Number(process.env['COMFYUI_QUEUE_WAIT_MS'] ?? 60 * 60_000)
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

/** ControlNet files on the box. Empty when none, or when the box is down. */
export async function listControlNets(): Promise<string[]> {
  return loaderOptions('ControlNetLoader', 'control_net_name').catch(() => [])
}

/**
 * The ControlNet to hold a redraw's lines: an SDXL "union" model if there is
 * one (it takes canny, lineart, depth and pose in one file), else anything
 * whose name says canny or lineart. Nothing at all rather than a guess — a
 * ControlNet for the wrong model family fails the render with a shape error.
 */
export function pickControlNet(installed: string[]): string {
  const lower = installed.map(n => n.toLowerCase())
  const idx = (pred: (n: string) => boolean) => lower.findIndex(pred)
  const i = [
    idx(n => n.includes('union') && (n.includes('promax') || n.includes('sdxl'))),
    idx(n => n.includes('union')),
    idx(n => (n.includes('canny') || n.includes('lineart')) && n.includes('xl')),
    idx(n => n.includes('canny') || n.includes('lineart')),
  ].find(x => x >= 0)
  return i === undefined ? '' : installed[i]!
}

/** The preprocessor node each hold mode needs. `lines` is core ComfyUI; the other two come with comfyui_controlnet_aux. */
export const HOLD_NODES: Record<HoldMode, string> = {
  lines: 'Canny',
  body:  'DepthAnythingV2Preprocessor',
  pose:  'DWPreprocessor',
}

let holdModesCache: { at: number; modes: Record<HoldMode, boolean> } | null = null
/** Which hold modes this box can run. Cached a minute. */
export async function holdModes(): Promise<Record<HoldMode, boolean>> {
  if (!COMFY_URL) return { lines: false, body: false, pose: false }
  if (holdModesCache && Date.now() - holdModesCache.at < 60_000) return holdModesCache.modes
  const has = async (n: string) => comfyFetch(`/object_info/${n}`, undefined, 8000)
    .then(async r => r.ok && Object.keys(await r.json() as object).length > 0).catch(() => false)
  const [lines, body, pose] = await Promise.all([has(HOLD_NODES.lines), has(HOLD_NODES.body), has(HOLD_NODES.pose)])
  const modes = { lines, body, pose }
  holdModesCache = { at: Date.now(), modes }
  return modes
}

let structureCache: { at: number; ok: boolean } | null = null
/** Whether "keep the pose" can be offered: the nodes exist and a usable ControlNet is installed. Cached a minute. */
export async function structureAvailable(): Promise<boolean> {
  if (!COMFY_URL) return false
  if (structureCache && Date.now() - structureCache.at < 60_000) return structureCache.ok
  let ok = false
  try {
    const [nodes, files] = await Promise.all([
      Promise.all(['Canny', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'SetUnionControlNetType']
        .map(n => comfyFetch(`/object_info/${n}`, undefined, 8000).then(r => r.ok).catch(() => false))),
      listControlNets(),
    ])
    ok = nodes.every(Boolean) && pickControlNet(files) !== ''
  } catch { ok = false }
  structureCache = { at: Date.now(), ok }
  return ok
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
  /**
   * Only PART of the source was repainted. `region` is what the user named,
   * when the mask came from a description ("the hat") rather than a brush.
   */
  mask?:    boolean
  region?:  string
  /** The ControlNet that held the source's lines in place during a redraw, if one did. */
  controlnet?: string
  /** Wall-clock render time, so "which settings" can be weighed against "how long". */
  tookMs:   number
  /**
   * What the user actually typed, when the prompt improver rewrote it.
   *
   * Absent when it was off or made no change, so its PRESENCE is the record
   * that a rewrite happened — the alternative, storing it always, would make
   * every picture's detail panel show two identical prompts. `prompt` on the
   * StoredImage is the rewritten one, because that is what the sampler saw and
   * what "use as prompt" should hand back.
   */
  promptOriginal?: string
  /** Which model did the rewriting. Two models give very different prompts. */
  improvedBy?:     string
  /** Booster text appended to the prompt for this style, when there was any. */
  optimizations?:  string
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
  /**
   * 'upload' for a picture the user added from their own device rather than one
   * this app drew.
   *
   * It joins the gallery as an ordinary entry ON PURPOSE. `source` on a render
   * is a gallery id and never a path or a URL — that is what keeps the set of
   * images this app will hand to the GPU box closed and enumerable — so making
   * "start from my own picture" work is exactly the job of getting the picture
   * INTO the gallery. Everything downstream (redraw, "Change this", the viewer's
   * arrows, pruning) then needs no cases of its own.
   *
   * Absent means drawn here, which is what every entry written before this was
   * added was.
   */
  origin?: 'upload'
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

/** Empty the gallery: every render and upload, and the files behind them. */
export function clearImages(): number {
  const all = listImages()
  saveIndex([])
  for (const e of all) {
    try { fs.unlinkSync(path.join(imagesDir(), e.file)) } catch { /* already gone */ }
  }
  console.log(`[image] cleared the gallery (${all.length} pictures)`)
  return all.length
}

/** Biggest upload accepted. A phone photo is ~5 MB; this is generous, not tight. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

/**
 * Width and height straight out of a PNG's IHDR chunk.
 *
 * Parsed rather than trusted from the client, because these two numbers are
 * stored and later shown as fact. It is also the only validation that matters
 * here: a file whose first 8 bytes are the PNG signature and whose first chunk
 * is a well-formed IHDR is a PNG, and anything else is refused before it
 * reaches the disk.
 *
 * No image library for this on purpose. `sharp` would be a native dependency on
 * a multi-arch build that has to keep producing linux/arm64 for the Pi, and the
 * client hands us PNG already — it draws whatever the user picked onto a canvas
 * first — so the one thing left to do is read four big-endian integers.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // 8 signature + 4 length + 4 type + 13 IHDR data = 29 bytes minimum.
  if (bytes.length < 29 || !bytes.subarray(0, 8).equals(SIG)) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  // PNG allows up to 2^31-1 per side; anything near that is a malformed header
  // rather than a picture, and these numbers go on to size a latent.
  if (width < 1 || height < 1 || width > 16384 || height > 16384) return null
  return { width, height }
}

/**
 * Add a picture the user supplied to the gallery, so it can be redrawn.
 *
 * The whole feature is this function, and that is the point. `source` on a
 * render is a gallery id and never a path or a URL — the operator-vs-model
 * distinction that keeps the set of images this app will hand to the GPU closed
 * — so "let me start from a picture of my own" is not a new pipeline, it is
 * getting one more picture into the set. Redraw, "Change this", the viewer's
 * arrows and the oldest-first pruning then all work with no cases of their own.
 *
 * `seed: 0` and no `settings` because there was no render: the details panel
 * reads `origin` and says where it came from instead of inventing a sampler.
 */
export function addUploadedImage(bytes: Buffer, caption: string): StoredImage {
  const size = pngSize(bytes)
  if (!size) throw new Error('that file could not be read as a PNG')

  const id = crypto.randomBytes(16).toString('hex')
  const file = `${id}.png`
  const dest = path.join(imagesDir(), file)
  const tmp = `${dest}.tmp-${process.pid}`
  // Write-then-rename, like every other write to this directory: a half-written
  // PNG that the gallery has already been told about is a broken thumbnail
  // forever, because the id never comes round again.
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, dest)

  const entry: StoredImage = {
    id,
    prompt: caption.trim().slice(0, MAX_PROMPT),
    file,
    width:  size.width,
    height: size.height,
    seed:   0,
    origin: 'upload',
    at:     new Date().toISOString(),
  }
  remember(entry)
  console.log(`[image] added upload ${file} ${size.width}×${size.height} (${(bytes.length / 1024).toFixed(0)} KB)`)
  return entry
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
  /**
   * The four pieces of text this app adds on the user's behalf, ALL resolved
   * here at queue time from the style's published default and the user's
   * per-style override.
   *
   * Resolved at queue time like the style and the steps, so editing them in
   * Settings cannot retroactively change a picture that is already waiting —
   * and resolved HERE rather than in buildGraph so that precedence lives in one
   * place with the rest of it, and buildGraph stays purely mechanical.
   */
  prefix:        string
  optimizations: string
  negativePrefix: string
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
  /**
   * The source's own pixel size. `width`/`height` above are the size the
   * render is drawn at, and for a redraw the two differ on purpose: the source
   * is fitted to the style's megapixel budget before it is encoded, because a
   * 3 MP phone photo handed straight to a model trained at 1 MP comes back as
   * a smeared enlargement of itself. buildGraph inserts the resize when the
   * numbers differ. 0 when there is no source.
   */
  sourceWidth:  number
  sourceHeight: number
  /**
   * True when the source came from the user's device rather than a render. An
   * upload has no prompt — its "prompt" is a filename — so a redraw of one
   * cannot be seeded with a description of what it shows, and the picture has
   * to be LOOKED at to write one. See composeRedrawPrompt.
   */
  sourceUpload: boolean
  /** How much of the source to throw away, 0.05-1. Meaningless without a source. */
  denoise:  number
  /**
   * CHANGE ONLY PART OF IT. `mask` is the id of a stored mask (white where the
   * picture may change, black where it must not), painted on the touchscreen
   * or produced by findMask() from `region` — a description of the part, "the
   * hat", "the sky", which run() turns into a mask on the GPU box before the
   * render. Either is '' when the whole picture is being redrawn.
   */
  mask:     string
  maskFile: string
  region:   string
  /**
   * KEEP THE POSE. A redraw — whole or part — conditions the sampler on the
   * source's own edges through a ControlNet, so shoulders, arms and hands
   * stay where they are while what is painted over them changes. Wanted by
   * default for any redraw that isn't an instruction edit; `controlnet` is
   * the file run() resolved for it, '' when none is installed or the style's
   * graph is not the SDXL family the installed one fits.
   */
  structure:  boolean
  controlnet: string
  /** How it is held, resolved from the settings (or the request) at queue time. */
  hold:         HoldMode
  holdStrength: number
  holdEnd:      number
  cannyLow:     number
  cannyHigh:    number
  /** Names the preprocessor nodes need, resolved in run() from what the box lists. */
  depthCkpt:    string
  poseDetector: string
  poseEstimator: string
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
  /**
   * Run the prompt through the improver before drawing.
   *
   * Resolved at QUEUE time from the request or the saved default, like the style
   * and the quality preset, so flipping the toggle can't retroactively change
   * what is already waiting in the queue.
   */
  improve:  boolean
  /** What the user typed, once the improver has replaced `prompt`. '' otherwise. */
  promptOriginal: string
  /** Which model rewrote it. '' when nothing did. */
  improvedBy:     string
  /**
   * Time spent rewriting, so it can be subtracted from the render's timing
   * sample. Left in, it would teach image-timing.ts that this style is several
   * seconds slower than it is, and the estimate would drift with the toggle
   * rather than with the GPU.
   */
  improveMs:      number
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
   * Rewrite the prompt for the chosen style before drawing.
   *
   * `undefined` means "whatever the user's saved default says", which is what
   * the Draw panel relies on. The ASSISTANT passes false explicitly: a spoken
   * `generate_image` prompt was already written by a model that had this
   * style's prompting guidance in its system prompt, so improving it again is
   * one model paraphrasing another for no gain and several seconds of delay.
   */
  improve?:  boolean
  /**
   * REDRAW: the id of a picture in the gallery to start from. The size comes
   * from that picture and `width`/`height` are ignored — an img2img latent is
   * the source's own shape, and quietly rendering a different one would be the
   * silent-override failure this file keeps trying not to have.
   */
  source?:   string
  /** How much of the source to throw away, 0.05-1. Ignored without a source. */
  denoise?:  number
  /**
   * Repaint only the marked part of the source. `mask` is a stored mask id
   * (see saveMask); `region` is a description the GPU box turns into one
   * ("the cat's hat"). One or the other; both means the mask wins. Ignored
   * for an editing style, which decides what to keep from the words instead.
   */
  mask?:     string
  region?:   string
  /** Keep the source's pose and shapes through a ControlNet. Default: the setting (on). */
  structure?: boolean
  /** What to hold: lines (edges), body (depth) or pose (skeleton). Default: the setting. */
  hold?:      HoldMode
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
  // A mask only means anything over a source, and an editor takes none — it
  // decides what to keep from the instruction. A described region is kept as
  // words here and turned into a mask in run(), where the GPU is.
  const maskId = source && !styleEdits(style) ? (req.mask ?? '').trim() : ''
  const maskFile = maskId && /^[a-f0-9]{32}$/.test(maskId) && fs.existsSync(path.join(masksDir(), `${maskId}.png`))
    ? `${maskId}.png` : ''
  const region = source && !styleEdits(style) && !maskFile ? (req.region ?? '').trim().slice(0, 120) : ''
  // The pose-hold settings, read now so a change reaches the next picture and
  // a picture already waiting keeps the settings it was queued with.
  const hold = readStructure()

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
  //
  // Not the source's OWN size any more, though. It used to be, on the grounds
  // that VAEEncode makes a latent the shape of what it is given — true, but a
  // 3 MP phone photo encoded as-is is handed to a model trained at 1 MP, which
  // repaints it as a smeared enlargement, and a 600px web image is repainted
  // with no room for detail. So the source keeps its SHAPE and is fitted to the
  // style's megapixel budget (1 MP when Advanced leaves it at Auto, the number
  // every model here was trained around) before it is encoded; buildGraph
  // inserts the resize. An edit style has its own idea of the size — Kontext
  // snaps the source to one of its published resolutions — and that is
  // mirrored here so the frame's size text is right before the render starts.
  const edits = styleEdits(style)
  const size = source
    ? edits
      ? kontextSize(source.width, source.height)
      : sizeForMegapixels(source.width, source.height, p.megapixels > 0 ? p.megapixels : 1, p.multipleOf)
    : p.megapixels > 0
      ? sizeForMegapixels(asked.width, asked.height, p.megapixels, p.multipleOf)
      : asked
  // How much of the source is thrown away. An editor takes none of this: it
  // runs at denoise 1 over the encoded source and decides what to keep from the
  // instruction, so the three strength words simply do not apply to it.
  // A masked edit defaults to a FULL repaint of the marked part rather than the
  // redraw's 0.65: the unmarked pixels are pasted back over the result anyway,
  // so there is nothing outside the mask for a lower strength to protect, and
  // inside it "put a hat there" wants a hat, not a ghost of what was there.
  const denoise = source && !edits
    ? clampDenoise(Number.isFinite(req.denoise) ? Number(req.denoise) : (maskFile || region ? 1 : DEFAULT_DENOISE))
    : 1
  const baseSteps = Number.isFinite(req.steps) && Number(req.steps) > 0
    ? Math.max(1, Math.min(150, Math.round(Number(req.steps))))
    : p.steps > 0 ? p.steps
    : styleIgnoresQuality(style) ? 0
    : (QUALITY_STEPS[selectedQuality()] ?? 0)

  const job: ImageJob = {
    id:        crypto.randomBytes(16).toString('hex'),
    prompt:    req.prompt.slice(0, MAX_PROMPT),
    // Precedence, widest to narrowest: this request → the user's per-style
    // override from Settings → the style's own published text → the house
    // default. `??` and not `||` throughout, because an override of '' is a
    // real answer meaning "add nothing" and must not fall through to the
    // built-in it was set to switch off.
    negative:  (req.negative ?? p.negative ?? (styleNegative(style) || DEFAULT_NEGATIVE))
      .slice(0, MAX_PROMPT),
    prefix:         (p.prefix ?? stylePrefixFor(style)).slice(0, MAX_PROMPT),
    optimizations:  (p.optimizations ?? styleOptimizations(style)).slice(0, MAX_PROMPT),
    negativePrefix: (p.negativePrefix ?? styleNegativePrefixFor(style)).slice(0, MAX_PROMPT),
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
    //
    // A plain img2img redraw then gets its step count RAISED to compensate for
    // denoise: a KSampler at 30 steps and 0.65 denoise runs ~20 of them, and at
    // Draft × Light that was 12 × 0.45 ≈ 5 sampling steps — a picture nobody
    // would call finished, from a setting that said "draft", which reads as
    // "redrawing is bad". The sampler is asked for enough steps that the ones
    // it actually runs come to what a fresh render at these settings would get
    // (never fewer than 20 for a normal model; a distilled one keeps its own
    // number, since 20 is four times what it wants). effectiveSteps() takes
    // the same discount back off for the estimate and the status line.
    steps:     source && !edits && denoise < 1
      ? Math.min(150, Math.ceil(
          (styleIgnoresQuality(style)
            ? (baseSteps > 0 ? baseSteps : styleDefaults(style).steps)
            : Math.max(20, baseSteps > 0 ? baseSteps : styleDefaults(style).steps)) / denoise))
      : baseSteps,
    // cfg has no quality-preset layer on purpose — it is per-model tuning, not
    // a speed/quality dial. 0 all the way down means "whatever the graph says".
    cfg:       Number.isFinite(req.cfg) && Number(req.cfg) > 0 ? Number(req.cfg) : p.cfg,
    turbo:     p.turbo,
    source:     source?.id ?? '',
    sourceFile: source?.file ?? '',
    sourceWidth:  source?.width ?? 0,
    sourceHeight: source?.height ?? 0,
    sourceUpload: source?.origin === 'upload',
    mask:     maskFile ? maskId : '',
    maskFile,
    region,
    structure: !!source && !edits && (req.structure ?? hold.enabled),
    controlnet: '',
    hold:         req.hold === 'body' || req.hold === 'pose' || req.hold === 'lines' ? req.hold : hold.mode,
    holdStrength: hold.strength,
    holdEnd:      hold.end,
    cannyLow:     CANNY[hold.detail].low,
    cannyHigh:    CANNY[hold.detail].high,
    depthCkpt: '', poseDetector: '', poseEstimator: '',
    // Clamped above so the number the UI shows and the number the sampler gets
    // are the same one. Without a source it stays 1 — a full render — which is
    // also exactly what the sampler wants for txt2img.
    denoise,
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
    // Explicit false from the assistant, undefined from the Draw panel, which
    // is how the saved default reaches a tap without the panel having to send
    // it. Read here rather than in run() for the same reason as the style: the
    // picture is drawn the way it was asked for, not the way the toggle happens
    // to be set two minutes later when it reaches the front of the queue.
    improve:   typeof req.improve === 'boolean' ? req.improve : readPrompter().enabled,
    promptOriginal: '',
    improvedBy:     '',
    improveMs:      0,
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

  // An editor with nothing to edit. Drawing from an empty latent with Kontext
  // is not "a worse picture", it is a graph with a LoadImage that names no
  // file, which ComfyUI rejects with a bare validation error twenty seconds
  // from now — so it is refused here, in a sentence, while the button is
  // still under the finger.
  if (edits && !source) {
    job.status = 'failed'
    job.error = `${styleLabel(style)} edits a picture rather than drawing one — pick one to change first`
    job.endedAt = Date.now()
    console.warn(`[image] refused ${job.id}: edit style with no source`)
    push(job, 'failed',
      `${styleLabel(style)} changes an existing picture and cannot draw one from nothing. ` +
      'Tap "Change this" on a picture in the gallery, or add one of your own, and say what ' +
      'to change — or pick a different style to draw from scratch.')
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
    `${job.turbo ? ' turbo' : ''}` +
    `${job.source ? ` ${edits ? 'edit' : 'redraw'} of ${job.source} (${job.sourceWidth}×${job.sourceHeight}) denoise=${job.denoise}` : ''}` +
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

  // ── Rewrite the prompt for this style, if asked ──
  //
  // Ahead of the drawing phase rather than inside it, because it changes WHAT
  // is drawn: the line below names the job, and announcing a prompt that is
  // about to be replaced would be wrong in the one place the user is looking.
  //
  // improvePrompt() never throws and never returns nothing — every failure path
  // falls back to what the user typed. That is what makes the toggle safe to
  // leave on: a dead Ollama box costs a better prompt, not the picture. The
  // reason is carried into the detail line rather than swallowed, because
  // "it drew what I typed" and "it silently couldn't reach the model" look
  // identical from the outside otherwise.
  let improveNote = ''
  const edits = styleEdits(job.model)
  // ── A redraw needs a description of the whole picture, and usually hasn't one ──
  //
  // img2img repaints the source's layout from the PROMPT, and the prompt is
  // the only thing the sampler is told about what that layout depicts — so
  // "make it night" over a picture of a fox draws "make it night" in a
  // fox-shaped composition. The Draw panel seeds the field with the original's
  // own prompt to make the edit two words, but an uploaded picture has no
  // prompt (its "prompt" is the filename), and out loud nobody says the whole
  // description again. So when the improver is on, or the source is an upload,
  // the picture is SHOWN to a vision model along with what was typed and the
  // model writes the description-with-the-change in this style's register.
  // Never for an edit style: Kontext wants the instruction verbatim, and a
  // model that helpfully expands "make it night" into a paragraph describing
  // the scene turns an edit into a repaint — the exact thing it exists to avoid.
  const partial = !!(job.maskFile || job.region)
  if (partial) {
    // The prompt for a masked edit describes what goes IN the marked part, and
    // that is exactly the words the user typed. Neither rewriter applies: the
    // improver would embellish a whole scene, and the vision composer would
    // describe the whole picture — both are ways of telling the sampler to
    // repaint more than was asked for.
    if (job.improve) improveNote = ' The prompt is used as written: it describes what goes in the marked part.'
  } else if (job.source && !edits && (job.improve || job.sourceUpload)) {
    push(job, 'looking at the picture',
      `Showing the original to ${visionModel()} so it can describe the whole picture with ` +
      'your change applied. The picture model repaints from words alone and never sees ' +
      'the original, so a prompt that only names the change would draw the change and ' +
      'nothing else.')
    let bytes: Buffer | null = null
    try { bytes = fs.readFileSync(path.join(imagesDir(), job.sourceFile)) } catch { bytes = null }
    const seen = bytes
      ? await composeRedrawPrompt(bytes, job.prompt, {
          label: styleLabel(job.model), guidance: stylePromptGuide(job.model),
        })
      : null
    job.improveMs += seen?.ms ?? 0
    if (seen?.changed) {
      job.promptOriginal = seen.original
      job.improvedBy = seen.model
      job.prompt = seen.prompt
      improveNote = ' The prompt was written from the original picture plus your change.'
      console.log(`[image] ${job.id} redraw prompt composed by ${seen.model}: "${seen.prompt.slice(0, 80)}"`)
    } else if (seen?.why) {
      improveNote = ` The prompt was left exactly as you wrote it — ${seen.why}.`
      console.warn(`[image] ${job.id} redraw prompt not composed — ${seen.why}`)
    }
  } else if (edits) {
    // Nothing to improve: an instruction is the format, and the user's own
    // words are the instruction. Said in the detail so a switched-on improver
    // that appears to do nothing here reads as deliberate.
    if (job.improve) improveNote = ' The prompt is used as written: this style takes instructions, not descriptions.'
  } else if (job.improve) {
    push(job, 'improving',
      `Rewriting the prompt for ${styleLabel(job.model)} before drawing it. This is a ` +
      `separate model (${prompterModel()}) on a brand new conversation, so nothing else ` +
      'you have asked for today can colour it.')
    const better = await improvePrompt(job.prompt, {
      label:    styleLabel(job.model),
      guidance: stylePromptGuide(job.model),
    })
    job.improveMs += better.ms
    if (better.changed) {
      job.promptOriginal = better.original
      job.improvedBy = better.model
      job.prompt = better.prompt
      improveNote = ' The prompt was rewritten for this style first.'
      console.log(`[image] ${job.id} prompt improved by ${better.model}: "${better.prompt.slice(0, 80)}"`)
    } else if (better.why) {
      improveNote = ` The prompt was left exactly as you wrote it — ${better.why}.`
      console.warn(`[image] ${job.id} prompt not improved — ${better.why}`)
    }
  }

  push(job, 'drawing',
    `Drawing ${jobShape(job)}. ${etaSentence(job)}` +
    (job.warm ? '' : ' This style is not on the GPU yet, so loading it comes first.') +
    improveNote)

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
    // Keep-the-pose: name the ControlNet now, for the same reason the LoRA is
    // named here — it is a file on the GPU box's disk. A miss does NOT fail
    // the render: unlike the LoRA, this is a default nobody switched on, and
    // a box with no ControlNet should still redraw, just without the lines
    // held — said in the detail, so "why did the pose drift" has an answer.
    if (job.structure && job.source) {
      job.controlnet = pickControlNet(await listControlNets())
      if (!job.controlnet) {
        improveNote += ' No ControlNet is installed on the image server, so the pose is not held in place — put an SDXL union ControlNet in ComfyUI/models/controlnet to enable it.'
      } else {
        // The depth and pose preprocessors are a node pack, and their model
        // files are combo inputs whose valid names only the box knows. Ask,
        // take the first, and fall back to lines — with a sentence — when
        // the pack isn't there, rather than failing the render over a
        // setting that has a working alternative.
        const modes = await holdModes()
        if (job.hold === 'body') {
          job.depthCkpt = modes.body ? ((await loaderOptions(HOLD_NODES.body, 'ckpt_name').catch(() => []))[0] ?? '') : ''
          if (!job.depthCkpt) { job.hold = 'lines'; improveNote += ' The depth preprocessor is not installed on the image server, so the lines are held instead of the body.' }
        } else if (job.hold === 'pose') {
          const [det, est] = modes.pose
            ? await Promise.all([loaderOptions(HOLD_NODES.pose, 'bbox_detector').catch(() => []), loaderOptions(HOLD_NODES.pose, 'pose_estimator').catch(() => [])])
            : [[], []]
          job.poseDetector = det[0] ?? ''; job.poseEstimator = est[0] ?? ''
          if (!job.poseDetector || !job.poseEstimator) { job.hold = 'lines'; improveNote += ' The pose preprocessor is not installed on the image server, so the lines are held instead of the skeleton.' }
        }
        improveNote += ` Holding the ${job.hold === 'lines' ? 'lines' : job.hold === 'body' ? "body's depth" : 'skeleton'} with a ControlNet at ${Math.round(job.holdStrength * 100)}% for the first ${Math.round(job.holdEnd * 100)}% of the render.`
      }
    }

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
        `Uploading the picture this one is ${edits ? 'editing' : job.maskFile || job.region ? 'changing part of' : 'redrawing'} to the GPU box. There is no ` +
        'shared disk between the two machines, so the bytes have to travel before ' +
        'ComfyUI can load them.')
      sourceName = await uploadSource(job)
    }

    // A region named in words becomes a mask HERE, on the GPU box, where the
    // segmentation models are. Done inside the job rather than up front so the
    // frame on screen says what is happening, and so a description nothing in
    // the picture matches fails the job with a sentence instead of quietly
    // repainting everything.
    let maskName = ''
    if (job.source && job.region && !job.maskFile) {
      push(job, 'finding the part',
        `Looking for "${job.region}" in the picture. GroundingDINO finds it from the words and ` +
        'Segment Anything traces its outline; only that outline will be repainted.')
      const limit = maxCoverageFor(job.region)
      let found = await findRegion(sourceName, job.region, 0.3, job.sourceFile)
      if (found && found.coverage > limit) {
        // Too much of the picture for what was named: ask again, stricter.
        // The segmenter returns its best box even for a thing that is not
        // there, and a higher threshold is what makes it say "nothing".
        console.log(`[image] ${job.id} "${job.region}" matched ${(found.coverage * 100).toFixed(0)}% — retrying stricter`)
        push(job, 'finding the part', `"${job.region}" matched ${Math.round(found.coverage * 100)}% of the picture, which is too much for a part — looking again more strictly.`)
        found = await findRegion(sourceName, job.region, 0.5, job.sourceFile)
      }
      if (!found || found.coverage < 0.002) {
        throw new Error(`could not find "${job.region}" in the picture — it may not be there yet; try naming it differently, or paint the part by hand`)
      }
      if (found.coverage > limit) {
        throw new Error(`"${job.region}" matched ${Math.round(found.coverage * 100)}% of the picture, too much for a part — it is probably not in the picture; name something that is, or paint the part by hand`)
      }
      job.mask = found.id
      job.maskFile = found.file
      maskName = found.uploaded
      console.log(`[image] ${job.id} region "${job.region}" → mask ${found.id} covering ${(found.coverage * 100).toFixed(1)}%`)
    } else if (job.maskFile) {
      maskName = await uploadMask(job)
    }

    const graph = buildGraph(job, sourceName, maskName)
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
    // The size the picture actually came back at wins over the one computed at
    // queue time. They agree for a fresh render; for an edit or a resized
    // redraw the graph's own scaling node had the final say, and the number
    // stored against the picture must be the number in its header.
    const real = pngSize(bytes)
    if (real && (real.width !== job.width || real.height !== job.height)) {
      console.log(`[image] ${job.id} came back ${real.width}×${real.height} (expected ${job.width}×${job.height})`)
      job.width = real.width
      job.height = real.height
    }
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
      // The GPU's time, not the wall clock. A prompt rewrite is several seconds
      // of a DIFFERENT model on a different box, and folding it in here would
      // teach the estimator that this style is slower than it is — so the bar
      // would drift with a toggle rather than with the hardware, which is the
      // whole failure image-timing.ts was written to end.
      ms:     Math.max(1, took - job.improveMs),
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
function sdxlAnimeGraph(
  ckpt: string, steps: number, cfg: number, sampler: string, scheduler: string,
): ComfyGraph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    // 832x1216 is a trained-resolution bucket BOTH of these models list; the job
    // overwrites it anyway, so this is only the shape of the default.
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
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

/**
 * FLUX.1 Kontext dev — an EDITOR, not a painter.
 *
 * Transcribed from ComfyUI's own `flux_kontext_dev_basic` template with its
 * frontend subgraph flattened and its second, bypassed LoadImage + ImageStitch
 * (the two-picture input) dropped. It is the answer to the thing plain img2img
 * cannot do: "this exact picture, but at night". img2img is SDEdit — the
 * source is noised part-way and repainted from the PROMPT, so the prompt has to
 * describe the whole picture and the composition is all that survives. Kontext
 * is handed the source as a reference latent alongside the conditioning
 * (`ReferenceLatent`), reads the prompt as an INSTRUCTION, and keeps whatever
 * the instruction does not touch — the face, the pose, the lighting, the text
 * on the sign. Which is why its sampler runs `denoise: 1` on the encoded source
 * and there is no strength to choose: the model decides what to keep from what
 * you said, not from how much noise was added.
 *
 * Three things follow that buildGraph has to honour, and does through
 * `styleEdits()`: the source goes into THIS graph's own LoadImage rather than
 * being spliced in as a latent, `denoise` is left alone, and there is no size
 * to set — `FluxKontextImageScale` resizes the source to the nearest of the
 * model's published resolutions (~1 MP), which is what `kontextSize()` mirrors
 * at queue time so the frame's size text is right before the render starts.
 *
 * Same FLUX-family facts as fluxGraph(): guidance-distilled, so cfg 1 on the
 * sampler and the real dial on FluxGuidance (2.5 is the template's number,
 * lower than dev's 3.5 because an editor that is pushed hard drifts away from
 * its reference); the "negative" is a ConditioningZeroOut of the positive; two
 * text encoders, CLIP-L and T5. The published fp8 checkpoint is already scaled,
 * so `weight_dtype` stays `default` — casting it again would be wrong.
 * It reuses FLUX dev's own encoder and VAE files, so a box with dev installed
 * needs exactly one more download.
 */
function kontextGraph(): ComfyGraph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev-kontext_fp8_scaled.safetensors', weight_dtype: 'default' } },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp8_e4m3fn.safetensors', type: 'flux', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    // Filled in by buildGraph with the uploaded source's name. Empty here so a
    // graph that somehow reaches the GPU without one fails loudly in ComfyUI
    // rather than editing a stale file from a previous render.
    '5': { class_type: 'LoadImage', inputs: { image: '' } },
    '6': { class_type: 'FluxKontextImageScale', inputs: { image: ['5', 0] } },
    '7': { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: ['3', 0] } },
    // The source, as conditioning: this is what makes it an edit of THAT
    // picture rather than a repaint over its silhouette.
    '8': { class_type: 'ReferenceLatent', inputs: { conditioning: ['4', 0], latent: ['7', 0] } },
    '9': { class_type: 'FluxGuidance', inputs: { guidance: 2.5, conditioning: ['8', 0] } },
    '10': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '11': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['9', 0], negative: ['10', 0], latent_image: ['7', 0],
      },
    },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { filename_prefix: 'touchsphere', images: ['12', 0] } },
  }
}

/**
 * The resolutions Kontext was trained at, as ComfyUI's FluxKontextImageScale
 * node lists them. The node picks the one whose aspect is closest to the
 * source's; this does the same sum at queue time so the job carries the size
 * the picture will actually come back at rather than the source's.
 */
const KONTEXT_SIZES: [number, number][] = [
  [672, 1568], [688, 1504], [720, 1456], [752, 1392], [800, 1328], [832, 1248],
  [880, 1184], [944, 1104], [1024, 1024], [1104, 944], [1184, 880], [1248, 832],
  [1328, 800], [1392, 752], [1456, 720], [1504, 688], [1568, 672],
]
function kontextSize(width: number, height: number): { width: number; height: number } {
  const aspect = width / Math.max(1, height)
  let best = KONTEXT_SIZES[8]!
  let miss = Infinity
  for (const [w, h] of KONTEXT_SIZES) {
    const d = Math.abs(aspect - w / h)
    if (d < miss) { miss = d; best = [w, h] }
  }
  return { width: best[0], height: best[1] }
}

/**
 * Anima's published positive prefix and negative, straight off its model card.
 *
 * These were simply absent, which meant every Anima render was being driven
 * with the house English negative ("text, watermark, signature, blurry…") — a
 * prose string aimed at a model trained on Danbooru tags and score tags, so the
 * slot was being spent on words the encoder had little use for.
 *
 * Base and Turbo take the score tags; AESTHETIC DOES NOT, and that is the card
 * being specific rather than us being clever: it is fine-tuned on high quality
 * images with the quality tags stripped from the captions, and its author says
 * to leave score_* out of BOTH the positive and the negative because they
 * "push it too hard into slop territory". Two constants rather than one for
 * exactly that reason.
 */
const ANIMA_PREFIX = { positive: 'masterpiece, best quality, score_7, safe, ', negative: '' }
// `nsfw` is the one addition to the card's verbatim recommended negative, and it
// comes from the same card: the Limitations section says the model "may generate
// undesired content, especially if the prompt is short" and to avoid it "by
// using the appropriate safety tags in the positive AND negative prompts". The
// positive prefix already carries `safe`; this is the other half. Same reasoning
// as `safe` in NoobAI's prefix — on a kiosk the assistant draws on unprompted,
// that tag is doing real work.
const ANIMA_NEGATIVE =
  'nsfw, worst quality, low quality, score_1, score_2, score_3, artist name, blurry, ' +
  'jpeg artifacts, chromatic aberration'

/** The aesthetic fine-tune's pair: same idea, no score tags on either side. */
const ANIMA_AES_PREFIX = { positive: 'masterpiece, best quality, safe, ', negative: '' }
const ANIMA_AES_NEGATIVE =
  'nsfw, worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration'

/**
 * Anima's prompting guidance, shared by all three variants because all three
 * share the Qwen-3 encoder that decides it. Turbo differs in step count, not in
 * how you talk to it.
 */
const ANIMA_PROMPT_GUIDE =
  'This model was trained on Danbooru tags, natural-language captions AND mixtures of ' +
  'the two, so either register works and you should keep whichever one the user wrote ' +
  'in rather than converting it. If writing tags: lowercase, and SPACES rather than ' +
  'underscores (score_* tags are the only ones that keep underscores). An artist tag ' +
  'MUST be written with an @ in front of it — "@artist name" — or its effect is very ' +
  'weak. Tag order is quality/meta/year/safety, then subject count (1girl, 1boy), then ' +
  'character, then series, then artist, then everything else. If writing plain English: ' +
  'use at least two sentences, because very short prompts give unexpected results, and ' +
  'when you name a character describe their appearance too rather than relying on the ' +
  'name alone — that matters most with more than one character in the picture. Prompt ' +
  'weighting works but needs higher weights than SDXL, e.g. (chibi:2). Do not add ' +
  'quality tags yourself; they are added for you.'

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
   * How THIS model asks to be prompted, in the words its own card uses.
   *
   * `promptStyle` above is the one-bit version, and one bit is all the system
   * prompt needs to stop the assistant writing sentences at a booru model. This
   * is the long version, and it exists because the prompt improver is a model
   * being asked to write a good prompt for a model — a job it cannot do from
   * "tags" or "prose" alone. It wants to know that FLUX rewards a paragraph and
   * has no negative, that NoobAI wants the character tag AND its series, that
   * Anima reads Qwen-3 prose. Taken from each model's published guidance rather
   * than invented, exactly like the sampler settings beside it.
   *
   * Falls back to a generic line per promptStyle, so a style that says nothing
   * still improves sensibly and a workflow dropped on the volume needs no entry.
   */
  promptGuide?: string
  /**
   * Booster text APPENDED to the positive prompt, after whatever the user or
   * the improver wrote.
   *
   * The sibling of `prefixes`, and separate from it because position is not a
   * preference here — it is published. NoobAI's card calls its quality ladder a
   * "Prompt Prefix" and Anima's calls its own a "recommended positive prefix",
   * so for those models the ladder stays in `prefixes` where the card puts it
   * and this field is empty; SDXL-family attention weights the front of a
   * prompt most heavily, so quietly relocating a documented prefix to the end
   * would weaken it while looking like a tidy-up.
   *
   * What this field is for is everything a model wants at the END, and for
   * whatever the user decides they always want on every picture — it is
   * overridable per style in Settings → Drawing, which is the real point of it.
   */
  optimizations?: string
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
  /**
   * True for a style that EDITS a picture rather than drawing one: it has a
   * LoadImage of its own that the source goes into, wants the prompt as an
   * instruction ("make it night"), and has no strength to choose because it
   * decides what to keep from the words rather than from how much noise was
   * added. Such a style cannot draw from nothing — startImage() refuses a job
   * with no source, and the Draw panel says so instead of offering "Draw it".
   */
  edits?: boolean
}> = {
  'flux1-dev': {
    label: 'FLUX.1 dev',
    graph: fluxGraph('flux1-dev.safetensors', 'fp8_e4m3fn', 't5xxl_fp8_e4m3fn.safetensors'),
    // T5-XXL reads sentences. Feeding a booru tag list to the model with the
    // best prose comprehension of anything installed here is the inverse of
    // the mistake promptStyle exists to stop.
    promptStyle: 'prose',
    promptGuide:
      'Write one flowing paragraph of plain English, never tags. This model reads ' +
      'sentences through a T5-XXL text encoder and rewards detail, so name the subject ' +
      'and what it is doing, then the setting, the lighting, the lens or camera angle if ' +
      'it matters, the mood, and the art style. Long, specific prompts beat short ones. ' +
      'It renders legible text, so put any words that should appear in the picture in ' +
      'quotes. There is NO negative prompt, so never write what you do not want — only ' +
      'ever describe what you do want.',
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
  'flux-kontext-dev': {
    label: 'FLUX Kontext (edit)',
    graph: kontextGraph(),
    edits: true,
    promptStyle: 'prose',
    // Black Forest Labs' own Kontext prompting guide, condensed. The whole of
    // it is about being specific about the change and explicit about what is
    // NOT to change, because that is the axis this model actually has.
    promptGuide:
      'This model EDITS the picture it is shown, so the prompt is an instruction, not a ' +
      'description of a scene. Say what to change in plain English, precisely: "change the ' +
      'car to red", "make it night time", "put a straw hat on the cat". Name the subject ' +
      'explicitly ("the woman in the red coat", never "her"). Say what should stay: "while ' +
      'keeping everything else the same", "keep the same facial features, pose and ' +
      'expression", "maintain the original composition". For a style change name the ' +
      'style and its traits: "convert to a watercolour painting with soft washes and visible ' +
      'paper texture". Put any text to add or replace in quotes. Do not describe the parts of ' +
      'the picture that are not changing, and never write a full scene description — that ' +
      'reads as a request to repaint everything.',
    // No `negative`, no prefix, no booster: an instruction with "masterpiece,
    // best quality" glued on is an instruction to change the quality tags.
    needs: [
      'diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors',
      'text_encoders/clip_l.safetensors',
      'text_encoders/t5xxl_fp8_e4m3fn.safetensors',
      'vae/ae.safetensors',
    ],
  },
  'animagine-xl-4': {
    label: 'Animagine XL 4.0',
    // Card: "CFG Scale: 4-7 (5 Recommended)", "Sampling Steps: 25-28 (28
    // Recommended)", "Preferred Sampler: Euler Ancestral". As a bare checkpoint
    // this rendered through the default SDXL graph at cfg 8 / euler / normal —
    // three settings wrong at once, which is exactly the "this model is bad"
    // reading that NoobAI's entry was created to stop.
    graph: sdxlAnimeGraph('animagine-xl-4.0.safetensors', 28, 5, 'euler_ancestral', 'normal'),
    // THE distinguishing case for the `optimizations` field. Every other style
    // here documents its boosters as a prefix; Animagine's card says, in its
    // own words, "Add these tags at the end of your prompt" — and its prompt
    // structure literally ends "...and end with quality enhancement". This is
    // the model that makes an appended slot necessary rather than tidy.
    optimizations: 'masterpiece, high score, great score, absurdres',
    negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, ' +
      'extra digits, fewer digits, cropped, worst quality, low quality, low score, ' +
      'bad score, average score, signature, watermark, username, blurry',
    promptStyle: 'tags',
    promptGuide:
      'Write lowercase Danbooru tags separated by commas, with SPACES rather than ' +
      'underscores, in this order: subject count (1girl, 1boy, 1other), then the ' +
      'character name, then the series it is from, then the rating, then everything ' +
      'else in any order. Parentheses in a character or series name are escaped, as in ' +
      'firefly \\(honkai: star rail\\). Score tags steer this model harder than plain ' +
      'quality tags do. Do not add the quality tags yourself — they are appended for you.',
    supersedes: 'animagine-xl-4.0.safetensors',
    needs: ['checkpoints/animagine-xl-4.0.safetensors'],
  },
  'noobai-xl-v11': {
    label: 'NoobAI XL v1.1',
    // Model card: CFG 5-6, Steps 25-30, Euler a.
    graph: sdxlAnimeGraph('NoobAI-XL-v1.1.safetensors', 28, 5.5, 'euler_ancestral', 'normal'),
    // Straight off the model card: quality ladder in front, booru terms behind.
    // `safe` is doing real work on a kiosk the assistant draws on unprompted.
    prefixes: {
      positive: 'masterpiece, best quality, newest, absurdres, highres, safe, ',
      negative: '',
    },
    // Verbatim from the model card's "Negative Prompt" block. The last six tags
    // were missing for a while, which is exactly the half that stops an anime
    // model drifting into furry/anthro output on an ambiguous prompt — a gap
    // that shows up as "why did it draw that" rather than as an error.
    negative: 'nsfw, worst quality, old, early, low quality, lowres, signature, ' +
      'username, logo, bad hands, mutated hands, mammal, anthro, furry, ' +
      'ambiguous form, feral, semi-anthro',
    promptStyle: 'tags',
    promptGuide:
      'Write lowercase Danbooru tags separated by commas, never sentences. Lead with the ' +
      'subject count and framing (1girl, solo, upper body), then — for a named character — ' +
      'its booru tag AND its series, both underscored (haruno_sakura, naruto_(series)), ' +
      'then appearance, clothing, pose, expression, background and lighting tags. An ' +
      'artist tag written as "by <artist>" steers the style hard. The quality ladder is ' +
      'already prepended for you, so do not repeat masterpiece or best quality.',
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
    promptGuide:
      'Write lowercase Danbooru tags separated by commas. This is an anime fine-tune and ' +
      'answers to character tags directly (hatsune_miku, vocaloid), so name the character ' +
      'and its series rather than describing the look. Lead with subject count and ' +
      'framing, then appearance, clothing, pose and background. A short natural-language ' +
      'clause about the scene at the end is fine. Do not write an instruction line — the ' +
      'model is instruction-tuned and its system line is added for you.',
    // The Neta Lumina prompt book's own recommendation, and the one style here
    // whose booster genuinely belongs at the END: its `prefixes` slot is already
    // taken by the instruction line the model was trained to be addressed with,
    // and nothing may come between that and `<Prompt Start>`.
    optimizations: 'best quality',
    supersedes: 'NetaYumev35_pretrained_all_in_one.safetensors',
    // One file, unlike Anima's three — it is an all-in-one checkpoint.
    needs: ['checkpoints/NetaYumev35_pretrained_all_in_one.safetensors'],
  },
  'anima-aesthetic-v1-1': {
    label: 'Anima Aesthetic v1.1',
    promptStyle: 'prose',
    promptGuide: ANIMA_PROMPT_GUIDE,
    prefixes: ANIMA_AES_PREFIX,
    negative: ANIMA_AES_NEGATIVE,
    graph: animaGraph('anima-aesthetic-v1.1.safetensors', 30, 4),
    turboHints: ['anima', 'turbo'],
    needs: ['diffusion_models/anima-aesthetic-v1.1.safetensors', ...ANIMA_SHARED],
  },
  'anima-turbo-v1-1': {
    label: 'Anima Turbo v1.1',
    promptStyle: 'prose',
    promptGuide: ANIMA_PROMPT_GUIDE,
    prefixes: ANIMA_PREFIX,
    // Kept even though this style samples at cfg 1, where classifier-free
    // guidance — and therefore the negative — does nothing at all. It costs one
    // encode and it is the right string the moment anyone raises cfg in
    // Advanced. Settings → Drawing says so on the row rather than leaving a
    // field that looks live and isn't.
    negative: ANIMA_NEGATIVE,
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
    promptGuide: ANIMA_PROMPT_GUIDE,
    prefixes: ANIMA_PREFIX,
    negative: ANIMA_NEGATIVE,
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
  return withSafety(BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.negative ?? '')
}

// ── Safety tags ──────────────────────────────────────────────────────────────
//
// Several built-in prefixes carry the booru rating tag `safe` and several
// built-in negatives lead with `nsfw`. They are there because the assistant
// draws on a kiosk unprompted (see the NoobAI and Anima entries). They are
// also why "swap the shirt for a bikini" fights the model: on the booru scale
// swimwear is `sensitive`, so `safe` in the prefix pushes against it. This is
// the user's call, so it is one switch — off strips those tags from every
// style's BUILT-IN text; a prefix or negative the user typed is theirs and is
// never touched. Read per call like the quality preset, so flipping it
// reaches the next picture.

const SAFETY_TAGS = new Set(['safe', 'nsfw', 'sfw', 'rating:safe', 'rating:general', 'rating:s', 'rating:g'])

function safetyFile(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'image-safety.json')
}

/** Whether the built-in safety tags are added. Default on. */
export function safeTagsOn(): boolean {
  try {
    const v = (JSON.parse(fs.readFileSync(safetyFile(), 'utf8')) as { safeTags?: unknown }).safeTags
    return v !== false
  } catch {
    return true
  }
}

export function setSafeTags(on: boolean): void {
  const dir = path.dirname(safetyFile())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = safetyFile()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ safeTags: on }, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    console.log(`[image] built-in safety tags ${on ? 'on' : 'OFF'}`)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[image] failed to save the safety-tag switch:', err)
  }
}

/**
 * Strip the safety tags out of a comma-separated built-in string, keeping
 * its shape: a prefix that ended in ", " still does, so joinPrefix() sees
 * what it always saw.
 */
export function stripSafetyTags(text: string): string {
  if (!text) return text
  const trailing = /,\s*$/.test(text) ? ', ' : ''
  const items = text.split(',').map(x => x.trim()).filter(x => x.length > 0 && !SAFETY_TAGS.has(x.toLowerCase()))
  return items.length ? items.join(', ') + trailing : ''
}

/** A built-in string as the switch says it should be. */
function withSafety(text: string): string {
  return safeTagsOn() ? text : stripSafetyTags(text)
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

/**
 * Generic prompting guidance for a style that names none of its own.
 *
 * A plain checkpoint dropped in the models folder gets one of these, which is
 * the honest amount to say about a model this app knows nothing about beyond
 * whether it is tag-trained.
 */
const GENERIC_PROMPT_GUIDES: Record<'tags' | 'prose', string> = {
  tags:
    'Write lowercase Danbooru-style tags separated by commas, not sentences. Lead with ' +
    'subject count and framing (1girl, solo), then the character tag and its series if ' +
    'there is one, then appearance, clothing, pose, background and lighting.',
  prose:
    'Write a comma-separated English description with the most important idea first: ' +
    'the subject, then the setting, the lighting, the art style and any quality words. ' +
    'Stable Diffusion weights the front of a prompt most heavily, so put what matters ' +
    'at the start and keep the whole thing to roughly 75 words.',
}

/**
 * How the chosen model asks to be prompted, in full sentences.
 *
 * This is what makes the prompt improver model-aware: the same user template
 * produces booru tags in front of NoobAI and a T5 paragraph in front of FLUX,
 * because the half of the system prompt that describes the target model is
 * substituted from here rather than typed by the user. See image-prompt.ts.
 */
export function stylePromptGuide(style: string): string {
  if (style.startsWith(WORKFLOW_PREFIX)) {
    const own = BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.promptGuide
    if (own) return own
  }
  return GENERIC_PROMPT_GUIDES[stylePromptStyle(style)]
}

/**
 * Booster text a style wants appended, before any per-style override.
 *
 * Empty for most of them, and that is a statement rather than a gap: where a
 * model's card puts its quality tags in FRONT they live in `prefixes`, and
 * where a model's guidance is to describe what you want instead of appending
 * tags at all — FLUX, whose encoder is T5 and which has no negative to balance
 * them against — the honest default is nothing. Settings → Drawing shows the
 * user which of those two applies to the style they are looking at, and lets
 * them append their own either way.
 */
/**
 * The negative a style will actually use when nobody overrides it.
 *
 * Resolves the same chain the render does, so the Settings placeholder shows
 * the string that is really in effect rather than the style's own field, which
 * is empty for most of them and would read as "no negative at all".
 */
export function styleNegativeFor(style: string): string {
  return styleNegative(style) || DEFAULT_NEGATIVE
}

/**
 * Whether this style's negative prompt reaches a text node of its own.
 *
 * False for FLUX, whose sampler's negative is a ConditioningZeroOut of the
 * positive — there is no second encode and nothing a negative could be written
 * into. Black Forest Labs say so directly: describe what you want, not what you
 * don't. Settings uses this to say the field does not apply rather than showing
 * an editable box whose contents can never affect a picture, which is the same
 * silent-override failure the per-style params exist to avoid.
 *
 * Distinct from a style that merely samples at cfg 1 (Anima Turbo): there the
 * negative IS encoded and would take effect the moment guidance is raised, so
 * that one gets a warning rather than a disabled field.
 */
export function styleUsesNegative(style: string): boolean {
  const graph = style.startsWith(WORKFLOW_PREFIX)
    ? workflowGraph(style.slice(WORKFLOW_PREFIX.length))
    : baseGraph()
  if (!graph) return true
  const samplerId = findNode(graph, ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  if (!samplerId) return true
  const inputs = graph[samplerId]!.inputs
  const linked = (key: string): string | null => {
    const v = inputs[key]
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
  }
  const posId = conditioningText(graph, linked('positive'))
  const negId = conditioningText(graph, linked('negative'))
  // The same identity test buildGraph uses before it writes: landing on the
  // positive's own text node means there is no separate negative.
  return !!negId && negId !== posId
}

/** The lead-in a style's card puts IN FRONT of every prompt. '' for most. */
export function stylePrefixFor(style: string): string {
  return withSafety(stylePrefixes(style).positive)
}

/** The lead-in in front of the NEGATIVE. Only instruction-tuned models ship one. */
export function styleNegativePrefixFor(style: string): string {
  return withSafety(stylePrefixes(style).negative)
}

export function styleOptimizations(style: string): string {
  if (!style.startsWith(WORKFLOW_PREFIX)) return ''
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.optimizations ?? ''
}

/**
 * Glue a booster onto a prompt without producing ", , " or a trailing comma.
 *
 * Worth a function because both halves are user-editable text: a prompt that
 * already ends in a comma and an optimization that starts with one are both
 * things people type, and an empty tag in a booru prompt is not harmless — it
 * is one more token the encoder spends on nothing.
 */
export function joinPrompt(base: string, extra: string): string {
  // Commas AND the whitespace around them, from both ends of both halves. The
  // first version stripped a leading comma but left the space behind it, so
  // ", cinematic lighting" appended as "a red fox,  cinematic lighting" — a
  // double space that a tag parser reads as an empty tag.
  const strip = (t: string) => t.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '')
  const a = strip(base)
  const b = strip(extra)
  if (!b) return a
  if (!a) return b
  return `${a}, ${b}`
}

/**
 * Glue a lead-in onto the front of a prompt.
 *
 * Separate from joinPrompt because a prefix is not always a tag list. The two
 * shapes shipped here end differently on purpose:
 *
 *   NoobAI    "masterpiece, best quality, newest, absurdres, highres, safe,"
 *   NetaYume  "...generate high quality anime images based on textual prompts. <Prompt Start>"
 *
 * The first wants a comma before the prompt; the second must NOT get one, since
 * `<Prompt Start>` is a separator the model was trained on and a comma after it
 * is a token it never saw there. This used to work only because the built-in
 * strings carried their own trailing separator and nothing else could reach the
 * field — now that the user can type one, guessing has to be done here instead
 * of hoping they remember a trailing space that a text box does not show.
 */
export function joinPrefix(prefix: string, body: string): string {
  const lead = prefix.trim()
  if (!lead) return body
  if (!body) return lead
  // Ends in sentence or marker punctuation → a space is the right separator.
  // Anything else is treated as a tag list, where a comma is.
  return /[>:.!?]$/.test(lead) ? `${lead} ${body}` : joinPrompt(lead, body)
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

/** True for a style that edits an existing picture rather than drawing one. */
export function styleEdits(style: string): boolean {
  if (!style.startsWith(WORKFLOW_PREFIX)) return false
  return BUILTIN_WORKFLOWS[style.slice(WORKFLOW_PREFIX.length)]?.edits === true
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
function buildGraph(job: ImageJob, sourceName = '', maskName = ''): ComfyGraph {
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
  // No style lookup here any more: startImage() resolved the four text fields
  // against the user's overrides when the job was queued, and re-deriving them
  // from the style at render time would quietly ignore every one of them.
  if (posId && graph[posId] && 'text' in graph[posId]!.inputs) {
    // prefix + what was asked for + booster, in that order. The booster goes
    // LAST rather than into the prefix because the prefix is where a model's
    // card puts its own documented lead-in — Lumina's instruction line has to
    // be first, and NoobAI's quality ladder is specified as a prefix — so the
    // user's "always add this" has to be a third position, not a fight with
    // either of them.
    graph[posId]!.inputs['text'] = joinPrefix(job.prefix, joinPrompt(job.prompt, job.optimizations))
  } else {
    throw new Error("workflow's positive prompt does not reach a text node")
  }
  // `negId !== posId` is load-bearing, not defensive. A style whose negative is
  // a ConditioningZeroOut of the POSITIVE (FLUX) resolves both links to the one
  // text node, and writing the negative there would replace the prompt with the
  // negative and draw a picture of everything the user didn't want. A negative
  // that is inert in the graph stays inert.
  if (negId && negId !== posId && graph[negId] && 'text' in graph[negId]!.inputs) {
    graph[negId]!.inputs['text'] = joinPrefix(job.negativePrefix, job.negative)
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
  if (sourceName && styleEdits(job.model)) {
    // An edit style brings its own LoadImage, wired through whatever the model
    // needs between it and the sampler (Kontext: a scale node, an encode and a
    // ReferenceLatent into the conditioning). Splicing the generic img2img
    // pair in here would hand the sampler the source twice and set a denoise
    // the model was not trained for — so the ONLY patch is the filename.
    const loadId = findNode(graph, ['LoadImage'])
    if (!loadId) throw new Error("this editing style's workflow has no LoadImage node to put the picture in")
    graph[loadId]!.inputs['image'] = sourceName
  } else if (sourceName) {
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
    // Fit the source to the size startImage() settled on — the style's
    // megapixel budget at the source's own shape — before it is encoded, so the
    // model works at the resolution it was trained at rather than at whatever
    // a phone camera produced. Skipped when the numbers already agree, which
    // is the case for redrawing one of this app's own renders at the same
    // budget. `center` crop rather than `disabled`: the budget size is snapped
    // to the grid, so the aspect is off by a few pixels, and a crop of those
    // beats a stretch of them.
    let pixels: [string, number] = [loadId, 0]
    if (job.sourceWidth > 0 && (job.width !== job.sourceWidth || job.height !== job.sourceHeight)) {
      const scaleId = 'touchsphere_source_scale'
      graph[scaleId] = {
        class_type: 'ImageScale',
        inputs: { image: pixels, upscale_method: 'lanczos', width: job.width, height: job.height, crop: 'center' },
      }
      pixels = [scaleId, 0]
    }
    graph[encId]  = { class_type: 'VAEEncode', inputs: { pixels, vae } }
    sampler.inputs['latent_image'] = [encId, 0]

    // ── Change only the marked part ──
    //
    // Inpainting, on any model this app can select, by three additions to the
    // img2img graph above rather than a separate one:
    //
    //   1. SetLatentNoiseMask tells the sampler which latent cells it may
    //      change; the rest are held to the source at every step. The mask is
    //      grown a few pixels with tapered corners so the seam is blended
    //      rather than cut.
    //   2. DifferentialDiffusion is patched onto the model so a soft mask edge
    //      means a soft handover, not a hard one. It is a model patch, so the
    //      turbo LoRA splice further down wraps it correctly.
    //   3. ImageCompositeMasked pastes the decoded result back over the ORIGINAL
    //      pixels through the same mask, so everything outside it is not
    //      "barely changed" but byte-identical. The VAE round-trip alone would
    //      shift every unmasked pixel slightly, which reads as the whole picture
    //      having been touched.
    //
    // The mask arrives as a PNG the size of the SOURCE (white = change), so it
    // is scaled to the render size with the same crop the source got, and read
    // through ImageToMask on the red channel.
    if (maskName) {
      const mLoadId = 'touchsphere_mask_image'
      graph[mLoadId] = { class_type: 'LoadImage', inputs: { image: maskName } }
      let maskImg: [string, number] = [mLoadId, 0]
      if (job.sourceWidth > 0 && (job.width !== job.sourceWidth || job.height !== job.sourceHeight)) {
        graph['touchsphere_mask_scale'] = {
          class_type: 'ImageScale',
          // Bilinear, not nearest: a segmenter's outline scaled nearest-exact
          // arrives as a staircase, and the staircase is what the seam shows.
          inputs: { image: maskImg, upscale_method: 'bilinear', width: job.width, height: job.height, crop: 'center' },
        }
        maskImg = ['touchsphere_mask_scale', 0]
      }
      graph['touchsphere_mask'] = { class_type: 'ImageToMask', inputs: { image: maskImg, channel: 'red' } }
      // Two masks from one outline. The GROWN one (a few pixels out, rounded)
      // is what the sampler may paint — a little past the found edge, so a
      // new garment can reach its own outline. The FEATHERED one (the grown
      // mask blurred) is what the paste-back uses, so the handover from new
      // pixels to original is a gradient rather than a cut; a hard edge here
      // read as a jagged seam around the neck on the first anime test.
      graph['touchsphere_mask_soft'] = {
        class_type: 'GrowMask',
        inputs: { mask: ['touchsphere_mask', 0], expand: 10, tapered_corners: true },
      }
      graph['touchsphere_mask_soft_img'] = { class_type: 'MaskToImage', inputs: { mask: ['touchsphere_mask_soft', 0] } }
      graph['touchsphere_mask_blur'] = {
        class_type: 'ImageBlur',
        inputs: { image: ['touchsphere_mask_soft_img', 0], blur_radius: 9, sigma: 4.5 },
      }
      graph['touchsphere_mask_feather'] = { class_type: 'ImageToMask', inputs: { image: ['touchsphere_mask_blur', 0], channel: 'red' } }
      const modelLink = sampler.inputs['model']
      if (Array.isArray(modelLink)) {
        graph['touchsphere_diff'] = { class_type: 'DifferentialDiffusion', inputs: { model: modelLink } }
        sampler.inputs['model'] = ['touchsphere_diff', 0]
      }
      graph['touchsphere_masked_latent'] = {
        class_type: 'SetLatentNoiseMask',
        inputs: { samples: [encId, 0], mask: ['touchsphere_mask_soft', 0] },
      }
      sampler.inputs['latent_image'] = ['touchsphere_masked_latent', 0]

      // Whatever the graph saves, save the composite instead.
      const saveId = findNode(graph, ['SaveImage', 'PreviewImage'])
      if (saveId && Array.isArray(graph[saveId]!.inputs['images'])) {
        graph['touchsphere_composite'] = {
          class_type: 'ImageCompositeMasked',
          inputs: {
            destination: pixels,
            source: graph[saveId]!.inputs['images'],
            x: 0, y: 0, resize_source: false,
            mask: ['touchsphere_mask_feather', 0],
          },
        }
        graph[saveId]!.inputs['images'] = ['touchsphere_composite', 0]
      }
    }

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

    // ── Keep the pose: a ControlNet on the source's own edges ──
    //
    // The sampler is otherwise free to reinvent whatever is inside the mask,
    // and at any useful strength it does — a "pink jacket" over a lying
    // figure came back with the arm, the hand and the shoulder moved. Canny
    // edges of the source, fed through a ControlNet, hold every contour
    // where it is while the model decides what the surfaces are. Canny is a
    // core node, so no preprocessor pack is needed; on anime line art the
    // edge map IS the line art, which is the best case for it.
    //
    // Spliced by rewiring, like the LoRA: whatever fed the sampler's positive
    // and negative goes through ControlNetApplyAdvanced first. Only for a
    // graph with a CheckpointLoaderSimple — the SDXL family the installed
    // union model fits; Anima, Lumina and FLUX have their own architectures
    // and a mismatched ControlNet fails with a shape error, so they get the
    // redraw without it and the detail says so.
    if (job.controlnet && findNode(graph, ['CheckpointLoaderSimple', 'CheckpointLoader'])) {
      const pos = sampler.inputs['positive'], neg = sampler.inputs['negative']
      if (Array.isArray(pos) && Array.isArray(neg)) {
        // The control image: what the ControlNet is asked to hold.
        //   lines — the source's edges (core Canny). Holds everything,
        //           garments included; right for recolours and materials.
        //   body  — its depth map. Holds the volume and the pose while the
        //           surfaces are free; right for swapping or removing clothes.
        //   pose  — its skeleton. Holds only where the limbs are.
        if (job.hold === 'body' && job.depthCkpt) {
          graph['touchsphere_edges'] = {
            class_type: HOLD_NODES.body,
            inputs: { image: pixels, ckpt_name: job.depthCkpt, resolution: 1024 },
          }
        } else if (job.hold === 'pose' && job.poseDetector && job.poseEstimator) {
          graph['touchsphere_edges'] = {
            class_type: HOLD_NODES.pose,
            inputs: {
              image: pixels, detect_hand: 'enable', detect_body: 'enable', detect_face: 'enable',
              resolution: 1024, bbox_detector: job.poseDetector, pose_estimator: job.poseEstimator,
            },
          }
        } else {
          job.hold = 'lines'
          graph['touchsphere_edges'] = {
            class_type: 'Canny',
            inputs: { image: pixels, low_threshold: job.cannyLow, high_threshold: job.cannyHigh },
          }
        }
        graph['touchsphere_controlnet'] = {
          class_type: 'ControlNetLoader',
          inputs: { control_net_name: job.controlnet },
        }
        // A union model has to be told which of its heads to use.
        graph['touchsphere_controlnet_type'] = {
          class_type: 'SetUnionControlNetType',
          inputs: {
            control_net: ['touchsphere_controlnet', 0],
            type: job.hold === 'body' ? 'depth' : job.hold === 'pose' ? 'openpose' : 'canny/lineart/anime_lineart/mlsd',
          },
        }
        graph['touchsphere_controlnet_apply'] = {
          class_type: 'ControlNetApplyAdvanced',
          inputs: {
            positive: pos, negative: neg,
            control_net: ['touchsphere_controlnet_type', 0],
            image: ['touchsphere_edges', 0],
            // Firm early, released for the rest: the structure decides the
            // layout, the model decides the surfaces and the fine detail.
            // Both numbers are the user's (Settings → Drawing).
            strength: job.holdStrength, start_percent: 0, end_percent: job.holdEnd,
            vae,
          },
        }
        sampler.inputs['positive'] = ['touchsphere_controlnet_apply', 0]
        sampler.inputs['negative'] = ['touchsphere_controlnet_apply', 1]
      }
    } else if (job.controlnet) {
      job.controlnet = ''
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
    // Present only when a rewrite actually happened — see ImageSettings. The
    // stored `prompt` is the rewritten one, because that is what the sampler
    // read and what "use as prompt" should hand back.
    ...(job.promptOriginal
      ? { promptOriginal: job.promptOriginal, improvedBy: job.improvedBy }
      : {}),
    // Recorded only when there was one, so its presence is the record — the
    // same rule as promptOriginal. Without it the stored prompt and the picture
    // disagree for no visible reason.
    ...(job.optimizations ? { optimizations: job.optimizations } : {}),
    ...(job.lora ? { lora: job.lora, loraStrength: job.loraStrength } : {}),
    ...(job.source ? { source: job.source, denoise: job.denoise } : {}),
    ...(job.maskFile ? { mask: true, ...(job.region ? { region: job.region } : {}) } : {}),
    ...(job.controlnet ? { controlnet: `${job.controlnet} · ${job.hold} ${Math.round(job.holdStrength * 100)}% to ${Math.round(job.holdEnd * 100)}%` } : {}),
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

// ── Masks: which part of a picture may change ────────────────────────────────
//
// A mask is a PNG the size of its source — white where the picture may be
// repainted, black where it must not — kept beside the gallery but NOT in it:
// it is not a picture anyone wants to see in a grid, and it is only meaningful
// against the one source it was drawn over. Two ways one comes to exist: the
// user paints it on the touchscreen (POST /api/image/mask), or names the part
// in words and findMask() has the GPU box find it. Both end up here, both go
// up to ComfyUI the same way the source does, and buildGraph() treats them
// identically.

function masksDir(): string {
  const dir = path.join(imagesDir(), 'masks')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Keep the newest few dozen; a mask is a one-shot thing and this is a small disk. */
const MAX_MASKS = 60

export interface StoredMask { id: string; file: string; width: number; height: number }

/** Store a mask PNG the client painted. Validated the way uploads are. */
export function saveMask(bytes: Buffer): StoredMask {
  const size = pngSize(bytes)
  if (!size) throw new Error('that mask could not be read as a PNG')
  const id = crypto.randomBytes(16).toString('hex')
  const file = `${id}.png`
  const dest = path.join(masksDir(), file)
  const tmp = `${dest}.tmp-${process.pid}`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, dest)
  // Oldest-first pruning by mtime, same idea as the gallery's cap.
  try {
    const all = fs.readdirSync(masksDir()).filter(f => /^[a-f0-9]{32}\.png$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(masksDir(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of all.slice(MAX_MASKS)) { try { fs.unlinkSync(path.join(masksDir(), old.f)) } catch { /* gone */ } }
  } catch { /* pruning is best-effort */ }
  return { id, file, width: size.width, height: size.height }
}

export function maskPath(file: string): string | null {
  const full = path.join(masksDir(), file)
  return fs.existsSync(full) ? full : null
}

/**
 * Decode a PNG far enough to measure it: how much of it is white, and where.
 *
 * Only what a MASK needs — 8-bit, non-interlaced, grey or RGB with or without
 * alpha — which is exactly what MaskToImage and a canvas both emit. Anything
 * else returns null and the caller treats the mask as unmeasured rather than
 * wrong. Written here rather than pulling in an image library because the
 * server image is built for linux/arm64 and every native dependency is a
 * cross-build to keep working.
 */
function maskCoverage(bytes: Buffer): { coverage: number; box: [number, number, number, number] } | null {
  const g = decodeGrey(bytes)
  if (!g) return null
  const { width: w, height: h, grey } = g
  let white = 0, minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grey[y * w + x]! > 127) {
        white++
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
  }
  return { coverage: white / (w * h), box: maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1] }
}

/**
 * How different two pictures are, 0 (identical) to 1, on a coarse grey grid.
 *
 * Both are sampled onto the same 96-wide grid by relative position, so a
 * source and its Kontext output (a different pixel size) compare directly.
 * Exists for one question: did an edit step actually change anything? An
 * editor told to keep everything keeps everything, and a plan must notice
 * that rather than hand the untouched picture to the next step.
 */
export function imageDifference(fileA: string, fileB: string): number | null {
  return imageChange(fileA, fileB)?.peak ?? null
}

/**
 * Mean cell difference AND the peak: the mean of the top 2% of cells.
 *
 * The peak is the number that answers "did anything happen". An editor's
 * untouched output still differs faintly everywhere (its own resize and VAE
 * round trip), while a real edit — even a small one, a recoloured fringe —
 * is a cluster of cells that changed a lot. Measured on real renders: an
 * untouched Kontext output has a mean of ~1.8% and a recoloured 1%-of-the-
 * picture fringe a mean of 0.3%, so the mean cannot tell them apart; the
 * peaks can.
 */
export function imageChange(fileA: string, fileB: string): { mean: number; peak: number } | null {
  let a: ReturnType<typeof decodeGrey>, b: ReturnType<typeof decodeGrey>
  try {
    a = decodeGrey(fs.readFileSync(path.join(imagesDir(), fileA)))
    b = decodeGrey(fs.readFileSync(path.join(imagesDir(), fileB)))
  } catch { return null }
  if (!a || !b) return null
  // Each cell is the AVERAGE of every pixel in it, not one sampled pixel:
  // a source and its output are different sizes, and nearest sampling reads
  // the resampling itself as ~4% difference, which is the size of a real
  // small edit. Averaged, an untouched picture measures well under 1%.
  // The two pictures may not be the same shape: an editor snaps its output to
  // one of its own resolutions, and whether it got there by stretching or by
  // a centre crop is not written anywhere. Both alignments are tried and the
  // one that makes the pictures agree MORE is used — an untouched output then
  // measures near zero under the right alignment, while a real edit stays a
  // real edit under either.
  const GW = 64, GH = Math.max(8, Math.round(GW * a.height / a.width))
  type Img = NonNullable<typeof a>
  // A window onto an image: the region of it the grid maps over.
  const cellOf = (img: Img, win: { x: number; y: number; w: number; h: number }, gx: number, gy: number): number => {
    const x0 = Math.floor(win.x + gx / GW * win.w), x1 = Math.max(x0 + 1, Math.floor(win.x + (gx + 1) / GW * win.w))
    const y0 = Math.floor(win.y + gy / GH * win.h), y1 = Math.max(y0 + 1, Math.floor(win.y + (gy + 1) / GH * win.h))
    let t = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) t += img.grey[y * img.width + x]!
    return t / ((x1 - x0) * (y1 - y0))
  }
  const full = (img: Img) => ({ x: 0, y: 0, w: img.width, h: img.height })
  // The centre crop of `img` that has `aspect`'s shape.
  const cropTo = (img: Img, aspect: number) => {
    const own = img.width / img.height
    if (Math.abs(own - aspect) < 1e-3) return full(img)
    if (own > aspect) { const w = Math.round(img.height * aspect); return { x: Math.round((img.width - w) / 2), y: 0, w, h: img.height } }
    const h = Math.round(img.width / aspect); return { x: 0, y: Math.round((img.height - h) / 2), w: img.width, h }
  }
  const candidates = [
    { wa: full(a), wb: full(b) },                                  // stretched to fit
    { wa: cropTo(a, b.width / b.height), wb: full(b) },            // A centre-cropped to B's shape
    { wa: full(a), wb: cropTo(b, a.width / a.height) },            // B centre-cropped to A's shape
  ]
  let best: { mean: number; peak: number } | null = null
  for (const { wa, wb } of candidates) {
    const diffs: number[] = []
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) diffs.push(Math.abs(cellOf(a, wa, gx, gy) - cellOf(b, wb, gx, gy)) / 255)
    }
    diffs.sort((x, y) => y - x)
    const top = Math.max(1, Math.round(diffs.length * 0.02))
    const peak = diffs.slice(0, top).reduce((t, v) => t + v, 0) / top
    const mean = diffs.reduce((t, v) => t + v, 0) / diffs.length
    if (!best || mean < best.mean) best = { mean, peak }
  }
  return best
}

/**
 * Decode an 8-bit non-interlaced PNG (grey, RGB, with or without alpha) to
 * one grey byte per pixel. Written here rather than pulling in an image
 * library because the server image is built for linux/arm64 and every native
 * dependency is a cross-build to keep working. Returns null for anything
 * fancier, and callers treat that as "unmeasured", never as an error.
 */
function decodeGrey(bytes: Buffer): { width: number; height: number; grey: Uint8Array } | null {
  const size = pngSize(bytes)
  if (!size) return null
  const depth = bytes[24], colour = bytes[25], interlace = bytes[28]
  if (depth !== 8 || interlace !== 0) return null
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 4 ? 2 : colour === 6 ? 4 : 0
  if (!channels) return null
  // Concatenate IDAT chunks.
  const idat: Buffer[] = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off); const type = bytes.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len))
    if (type === 'IEND') break
    off += 12 + len
  }
  let raw: Buffer
  try { raw = zlib.inflateSync(Buffer.concat(idat)) } catch { return null }
  const { width: w, height: h } = size
  const stride = w * channels
  if (raw.length < (stride + 1) * h) return null
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride)
  const grey = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      let v = line[i]!
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[i] = v & 255
    }
    for (let x = 0; x < w; x++) {
      const i = x * channels
      grey[y * w + x] = channels >= 3
        ? (cur[i]! * 299 + cur[i + 1]! * 587 + cur[i + 2]! * 114) / 1000
        : cur[i]!
    }
    prev.set(cur)
  }
  return { width: w, height: h, grey }
}

/**
 * How much of the picture a named part may plausibly be.
 *
 * "The jacket" matching 59% of the picture is not a jacket, it is the
 * segmenter returning its best box for a thing that is not there — which is
 * how a plan repainted a woman's hair pink. A part that is by nature most of
 * the picture (background, sky, wall, floor) is allowed to be.
 */
export function maxCoverageFor(region: string): number {
  // A box is asked for precisely when the thing is big: a person, an area.
  if (/(^|[+\-−–]\s*)(box|area)\s*:/i.test(region)) return 0.85
  if (/\b(background|backdrop|sky|wall|walls|floor|ground|room|scene|surroundings|landscape|water|sea|ocean|field|grass|snow|everything)\b/i.test(region)) return 0.92
  // A whole person or animal fills half of most portraits; "the woman" at 51%
  // was measured correct on a picture where "her upper body" at 51% was not.
  if (/\b(woman|man|girl|boy|person|people|character|figure|body|lady|guy|child|kid|dog|cat|horse|animal)\b/i.test(region)) return 0.85
  return 0.45
}

// ── Region algebra: "the woman - the face - the orange hair" ─────────────────
//
// The finder locates CONCRETE things — a striped top, a face, a woman — and
// cannot locate an area ("her upper body" returned the hair, twice). But the
// region a new garment needs IS an area: the body without the head. So a
// region may be several finds combined: ` + ` unions, ` - ` subtracts, in
// order, each a plain phrase for the finder. The combined mask is stored and
// uploaded like any other, so nothing downstream knows the difference.

function parseRegion(region: string): { what: string; op: 'add' | 'sub'; box: boolean }[] {
  const out: { what: string; op: 'add' | 'sub'; box: boolean }[] = []
  // Split on " + " / " - " (with the surrounding spaces, so a hyphenated word survives).
  const parts = region.split(/\s+([+\-−–])\s+/)
  let op: 'add' | 'sub' = 'add'
  for (const p of parts) {
    if (p === '+') { op = 'add'; continue }
    if (p === '-' || p === '−' || p === '–') { op = 'sub'; continue }
    // "box: her torso and arms" — located as a rectangle by the vision model
    // rather than traced by the segmenter. For areas and whole people.
    const m = /^(box|area)\s*:\s*(.+)$/i.exec(p.trim())
    const what = (m ? m[2]! : p).trim()
    if (what) out.push({ what, op, box: !!m })
  }
  return out
}

/** Minimal PNG writer for an 8-bit greyscale mask — the inverse of decodeGrey, and as small. */
function encodeGreyPng(width: number, height: number, grey: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    raw.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc = (buf: Buffer) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Find a region that may be several finds combined (see parseRegion). A single
 * plain phrase goes straight to findMask; anything with ` + ` or ` - ` is
 * resolved term by term and composed here.
 */
export async function findRegion(sourceRef: string, region: string, threshold = 0.3, sourceFile = ''): Promise<FoundMask | null> {
  const terms = parseRegion(region)
  if (terms.length === 0) return null
  if (terms.length === 1 && !terms[0]!.box) return findMask(sourceRef, terms[0]!.what, threshold)
  // The picture itself: for the vision model's boxes, and for the mask size.
  const entry = /^[a-f0-9]{32}$/.test(sourceRef) ? listImages().find(e => e.id === sourceRef) : undefined
  if (/^[a-f0-9]{32}$/.test(sourceRef) && !entry) throw new Error('that picture is not in the gallery')
  const file = sourceFile || entry?.file || ''
  const srcBytes = file ? fs.readFileSync(path.join(imagesDir(), file)) : null
  const size = srcBytes ? pngSize(srcBytes) : null
  // Upload the source once for all the segmenter terms; only when one is needed.
  let ref = sourceRef
  if (entry && terms.some(t => !t.box)) {
    ref = await uploadInput(`touchsphere-src-${entry.id}.png`, srcBytes!, 'source picture')
  }
  let acc: Uint8Array | null = null
  let w = 0, h = 0
  const ensure = (gw: number, gh: number) => {
    if (!acc) { acc = new Uint8Array(gw * gh); w = gw; h = gh }
    return gw === w && gh === h
  }
  for (const t of terms) {
    if (t.box) {
      if (!srcBytes || !size) { console.log(`[image] region box "${t.what}" skipped: no source bytes`); continue }
      const box = await locateBox(srcBytes, t.what)
      if (!box) { if (t.op === 'add') console.log(`[image] region box "${t.what}" not located`); continue }
      if (!ensure(size.width, size.height)) continue
      const x0 = Math.floor(box.left * w), x1 = Math.ceil(box.right * w)
      const y0 = Math.floor(box.top * h), y1 = Math.ceil(box.bottom * h)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) acc![y * w + x] = t.op === 'add' ? 255 : 0
      console.log(`[image] region ${t.op === 'add' ? '+' : '-'} box "${t.what}" (${(((x1 - x0) * (y1 - y0)) / (w * h) * 100).toFixed(1)}%)`)
      continue
    }
    const m = await findMask(ref, t.what, threshold)
    if (!m) {
      if (t.op === 'add') console.log(`[image] region term "${t.what}" found nothing`)
      continue
    }
    const full = maskPath(m.file)
    const g = full ? decodeGrey(fs.readFileSync(full)) : null
    if (!g) continue
    if (!ensure(g.width, g.height)) continue
    for (let i = 0; i < acc!.length; i++) {
      if (g.grey[i]! > 127) acc![i] = t.op === 'add' ? 255 : 0
    }
    console.log(`[image] region ${t.op === 'add' ? '+' : '-'} "${t.what}" (${(m.coverage * 100).toFixed(1)}%)`)
  }
  if (!acc) return null
  const bytes = encodeGreyPng(w, h, acc)
  const stored = saveMask(bytes)
  const measured = maskCoverage(bytes) ?? { coverage: 0, box: [0, 0, 0, 0] as [number, number, number, number] }
  const uploaded = await uploadInput(`touchsphere-mask-${stored.id}.png`, bytes, 'mask')
  console.log(`[image] region "${region}" → mask ${stored.id}, ${(measured.coverage * 100).toFixed(1)}% of the picture`)
  return { ...stored, ...measured, uploaded }
}

export function measureMask(file: string): { coverage: number; box: [number, number, number, number] } | null {
  const full = maskPath(file)
  if (!full) return null
  try { return maskCoverage(fs.readFileSync(full)) } catch { return null }
}

/** One multipart upload into ComfyUI's input directory; the name ComfyUI kept comes back. */
async function uploadInput(name: string, bytes: Buffer, what: string): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const res = await comfyFetch('/upload/image', { method: 'POST', body: form }, 60_000)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ComfyUI would not accept the ${what} (${res.status}): ${body.slice(0, 200)}`)
  }
  const j = await res.json().catch(() => ({})) as { name?: string; subfolder?: string }
  const saved = j.name ?? name
  return j.subfolder ? `${j.subfolder}/${saved}` : saved
}

async function uploadMask(job: ImageJob): Promise<string> {
  const full = maskPath(job.maskFile)
  if (!full) throw new Error('the mask for this edit is missing from this server')
  const ref = await uploadInput(`touchsphere-mask-${job.mask}.png`, fs.readFileSync(full), 'mask')
  console.log(`[image] ${job.id} uploaded mask as ${ref}`)
  return ref
}

// The exact class names comfyui_segment_anything registers. Checked against
// /object_info rather than assumed, so a box without the pack simply does not
// offer "find it by name" instead of failing every attempt with a bare
// "node not found".
const SEG_LOADER_DINO = 'GroundingDinoModelLoader (segment anything)'
const SEG_LOADER_SAM  = 'SAMModelLoader (segment anything)'
const SEG_SEGMENT     = 'GroundingDinoSAMSegment (segment anything)'

let segCache: { at: number; ok: boolean } | null = null
/** The last answer, synchronously — for the per-request system prompt line, which cannot await. */
export function segmentationCached(): boolean { return segCache?.ok ?? false }
/** Whether the GPU box can turn a description into a mask. Cached for a minute. */
export async function segmentationAvailable(): Promise<boolean> {
  if (!COMFY_URL) return false
  if (segCache && Date.now() - segCache.at < 60_000) return segCache.ok
  let ok = false
  try {
    const res = await comfyFetch(`/object_info/${encodeURIComponent(SEG_SEGMENT)}`, undefined, 8000)
    ok = res.ok && Object.keys(await res.json() as object).length > 0
  } catch { ok = false }
  segCache = { at: Date.now(), ok }
  return ok
}

let inpaintCache: { at: number; ok: boolean } | null = null
/** Whether the graph nodes a masked edit needs exist. Core ComfyUI has them; an old build might not. */
export async function inpaintAvailable(): Promise<boolean> {
  if (!COMFY_URL) return false
  if (inpaintCache && Date.now() - inpaintCache.at < 300_000) return inpaintCache.ok
  let ok = false
  try {
    const r = await Promise.all(['SetLatentNoiseMask', 'ImageCompositeMasked', 'ImageToMask', 'GrowMask']
      .map(n => comfyFetch(`/object_info/${n}`, undefined, 8000).then(x => x.ok).catch(() => false)))
    ok = r.every(Boolean)
  } catch { ok = false }
  inpaintCache = { at: Date.now(), ok }
  return ok
}

export interface FoundMask extends StoredMask { coverage: number; box: [number, number, number, number]; uploaded: string }

/**
 * Turn words into a mask on the GPU box: GroundingDINO finds the thing the
 * words name and Segment Anything traces it. The result comes back as a
 * white-on-black PNG, is stored like a painted mask, and is ALSO left in
 * ComfyUI's input directory under `uploaded` so a render that follows can
 * name it without a second round trip.
 *
 * `sourceRef` is the source as already uploaded to ComfyUI (a LoadImage name);
 * a gallery id is accepted too and uploaded here. Coverage is measured on the
 * way back so a description that matched nothing, or everything, can be said
 * out loud instead of quietly repainting the wrong amount.
 */
export async function findMask(sourceRef: string, what: string, threshold = 0.3): Promise<FoundMask | null> {
  if (!(await segmentationAvailable())) throw new Error('this GPU box cannot find parts by name — the Segment Anything node pack is not installed')
  let ref = sourceRef
  if (/^[a-f0-9]{32}$/.test(sourceRef)) {
    const entry = listImages().find(e => e.id === sourceRef)
    if (!entry) throw new Error('that picture is not in the gallery')
    ref = await uploadInput(`touchsphere-src-${entry.id}.png`, fs.readFileSync(path.join(imagesDir(), entry.file)), 'source picture')
  }
  const graph: ComfyGraph = {
    src:  { class_type: 'LoadImage', inputs: { image: ref } },
    dino: { class_type: SEG_LOADER_DINO, inputs: { model_name: 'GroundingDINO_SwinT_OGC (694MB)' } },
    sam:  { class_type: SEG_LOADER_SAM,  inputs: { model_name: 'sam_vit_b (375MB)' } },
    seg:  { class_type: SEG_SEGMENT, inputs: { sam_model: ['sam', 0], grounding_dino_model: ['dino', 0], image: ['src', 0], prompt: what.trim(), threshold } },
    m2i:  { class_type: 'MaskToImage', inputs: { mask: ['seg', 1] } },
    save: { class_type: 'SaveImage', inputs: { images: ['m2i', 0], filename_prefix: 'touchsphere-mask' } },
  }
  const promptId = await queuePrompt(graph)
  // A small poll of our own: awaitOutput() narrates into a render job, and this
  // is a side step with no frame of its own. Segmentation is seconds once the
  // two models are loaded; the first run downloads and loads them, so three
  // minutes is generous rather than tight.
  const deadline = Date.now() + 180_000
  let out: OutputRef | null = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    const res = await comfyFetch(`/history/${promptId}`, undefined, 10_000)
    if (!res.ok) continue
    const hist = await res.json() as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: OutputRef[] }> }>
    const h = hist[promptId]
    if (!h) continue
    if (h.status?.status_str === 'error') {
      // The useful sentence is buried in the execution_error message; the
      // rest is timestamps. Name the node too, since "which model broke" is
      // the first question.
      const errs = (h.status.messages ?? []).filter((m): m is [string, Record<string, unknown>] =>
        Array.isArray(m) && m[0] === 'execution_error' && typeof m[1] === 'object' && m[1] !== null)
      const e = errs[0]?.[1]
      const msg = e
        ? `${String(e['node_type'] ?? e['node_id'] ?? 'a node')}: ${String(e['exception_message'] ?? '').split(/\r?\n/)[0]}`
        : JSON.stringify(h.status.messages ?? []).slice(0, 300)
      throw new Error(`the GPU box could not segment the picture — ${msg}`)
    }
    const imgs = h.outputs?.['save']?.images
    if (imgs?.length) { out = imgs[0]!; break }
  }
  if (!out) throw new Error('finding the part took too long on the GPU box')
  const bytes = await downloadOutput(out)
  const stored = saveMask(bytes)
  const m = maskCoverage(bytes) ?? { coverage: 0, box: [0, 0, 0, 0] as [number, number, number, number] }
  // Left in ComfyUI's input dir under a stable name so the render can use it.
  const uploaded = await uploadInput(`touchsphere-mask-${stored.id}.png`, bytes, 'mask')
  console.log(`[image] found "${what}" → mask ${stored.id}, ${(m.coverage * 100).toFixed(1)}% of the picture`)
  return { ...stored, ...m, uploaded }
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
/**
 * Is our prompt still sitting in ComfyUI's queue, un-started?
 *
 * Needed because /history only gains an entry when a prompt FINISHES, so from
 * here "queued behind eleven other jobs" and "rendering right now" look
 * identical — and they must not, because only one of them should burn the
 * render deadline. Returns null when ComfyUI can't be asked, which the caller
 * treats as "assume it is running": erring towards timing out is safer than
 * erring towards waiting forever.
 */
async function stillQueued(promptId: string): Promise<boolean | null> {
  try {
    const res = await comfyFetch('/queue', undefined, 10_000)
    if (!res.ok) return null
    const q = await res.json() as {
      queue_pending?: unknown[][]
      queue_running?: unknown[][]
    }
    const idOf = (it: unknown[]): string => (typeof it[1] === 'string' ? it[1] : '')
    if ((q.queue_running ?? []).some(it => idOf(it) === promptId)) return false
    return (q.queue_pending ?? []).some(it => idOf(it) === promptId)
  } catch {
    return null
  }
}

/**
 * Drop our prompt from ComfyUI's queue.
 *
 * Called when we give up on a render, and it is the fix for a genuine death
 * spiral rather than tidiness. A timed-out job used to be abandoned while its
 * prompt stayed queued on the GPU box: the work still ran, nobody collected it,
 * and it made the queue deeper — so the NEXT render timed out sooner, leaving
 * another orphan behind it. Thirteen deep, every single render was failing
 * before it had started, and clearing the queue by hand was the only way out.
 */
async function dropFromQueue(promptId: string): Promise<void> {
  try {
    await comfyFetch('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    }, 10_000)
    console.log(`[image] dropped abandoned prompt ${promptId} from ComfyUI's queue`)
  } catch (err) {
    // Best effort: we are already on a failure path and the render is lost
    // either way. Saying so beats throwing a second error over the first.
    console.warn('[image] could not drop the abandoned prompt:', err instanceof Error ? err.message : err)
  }
}

async function awaitOutput(promptId: string, job: ImageJob): Promise<OutputRef> {
  // The deadline covers RENDERING, not queueing.
  //
  // ComfyUI is a shared box: its queue can hold work from another client, from
  // an earlier run of this server that was restarted mid-render, or simply from
  // the four pictures somebody asked for in a row. Counting that wait against a
  // render's own budget is what made a busy GPU fail every job it was given —
  // and each failure left its prompt in the queue, so the backlog grew with
  // every attempt. So the clock only advances while our prompt is not sitting
  // in the pending list, and a separate, far more generous budget bounds the
  // total so a genuinely stuck box still gives up eventually.
  let deadline = Date.now() + TIMEOUT_MS
  const hardStop = Date.now() + QUEUE_WAIT_MS
  let announcedRunning = false
  let announcedQueued = false

  while (Date.now() < deadline && Date.now() < hardStop) {
    await new Promise(r => setTimeout(r, POLL_MS))

    // Push the render deadline out for as long as we are still behind other
    // work. Checked before /history so a prompt that is merely waiting can
    // never consume the budget meant for drawing it.
    const queued = await stillQueued(promptId)
    if (queued === true) {
      deadline = Date.now() + TIMEOUT_MS
      if (!announcedQueued) {
        announcedQueued = true
        push(job, 'waiting for the GPU',
          'ComfyUI has accepted the job but is still working through other pictures ' +
          'ahead of it. The render clock has not started yet — this wait does not count ' +
          'against it, and the picture will begin as soon as the card is free.')
      }
      continue
    }

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
  // Whatever we do next, this prompt must not be left on the GPU box: see
  // dropFromQueue. Awaited so the slot is actually free before the next job in
  // our own chain is submitted.
  await dropFromQueue(promptId)
  throw new Error(
    Date.now() >= hardStop
      ? `gave up after ${humanMs(QUEUE_WAIT_MS)} waiting for the image server`
      : `render did not finish within ${(TIMEOUT_MS / 1000).toFixed(0)}s`,
  )
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
