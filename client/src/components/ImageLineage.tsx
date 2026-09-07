// WHY DID THIS PICTURE COME BACK LIKE THAT?
//
// A redraw has a lot of machinery behind it — a region found from words, a
// mask, a pose hold, a strength, a prompt that was rewritten twice — and none
// of it is visible in the result. When the answer is "it came back unchanged",
// the reason is always in what the render was asked, and until now that was
// only in the server's log.
//
// So: the chain of pictures this one came from, oldest first, each link
// showing the tool, the region (drawn over the thumbnail), the settings that
// steered it, the prompt actually sent — and HOW MUCH IT CHANGED, measured,
// with a plain-words verdict when that number is small. The verdict is the
// point; everything else is the evidence for it.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowDown, Lasso, Wand2, Brush, Upload, Sparkles, AlertTriangle, Loader2 } from 'lucide-react'
import { openImage } from '../hooks/useImageOverlay'
import type { ImageSettings } from '../hooks/useImages'

interface Link {
  id:       string
  url:      string
  prompt:   string
  width:    number
  height:   number
  at:       string
  origin:   'render' | 'upload'
  settings: ImageSettings | null
  maskUrl:  string | null
  sourceMissing: boolean
}

/** Below this the picture is, to the eye, the one it started from. Matches NO_CHANGE on the server. */
const UNCHANGED = 0.05
/** Below this it changed, but barely — worth flagging without calling it a failure. */
const BARELY = 0.12

/** What kind of step this was, in the words the Draw panel uses. */
function toolOf(st: ImageSettings | null, origin: string): { label: string; icon: React.ReactNode } {
  if (origin === 'upload') return { label: 'Added from your device', icon: <Upload size={13} /> }
  if (!st?.source) return { label: 'Drawn from scratch', icon: <Sparkles size={13} /> }
  if (st.mask) return { label: 'Changed a part', icon: <Lasso size={13} /> }
  if (/kontext/i.test(st.styleLabel ?? '')) return { label: 'Instruction edit', icon: <Wand2 size={13} /> }
  return { label: 'Redrawn whole', icon: <Brush size={13} /> }
}

/**
 * The verdict, in one or two sentences, for a link that barely moved.
 *
 * Ordered by how often each one is the real cause, and each names the control
 * that fixes it — a diagnosis you can't act on is just a different way of
 * saying the picture is wrong.
 */
function verdict(st: ImageSettings | null): { tone: 'bad' | 'warn'; text: string } | null {
  if (!st?.source || typeof st.changed !== 'number') return null
  const pct = Math.round(st.changed * 100)
  if (st.changed >= BARELY) return null
  const tone = st.changed < UNCHANGED ? 'bad' : 'warn'
  const lead = st.changed < UNCHANGED
    ? 'This came back essentially unchanged.'
    : `This changed very little (${pct}% of the picture).`
  const causes: string[] = []
  const isEdit = /kontext/i.test(st.styleLabel ?? '')
  const prompt = (st.promptOriginal ?? st.fullPrompt ?? '').toLowerCase()

  if (isEdit && /\b(keep|keeping|unchanged|the same|preserve|don't change|do not change)\b/.test(prompt)) {
    causes.push(
      'The instruction ends by listing what to keep. An editor told to keep everything ' +
      'changes nothing — say the result you want, then at most one short clause about what is at risk.',
    )
  }
  if (st.mask && st.region) {
    causes.push(
      `Only "${st.region}" was allowed to change. If that phrase found the wrong thing — or a thing ` +
      'that is not in the picture — the repaint had nowhere to happen. The mask is drawn over the ' +
      'thumbnail; check it covers what you meant.',
    )
  } else if (st.mask) {
    causes.push('Only the marked part was allowed to change, so everything outside it is identical by design.')
  }
  if (st.controlnet && /·\s*lines/.test(st.controlnet)) {
    causes.push(
      'The pose hold was on Lines, which pins every contour of the original — including the thing you ' +
      'asked to remove or replace. Settings → Drawing → Keeping the pose: Body holds the shape but ' +
      'frees the outlines, or set Line detail to coarse.',
    )
  }
  if (!st.mask && typeof st.denoise === 'number' && st.denoise > 0 && st.denoise < 0.5) {
    causes.push(`Strength was ${Math.round(st.denoise * 100)}%, which keeps most of the original by design. Try a stronger setting.`)
  }
  if (isEdit && !causes.length) {
    causes.push(
      'The editor did not find anything to do with this instruction. Name the subject as it appears ' +
      'in the picture and say the change concretely, or use "Just a part" and mark the region by hand.',
    )
  }
  return { tone, text: [lead, ...causes].join(' ') }
}

function Facts({ st, origin }: { st: ImageSettings | null; origin: string }) {
  const rows: [string, string][] = []
  if (origin === 'upload') rows.push(['Source', 'your device'])
  if (st?.styleLabel) rows.push(['Style', st.styleLabel])
  if (st?.region) rows.push(['Region', st.region])
  else if (st?.mask) rows.push(['Region', 'marked by hand'])
  if (typeof st?.denoise === 'number' && st.source) rows.push(['Strength', `${Math.round(st.denoise * 100)}%`])
  if (st?.controlnet) {
    // "file · mode NN% to MM%" — the file name means nothing here; the mode does.
    const tail = st.controlnet.split('·').slice(1).join('·').trim()
    rows.push(['Pose held', tail || 'yes'])
  } else if (st?.source) {
    rows.push(['Pose held', 'no'])
  }
  if (st?.steps) rows.push(['Steps', String(st.steps)])
  if (st?.cfg) rows.push(['Guidance', String(st.cfg)])
  if (st?.improvedBy) rows.push(['Prompt rewritten by', st.improvedBy])
  if (!rows.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 mt-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[11px] text-white/30 whitespace-nowrap">{k}</dt>
          <dd className="text-[11px] text-white/70 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ChangeBar({ changed }: { changed: number }) {
  const pct = Math.round(changed * 100)
  const tone = changed < UNCHANGED ? 'bg-red-400' : changed < BARELY ? 'bg-amber-400' : 'bg-emerald-400'
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">Changed</span>
        <span className={`text-[11px] tabular-nums font-semibold ${
          changed < UNCHANGED ? 'text-red-300' : changed < BARELY ? 'text-amber-300' : 'text-emerald-300'}`}>
          {pct < 1 ? '<1' : pct}% of the picture
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-1">
        {/* Scaled so the interesting range (0–40%) fills the bar: everything
            above that is plainly "a lot" and needs no resolution. */}
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, (changed / 0.4) * 100)}%` }} />
      </div>
    </div>
  )
}

function Thumb({ link }: { link: Link }) {
  return (
    <button
      type="button"
      onClick={() => openImage(link.id, link.prompt, link.url)}
      className="relative w-20 h-20 shrink-0 rounded-xl overflow-hidden border border-hairline
                 active:scale-95 transition-transform"
      aria-label="Open this picture"
    >
      <img src={link.url} alt="" className="w-full h-full object-cover" />
      {/* The region that was allowed to change, over the picture it changed. */}
      {link.maskUrl && (
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundColor: 'rgba(244,114,182,0.55)',
            WebkitMaskImage: `url(${link.maskUrl})`, maskImage: `url(${link.maskUrl})`,
            WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
          }}
        />
      )}
    </button>
  )
}

export default function ImageLineage({ id, onClose }: { id: string; onClose: () => void }) {
  const [chain, setChain] = useState<Link[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/image/lineage/${id}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { chain: Link[] }) => { if (!cancelled) setChain(j.chain) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'could not load the history') })
    return () => { cancelled = true }
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    // Above the picture viewer (9400) because it is opened from inside it.
    <div className="fixed inset-0 z-[9500] bg-black/95 flex flex-col text-white">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-widest text-pink-300/80 font-semibold">
            How this picture was made
          </div>
          <div className="text-[13px] text-white/50">
            {chain ? `${chain.length} step${chain.length === 1 ? '' : 's'}, oldest first` : 'Loading…'}
          </div>
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

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
        {!chain && !error && (
          <div className="py-12 flex justify-center text-white/40"><Loader2 size={22} className="animate-spin" /></div>
        )}
        {error && <p className="py-8 text-center text-[13px] text-red-300">{error}</p>}

        {chain?.map((link, i) => {
          const tool = toolOf(link.settings, link.origin)
          const v = verdict(link.settings)
          const st = link.settings
          return (
            <div key={link.id}>
              {i > 0 && (
                <div className="flex items-center gap-2 py-1.5 pl-9 text-white/25">
                  <ArrowDown size={14} />
                  <span className="text-[11px]">then</span>
                </div>
              )}
              <div className="flex gap-3">
                <Thumb link={link} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-white/85">
                    {tool.icon}{tool.label}
                  </div>
                  {link.sourceMissing && (
                    <p className="text-[11px] text-amber-300/70 leading-snug mt-0.5">
                      What this started from is no longer in the gallery, so the chain begins here.
                    </p>
                  )}
                  <p className="selectable-text text-[12px] text-white/60 leading-snug mt-1 break-words">
                    {link.prompt}
                  </p>
                  {st?.promptOriginal && st.promptOriginal !== link.prompt && (
                    <p className="text-[11px] text-white/35 leading-snug mt-1 break-words">
                      You asked for: {st.promptOriginal}
                    </p>
                  )}
                  {st?.prefix && (
                    <p className="text-[11px] text-white/25 leading-snug mt-1 break-words">
                      Added in front: {st.prefix}
                    </p>
                  )}
                  <Facts st={st} origin={link.origin} />
                  {typeof st?.changed === 'number' && <ChangeBar changed={st.changed} />}
                  {v && (
                    <div className={`mt-2 rounded-xl px-3 py-2 border text-[11px] leading-relaxed ${
                      v.tone === 'bad'
                        ? 'bg-red-500/10 border-red-400/30 text-red-100/90'
                        : 'bg-amber-500/10 border-amber-400/30 text-amber-100/90'}`}>
                      <span className="flex items-start gap-1.5">
                        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                        <span>{v.text}</span>
                      </span>
                    </div>
                  )}
                  {st?.source && typeof st.changed !== 'number' && (
                    <p className="text-[11px] text-white/25 leading-snug mt-1.5">
                      This picture predates the change measurement, so how much it moved was not recorded.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {chain && chain.length === 1 && (
          <p className="mt-4 text-[11px] text-white/30 leading-relaxed">
            This one was drawn from scratch, so there is nothing before it. A picture made by
            changing another shows every step it went through, and how much each one moved.
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
