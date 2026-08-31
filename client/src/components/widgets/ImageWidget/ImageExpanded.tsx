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

import { useState } from 'react'
import { Sparkles, Trash2, AlertTriangle } from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { openImage } from '../../../hooks/useImageOverlay'
import type { Orientation, StoredImage } from '../../../hooks/useImages'

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
  /** Phase text of the render in flight, if any — straight from the server. */
  phase:    string
  onGenerate: (prompt: string, orientation: Orientation) => void
  onDelete:   (id: string) => void
}

export default function ImageExpanded({ images, enabled, busy, phase, onGenerate, onDelete }: Props) {
  const [prompt, setPrompt] = useState('')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  // Two-step delete. These take real time and GPU to make, so a stray fingertip
  // on a 7" screen must not be able to destroy one in a single tap.
  const [confirming, setConfirming] = useState<string | null>(null)

  const canDraw = enabled !== false && prompt.trim().length > 0 && !busy

  function draw() {
    if (!canDraw) return
    onGenerate(prompt.trim(), orientation)
    // The prompt is deliberately KEPT, not cleared: the common next action is
    // another go at the same idea with a word changed, and re-typing it on an
    // on-screen keyboard is the most expensive thing in this panel.
  }

  return (
    <div className="flex flex-col h-full p-6 pt-16 gap-4">
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

      {/* ── Compose ── */}
      <div className="shrink-0">
        <TouchInput
          value={prompt}
          onChange={setPrompt}
          multiline
          rows={3}
          placeholder="A ginger cat in a spacesuit…"
          ariaLabel="What should the picture show?"
          className="w-full bg-white/10 text-white rounded-2xl px-4 py-3 text-sm leading-relaxed
                     placeholder:text-white/30 border border-hairline"
        />
      </div>

      {prompt.trim() === '' && (
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

      <div className="flex gap-2 shrink-0">
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
        {busy ? (
          <>
            <Sparkles size={20} className="animate-pulse" />
            {/* The server's own phase text — "loading the model" is the honest
                explanation for the 20s first render, and guessing at it here
                would drift from what the overlay says. */}
            {phase || 'Drawing…'}
          </>
        ) : (
          <>
            <Sparkles size={20} />
            Draw it
          </>
        )}
      </button>

      {/* ── Gallery ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {images.length === 0 ? (
          <p className="text-[13px] text-white/30 text-center py-8">
            Nothing drawn yet. Pictures you make — here or by asking out loud — collect here.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
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
