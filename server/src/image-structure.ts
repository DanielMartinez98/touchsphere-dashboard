// How a redraw holds the source's structure — the user's settings for it.
//
// A ControlNet on the source keeps its lines, its volume or its skeleton in
// place while the surfaces are repainted (see buildGraph in image.ts). Which
// of those, how firmly, and for how much of the render are not one right
// answer: "recolour the jacket" wants the lines held hard, "swap the shirt
// for a bikini" wants the body's volume held and the shirt's lines free to
// go, "make her wave" wants nothing held at all. So they are settings, in
// their own file like the quality preset, read per request so a change
// reaches the next picture rather than the next restart.

import fs from 'fs'
import path from 'path'

/** What the ControlNet is given: the source's edges, its depth, or its skeleton. */
export type HoldMode = 'lines' | 'body' | 'pose'
/** How fine the edge detection is, for `lines`. */
export type LineDetail = 'fine' | 'normal' | 'coarse'

export interface StructureSettings {
  /** Hold the pose by default on every redraw that isn't an instruction edit. */
  enabled:  boolean
  mode:     HoldMode
  /** ControlNet strength, 0.1–1. */
  strength: number
  /** Fraction of the sampling schedule it is applied for, 0.2–1. */
  end:      number
  detail:   LineDetail
}

export const DEFAULT_STRUCTURE: StructureSettings = {
  enabled: true, mode: 'lines', strength: 0.65, end: 0.7, detail: 'normal',
}

/** Canny thresholds per detail level. Lower = more lines survive. */
export const CANNY: Record<LineDetail, { low: number; high: number }> = {
  fine:   { low: 0.2,  high: 0.5 },
  normal: { low: 0.3,  high: 0.7 },
  coarse: { low: 0.45, high: 0.85 },
}

function file(): string {
  return path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'image-structure.json')
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : dflt
}

export function readStructure(): StructureSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StructureSettings>
    return {
      enabled:  typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_STRUCTURE.enabled,
      mode:     raw.mode === 'body' || raw.mode === 'pose' ? raw.mode : 'lines',
      strength: clamp(raw.strength, 0.1, 1, DEFAULT_STRUCTURE.strength),
      end:      clamp(raw.end, 0.2, 1, DEFAULT_STRUCTURE.end),
      detail:   raw.detail === 'fine' || raw.detail === 'coarse' ? raw.detail : 'normal',
    }
  } catch {
    return { ...DEFAULT_STRUCTURE }
  }
}

export function writeStructure(patch: Partial<StructureSettings>): StructureSettings {
  const cur = readStructure()
  const next: StructureSettings = {
    enabled:  typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    mode:     patch.mode === 'lines' || patch.mode === 'body' || patch.mode === 'pose' ? patch.mode : cur.mode,
    strength: patch.strength !== undefined ? clamp(patch.strength, 0.1, 1, cur.strength) : cur.strength,
    end:      patch.end !== undefined ? clamp(patch.end, 0.2, 1, cur.end) : cur.end,
    detail:   patch.detail === 'fine' || patch.detail === 'normal' || patch.detail === 'coarse' ? patch.detail : cur.detail,
  }
  const dir = path.dirname(file())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const p = file()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    console.log(`[image] pose hold: ${next.enabled ? 'on' : 'off'} by default, ${next.mode}, ${next.strength} until ${Math.round(next.end * 100)}%, ${next.detail} lines`)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing */ }
    console.error('[image] failed to save pose-hold settings:', err)
  }
  return next
}
