// How long a render actually takes on THIS box, per style and per settings.
//
// This replaces a single module-level `lastDurationMs` — the duration of the
// last render, whatever it happened to be — which the overlay's progress bar was
// measured against. That number is wrong in every case anyone cares about, and
// wrong by a lot: an Anima Turbo picture is ~10 steps at cfg 1 where a NoobAI
// one is 28, draft is 12 steps where high is 44, and the megapixel knob runs
// from 0.5 to 16. A 40s bar over a 6s render fills to 15% and stops; a 6s bar
// over a 40s render sits pinned at its 95% cap for half a minute. Both read as
// the estimate being made up, because it was.
//
// So: keep the samples, and estimate from the ones that resemble the job.
//
// The model is deliberately small — render time is close to linear in
// `steps × pixels`, and the part that isn't linear in it is the fixed cost of
// getting the checkpoint into VRAM. That second part is why `warm` is recorded
// alongside: 20–40s of checkpoint load is most of a short render and a rounding
// error on a long one, so a cold sample cannot be scaled onto a warm job by
// ratio. Warm and cold are separate populations, and the estimator says which
// one it drew on rather than quietly mixing them.
//
// Persisted, unlike the counter it replaces, because a restart is exactly when
// an estimate matters most: the first render after one is both the slowest and
// the one the old code had no history for at all.

import fs from 'fs'
import path from 'path'

/** One finished render, as evidence. */
export interface RenderSample {
  /** Style id — a checkpoint filename, or `wf:<id>`. */
  style:  string
  /**
   * Sampler steps the render actually ran.
   *
   * For a redraw this is `steps × denoise`, not `steps`: img2img starts partway
   * through the schedule, so a 30-step render at 0.65 denoise does about 20 —
   * and filing it as 30 would teach this file that the style is half again as
   * fast as it is, for every job after it.
   */
  steps:  number
  pixels: number
  /** Was this style already on the GPU when the render started? */
  warm:   boolean
  ms:     number
  /** Epoch ms, so pruning can take the oldest. */
  at:     number
}

/** An answer, with the reason it can be believed. */
export interface Estimate {
  /** Milliseconds. 0 means "no idea", and the UI must not draw a bar for it. */
  ms:    number
  /** Where the number came from, in words fit to show a person. '' when ms is 0. */
  basis: string
}

// Capped per style, so a fortnight of one style can't evict every sample of
// another — which is the case that matters most, since switching style is
// exactly when the old single-number estimate was furthest out.
const MAX_PER_STYLE = 40
// Overall ceiling. This sits on the Pi's volume next to the images.
const MAX_SAMPLES = 400

// Nothing outside this is a real render on real hardware. A sub-second sample is
// a cached ComfyUI result and an hour-long one is a box that went to sleep
// mid-job; either poisons a median that only ever has a handful of members.
const MIN_MS = 500
const MAX_MS = 60 * 60_000

function storePath(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  return path.join(dir, 'image-timing.json')
}

/** Samples newest-first. A corrupt or missing file reads as no history. */
export function loadSamples(): RenderSample[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSample).slice(0, MAX_SAMPLES)
  } catch {
    // Losing this costs the estimates, not the pictures — and it refills itself
    // over the next few renders. Never worth failing a job over.
    return []
  }
}

function isSample(v: unknown): v is RenderSample {
  const s = v as RenderSample | null
  return !!s && typeof s === 'object' &&
    typeof s.style === 'string' &&
    typeof s.steps === 'number' && Number.isFinite(s.steps) && s.steps > 0 &&
    typeof s.pixels === 'number' && Number.isFinite(s.pixels) && s.pixels > 0 &&
    typeof s.ms === 'number' && s.ms >= MIN_MS && s.ms <= MAX_MS &&
    typeof s.at === 'number'
}

/** Write-then-rename, the memory.ts pattern: a crash mid-write can't truncate it. */
function save(samples: RenderSample[]): void {
  const p = storePath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(samples, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image] failed to write timing history:', err)
  }
}

/** Remember one finished render. An implausible duration is dropped, not stored. */
export function recordRender(sample: RenderSample): void {
  // Read out before the guard: isSample() narrows `sample` to `never` on the
  // failing branch, which is exactly the branch that wants to name the numbers.
  const { ms, steps } = sample
  if (!isSample(sample)) {
    console.warn(
      `[image] not timing that render — ${Math.round(ms)}ms at ${steps} steps ` +
      'is outside what a render on real hardware looks like',
    )
    return
  }
  const kept: RenderSample[] = []
  const perStyle = new Map<string, number>()
  for (const s of [sample, ...loadSamples()]) {
    const n = perStyle.get(s.style) ?? 0
    if (n >= MAX_PER_STYLE) continue
    perStyle.set(s.style, n + 1)
    kept.push(s)
    if (kept.length >= MAX_SAMPLES) break
  }
  save(kept)
}

/** Steps × megapixels — the quantity a render's duration is roughly linear in. */
function workOf(steps: number, pixels: number): number {
  return Math.max(0.001, steps * (pixels / 1_000_000))
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * How long this job should take, and why we think so.
 *
 * Four tiers, best first, each a wider net than the last and each one saying so
 * — because the difference between "six renders exactly like this one" and "a
 * guess borrowed from a different model" is the difference between a number
 * worth planning around and a number worth ignoring, and the screen can only
 * pass that distinction on if it is handed it.
 */
export function estimateRender(
  style: string, steps: number, pixels: number, warm: boolean,
): Estimate {
  const work = workOf(steps, pixels)
  const all  = loadSamples()
  if (all.length === 0) return { ms: 0, basis: '' }

  const rate  = (s: RenderSample) => s.ms / workOf(s.steps, s.pixels)
  const scale = (xs: RenderSample[]) => Math.round(median(xs.map(rate)) * work)

  const sameStyle  = all.filter(s => s.style === style)
  const sameWarmth = sameStyle.filter(s => s.warm === warm)

  // 1. This style, this warmth, at a workload within 15% of this job's. No
  //    scaling at all — this tier is a measurement, not a model.
  const near = sameWarmth.filter(s => {
    const w = workOf(s.steps, s.pixels)
    return w >= work * 0.85 && w <= work * 1.15
  })
  if (near.length > 0) {
    return {
      ms: Math.round(median(near.map(s => s.ms))),
      basis: `measured from ${plural(near.length, 'earlier render')} of this style at these settings`,
    }
  }

  // 2. This style and this warmth, at a different workload — scale by steps × pixels.
  if (sameWarmth.length > 0) {
    return {
      ms: scale(sameWarmth),
      basis: `scaled from ${plural(sameWarmth.length, 'render')} of this style`,
    }
  }

  // 3. This style, but every sample is from the other side of the warm/cold
  //    line. Usable, and biased in a direction we know, so name the direction.
  if (sameStyle.length > 0) {
    return {
      ms: scale(sameStyle),
      basis: warm
        ? `scaled from ${plural(sameStyle.length, 'render')} that had to load this style first — this one should beat that`
        : `scaled from ${plural(sameStyle.length, 'render')} with this style already loaded — loading it will add to this`,
    }
  }

  // 4. Nothing of this style at all. Other models are still evidence about this
  //    graphics card, which beats the silence the old code fell back to.
  return {
    ms: scale(all),
    basis: `a rough guess — nothing drawn with this style yet, scaled from ${plural(all.length, 'render')} of others`,
  }
}

/** "45s", "1m 20s", "12m". The one place a duration is worded on this side. */
export function humanMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}
