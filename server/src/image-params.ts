// Per-style render parameters — the knobs that used to live only inside the
// graph JSON, made editable from the Draw panel.
//
// KEYED BY STYLE, not global, and that is the whole point of the file. cfg is
// the clearest case: Anima Base v1 wants cfg 4 where SDXL wants 8, which is
// exactly why image.ts refused to let the *quality* button touch cfg at all.
// One global cfg would have the same problem — switching style would silently
// wreck whichever model wasn't the one you tuned for. A style's settings follow
// the style, so "Anima at cfg 3.5 with the turbo LoRA" and "SDXL at cfg 8" are
// both remembered and neither can clobber the other.
//
// Everything is optional and every zero means "leave it alone": steps 0 falls
// through to the quality preset, cfg 0 to whatever the graph itself specifies,
// megapixels 0 to the fixed orientation sizes. So a user who never opens the
// Advanced section gets byte-identical behaviour to before this file existed.
//
// Same store shape as image-model.json / image-quality.json: one small JSON on
// the cache volume, read per request rather than cached, written atomically.
// Read per request for the same reason as the voice-pitch slider — a knob has
// to take effect on the NEXT picture, not after a container restart.

import fs from 'fs'
import path from 'path'

export type SeedMode = 'random' | 'fixed' | 'increment'

export interface ImageParams {
  /** Total pixel budget in megapixels. 0 = use the fixed orientation sizes. */
  megapixels:   number
  /** Round each side to a multiple of this. Latents are 8px; some models want 64. */
  multipleOf:   number
  /** Sampling steps. 0 = fall through to the quality preset. */
  steps:        number
  /** Classifier-free guidance. 0 = leave whatever the graph specifies. */
  cfg:          number
  /** Insert a model-only LoRA ahead of the sampler (Anima's turbo LoRA, etc.). */
  turbo:        boolean
  /** LoRA filename as ComfyUI knows it. '' = pick the obvious turbo one. */
  lora:         string
  /** LoRA strength, only meaningful while `turbo` is on. */
  loraStrength: number
  /** Where the seed comes from when the caller doesn't pass one. */
  seedMode:     SeedMode
  /** The seed itself, for 'fixed' and as the running value for 'increment'. */
  seed:         number
}

export const DEFAULT_PARAMS: ImageParams = {
  megapixels:   0,
  multipleOf:   8,
  steps:        0,
  cfg:          0,
  turbo:        false,
  lora:         '',
  loraStrength: 1,
  seedMode:     'random',
  seed:         0,
}

// Bounds. These are operator settings, not model-supplied ones, so they're
// looser than the guards in image.ts on what the LLM may ask for — but a
// fat-fingered 400-step render on a kiosk with no keyboard to cancel it is
// still worth preventing.
export const MEGAPIXEL_CHOICES = [0, 0.5, 1, 1.5, 2, 3]
export const MULTIPLE_CHOICES  = [8, 16, 32, 64]
const MAX_STEPS = 150
const MAX_CFG   = 30
const MAX_LORA  = 2
export const MAX_SEED = 2 ** 31 - 1

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Coerce anything (a JSON file, a request body) into a valid ImageParams. */
export function normalizeParams(raw: unknown, base: ImageParams = DEFAULT_PARAMS): ImageParams {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mp       = num(o['megapixels'])
  const mult     = num(o['multipleOf'])
  const steps    = num(o['steps'])
  const cfg      = num(o['cfg'])
  const strength = num(o['loraStrength'])
  const seed     = num(o['seed'])
  const mode     = o['seedMode']

  return {
    // 0 is a real value here ("off"), so it can't be filtered out by truthiness.
    megapixels:   mp === null ? base.megapixels : (mp <= 0 ? 0 : clamp(mp, 0.25, 4)),
    multipleOf:   mult === null || !MULTIPLE_CHOICES.includes(mult)
      ? base.multipleOf
      : mult,
    steps:        steps === null ? base.steps : clamp(Math.round(steps), 0, MAX_STEPS),
    cfg:          cfg === null ? base.cfg : clamp(Math.round(cfg * 10) / 10, 0, MAX_CFG),
    turbo:        typeof o['turbo'] === 'boolean' ? o['turbo'] : base.turbo,
    lora:         typeof o['lora'] === 'string' ? o['lora'].trim().slice(0, 200) : base.lora,
    loraStrength: strength === null
      ? base.loraStrength
      : clamp(Math.round(strength * 100) / 100, 0, MAX_LORA),
    seedMode:     mode === 'random' || mode === 'fixed' || mode === 'increment'
      ? mode
      : base.seedMode,
    seed:         seed === null ? base.seed : clamp(Math.round(seed), 0, MAX_SEED),
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

type Store = Record<string, ImageParams>

function file(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'image-params.json')
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [style, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[style] = normalizeParams(v)
    }
    return out
  } catch {
    return {}                 // never saved, or unreadable — everything defaults
  }
}

function writeStore(store: Store): void {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = file()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image] failed to save render parameters:', err)
  }
}

/** The saved knobs for one style. Untouched styles read as all-defaults. */
export function paramsFor(style: string): ImageParams {
  return readStore()[style] ?? { ...DEFAULT_PARAMS }
}

/** Merge a partial update into one style's knobs and persist. Returns the result. */
export function setParamsFor(style: string, patch: unknown): ImageParams {
  const store = readStore()
  const next = normalizeParams(patch, store[style] ?? DEFAULT_PARAMS)
  store[style] = next
  writeStore(store)
  console.log(
    `[image] params for ${style || '(workflow default)'}: ` +
    `${next.megapixels || 'preset'}MP/${next.multipleOf} steps=${next.steps || 'auto'} ` +
    `cfg=${next.cfg || 'graph'} turbo=${next.turbo ? `${next.lora || 'auto'}@${next.loraStrength}` : 'off'} ` +
    `seed=${next.seedMode}${next.seedMode === 'random' ? '' : `:${next.seed}`}`,
  )
  return next
}

/** Forget one style's knobs entirely — the Reset button. */
export function clearParamsFor(style: string): ImageParams {
  const store = readStore()
  delete store[style]
  writeStore(store)
  console.log(`[image] params for ${style || '(workflow default)'} reset to the style's own defaults`)
  return { ...DEFAULT_PARAMS }
}

/**
 * Advance a stored seed after a render used it.
 *
 * Only 'increment' writes anything back: 'fixed' means fixed, and 'random'
 * never consulted the stored value in the first place. Kept here rather than in
 * image.ts so the file that owns the store is the only thing that writes it.
 */
export function advanceSeed(style: string, used: number): void {
  const store = readStore()
  const cur = store[style]
  if (!cur || cur.seedMode !== 'increment') return
  store[style] = { ...cur, seed: (used + 1) % (MAX_SEED + 1) }
  writeStore(store)
}
