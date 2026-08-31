// The knobs that used to live only inside the graph JSON.
//
// Style and Quality above this cover the two decisions almost everybody makes.
// This is for the third kind of session — the one where you already know the
// model and are tuning it: Anima at cfg 3.5, turbo LoRA at 0.8, a fixed seed so
// changing one word in the prompt changes one thing in the picture.
//
// Everything is stored PER STYLE (see server/src/image-params.ts), so the panel
// always describes the style currently selected, and switching styles swaps the
// whole set rather than carrying SDXL's cfg over to Anima.
//
// Every control has an OFF position that reads "Auto" and names the number it
// would use — a knob whose neutral setting is a shrug is a knob you can't
// safely leave alone. Nothing here is required: untouched, this panel changes
// the render by exactly nothing.
//
// Touch rules, same as everywhere else in the app: no native <select> (TouchKio
// renders the OS popup badly), no drag-only sliders (a fingertip on a 7" screen
// can't land 0.05 reliably), so every numeric control is a big −/+ stepper and
// every choice is a chip.

import { useState } from 'react'
import {
  ChevronDown, Dices, Gauge, Grid3x3, Hash, RotateCcw, Sliders, Zap,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import {
  MEGAPIXELS, MULTIPLES, resolutionFor,
  type ImageParams, type Orientation, type SeedMode, type StyleDefaults,
} from '../../../hooks/useImages'

interface Props {
  params:    ImageParams
  /** What the selected style's own graph specifies. null = server didn't say. */
  defaults:  StyleDefaults | null
  /** Installed LoRAs, from ComfyUI. Empty when the GPU box is unreachable. */
  loras:     string[]
  /** The LoRA turbo would pick if left on Auto. '' = it couldn't find one. */
  autoLora:  string
  /** Steps the current quality preset means, for the Steps control's "Auto". */
  qualitySteps: number
  /** The shape selected above, so the resolution readout is the real one. */
  orientation: Orientation
  onChange:  (patch: Partial<ImageParams>) => void
  onReset:   () => void
}

// 44px minimum everywhere; these are 48. The kiosk is used at arm's length.
const CHIP = 'shrink-0 h-11 px-3.5 rounded-xl text-[13px] font-semibold whitespace-nowrap ' +
  'flex items-center justify-center transition-colors active:scale-95'
const CHIP_ON  = 'bg-pink-500/25 text-white border border-pink-400/40'
const CHIP_OFF = 'bg-white/5 text-white/50 border border-transparent'

const LABEL = 'text-xs uppercase tracking-widest text-white/35 font-semibold flex items-center gap-1.5'

/**
 * A −/+ number row.
 *
 * `auto` is what value 0 means, spelled out — "Auto (26 from Quality)" rather
 * than a bare 0, because the whole point of leaving it at zero is that
 * something else decides and you should be able to see what.
 */
function Stepper({
  value, onChange, min, max, step, decimals = 0, auto, unit = '',
}: {
  value:    number
  onChange: (v: number) => void
  min:      number
  max:      number
  step:     number
  decimals?: number
  /** Text shown instead of the number when value is 0. Omit if 0 is a real value. */
  auto?:    string
  unit?:    string
}) {
  // Float steps (cfg 0.5, strength 0.05) accumulate error fast; round to the
  // control's own precision on every change rather than letting 0.7000000001
  // reach the server and come back as a different-looking number.
  const round = (n: number) => Math.round(n * 10 ** decimals) / 10 ** decimals
  const bump = (dir: number) => {
    // Stepping UP out of "auto" should land on something usable, not on `step`
    // — one step above 0 for cfg would be 0.5, which no model wants.
    const from = value === 0 && auto ? min : value
    const next = value === 0 && auto && dir > 0 ? min : round(from + dir * step)
    onChange(Math.max(auto ? 0 : min, Math.min(max, next)))
  }

  const btn = 'w-14 h-12 rounded-xl bg-white/5 border border-hairline text-white/70 ' +
    'text-xl font-semibold flex items-center justify-center active:scale-95 active:bg-white/15 ' +
    'disabled:opacity-25'

  return (
    <div className="flex items-center gap-2">
      <button type="button" className={btn} onClick={() => bump(-1)}
              disabled={value === 0 && !!auto} aria-label="Less">−</button>
      <div className="flex-1 h-12 rounded-xl bg-white/[0.07] border border-hairline
                      flex items-center justify-center text-white text-[15px] font-semibold tabular-nums">
        {value === 0 && auto ? <span className="text-white/45 text-[13px]">{auto}</span>
                             : `${value.toFixed(decimals)}${unit}`}
      </div>
      <button type="button" className={btn} onClick={() => bump(1)}
              disabled={value >= max} aria-label="More">+</button>
      {/* Getting BACK to auto has to be one tap. Without it, a stepper you
          nudged once can never be un-set without knowing that 0 is special. */}
      {auto && value !== 0 && (
        <button
          type="button"
          onClick={() => onChange(0)}
          className="w-14 h-12 rounded-xl bg-white/5 border border-hairline text-[11px]
                     font-semibold text-white/45 active:scale-95"
        >
          Auto
        </button>
      )}
    </div>
  )
}

export default function AdvancedPanel({
  params, defaults, loras, autoLora, qualitySteps, orientation, onChange, onReset,
}: Props) {
  const [open, setOpen] = useState(false)

  const res = resolutionFor(orientation, params)
  // Which knobs are actually doing something, so the collapsed header can say
  // so — an Advanced section that hides a cfg override is how you end up
  // debugging a "broken model" that is just set to cfg 1.
  const active = [
    params.megapixels > 0 && `${params.megapixels} MP`,
    params.steps > 0 && `${params.steps} steps`,
    params.cfg > 0 && `cfg ${params.cfg}`,
    params.turbo && 'turbo',
    params.seedMode !== 'random' && `seed ${params.seed}`,
  ].filter(Boolean) as string[]

  const seedModes: { id: SeedMode; label: string; hint: string }[] = [
    { id: 'random',    label: 'Random',    hint: 'new every time' },
    { id: 'fixed',     label: 'Fixed',     hint: 'same every time' },
    { id: 'increment', label: 'Increment', hint: '+1 each render' },
  ]

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="h-12 rounded-2xl bg-white/5 border border-hairline px-4 flex items-center gap-2
                   active:scale-[0.99] active:bg-white/10 transition"
      >
        <Sliders size={15} className="text-white/45" />
        <span className="text-[13px] font-semibold text-white/70">Advanced</span>
        {/* The summary lives on the closed header on purpose: the failure mode
            of a collapsed panel is forgetting what you left inside it. */}
        {active.length > 0 && !open && (
          <span className="text-[11px] text-pink-300/70 truncate">{active.join(' · ')}</span>
        )}
        <ChevronDown
          size={16}
          className={`ml-auto text-white/40 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-5 rounded-2xl bg-white/[0.03] border border-hairline p-3.5">

          {/* ── Resolution ──
              Megapixels sets the SIZE; the orientation buttons above still set
              the shape. Keeping the two apart is why one setting covers all
              three orientations instead of needing nine fixed sizes — and it's
              how ComfyUI's own Anima template does it. */}
          <div className="flex flex-col gap-2">
            <div className={LABEL}>
              <Grid3x3 size={13} />
              Resolution
              <span className="ml-auto normal-case tracking-normal text-white/50 tabular-nums">
                {res.width} × {res.height}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {MEGAPIXELS.map(mp => (
                <button
                  key={mp}
                  type="button"
                  onClick={() => onChange({ megapixels: mp })}
                  className={`${CHIP} ${params.megapixels === mp ? CHIP_ON : CHIP_OFF}`}
                >
                  {mp === 0 ? 'Preset' : `${mp} MP`}
                </button>
              ))}
            </div>
            {params.megapixels > 0 && (
              <>
                <div className={LABEL}>Align each side to</div>
                <div className="flex gap-2">
                  {MULTIPLES.map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onChange({ multipleOf: m })}
                      className={`${CHIP} flex-1 ${params.multipleOf === m ? CHIP_ON : CHIP_OFF}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-white/25 leading-snug">
                  Models are trained on a grid. 8 suits SDXL; some newer models seam
                  unless both sides land on 64.
                </span>
              </>
            )}
          </div>

          {/* ── Steps ── */}
          <div className="flex flex-col gap-2">
            <div className={LABEL}>
              <Gauge size={13} />
              Steps
            </div>
            <Stepper
              value={params.steps}
              onChange={steps => onChange({ steps })}
              min={1} max={150} step={1}
              auto={`Auto — ${qualitySteps} from Quality`}
            />
          </div>

          {/* ── Guidance ──
              Deliberately NOT wired to the Quality buttons: cfg is per-model
              tuning, not a speed/quality dial. Anima wants 4 where SDXL wants
              8, which is exactly why it needs its own control and why that
              control's default is "whatever this style already says". */}
          {defaults?.hasCfg !== false && (
            <div className="flex flex-col gap-2">
              <div className={LABEL}>
                <Sliders size={13} />
                Guidance (CFG)
              </div>
              <Stepper
                value={params.cfg}
                onChange={cfg => onChange({ cfg })}
                min={1} max={20} step={0.5} decimals={1}
                auto={defaults ? `Auto — ${defaults.cfg} from this style` : 'Auto'}
              />
              <span className="text-[11px] text-white/25 leading-snug">
                How hard the model is pushed toward the prompt. Too high burns the
                image; turbo LoRAs usually want 1–2.
              </span>
            </div>
          )}

          {/* ── Turbo ──
              ComfyUI's Anima template ships this as a switch node in the graph;
              flattening the graph for /prompt threw the switch away, and this
              puts it back. Offered for any style — a LoRA is a LoRA — but the
              auto-pick only knows which one belongs to the styles that say so. */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onChange({ turbo: !params.turbo })}
              className={`h-12 rounded-xl px-4 flex items-center gap-2.5 border transition-colors
                          active:scale-[0.99] ${
                params.turbo
                  ? 'bg-amber-400/20 border-amber-300/40 text-white'
                  : 'bg-white/5 border-hairline text-white/55'
              }`}
            >
              <Zap size={15} className={params.turbo ? 'text-amber-300' : 'text-white/40'} />
              <span className="text-[13px] font-semibold">Turbo LoRA</span>
              {/* A track-and-knob switch rather than a checkbox: it reads as
                  on/off from across the room, which a tick does not. */}
              <span className={`ml-auto w-11 h-6 rounded-full p-0.5 transition-colors ${
                params.turbo ? 'bg-amber-300/70' : 'bg-white/15'
              }`}>
                <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                  params.turbo ? 'translate-x-5' : ''
                }`} />
              </span>
            </button>

            {params.turbo && (
              <>
                <div className={LABEL}>LoRA</div>
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                  <button
                    type="button"
                    onClick={() => onChange({ lora: '' })}
                    className={`${CHIP} ${params.lora === '' ? CHIP_ON : CHIP_OFF}`}
                  >
                    {/* Auto names the file it would use. "Auto" on its own is
                        useless when the whole question is which file. */}
                    {autoLora ? `Auto · ${autoLora.replace(/\.safetensors$/i, '')}` : 'Auto'}
                  </button>
                  {loras.map(l => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => onChange({ lora: l })}
                      className={`${CHIP} ${params.lora === l ? CHIP_ON : CHIP_OFF}`}
                    >
                      {l.replace(/\.safetensors$/i, '')}
                    </button>
                  ))}
                </div>
                {loras.length === 0 && (
                  <span className="text-[11px] text-amber-300/60 leading-snug">
                    No LoRAs found on the image server — turbo will be skipped rather
                    than guessed at.
                  </span>
                )}

                <div className={LABEL}>Strength</div>
                <Stepper
                  value={params.loraStrength}
                  onChange={loraStrength => onChange({ loraStrength })}
                  min={0} max={2} step={0.05} decimals={2}
                />
                <span className="text-[11px] text-white/25 leading-snug">
                  A turbo LoRA cuts the steps it needs, so drop Steps to around 8 and
                  Guidance to 1–2 when it's on.
                </span>
              </>
            )}
          </div>

          {/* ── Seed ──
              Random is right for "draw me a cat"; Fixed is what makes iterating
              on ONE picture possible, because changing a word in the prompt then
              changes one thing rather than everything. */}
          <div className="flex flex-col gap-2">
            <div className={LABEL}>
              <Hash size={13} />
              Seed
            </div>
            <div className="flex gap-2">
              {seedModes.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange({
                    seedMode: m.id,
                    // Moving off Random with no seed yet would pin every picture
                    // to 0 forever, which looks like the control doing nothing.
                    ...(m.id !== 'random' && params.seed === 0
                      ? { seed: Math.floor(Math.random() * 2 ** 31) }
                      : {}),
                  })}
                  className={`flex-1 h-14 rounded-xl flex flex-col items-center justify-center leading-tight
                              transition-colors active:scale-95 ${
                    params.seedMode === m.id
                      ? 'bg-pink-500/25 text-white border border-pink-400/40'
                      : 'bg-white/5 text-white/45 border border-transparent'
                  }`}
                >
                  <span className="text-[13px] font-semibold">{m.label}</span>
                  <span className="text-[10px] text-white/35">{m.hint}</span>
                </button>
              ))}
            </div>

            {params.seedMode !== 'random' && (
              <div className="flex gap-2">
                <TouchInput
                  value={String(params.seed)}
                  onChange={v => {
                    // The touch keyboard can produce anything; a NaN seed would
                    // be rejected server-side and silently snap back to 0.
                    const n = parseInt(v.replace(/\D/g, ''), 10)
                    onChange({ seed: Number.isFinite(n) ? n : 0 })
                  }}
                  ariaLabel="Seed value"
                  className="flex-1 h-12 bg-white/[0.07] text-white rounded-xl px-4 text-[15px]
                             font-semibold tabular-nums border border-hairline"
                />
                <button
                  type="button"
                  onClick={() => onChange({ seed: Math.floor(Math.random() * 2 ** 31) })}
                  aria-label="Roll a new seed"
                  className="w-14 h-12 rounded-xl bg-white/5 border border-hairline
                             flex items-center justify-center text-white/60 active:scale-95"
                >
                  <Dices size={18} />
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onReset}
            className="h-12 rounded-xl bg-white/5 border border-hairline flex items-center
                       justify-center gap-2 text-[13px] font-semibold text-white/45 active:scale-[0.99]"
          >
            <RotateCcw size={14} />
            Reset to this style's own settings
          </button>
        </div>
      )}
    </div>
  )
}
