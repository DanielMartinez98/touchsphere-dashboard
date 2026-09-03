// The tap interface for ComfyUI: describe a picture, pick a shape, draw it,
// and browse what's already been drawn.
//
// This is the counterpart to `generate_image`, and deliberately the SAME job
// engine underneath — a picture the assistant was asked for and one typed here
// land in the same store and the same grid, and either one's progress arrives
// on the same SSE event. Nothing here knows about the conversation; it just
// POSTs the request the assistant would have.
//
// Tapping a thumbnail opens the existing full-screen ImageOverlay rather than a
// second viewer, so a picture looks the same however it was asked for.

import { useRef, useState } from 'react'
import {
  Sparkles, Trash2, AlertTriangle, Check, Layers, Gauge, X, Clock, Brush, Download,
  Wand2, ImagePlus, Loader2, LayoutGrid,
} from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { openImage } from '../../../hooks/useImageOverlay'
import { MAX_COLUMNS, MIN_COLUMNS, setGalleryColumns, useGalleryColumns } from '../../../hooks/useGalleryColumns'
import {
  clearImageSource, redrawImage, setImagePrompt, useImagePrompt, useImageSource,
} from '../../../hooks/useImagePrompt'
import AdvancedPanel from './AdvancedPanel'
import { STRENGTHS, styleUsable } from '../../../hooks/useImages'
import type {
  ImageParams, ImageStyle, Orientation, QueuedJob, StoredImage, StyleDefaults,
} from '../../../hooks/useImages'

// Starters, not a menu. A blank box is the hardest thing to hand someone on a
// touchscreen with no keyboard, and these show the SHAPE of a prompt that works
// (subject, setting, lighting, style) better than any placeholder text.
const SUGGESTIONS = [
  'a ginger cat in a spacesuit, floating in a nebula, cinematic lighting, detailed',
  'a lighthouse in a storm, dramatic sky, oil painting',
  'a quiet Tokyo alley at night, neon signs, rain, cinematic',
  'a cosy cabin in snowy pines, warm window light, golden hour',
]

const ORIENTATIONS: { id: Orientation; label: string; box: string }[] = [
  // The preview box mirrors the real aspect ratio, so the choice is legible
  // without reading the pixel numbers.
  { id: 'portrait',  label: 'Portrait',  box: 'w-5 h-7' },
  { id: 'landscape', label: 'Landscape', box: 'w-7 h-5' },
  { id: 'square',    label: 'Square',    box: 'w-6 h-6' },
]

interface Props {
  images:   StoredImage[]
  enabled:  boolean | null
  busy:     boolean
  /** Everything waiting or drawing, in draw order. Empty when the GPU is idle.
      Each row carries its own phase text, which is why the panel no longer
      takes a single `phase`: with a queue there isn't one. */
  queue:    QueuedJob[]
  /** How many may wait at once, from the server. */
  queueMax: number
  /** Why the last attempt to queue something was refused. '' = it wasn't. */
  drawError: string
  onCancel: (id: string) => void
  /** Styles available — checkpoints and whole-workflow styles alike. */
  styles:   ImageStyle[]
  /** The one in effect. '' = whatever the workflow specifies. */
  model:    string
  /** Sampling-quality preset: more steps, slower, better. */
  quality:  string
  /** Advanced per-style knobs — megapixels, steps, cfg, turbo LoRA, seed. */
  params:   ImageParams
  /** What the selected style's own graph specifies, under those knobs. */
  defaults: StyleDefaults | null
  loras:    string[]
  autoLora: string
  onModel:    (model: string) => void
  onQuality:  (quality: string) => void
  onParams:   (patch: Partial<ImageParams>) => void
  onResetParams: () => void
  /** `source`/`denoise` are set only for a redraw; '' / 0 means draw from scratch. */
  onGenerate: (
    prompt: string, orientation: Orientation, source: string, denoise: number, improve: boolean,
  ) => void
  onDelete:   (id: string) => void
  /**
   * Whether the prompt improver is on by default, from the server's store.
   * null while it is still loading — the switch is hidden until it is known,
   * because a switch that flips itself a second after the panel opens reads as
   * the panel having changed the setting.
   */
  improveDefault: boolean | null
  /** Persist the switch, so it is remembered the next time the panel opens. */
  onImproveChange: (on: boolean) => void
  /** Add a picture from this device to the gallery. Resolves to its id, or null. */
  onUpload: (file: File) => Promise<{ id: string; prompt: string; file: string } | null>
}

/**
 * One row of the queue.
 *
 * The body opens the same full-screen frame the assistant's `generate_image`
 * opens, so a picture can be watched while it draws from either half of the
 * app. The trailing X is a second tap target rather than part of it, the same
 * split the guide's chapter rows use — leaving the queue and dropping an item
 * from it must never be the same guess.
 *
 * Cancelling is offered only for a job that hasn't started. The one on the GPU
 * is usually seconds from existing, and abandoning it would waste the render
 * that is already paid for; what a mis-tap on "Draw it" actually produces is
 * the four behind it, and those are exactly the ones this can drop.
 */
function QueueRow({
  job, position, onOpen, onCancel,
}: {
  job:      QueuedJob
  /** 0 for the one being drawn; 1, 2… for what is waiting behind it. */
  position: number
  onOpen:   () => void
  onCancel: () => void
}) {
  const drawing = position === 0

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onOpen}
        className={`flex-1 min-w-0 flex items-center gap-3 rounded-xl px-3 py-2.5 text-left
                    border transition active:scale-[0.99] ${
          drawing
            ? 'bg-pink-500/15 border-pink-400/30'
            : 'bg-white/5 border-hairline'
        }`}
      >
        <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${
          drawing ? 'bg-pink-500/25 text-pink-200' : 'bg-white/10 text-white/45'
        }`}>
          {drawing
            ? <Sparkles size={16} className="animate-pulse" />
            : <span className="text-[13px] font-bold tabular-nums">{position}</span>}
        </span>
        <span className="min-w-0 flex flex-col gap-0.5">
          <span className="text-[13px] text-white/80 leading-snug line-clamp-1">
            {job.prompt || 'a picture'}
          </span>
          <span className="text-[11px] text-white/45 tabular-nums">
            {/* The server's short label for the live one — "loading the model"
                is the honest explanation for a 20s first render — and for the
                rest, where they are in the line plus what that costs in
                minutes. `waitMs` is recomputed server-side on every frame,
                because a job's wait changes when the one AHEAD of it moves. */}
            {drawing
              ? (job.phase || 'drawing')
              : `waiting · ${job.width}×${job.height}`}
            {job.etaMs > 0 && drawing && ` · about ${shortMs(job.etaMs)}`}
            {job.waitMs > 0 && !drawing && ` · starts in about ${shortMs(job.waitMs)}`}
          </span>
          {/* The verbose line, for the one on the GPU only. Every row carrying a
              paragraph would turn a queue of eight into a page of prose, and the
              waiting ones have nothing to report beyond their position — which
              the line above already gives them. */}
          {drawing && job.detail !== '' && (
            <span className="text-[11px] text-white/30 leading-snug line-clamp-3">
              {job.detail}
            </span>
          )}
        </span>
      </button>

      {drawing ? (
        // No cancel, and no dead button pretending otherwise.
        <span className="w-11 shrink-0" aria-hidden />
      ) : (
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Remove "${job.prompt}" from the queue`}
          className="w-11 h-11 shrink-0 rounded-xl bg-white/5 border border-hairline
                     flex items-center justify-center text-white/45 active:scale-90 active:bg-red-500/40"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}

/** "45s", "1m 20s" — mirrors humanMs() in server/src/image-timing.ts. */
function shortMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

// Mirrors QUALITY_STEPS in server/src/image.ts — only so the Steps control's
// "Auto" can say which number it means. Duplicated for the same reason SIZES is.
const QUALITY_STEP_COUNT: Record<string, number> = { draft: 12, standard: 26, high: 44 }

/**
 * "animagine-xl-4.0.safetensors" → "Animagine Xl 4.0".
 *
 * Checkpoint filenames are the least readable thing in this panel and the user
 * picked them by downloading, not by typing — so the list shows the name a
 * person would recognise, with the raw filename kept only as the value.
 */
function pretty(file: string): string {
  return file
    .replace(/\.(safetensors|ckpt|sft)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Steps are the honest quality lever; the labels say what that costs, because
// on a kiosk "High" with no warning just reads as the thing having got slower.
const QUALITIES: { id: string; label: string; hint: string }[] = [
  { id: 'draft',    label: 'Draft',    hint: 'fastest' },
  { id: 'standard', label: 'Standard', hint: 'balanced' },
  { id: 'high',     label: 'High',     hint: 'slowest' },
]

export default function ImageExpanded({
  images, enabled, busy, queue, queueMax, drawError,
  styles, model, quality,
  params, defaults, loras, autoLora,
  onModel, onQuality, onParams, onResetParams, onGenerate, onDelete, onCancel,
  improveDefault, onImproveChange, onUpload,
}: Props) {
  // The compose field lives in a module store rather than here, so the
  // full-screen viewer's "Use as prompt" can hand a finished picture's prompt
  // back to it — a portal at the top of the tree cannot reach into this
  // component's useState. It also means the text survives closing the panel,
  // which is what you want on a device where typing a prompt is the most
  // expensive thing in the app.
  const prompt = useImagePrompt()
  const setPrompt = setImagePrompt
  // The picture this render starts from, when the user tapped "Change this" on
  // one. Same store as the prompt, and for the same reason: both are pieces of
  // the request being composed, and both are set from the full-screen viewer.
  const source = useImageSource()
  const [strength, setStrength] = useState('balanced')
  // The selected style, and whether it EDITS rather than draws. An editor
  // (FLUX Kontext) changes the meaning of nearly everything below: the prompt
  // is an instruction, there is no strength to choose, and with no source
  // there is nothing it can do at all.
  const current = styles.find(st => st.id === model)
  const editStyle = current?.edits === true
  // The one installed editor, for the shortcut chip on the source card. Only
  // offered when it is usable and not already selected — a dead chip on a
  // touchscreen is a tap that looks broken.
  const editor = styles.find(st => st.edits && styleUsable(st))
  // "Change this" seeds the field with the original's own prompt, which is the
  // right start for img2img (the edit is then two words) and the wrong one for
  // an editor, where the original's description reads as "repaint all of this".
  // Cleared once per source, and only while it still IS the seed — a
  // half-typed instruction is never thrown away. Derived in the render body
  // rather than an effect, the pattern the improve switch below already uses.
  const [unseeded, setUnseeded] = useState('')
  if (source && editStyle && unseeded !== source.id && prompt === source.prompt) {
    setPrompt('')
    setUnseeded(source.id)
  }
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  // The improve switch. Held locally so a tap is instant, seeded from the
  // server's saved default and re-seeded when that arrives — derived in the
  // render body rather than in an effect, the pattern the ImageOverlay's
  // details toggle already uses to stay clear of react-hooks/set-state-in-effect.
  const [improve, setImprove] = useState({ on: false, seeded: false })
  if (!improve.seeded && improveDefault !== null) {
    setImprove({ on: improveDefault, seeded: true })
  }
  // The hidden file input behind "Use my own picture". A file picker cannot be
  // opened programmatically without a real input, so there is one, off screen.
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  // Two-step delete. These take real time and GPU to make, so a stray fingertip
  // on a 7" screen must not be able to destroy one in a single tap.
  const [confirming, setConfirming] = useState<string | null>(null)
  // How many across. Per device, see useGalleryColumns. Two ways to change
  // it: the chips above the grid, and pinching the grid itself — the gesture
  // every photo app uses for exactly this, and the one a finger tries first.
  const columns = useGalleryColumns()
  const pinch = useRef<{ start: number; columns: number } | null>(null)
  const pinchDistance = (t: React.TouchList) => {
    const a = t[0], b = t[1]
    return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0
  }
  const onPinchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) pinch.current = { start: pinchDistance(e.touches), columns }
  }
  const onPinchMove = (e: React.TouchEvent) => {
    const p = pinch.current
    if (!p || e.touches.length !== 2 || !p.start) return
    // Spreading the fingers makes each picture bigger — fewer across. One
    // column per ~35% of spread, from the count the pinch began at.
    const ratio = pinchDistance(e.touches) / p.start
    const steps = Math.round(Math.log(ratio) / Math.log(1.35))
    if (steps !== 0) setGalleryColumns(p.columns - steps)
  }
  const onPinchEnd = () => { pinch.current = null }

  // Deliberately NOT gated on `busy` any more. Renders are still drawn one at a
  // time, but asking for four pictures is one thought, and making someone stand
  // at the kiosk for ninety seconds between them was the feature that was
  // missing. The only thing that closes the button is a full queue.
  const full = queue.length >= queueMax
  const canDraw = enabled !== false && prompt.trim().length > 0 && !full && !(editStyle && !source)
  // A distilled style carries its own step count; the draft/standard/high preset
  // does not reach it. Defaults to true so a server that predates the field —
  // Watchtower updates the two halves independently — keeps the row live.
  const qualityApplies = defaults?.qualityApplies !== false

  function draw() {
    if (!canDraw) return
    const d = STRENGTHS.find(x => x.id === strength)?.denoise ?? 0.65
    // An editor takes no strength: it runs the whole schedule over the source
    // and keeps what the instruction doesn't touch. 1 says so on the wire.
    onGenerate(prompt.trim(), orientation, source?.id ?? '', source ? (editStyle ? 1 : d) : 0, improve.on)
    // The prompt is deliberately KEPT, not cleared: the common next action is
    // another go at the same idea with a word changed, and re-typing it on an
    // on-screen keyboard is the most expensive thing in this panel.
  }

  return (
    // NATURAL HEIGHT, no h-full and no inner scroller. Widget already wraps this
    // in `flex-1 min-h-0 overflow-auto`, so a second scroll container here left
    // the outer one with nothing to scroll and made a drag anywhere except the
    // gallery do nothing at all — the classic nested-scroll dead zone on touch.
    // Padding is safe-area aware for a notched phone; env() is 0 on the kiosk.
    <div
      className="flex flex-col gap-4 pt-16"
      style={{
        paddingLeft:   'max(1rem, env(safe-area-inset-left))',
        paddingRight:  'max(1rem, env(safe-area-inset-right))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <Sparkles size={20} className="text-pink-300" />
        <h2 className="text-lg font-semibold text-white">Draw a picture</h2>
      </div>

      {enabled === false && (
        <div className="flex items-start gap-3 rounded-2xl bg-amber-500/10 border border-amber-400/30 p-4 shrink-0">
          <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[13px] text-white/70 leading-relaxed">
            The image server isn't reachable. Check that the GPU machine is awake and
            that <span className="font-mono text-white/85">COMFYUI_URL</span> is set —
            Settings → Debug has a connection check for it.
          </p>
        </div>
      )}

      {/* ── Redrawing this one ──
          Above the prompt because it changes what the prompt MEANS: with a
          source, the text describes the picture you want out, not a fresh idea.
          Seeded with the original's own words for exactly that reason, so the
          edit is usually two of them rather than forty.

          The × is a second tap target beside the body, the same split the queue
          rows and the guide's chapter rows use — going back to drawing from
          scratch must never be the same guess as opening the original. */}
      {source && (
        <div className="flex flex-col gap-3 rounded-2xl bg-pink-500/10 border border-pink-400/30 p-3 shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => openImage(source.id, source.prompt, source.url)}
              className="w-16 h-16 shrink-0 rounded-xl overflow-hidden border border-hairline
                         active:scale-95 transition-transform"
            >
              <img src={source.url} alt={source.prompt} className="w-full h-full object-cover" />
            </button>
            <div className="min-w-0 flex-1">
              <span className="text-[11px] uppercase tracking-widest text-pink-300/80 font-semibold
                               flex items-center gap-1.5">
                <Brush size={12} />
                Changing this one
              </span>
              <p className="text-[13px] text-white/60 leading-snug line-clamp-2 mt-0.5">
                {source.prompt}
              </p>
            </div>
            <button
              type="button"
              onClick={clearImageSource}
              aria-label="Draw from scratch instead"
              className="w-11 h-11 shrink-0 rounded-xl bg-white/5 border border-hairline
                         flex items-center justify-center text-white/45
                         active:scale-90 active:bg-red-500/40"
            >
              <X size={16} />
            </button>
          </div>

          {/* The shortcut to the editor, when one is installed and this isn't
              it. "Change this" is the moment someone wants Kontext, and the
              style row is a scroller a screen further down. */}
          {editor && !editStyle && (
            <button
              type="button"
              onClick={() => onModel(editor.id)}
              className="h-11 rounded-xl px-3 flex items-center justify-center gap-2 text-[13px] font-semibold
                         bg-white/5 text-white/70 border border-hairline active:scale-[0.98] active:bg-white/15"
            >
              <Wand2 size={15} className="text-pink-300" />
              Edit it with {editor.label} instead
            </button>
          )}

          {/* How far to go. Three words, not a slider: nobody standing at a
              kiosk knows what 0.65 means, and a fingertip can't land it on a
              7" screen anyway. Same three numbers the assistant's redraw_image
              uses, so asking out loud and tapping land in the same place.
              Absent for an editor, which has no such dial: it keeps what the
              instruction doesn't mention, however much that is. */}
          {!editStyle && <div className="flex gap-2">
            {STRENGTHS.map(st => (
              <button
                key={st.id}
                type="button"
                onClick={() => setStrength(st.id)}
                className={`flex-1 h-14 rounded-xl flex flex-col items-center justify-center leading-tight
                            transition-colors active:scale-95 ${
                  strength === st.id
                    ? 'bg-white/20 text-white border border-white/25'
                    : 'bg-white/5 text-white/45 border border-transparent'
                }`}
              >
                <span className="text-[13px] font-semibold">{st.label}</span>
                <span className="text-[10px] text-white/35">{st.hint}</span>
              </button>
            ))}
          </div>}

          {/* What to type differs by KIND of style, and it is the thing most
              likely to go wrong: img2img repaints from the words alone, so a
              prompt that only names the change draws the change; an editor is
              the reverse, and a whole description reads as "repaint it all". */}
          <span className="text-[11px] text-white/30 leading-snug">
            {editStyle
              ? 'Say what to change — "make it night", "put a hat on the cat" — and the rest ' +
                'stays as it is. Name the subject rather than saying "it".'
              : 'Describe the whole picture you want out, not just the change: this style ' +
                'repaints from your words and the original\'s layout. With Improve on, the ' +
                'original is looked at and the description written for you.'}
            {' '}The original is kept — this makes another picture beside it. Its shape
            comes from the original, so the orientation buttons don't apply.
          </span>
        </div>
      )}

      {/* An editor with nothing to edit. Said here, above the field, rather
          than as a greyed button with no explanation. */}
      {editStyle && !source && (
        <div className="flex items-start gap-3 rounded-2xl bg-white/5 border border-hairline p-3 shrink-0">
          <Wand2 size={18} className="text-pink-300 shrink-0 mt-0.5" />
          <span className="text-[13px] text-white/60 leading-snug">
            <span className="text-white">{current?.label}</span> changes a picture rather than
            drawing one. Tap a picture below and choose "Change this", or use one of your own —
            or pick another style to draw from scratch.
          </span>
        </div>
      )}

      {/* ── Compose ── */}
      <div className="shrink-0">
        <TouchInput
          value={prompt}
          onChange={setPrompt}
          multiline
          rows={3}
          placeholder={editStyle ? 'Make it night time, keep everything else the same…' : 'A ginger cat in a spacesuit…'}
          ariaLabel="What should the picture show?"
          className="w-full bg-white/10 text-white rounded-2xl px-4 py-3 text-sm leading-relaxed
                     placeholder:text-white/30 border border-hairline"
        />
      </div>

      {/* ── Improve my prompt ──
          Directly under the field it acts on, because it changes what that text
          becomes. A switch rather than a checkbox: this is a setting that
          persists, not a one-off, and the label says which model does it so it
          is obvious this is not the assistant reading over your shoulder. */}
      {improveDefault !== null && (
        <button
          type="button"
          role="switch"
          aria-checked={improve.on}
          onClick={() => {
            const on = !improve.on
            setImprove({ on, seeded: true })
            onImproveChange(on)
          }}
          className={`shrink-0 flex items-center gap-3 rounded-2xl px-3 py-3 border text-left
                      transition-colors active:scale-[0.99] ${
            improve.on
              ? 'bg-violet-500/15 border-violet-400/40'
              : 'bg-white/5 border-hairline'
          }`}
        >
          <span className={`w-11 h-6 shrink-0 rounded-full p-0.5 flex transition-colors ${
            improve.on ? 'bg-violet-400/80 justify-end' : 'bg-white/15 justify-start'
          }`}>
            <span className="w-5 h-5 rounded-full bg-white shadow" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-white/85">
              <Wand2 size={13} className={improve.on ? 'text-violet-300' : 'text-white/40'} />
              Improve my prompt
            </span>
            <span className="block text-[11px] text-white/40 leading-snug mt-0.5">
              {improve.on
                ? 'A separate model rewrites it the way this style asks to be prompted, ' +
                  'on a fresh conversation each time.'
                : 'Draw exactly what you typed.'}
            </span>
          </span>
        </button>
      )}

      {/* ── Start from a picture of your own ──
          Hidden while already redrawing: the source card above is the control
          for that, and a second way in would just be a way to lose the picture
          you already chose. */}
      {!source && (
        <div className="shrink-0">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async e => {
              const file = e.target.files?.[0]
              // Cleared straight away so picking the SAME file twice still
              // fires a change event the second time.
              e.target.value = ''
              if (!file) return
              setUploading(true)
              const added = await onUpload(file)
              setUploading(false)
              if (added) {
                // Straight into the redraw slot: adding your own picture and
                // then having to find it in the grid to tap "Change this" would
                // be two steps for one intention.
                redrawImage({ id: added.id, url: `/api/image/file/${added.file}`, prompt: added.prompt })
                // …but then blank the compose field. redrawImage seeds it from
                // the source PROMPT, which is right for one of our own pictures
                // (its words are the best first draft of the change) and wrong
                // here, where that string is just the filename. There is no
                // original prompt for a photo, so the field starts empty and its
                // placeholder asks the question. The card above keeps the
                // filename as its caption, which is what makes it identifiable.
                setImagePrompt('')
              }
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-3 rounded-2xl px-3 h-14 bg-white/5
                       border border-hairline active:bg-white/10 text-left disabled:opacity-50"
          >
            <span className="w-8 h-8 shrink-0 rounded-full bg-white/10 flex items-center
                             justify-center text-white/60">
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-white/85">
                {uploading ? 'Adding it…' : 'Use my own picture'}
              </span>
              <span className="block text-[11px] text-white/40 leading-snug">
                Start from a photo or drawing on this device instead of from scratch
              </span>
            </span>
          </button>
        </div>
      )}

      {/* Not offered while redrawing: the starters are ideas for a blank box, and
          swapping one in would silently throw away the picture being changed. */}
      {prompt.trim() === '' && !source && (
        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-xs uppercase tracking-widest text-white/35 font-semibold">Try one</span>
          {SUGGESTIONS.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setPrompt(s)}
              className="text-left text-[13px] text-white/60 bg-white/5 rounded-xl px-3 py-2.5
                         border border-hairline active:bg-white/15 active:scale-[0.99] transition"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* ── Style / checkpoint ──
          Above orientation because it matters more: the model decides whether
          you get anime or photoreal, and swapping it is the difference between
          "this isn't what I wanted" and one more tap. Only shown when there is
          a choice to make — one installed checkpoint is not a decision. */}
      {styles.length > 1 && (
        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-xs uppercase tracking-widest text-white/35 font-semibold flex items-center gap-1.5">
            <Layers size={13} />
            Style
          </span>
          {/* A horizontal scroller rather than a dropdown: a native <select> on a
              kiosk opens an OS popup that TouchKio renders badly, and these are
              a handful of options, not a hundred. */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {styles.map(st => {
              // A style whose files aren't on the GPU box can't draw. Shown but
              // not selectable, because hiding it would leave someone who read
              // about "Anima Turbo" wondering where it went — and the row is
              // the only place that can say which file to go and fetch.
              const usable = styleUsable(st)
              return (
                <button
                  key={st.id}
                  type="button"
                  disabled={!usable}
                  onClick={() => usable && onModel(st.id)}
                  title={usable ? undefined : `Not installed: ${st.missing!.join(', ')}`}
                  className={`shrink-0 h-12 px-4 rounded-2xl text-[13px] font-semibold whitespace-nowrap
                              flex items-center gap-2 transition-colors ${
                    !usable
                      ? 'bg-white/[0.03] text-white/25 border border-hairline line-through'
                      : model === st.id
                        ? 'bg-pink-500/25 text-white border border-pink-400/40 active:scale-95'
                        : 'bg-white/5 text-white/50 border border-transparent active:scale-95'
                  }`}
                >
                  {usable && model === st.id && <Check size={15} />}
                  {!usable && <Download size={13} />}
                  {/* A workflow style already has a human label from the server;
                      only raw checkpoint FILENAMES need prettifying. */}
                  {st.kind === 'workflow' ? st.label : pretty(st.label)}
                </button>
              )
            })}
          </div>

          {/* The filenames, spelled out. A greyed row says "you can't have
              this"; only the name of the file says what to do about it — and
              on a kiosk there is no tooltip to hover for it. */}
          {styles.some(st => !styleUsable(st)) && (
            <div className="flex flex-col gap-1 rounded-xl bg-white/[0.03] border border-hairline p-3">
              <span className="text-[11px] uppercase tracking-widest text-white/35 font-semibold">
                Not installed on the image server
              </span>
              {styles.filter(st => !styleUsable(st)).map(st => (
                <span key={st.id} className="text-[11px] text-white/40 leading-snug">
                  <span className="text-white/60">{st.label}</span>
                  {' needs '}
                  <span className="font-mono text-white/50">{st.missing!.join(', ')}</span>
                </span>
              ))}
              <span className="text-[11px] text-white/25 leading-snug mt-0.5">
                Drop the file into ComfyUI's matching models folder on the GPU box and it
                appears here — nothing to restart on this end.
              </span>
            </div>
          )}
          {/* The first picture after a switch reloads the checkpoint into VRAM,
              which is the 20s render. Saying so here stops it reading as a hang. */}
          <span className="text-[11px] text-white/25 leading-snug">
            Switching styles makes the next picture slower — the model has to load.
            Applies to pictures you ask for out loud too.
          </span>
        </div>
      )}

      {/* ── Quality ──
          Sampling steps and nothing else. cfg and sampler stay at whatever the
          chosen style specifies, because those are per-model tuning — Anima
          wants cfg 4 where SDXL wants 8 — and bending them from a "quality"
          button would quietly wreck one of them. Advanced below has a cfg
          control of its own for exactly that reason: it's per style, not a
          speed dial. */}
      <div className="flex flex-col gap-2 shrink-0">
        <span className="text-xs uppercase tracking-widest text-white/35 font-semibold flex items-center gap-1.5">
          <Gauge size={13} />
          Quality
          {/* A preset that isn't in effect must not look like it is. Advanced's
              Steps wins when it's set, and a distilled style (Anima Turbo) wins
              over both — it is trained to land in about ten steps and gains
              nothing from forty-four. Either way the only way to notice
              otherwise is to wonder why "High" renders as fast as "Draft". */}
          {params.steps > 0 ? (
            <span className="ml-auto normal-case tracking-normal text-pink-300/70">
              overridden — {params.steps} steps
            </span>
          ) : !qualityApplies ? (
            <span className="ml-auto normal-case tracking-normal text-pink-300/70">
              set by this style
            </span>
          ) : null}
        </span>
        <div className={`flex gap-2 ${params.steps > 0 || !qualityApplies ? 'opacity-40' : ''}`}>
          {QUALITIES.map(q => (
            <button
              key={q.id}
              type="button"
              onClick={() => onQuality(q.id)}
              className={`flex-1 h-14 rounded-2xl flex flex-col items-center justify-center leading-tight
                          transition-colors active:scale-95 ${
                quality === q.id
                  ? 'bg-white/20 text-white border border-white/25'
                  : 'bg-white/5 text-white/45 border border-transparent'
              }`}
            >
              <span className="text-[13px] font-semibold">{q.label}</span>
              <span className="text-[10px] text-white/35">{q.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Hidden on a redraw rather than disabled: an img2img latent is the source
          picture's own shape, so these genuinely have nothing to set, and three
          dead buttons read as the panel having broken. The source card above
          says where the size comes from instead. */}
      <div className={`flex gap-2 shrink-0 ${source ? 'hidden' : ''}`}>
        {ORIENTATIONS.map(o => (
          <button
            key={o.id}
            type="button"
            onClick={() => setOrientation(o.id)}
            className={`flex-1 h-14 rounded-2xl flex items-center justify-center gap-2 text-[13px] font-semibold
                        transition-colors active:scale-95 ${
              orientation === o.id
                ? 'bg-white/20 text-white border border-white/25'
                : 'bg-white/5 text-white/45 border border-transparent'
            }`}
          >
            <span className={`${o.box} rounded-[3px] border-2 ${
              orientation === o.id ? 'border-pink-300' : 'border-white/30'
            }`} aria-hidden />
            {o.label}
          </button>
        ))}
      </div>

      {/* ── Advanced ──
          Collapsed by default: the two decisions above cover almost every
          session, and a kiosk panel that opens on nine controls is a panel
          nobody reads. It lives below orientation because the resolution
          readout inside it depends on the shape chosen there. */}
      <AdvancedPanel
        params={params}
        defaults={defaults}
        loras={loras}
        autoLora={autoLora}
        qualitySteps={QUALITY_STEP_COUNT[quality] ?? 26}
        orientation={orientation}
        onChange={onParams}
        onReset={onResetParams}
      />

      <button
        type="button"
        onClick={draw}
        disabled={!canDraw}
        className={`h-16 rounded-2xl flex items-center justify-center gap-2 text-base font-semibold shrink-0
                    transition ${
          canDraw
            ? 'bg-pink-500/25 border border-pink-400/40 text-white active:scale-[0.98] active:bg-pink-500/40'
            : 'bg-white/5 border border-hairline text-white/30'
        }`}
      >
        {/* The label says which of the two things this tap does. While the GPU
            is busy it is genuinely a different action — the picture is not
            starting now — and a button that still said "Draw it" would be
            promising something the queue can't deliver for a minute. */}
        {full ? (
          <>
            <Clock size={20} />
            Queue is full
          </>
        ) : busy ? (
          <>
            {source ? <Brush size={20} /> : <Sparkles size={20} />}
            Add to the queue
          </>
        ) : source ? (
          <>
            <Brush size={20} />
            {editStyle ? 'Edit it' : 'Redraw it'}
          </>
        ) : (
          <>
            <Sparkles size={20} />
            Draw it
          </>
        )}
      </button>

      {/* A refusal belongs where the finger already is. This used to reach the
          console only, so a tap that did nothing looked like a broken button. */}
      {drawError !== '' && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 border border-amber-400/30 px-3 py-2.5 shrink-0">
          <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <span className="text-[12px] text-white/70 leading-snug">{drawError}</span>
        </div>
      )}

      {/* ── Queue ──
          Between the button and the gallery on purpose: it is the answer to
          "did that tap work?", and it is what the next tap on Draw adds to.
          Absent entirely when the GPU is idle — an empty list headed "Queue" is
          a permanent reminder of a feature nobody is using. */}
      {queue.length > 0 && (
        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-xs uppercase tracking-widest text-white/35 font-semibold flex items-center gap-1.5">
            <Clock size={13} />
            Drawing
            <span className="ml-auto normal-case tracking-normal text-white/30 tabular-nums">
              {queue.length} of {queueMax}
            </span>
          </span>
          {queue.map((j, i) => (
            <QueueRow
              key={j.id}
              job={j}
              position={i}
              onOpen={() => openImage(j.id, j.prompt)}
              onCancel={() => onCancel(j.id)}
            />
          ))}
          <span className="text-[11px] text-white/25 leading-snug">
            Pictures are drawn one at a time — two at once on one card is slower, not
            faster. Tap one to watch it; tap the × to drop one that hasn't started.
          </span>
        </div>
      )}

      {/* ── Gallery ──
          Flows in the page rather than scrolling on its own; see the note on the
          container above. Always `columns` across, whatever the viewport: it
          used to be a breakpoint (two on a phone, three from 380px), which
          followed the screen and could never be changed by the person looking
          at it. Now it is a per-device setting with chips and a pinch. */}
      <div>
        {images.length > 0 && (
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-widest text-white/35 font-semibold flex items-center gap-1.5">
              <LayoutGrid size={13} />Gallery <span className="text-white/20 normal-case tracking-normal">· {images.length}</span>
            </span>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Pictures per row">
              {Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, i) => MIN_COLUMNS + i).map(n => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={columns === n}
                  onClick={() => setGalleryColumns(n)}
                  className={`w-9 h-9 rounded-lg text-[13px] font-semibold tabular-nums active:scale-90 transition ${
                    columns === n ? 'bg-pink-500/25 text-pink-200 border border-pink-400/40' : 'bg-white/5 text-white/45 border border-transparent'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
        {images.length === 0 ? (
          <p className="text-[13px] text-white/30 text-center py-8">
            Nothing drawn yet. Pictures you make — here or by asking out loud — collect here.
          </p>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            onTouchStart={onPinchStart}
            onTouchMove={onPinchMove}
            onTouchEnd={onPinchEnd}
            onTouchCancel={onPinchEnd}
          >
            {images.map(img => (
              <div key={img.id} className="relative aspect-square">
                <button
                  type="button"
                  onClick={() => openImage(img.id, img.prompt, img.url)}
                  className="w-full h-full rounded-xl overflow-hidden border border-hairline
                             active:scale-95 transition-transform"
                >
                  <img src={img.url} alt={img.prompt} className="w-full h-full object-cover" />
                </button>

                {confirming === img.id ? (
                  <button
                    type="button"
                    onClick={() => { onDelete(img.id); setConfirming(null) }}
                    onBlur={() => setConfirming(null)}
                    className="absolute inset-0 rounded-xl bg-red-600/85 text-white text-[13px]
                               font-semibold flex items-center justify-center active:scale-95"
                  >
                    Delete?
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(img.id)}
                    aria-label={`Delete the picture of ${img.prompt}`}
                    // 40px and offset outward — big enough to hit deliberately,
                    // far enough from centre not to be hit by accident when the
                    // intent was to open the picture.
                    className="absolute -top-1 -right-1 w-10 h-10 rounded-full bg-black/70 border border-hairline
                               flex items-center justify-center text-white/60 active:scale-90 active:bg-red-500/60"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
