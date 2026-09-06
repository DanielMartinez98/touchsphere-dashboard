// Mark WHICH PART of a picture may change.
//
// Full screen, because a 7" kiosk has no room to paint on a thumbnail, and a
// portal above the image viewer (9450) because "change part of this" is asked
// for from inside the viewer and the editor must cover it.
//
// Two ways to mark a part, both landing in the same mask:
//
//   • paint it — a finger on the picture. The brush paints WHITE onto a
//     transparent canvas kept at the source's own resolution and CSS-scaled to
//     fit, so a fat fingertip at display size still produces a mask the
//     sampler can use. Drawn on screen as a pink wash over the picture, which is
//     what the user wants to see; exported as white-on-black, which is what the
//     GPU box wants.
//   • find it by name — the description goes to the server, which has the GPU
//     box find the part (GroundingDINO) and trace it (Segment Anything), and
//     the outline comes back as a PNG that is drawn into the same canvas. It
//     can then be touched up with the brush, because a model that thought
//     "the hat" included the hair is a model that is nearly right, and a
//     correction is three strokes where a re-search is a coin flip.
//
// Done uploads the mask and hands its id back; the render that follows names
// it beside the source. Nothing is uploaded until Done, since the failure mode
// of a touchscreen editor is a dozen accidental strokes, and the one deliberate
// action is the exit.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Brush, Eraser, Loader2, Search, Trash2, X, Check } from 'lucide-react'
import { TouchInput } from '../../TouchInput'
import { findMask, uploadMask, type MaskResult } from '../../../hooks/useImages'

interface Props {
  /** The gallery picture being edited. */
  source: { id: string; url: string; prompt: string }
  /** A mask already made for it, to start from. */
  initial?: { url: string } | null
  /** Whether the server can turn words into an outline. */
  canFind: boolean
  onDone:  (mask: MaskResult) => void
  onClose: () => void
}

const BRUSHES = [
  { id: 'fine',   label: 'Fine',   px: 18 },
  { id: 'medium', label: 'Medium', px: 40 },
  { id: 'broad',  label: 'Broad',  px: 90 },
]

export default function MaskEditor({ source, initial, canFind, onDone, onClose }: Props) {
  // The picture, once loaded — its natural size is the mask's size.
  const imgRef    = useRef<HTMLImageElement | null>(null)
  const maskRef   = useRef<HTMLCanvasElement | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [tool, setTool]       = useState<'paint' | 'erase'>('paint')
  const [brush, setBrush]     = useState('medium')
  const [what, setWhat]       = useState('')
  const [finding, setFinding] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  // What the last search found, so a mask that is 60% of the picture can be
  // seen for what it is before a render is spent on it.
  const [found, setFound]     = useState<{ what: string; coverage: number } | null>(null)
  // Painted-anything flag, for the Done button. Counted in strokes rather than
  // read back off the canvas on every render.
  const [strokes, setStrokes] = useState(0)

  // Where the canvas sits on screen. Recomputed from the element itself on
  // every pointer event rather than cached, because the frame resizes with the
  // keyboard coming up for the "find" field.
  const toCanvas = useCallback((e: { clientX: number; clientY: number }) => {
    const c = maskRef.current
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }, [])

  // Draw a white-on-transparent mask PNG (or the server's white-on-black one)
  // into the canvas. Any non-black pixel counts as marked; black is cleared to
  // transparent so a found mask composes with strokes rather than covering them.
  const paintMaskImage = useCallback(async (url: string, replace: boolean) => {
    const c = maskRef.current
    if (!c) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('the outline could not be loaded'))
      img.src = url
    })
    const off = document.createElement('canvas')
    off.width = c.width; off.height = c.height
    const octx = off.getContext('2d')!
    octx.drawImage(img, 0, 0, c.width, c.height)
    const data = octx.getImageData(0, 0, c.width, c.height)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      const on = px[i]! > 127
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = on ? 255 : 0
    }
    octx.putImageData(data, 0, 0)
    const ctx = c.getContext('2d')!
    if (replace) ctx.clearRect(0, 0, c.width, c.height)
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(off, 0, 0)
    setStrokes(n => n + 1)
  }, [])

  // Size the canvas to the picture once it has loaded, and seed it with the
  // mask we were handed, if any.
  const onImageLoad = useCallback(() => {
    const img = imgRef.current, c = maskRef.current
    if (!img || !c) return
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    setNatural({ w: img.naturalWidth, h: img.naturalHeight })
    if (initial?.url) void paintMaskImage(initial.url, true).catch(() => { /* start blank */ })
  }, [initial, paintMaskImage])

  // ── Painting ──
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  const stroke = useCallback((to: { x: number; y: number }) => {
    const c = maskRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    // Brush size is in DISPLAY pixels — a fingertip is the same width whatever
    // the picture's resolution — so it is scaled to canvas units here.
    const r = c.getBoundingClientRect()
    const px = (BRUSHES.find(b => b.id === brush)?.px ?? 40) * (c.width / Math.max(1, r.width))
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = '#fff'
    ctx.fillStyle = '#fff'
    ctx.lineWidth = px
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const from = last.current ?? to
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    last.current = to
  }, [brush, tool])

  const onPointerDown = (e: React.PointerEvent) => {
    if (!natural) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = null
    const p = toCanvas(e)
    if (p) stroke(p)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing.current) return
    e.preventDefault()
    const p = toCanvas(e)
    if (p) stroke(p)
  }
  const onPointerUp = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    setStrokes(n => n + 1)
  }

  const clear = () => {
    const c = maskRef.current
    if (!c) return
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    setFound(null)
    setStrokes(0)
  }

  // ── Find by name ──
  const find = async () => {
    const q = what.trim()
    if (!q || finding) return
    setFinding(true)
    setError('')
    try {
      const m = await findMask(source.id, q)
      if (m.coverage !== null && m.coverage < 0.002) {
        setError(`Couldn't find "${q}" in the picture. Try other words, or paint it.`)
        return
      }
      await paintMaskImage(m.url, true)
      setFound({ what: q, coverage: m.coverage ?? 0 })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not find that')
    } finally {
      setFinding(false)
    }
  }

  // ── Done: export white-on-black at the source's size and upload ──
  const done = async () => {
    const c = maskRef.current
    if (!c || saving) return
    setSaving(true)
    setError('')
    try {
      const out = document.createElement('canvas')
      out.width = c.width; out.height = c.height
      const ctx = out.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(c, 0, 0)
      const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('the mask could not be exported')
      const m = await uploadMask(blob)
      if (m.coverage !== null && m.coverage < 0.0005) {
        setError('Nothing is marked yet — paint over the part to change, or find it by name.')
        return
      }
      onDone({ ...m, what: found?.what })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save the mask')
    } finally {
      setSaving(false)
    }
  }

  // Escape closes, as every overlay here does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const marked = strokes > 0

  return createPortal(
    <div className="fixed inset-0 z-[9450] bg-black/95 flex flex-col text-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-widest text-pink-300/80 font-semibold">
            Mark the part to change
          </div>
          <div className="text-[13px] text-white/50 truncate">{source.prompt}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="w-11 h-11 rounded-full bg-white/10 border border-hairline flex items-center justify-center
                     text-white/70 active:scale-90 active:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {/* The picture with the mask over it. The frame is sized to fit; the
          canvas is positioned over the image exactly (both are object-contain
          in the same box, so they share the same rectangle). */}
      <div className="relative flex-1 min-h-0 mx-3 flex items-center justify-center">
        <div className="relative max-w-full max-h-full" style={{ aspectRatio: natural ? `${natural.w} / ${natural.h}` : undefined }}>
          <img
            ref={imgRef}
            src={source.url}
            alt={source.prompt}
            crossOrigin="anonymous"
            onLoad={onImageLoad}
            draggable={false}
            className="block max-w-full max-h-[calc(100dvh-230px)] select-none"
          />
          <canvas
            ref={maskRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // The wash: white strokes shown pink and half-transparent, which is
            // both "this is the marked part" and "you can still see it".
            // Invisible: it holds white-on-transparent for export and takes
            // the touches; the pink wash the user sees is PinkTint below,
            // clipped to this canvas's alpha. Kept above the tint so the
            // pointer events land here.
            className="absolute inset-0 w-full h-full touch-none cursor-crosshair opacity-0 z-10"
          />
          {natural && <PinkTint canvasRef={maskRef} strokes={strokes} />}
          {!natural && (
            <div className="absolute inset-0 flex items-center justify-center text-white/40">
              <Loader2 size={24} className="animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Tools */}
      <div className="shrink-0 px-3 pb-3 pt-2 flex flex-col gap-2">
        {error && (
          <div className="text-[12px] text-red-300 leading-snug px-1">{error}</div>
        )}
        {found && !error && (
          <div className="text-[12px] text-white/50 leading-snug px-1">
            Found <span className="text-white">{found.what}</span> · {Math.round(found.coverage * 100)}% of the picture.
            Touch it up with the brush if the outline isn't quite right.
          </div>
        )}

        {canFind && (
          <div className="flex items-center gap-2">
            <TouchInput
              value={what}
              onChange={setWhat}
              placeholder='"the hat", or "box: her torso - the face"'
              ariaLabel="What to find"
              className="flex-1 h-12 rounded-xl bg-white/10 border border-hairline px-3 text-[15px]"
            />
            <button
              type="button"
              onClick={find}
              disabled={!what.trim() || finding}
              className="h-12 px-4 rounded-xl bg-pink-500/25 border border-pink-400/40 text-white text-[14px]
                         font-semibold flex items-center gap-2 disabled:opacity-40 active:scale-95"
            >
              {finding ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {finding ? 'Finding…' : 'Find'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex rounded-xl overflow-hidden border border-hairline">
            <button
              type="button"
              onClick={() => setTool('paint')}
              className={`h-12 px-3 flex items-center gap-1.5 text-[13px] font-semibold ${
                tool === 'paint' ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50'}`}
            >
              <Brush size={15} /> Paint
            </button>
            <button
              type="button"
              onClick={() => setTool('erase')}
              className={`h-12 px-3 flex items-center gap-1.5 text-[13px] font-semibold ${
                tool === 'erase' ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50'}`}
            >
              <Eraser size={15} /> Erase
            </button>
          </div>
          <div className="flex gap-1.5 flex-1">
            {BRUSHES.map(b => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBrush(b.id)}
                className={`flex-1 h-12 rounded-xl text-[12px] font-semibold flex items-center justify-center gap-1.5 ${
                  brush === b.id ? 'bg-white/20 text-white border border-white/25' : 'bg-white/5 text-white/45 border border-transparent'}`}
              >
                <span
                  className="rounded-full bg-current"
                  style={{ width: Math.max(6, b.px / 5), height: Math.max(6, b.px / 5) }}
                />
                {b.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={clear}
            disabled={!marked}
            aria-label="Clear the mask"
            className="w-12 h-12 rounded-xl bg-white/5 border border-hairline flex items-center justify-center
                       text-white/60 disabled:opacity-30 active:scale-90 active:bg-red-500/40"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <button
          type="button"
          onClick={done}
          disabled={!marked || saving}
          className="h-14 rounded-2xl bg-pink-500 text-white text-[16px] font-bold flex items-center justify-center gap-2
                     disabled:opacity-40 active:scale-[0.98]"
        >
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
          {saving ? 'Saving the mask…' : marked ? 'Use this part' : 'Mark a part first'}
        </button>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The pink wash over the painted region.
 *
 * The mask canvas holds white-on-transparent because that is what exports
 * cleanly; painting it pink directly would put pink in the PNG. So a second
 * layer paints solid pink and clips itself to the canvas's alpha with
 * `mask-image`, re-rendered from the canvas after every stroke. The canvas
 * itself stays on top (invisible, opacity 0) to take the touches.
 */
function PinkTint({ canvasRef, strokes }: { canvasRef: React.RefObject<HTMLCanvasElement | null>; strokes: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    // toDataURL on every stroke end is fine at this cadence; strokes are counted
    // on pointer-up, not per move.
    try { setUrl(c.toDataURL('image/png')) } catch { setUrl('') }
  }, [canvasRef, strokes])
  if (!url) return null
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundColor: 'rgba(244, 114, 182, 0.55)',
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
        WebkitMaskSize: '100% 100%',
        maskSize: '100% 100%',
      }}
    />
  )
}
