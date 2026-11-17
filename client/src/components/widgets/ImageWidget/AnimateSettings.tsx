// The Animate sheet's Settings: AniSora's sampling knobs, saved per style
// (image-params.json, the same store as Draw → Advanced), so the voice tool's
// clips and the next tap use them too. Collapsed by default, with the closed
// header listing what is changed: the defaults are the measured ones (8 steps,
// cfg 1, shift 5, the switch after step 3, 768×1152, 5 s shots), and a
// collapsed panel's failure mode is forgetting what you left inside it.
//
// Every knob has an Auto that names the graph's own number, and everything
// heavier than the default says so before anyone waits half an hour for it.

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { NumberField } from './AdvancedPanel'
import {
  DEFAULT_PARAMS, LIMITS,
  type AnimDefaults, type ImageParams, type ParamsResponse, type SeedMode,
} from '../../../hooks/useImages'

const CHIP = 'shrink-0 h-10 px-3 rounded-full border text-[13px] font-semibold whitespace-nowrap active:scale-95 transition'
const ON   = 'bg-pink-500/30 border-pink-400/50 text-white'
const OFF  = 'bg-white/10 border-hairline text-white/70'
const LABEL = 'text-[12px] uppercase tracking-widest text-white/40 font-semibold flex items-center gap-2'

/** Short side of a 2:3 frame. 768 is the measured default; above it may not fit a 24 GB card. */
const SIZES = [480, 576, 640, 720, 768, 896, 1024]
const SHOTS = [2, 3, 4, 5]

/**
 * Only this sheet's knobs back to Auto. Not the server's `reset`, which would
 * also forget this style's negative and prefix overrides from Settings → Prompts.
 */
const ANIM_RESET: Partial<ImageParams> = {
  steps: 0, highSteps: 0, cfg: 0, shift: 0, videoRes: 0, shotSeconds: 0,
  sampler: '', scheduler: '', seedMode: 'random',
}

const FALLBACK: AnimDefaults = {
  steps: 8, highSteps: 3, cfg: 1, shift: 5, sampler: 'euler', scheduler: 'simple', res: 768, shotSeconds: 5,
}

/** The settings in effect: saved values over the graph's own. Mirrors animSettings() on the server. */
function effective(p: ImageParams, d: AnimDefaults) {
  const steps = (p.steps ?? 0) > 0 ? Math.max(2, p.steps) : d.steps
  const autoHigh = Math.round(steps * d.highSteps / Math.max(1, d.steps))
  return {
    steps,
    highSteps: Math.max(1, Math.min(steps - 1, (p.highSteps ?? 0) > 0 ? p.highSteps! : autoHigh)),
    cfg:       (p.cfg ?? 0) > 0 ? p.cfg : d.cfg,
    shift:     (p.shift ?? 0) > 0 ? p.shift! : d.shift,
    sampler:   p.sampler || d.sampler,
    scheduler: p.scheduler || d.scheduler,
    res:       (p.videoRes ?? 0) > 0 ? p.videoRes! : d.res,
    shot:      (p.shotSeconds ?? 0) > 0 ? p.shotSeconds! : d.shotSeconds,
  }
}

/** Minutes for a clip, from the measured 10 min per 5 s at the defaults. Mirrors animCost(). */
function animMinutes(e: ReturnType<typeof effective>, seconds: number): number {
  const pixels = (e.res * e.res * 1.5) / (768 * 1152)
  return Math.max(1, Math.round(10 * (e.steps / 8) * pixels * (e.cfg > 1 ? 2 : 1) * seconds / 5))
}

export default function AnimateSettings({ style, seconds }: { style: string; seconds: number }) {
  const [open, setOpen] = useState(false)
  const [p, setP] = useState<ImageParams>(DEFAULT_PARAMS)
  const [d, setD] = useState<AnimDefaults>(FALLBACK)
  const [samplers, setSamplers] = useState<string[]>([])
  const [schedulers, setSchedulers] = useState<string[]>([])

  // Cancelled guard: a style switch while the first answer is in flight must
  // not leave the sheet describing (and then saving against) the other style.
  useEffect(() => {
    let on = true
    fetch(`/api/image/params?style=${encodeURIComponent(style)}`)
      .then(r => r.json() as Promise<ParamsResponse>)
      .then(j => {
        if (!on) return
        setP({ ...DEFAULT_PARAMS, ...(j.values ?? {}) })
        if (j.anim?.defaults) setD(j.anim.defaults)
        setSamplers(j.anim?.samplers ?? [])
        setSchedulers(j.anim?.schedulers ?? [])
      })
      .catch(() => { /* the defaults stand; a save will report itself */ })
    return () => { on = false }
  }, [style])

  // Optimistic, then the server's normalized answer wins (the Advanced panel's shape).
  const save = useCallback(async (patch: Partial<ImageParams>) => {
    setP(prev => ({ ...prev, ...patch }))
    try {
      const res = await fetch('/api/image/params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, ...patch }),
      })
      const j = await res.json() as ParamsResponse
      if (j.values) setP({ ...DEFAULT_PARAMS, ...j.values })
    } catch { /* kept locally; the next open reloads the truth */ }
  }, [style])

  const e = effective(p, d)
  const changed: string[] = []
  if ((p.steps ?? 0) > 0) changed.push(`${e.steps} steps`)
  if ((p.highSteps ?? 0) > 0) changed.push(`switch at ${e.highSteps}`)
  if ((p.cfg ?? 0) > 0) changed.push(`cfg ${e.cfg}`)
  if ((p.shift ?? 0) > 0) changed.push(`shift ${e.shift}`)
  if (p.sampler) changed.push(p.sampler)
  if (p.scheduler) changed.push(p.scheduler)
  if ((p.videoRes ?? 0) > 0) changed.push(`${e.res}p`)
  if ((p.shotSeconds ?? 0) > 0) changed.push(`${e.shot} s shots`)
  if (p.seedMode !== 'random') changed.push(p.seedMode === 'fixed' ? `seed ${p.seed}` : 'seed +1')

  const minutes = animMinutes(e, seconds)
  const heavy = e.cfg > 1 || e.res > 768 || e.steps > 12

  const chooser = (list: string[], value: string, auto: string, key: 'sampler' | 'scheduler') => (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      <button type="button" onClick={() => void save(key === 'sampler' ? { sampler: '' } : { scheduler: '' })} className={`${CHIP} ${value ? OFF : ON}`}>
        Auto ({auto})
      </button>
      {list.filter(n => n !== auto).map(n => (
        <button key={n} type="button" onClick={() => void save(key === 'sampler' ? { sampler: n } : { scheduler: n })} className={`${CHIP} ${value === n ? ON : OFF}`}>
          {n}
        </button>
      ))}
    </div>
  )

  return (
    <div className="rounded-xl bg-black/20 border border-hairline">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full min-h-11 px-3 py-2 flex items-center gap-2 text-left active:scale-[0.99] transition"
      >
        <span className="text-[14px] text-white/80 font-semibold">Settings</span>
        <span className="flex-1 min-w-0 text-[12px] text-white/45 truncate">
          {changed.length ? changed.join(' · ') : 'the tested defaults'}
        </span>
        <ChevronDown size={18} className={`text-white/50 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Steps <span className="ml-auto normal-case tracking-normal text-white/30">2–{LIMITS.steps.max}</span></div>
            <NumberField value={p.steps} onChange={v => void save({ steps: v })}
              min={2} max={LIMITS.steps.max} step={1} auto={`Auto (${d.steps})`} ariaLabel="Steps" />
            <div className="text-[12px] text-white/40">Time grows with steps. 12 measured 42% slower than 8 for no visible gain.</div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Motion steps <span className="ml-auto normal-case tracking-normal text-white/30">1–{e.steps - 1}</span></div>
            <NumberField value={p.highSteps ?? 0} onChange={v => void save({ highSteps: v })}
              min={1} max={Math.max(1, e.steps - 1)} step={1} auto={`Auto (${e.highSteps} of ${e.steps})`} ariaLabel="Motion steps" />
            <div className="text-[12px] text-white/40">
              How many steps the high-noise expert takes, which lays out the motion, before the low-noise one draws the detail.
              More can mean bigger movement; fewer, a cleaner picture.
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Guidance (cfg) <span className="ml-auto normal-case tracking-normal text-white/30">1–{LIMITS.cfg.max}</span></div>
            <NumberField value={p.cfg} onChange={v => void save({ cfg: v })}
              min={1} max={LIMITS.cfg.max} step={0.5} decimals={1} auto={`Auto (${d.cfg})`} ariaLabel="Guidance" />
            <div className={`text-[12px] ${e.cfg > 1 ? 'text-amber-300/90' : 'text-white/40'}`}>
              {e.cfg > 1
                ? 'Above 1 the negative prompt is used too, which doubles every step and the memory. A 5-second shot may not fit; try 3-second shots.'
                : 'AniSora is tuned for 1, where the negative prompt is not used.'}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Shift <span className="ml-auto normal-case tracking-normal text-white/30">0.5–20</span></div>
            <NumberField value={p.shift ?? 0} onChange={v => void save({ shift: v })}
              min={0.5} max={20} step={0.5} decimals={1} auto={`Auto (${d.shift})`} ariaLabel="Shift" />
            <div className="text-[12px] text-white/40">Higher spends more of the steps on the big shapes, i.e. the movement; lower, on the fine detail.</div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Size</div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              <button type="button" onClick={() => void save({ videoRes: 0 })} className={`${CHIP} ${(p.videoRes ?? 0) > 0 ? OFF : ON}`}>
                Auto ({d.res}p)
              </button>
              {SIZES.filter(n => n !== d.res).map(n => (
                <button key={n} type="button" onClick={() => void save({ videoRes: n })}
                  className={`${CHIP} ${p.videoRes === n ? ON : OFF}`}>{n}p</button>
              ))}
            </div>
            <div className={`text-[12px] ${e.res > 768 ? 'text-amber-300/90' : 'text-white/40'}`}>
              The short side; a portrait at {e.res}p is {e.res}×{Math.round(e.res * 1.5 / 16) * 16}, other shapes keep the same area.
              {e.res > 768 ? ' Bigger than tested: a 5-second shot may not fit in memory, so shorter shots are safer.' : ' Smaller is faster and softer.'}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Shot length</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void save({ shotSeconds: 0 })} className={`${CHIP} ${(p.shotSeconds ?? 0) > 0 ? OFF : ON}`}>
                Auto ({d.shotSeconds} s)
              </button>
              {SHOTS.filter(n => n !== d.shotSeconds).map(n => (
                <button key={n} type="button" onClick={() => void save({ shotSeconds: n })}
                  className={`${CHIP} ${p.shotSeconds === n ? ON : OFF}`}>{n} s</button>
              ))}
            </div>
            <div className="text-[12px] text-white/40">
              A longer clip is drawn in pieces of this length, each starting from the last frame of the one before.
              Shorter pieces use less memory but drift more.
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Sampler</div>
            {chooser(samplers, p.sampler ?? '', d.sampler, 'sampler')}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Scheduler</div>
            {chooser(schedulers, p.scheduler ?? '', d.scheduler, 'scheduler')}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className={LABEL}>Seed</div>
            <div className="flex flex-wrap gap-2">
              {(['random', 'fixed', 'increment'] as SeedMode[]).map(m => (
                <button key={m} type="button" onClick={() => void save({ seedMode: m })}
                  className={`${CHIP} ${p.seedMode === m ? ON : OFF}`}>
                  {m === 'random' ? 'New each time' : m === 'fixed' ? 'Keep this one' : 'Count up'}
                </button>
              ))}
            </div>
            {p.seedMode !== 'random' && (
              <NumberField value={p.seed} onChange={v => void save({ seed: v })}
                min={0} max={LIMITS.seed.max} step={1} ariaLabel="Seed" />
            )}
            <div className="text-[12px] text-white/40">Keep one to try a different setting on the same motion.</div>
          </div>

          <div className="flex items-center gap-2">
            <div className={`flex-1 text-[12px] ${heavy ? 'text-amber-300/90' : 'text-white/45'}`}>
              About {minutes} minute{minutes === 1 ? '' : 's'} for {seconds} s at these settings.
            </div>
            {changed.length > 0 && (
              <button type="button" onClick={() => void save(ANIM_RESET)}
                className={`${CHIP} ${OFF} flex items-center gap-1.5`}>
                <RotateCcw size={14} /> Back to defaults
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
