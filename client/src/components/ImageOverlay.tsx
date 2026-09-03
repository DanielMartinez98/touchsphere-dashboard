// The full-screen generated picture.
//
// Opened two ways, which is why it's a top-level overlay driven by a store
// rather than a piece of some widget's state: the assistant being asked out loud
// ("draw me a cat in a spacesuit"), and a tap on an earlier picture.
//
// THE STACK, top to bottom — the four portals that can be on screen together:
//
//   9400/9390  this picture / its backdrop
//   9200/9190  BrowserOverlay window / its backdrop
//   9100       GuideOverlay
//   9000       Widget's expanded overlay
//
// A picture goes on TOP of the browser window on purpose: it is the thing that
// was just asked for, and it can be asked for while a video is playing. The
// guide's 8900 → 9100 fix is the cautionary tale for guessing a band wrong —
// it rendered under the very list it was opened from and read as "nothing
// happened".
//
// The frame goes up BEFORE the picture exists. A render is ten to thirty
// seconds and the overlay opens at the moment the spoken reply is revealed, so
// the empty frame with its phase text IS the feedback that something is
// happening — the alternative is half a minute of silence after "drawing that
// for you now".
//
// Once the picture DOES exist, this is also where everything anyone actually
// does with one lives: step to the picture either side of it, take its prompt
// back to the compose field, or redraw the picture itself with a change. They
// belong here rather than in the gallery grid, because looking at a render full
// size is the moment you decide it's nearly right and want another go at it.

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight, Copy, Check, Wand2, Brush, Info,
} from 'lucide-react'
import { closeImage, openImage, useImageJob, useImageTarget } from '../hooks/useImageOverlay'
import { redrawImage, reuseImagePrompt } from '../hooks/useImagePrompt'
import { onServerEvent } from '../hooks/useServerEvents'
import type { StoredImage } from '../hooks/useImages'

/**
 * The gallery entry, whole.
 *
 * It used to be trimmed to the three fields the arrows needed. It carries the
 * render settings now, and those belong to the same fetch: the picture and the
 * account of how it was made are one record, and splitting them would mean a
 * second request to answer a question asked by tapping ⓘ on a picture that is
 * already on screen.
 */
type GalleryEntry = StoredImage

/**
 * The gallery, for the sole purpose of knowing what sits either side of this
 * picture.
 *
 * Fetched here rather than handed in when the overlay opens, because it is
 * opened from three places — a thumbnail, a queue row, and a spoken
 * `generate_image` — and only one of those has the list to hand. One GET when
 * the frame goes up, and another whenever a render finishes, since the picture
 * being watched joins the list at the moment it lands.
 */
function useGallery(open: boolean): GalleryEntry[] {
  const [gallery, setGallery] = useState<GalleryEntry[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!open) return
    return onServerEvent('image', data => {
      const d = data as Record<string, unknown> | null
      if (d && d['status'] === 'ready') setTick(t => t + 1)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/image')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { images?: GalleryEntry[] }) => { if (!cancelled) setGallery(j.images ?? []) })
      // No neighbours is a perfectly good outcome: the arrows simply don't
      // appear, and the picture itself is unaffected.
      .catch(() => { if (!cancelled) setGallery([]) })
    return () => { cancelled = true }
  }, [open, tick])

  return gallery
}

export function ImageOverlay() {
  const target = useImageTarget()
  // A re-shown picture arrives with its url already on the payload and needs no
  // job tracking at all — the job it came from may not even exist any more.
  const done = !!target?.url
  const job = useImageJob(target?.jobId ?? null, done)

  const url = target?.url ?? job?.url
  // Taken out of the queue before it started. Not an error — nothing went wrong
  // — but the frame must stop pretending a picture is coming, and "try again"
  // is exactly the right offer, since re-queueing is what undoes it.
  const cancelled = job?.status === 'cancelled'
  const failed = job?.status === 'failed' || cancelled
  // Queued behind other renders. Worth its own state: the phase text and the
  // progress bar are both about a render that has not begun.
  const waiting = job?.status === 'queued'

  const gallery = useGallery(!!target)
  // Closed by default and reset on every open. The details are an answer to a
  // question ("what drew this one?"), not part of looking at a picture — and a
  // panel that stayed open would take a third of the frame off the NEXT
  // picture, which is the one thing a full-screen viewer must not do.
  //
  // Derived from the target's `seq` in the render body rather than reset from an
  // effect — the same "derive state from props" pattern Drawing() below uses,
  // and for the same reason: an effect would paint the previous picture's open
  // panel for one frame before closing it.
  const seq = target?.seq ?? 0
  const [details, setDetails] = useState({ open: false, seq })
  if (details.seq !== seq) setDetails({ open: false, seq })
  const detailsOpen = details.open && details.seq === seq
  // Tapping the picture drops the frame — caption, buttons, border — and
  // shows nothing but the picture, edge to edge; tapping it again brings the
  // frame back. Same derive-from-seq pattern as the details panel, so paging
  // to the next picture with the arrows keeps you in full screen (the seq
  // changes but the state is carried over) while a fresh open starts framed.
  const [fill, setFill] = useState<{ on: boolean; seq: number; carried?: number }>({ on: false, seq })
  const filled = fill.on && (fill.seq === seq || fill.carried === seq)
  // A stored picture keeps the id of the job that drew it (remember() in
  // server/src/image.ts), so one id addresses both halves — which is what lets a
  // render finishing under the frame slot straight into the list without the
  // overlay having to re-point itself at a different id.
  const index = target ? gallery.findIndex(g => g.id === target.jobId) : -1
  const prev = index > 0 ? gallery[index - 1] : undefined
  const next = index >= 0 && index < gallery.length - 1 ? gallery[index + 1] : undefined
  const entry = index >= 0 ? gallery[index] : undefined

  const show = useCallback((entry: GalleryEntry) => {
    // Paging inside full screen stays in full screen: the next open's seq is
    // this one plus one, and the state is stamped with it ahead of time.
    setFill(f => (f.on ? { on: true, seq: f.seq, carried: seq + 1 } : f))
    openImage(entry.id, entry.prompt, entry.url)
  }, [seq])

  // Arrow keys, for the same reason a dialog closes on Escape: free on a desktop
  // browser, invisible on the kiosk.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft'  && prev) show(prev)
      if (e.key === 'ArrowRight' && next) show(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, prev, next, show])

  const retry = useCallback(() => {
    if (!target) return
    fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A failed redraw is retried AS a redraw — same source, same strength.
      body: JSON.stringify({
        prompt: target.prompt,
        ...(job?.source ? { source: job.source, denoise: job.denoise ?? 0.65 } : {}),
      }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      // Re-open on the NEW job id: the overlay follows one job, so pointing it
      // at the retry is what makes the frame start filling in again.
      .then((j: { id: string }) => openImage(j.id, target.prompt))
      .catch(err => console.error('[image] retry failed:', err))
  }, [target, job])

  if (!target) return null

  // ── Full screen: the picture and nothing else ──
  // Its own tree rather than a class toggle on the frame, because nothing of
  // the frame survives: no caption, no actions, no border, no inset. Only the
  // close button and the arrows, since those are the two things a person
  // still needs while looking at a picture this way.
  if (filled && url) {
    return createPortal(
      <div className="fixed inset-0 z-[9400] bg-black flex items-center justify-center">
        <button
          type="button"
          onClick={() => setFill({ on: false, seq })}
          aria-label="Back to the framed view"
          className="w-full h-full flex items-center justify-center"
        >
          <img src={url} alt={target.prompt} className="max-w-full max-h-full object-contain" />
        </button>
        <div className="absolute top-0 right-0" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))', paddingRight: 'max(0.75rem, env(safe-area-inset-right))' }}>
          <CloseImageButton onClick={closeImage} />
        </div>
        {prev && <NavButton side="left"  label="Previous picture" onClick={() => show(prev)} />}
        {next && <NavButton side="right" label="Next picture"     onClick={() => show(next)} />}
      </div>,
      document.body,
    )
  }

  return createPortal(
    <>
      {/* Tapping outside the frame closes it — the same gesture as the browser
          window's backdrop, so the two overlays behave identically. */}
      <div className="fixed inset-0 z-[9390] bg-black/70" onClick={closeImage} />

      {/* Insets are max()'d against the safe area so the frame clears a notch and
          a home indicator on a phone, and sits exactly where it always did on
          the kiosk, where every env() is 0. */}
      <div
        className="fixed mx-auto max-w-[880px] z-[9400]
                   bg-black/95 backdrop-blur-xl rounded-3xl border border-hairline
                   flex flex-col overflow-hidden shadow-2xl"
        style={{
          left:   'max(1rem, env(safe-area-inset-left))',
          right:  'max(1rem, env(safe-area-inset-right))',
          top:    'max(2.5rem, env(safe-area-inset-top))',
          bottom: 'max(2.5rem, env(safe-area-inset-bottom))',
        }}
      >

        {/* ── Header: what was asked for, and the way out ── */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-1">
              {cancelled ? 'Taken out of the queue'
                : failed  ? 'Could not draw this'
                : url     ? 'Generated image'
                : waiting ? 'In the queue'
                : 'Drawing'}
            </p>
            {/* The prompt is the caption. It's the only thing that identifies one
                picture from another later, and the model expands what the user
                said — so it's worth reading, not hiding behind a title.

                `selectable-text` opts it out of the app-wide "a tap is never a
                text selection" rule. This is the one string in the app worth
                lifting a phrase out of by hand, and on a phone a long press is
                how that is done; the class also has to put -webkit-touch-callout
                back, or the press selects nothing and offers no Copy. The two
                buttons below cover the whole string, which is the common case
                and the only one the kiosk — where a long-press selection is
                genuinely fiddly — can manage. */}
            <p className="selectable-text text-sm text-white/85 leading-snug line-clamp-3">
              {target.prompt}
            </p>
          </div>
          <CloseImageButton onClick={closeImage} />
        </div>

        {/* ── What you do with the prompt ──
            Only once there is a picture. While one is drawing this row would
            offer to reuse a prompt that has produced nothing yet, and the
            position counter would be counting a list this picture isn't in. */}
        {url && target.prompt !== '' && (
          <PromptActions
            prompt={target.prompt}
            // A redraw needs the picture itself, not just its words, and only a
            // picture that is IN the gallery has an id the GPU box can be handed
            // — which is the same condition that gives it a position.
            source={index >= 0 ? { id: target.jobId, url, prompt: target.prompt } : null}
            position={index >= 0 ? `${index + 1} of ${gallery.length}` : ''}
            // Offered on the same condition, and for the same reason: the
            // account of how a picture was drawn lives on its gallery record,
            // so a render the list hasn't caught up with has nothing to show yet.
            details={index >= 0 ? detailsOpen : null}
            onDetails={() => setDetails(d => ({ ...d, open: !d.open }))}
          />
        )}

        {/* ── How it was drawn ──
            Between the actions and the picture rather than over it: this is
            read alongside the image ("cfg 4, 30 steps — that's why this one
            came out soft"), and an overlay panel would cover the evidence. */}
        {url && detailsOpen && index >= 0 && entry && (
          <ImageDetails
            image={entry}
            // The picture a redraw started from, when it is still in the
            // gallery. Tapping it walks back up the chain, which is the whole
            // reason the source id is worth showing rather than just the word
            // "redraw".
            onOpenSource={() => {
              const src = gallery.find(g => g.id === entry.settings?.source)
              if (src) show(src)
            }}
            hasSource={gallery.some(g => g.id === entry.settings?.source)}
          />
        )}

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4 relative">
          {url ? (
            // The picture is a button: tapping it is how the frame gets out of
            // the way (see `filled` above). `contain` rather than `cover`: a
            // picture the user asked for should be shown whole. Cropping the
            // subject out of a portrait render to fill a frame is the one thing
            // that makes it look broken.
            <button
              type="button"
              onClick={() => setFill({ on: true, seq })}
              aria-label="Show the picture full screen"
              className="max-w-full max-h-full flex items-center justify-center"
            >
              <img src={url} alt={target.prompt} className="max-w-full max-h-full object-contain rounded-2xl" />
            </button>
          ) : failed ? (
            <Failed
              message={cancelled
                ? 'You took this one out of the queue before it started.'
                : job?.error ?? 'the render failed'}
              // The server's account of the failure, which usually says what to
              // do about it — the error alone says what went wrong.
              detail={job?.detail ?? ''}
              onRetry={retry}
            />
          ) : (
            <Drawing
              phase={job?.phase ?? 'starting'}
              detail={job?.detail ?? ''}
              etaMs={job?.etaMs ?? 0}
              etaBasis={job?.etaBasis ?? ''}
              waitMs={job?.waitMs ?? 0}
              waiting={waiting}
              elapsedMs={job?.elapsedMs ?? 0}
            />
          )}

          {/* Stepping between pictures. Over the image rather than in a row under
              it, because the image is sized to fill whatever is left and a row
              beneath would take that height from every picture just to serve the
              ones being paged through. Absent — not disabled — at either end of
              the list: a dead arrow on a touchscreen is a tap that looks broken. */}
          {prev && <NavButton side="left"  label="Previous picture" onClick={() => show(prev)} />}
          {next && <NavButton side="right" label="Next picture"     onClick={() => show(next)} />}
        </div>
      </div>
    </>,
    document.body,
  )
}

/**
 * The three things you do with a finished picture.
 *
 * All of them are here, on the full-screen view, because that is where you
 * decide a picture is nearly right — and all three exist to avoid re-typing
 * forty words on an on-screen keyboard, which is the most expensive thing this
 * app can ask of anyone.
 *
 *   • Change this — a REDRAW. The picture becomes the base the next render
 *     paints over, and its own prompt is the first draft of the new one, since
 *     the model redraws from a description of the whole picture rather than
 *     from the change. This is the img2img half of the Draw panel.
 *   • Reuse prompt — the same words, a fresh render. Deliberately a separate
 *     button rather than a mode of the first: "another go at this idea" and
 *     "this exact picture but at night" want different starting points, and
 *     guessing wrong wastes a minute of GPU either way.
 *   • Copy — the phone half. `navigator.clipboard` needs a secure context,
 *     which Caddy provides, and the label reports what happened either way
 *     rather than failing silently into the console.
 *
 * Both of the first two fill the compose field and open the Draw corner on it,
 * then close this frame: filling a field nobody can see would not be reuse.
 */
function PromptActions({
  prompt, source, position, details, onDetails,
}: {
  prompt:   string
  /** The picture itself, when it is one the server can redraw. */
  source:   { id: string; url: string; prompt: string } | null
  position: string
  /** Whether the render details are showing, or null when there are none to show. */
  details:   boolean | null
  onDetails: () => void
}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)

  useEffect(() => {
    if (copied === null) return
    const t = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(prompt)
      .then(() => setCopied('yes'))
      .catch(() => setCopied('no'))
  }, [prompt])

  return (
    // Wraps rather than scrolls: on a 390px phone three pills and a counter do
    // not fit on one line, and a row that has to be scrolled sideways to reach
    // its last button is a button nobody finds.
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3 shrink-0">
      {source && (
        <button
          type="button"
          onClick={() => { redrawImage(source); closeImage() }}
          className="h-11 px-4 rounded-full bg-pink-500/20 border border-pink-400/35 text-white
                     text-[13px] font-semibold flex items-center gap-2
                     active:scale-95 active:bg-pink-500/35 transition"
        >
          <Brush size={16} />
          Change this
        </button>
      )}

      <button
        type="button"
        onClick={() => { reuseImagePrompt(prompt); closeImage() }}
        className="h-11 px-4 rounded-full bg-white/10 border border-hairline text-white/70
                   text-[13px] font-semibold flex items-center gap-2
                   active:scale-95 active:bg-white/20 transition"
      >
        <Wand2 size={16} />
        Reuse prompt
      </button>

      <button
        type="button"
        onClick={copy}
        aria-label={copied === 'no' ? "Couldn't copy the prompt" : 'Copy the prompt'}
        // Icon only, unlike the two beside it: it is the least-used of the three
        // and the row has to fit a phone. The check mark is the confirmation.
        className="w-11 h-11 rounded-full bg-white/10 border border-hairline text-white/70
                   flex items-center justify-center
                   active:scale-95 active:bg-white/20 transition"
      >
        {copied === 'yes' ? <Check size={16} className="text-green-300" />
          : copied === 'no' ? <X size={16} className="text-amber-300" />
          : <Copy size={16} />}
      </button>

      {/* How it was drawn. Icon-only like Copy, and beside it, because both are
          about the picture rather than about making another one — the two
          labelled pills stay the row's headline. */}
      {details !== null && (
        <button
          type="button"
          onClick={onDetails}
          aria-label={details ? 'Hide how this was drawn' : 'How this was drawn'}
          aria-expanded={details}
          className={`w-11 h-11 rounded-full border border-hairline flex items-center justify-center
                      active:scale-95 transition ${
            details ? 'bg-white/25 text-white' : 'bg-white/10 text-white/70 active:bg-white/20'
          }`}
        >
          <Info size={16} />
        </button>
      )}

      {/* Where this picture sits in the gallery — the thing that makes the two
          arrows over the image legible as "there are more of these". */}
      {position !== '' && (
        <span className="ml-auto text-[11px] text-white/30 tabular-nums shrink-0">{position}</span>
      )}
    </div>
  )
}

/**
 * How this picture was drawn.
 *
 * The point is the question nobody could answer before: "that one came out
 * well — what made it?". A gallery of thirty renders across four styles, three
 * quality presets and a per-style knob panel that changes under you is
 * unreproducible without this, and reproducing a good render is most of what
 * anyone does with a picture they like.
 *
 * Everything here is READ BACK from what the server recorded at the moment the
 * picture landed, never recomputed from today's settings — see ImageSettings in
 * server/src/image.ts for why that distinction is the whole feature.
 *
 * Rows are omitted rather than shown empty. A picture from before this was
 * recorded has only its size, seed and date, and says so in one line instead of
 * printing a column of zeros that look like real settings.
 */
function ImageDetails({
  image, onOpenSource, hasSource,
}: {
  image:        GalleryEntry
  onOpenSource: () => void
  hasSource:    boolean
}) {
  const st = image.settings
  const rows: { label: string; value: string }[] = []

  // A picture the user added from their own device has no style, no sampler and
  // no seed — it was not drawn here. Saying so once is the whole of its detail
  // panel; printing "Seed 0, Steps —" against a photograph would be inventing a
  // render that never happened.
  const uploaded = image.origin === 'upload'

  if (uploaded) {
    rows.push({ label: 'Source', value: 'added from your device' })
  } else {
    const style = st?.styleLabel || image.modelLabel || st?.style || image.model || ''
    if (style) rows.push({ label: 'Style', value: style })
  }
  rows.push({ label: 'Size', value: `${image.width} × ${image.height}` })
  // Steps and cfg are the two numbers anyone actually turns, so they lead.
  if (!uploaded && st?.steps) rows.push({ label: 'Steps', value: String(st.steps) })
  // 0 means the sampler has no cfg input at all (SamplerCustom), which is not
  // the same as cfg 0 — omitting it is the honest rendering of that.
  if (!uploaded && st?.cfg) rows.push({ label: 'Guidance', value: String(st.cfg) })
  if (!uploaded && st?.sampler) {
    rows.push({ label: 'Sampler', value: st.scheduler ? `${st.sampler} · ${st.scheduler}` : st.sampler })
  }
  // Last of the numbers, because it is the one you copy rather than read — it
  // is also what makes every other row above it reproducible.
  if (!uploaded) rows.push({ label: 'Seed', value: String(image.seed) })
  if (st?.lora) {
    rows.push({ label: 'Turbo LoRA', value: `${st.lora} @ ${st.loraStrength ?? 1}` })
  }
  if (st?.source) {
    // As a percentage, because that is what "how much of the original survived"
    // means to anyone who didn't pick the number: 0.65 denoise is 65% redrawn.
    rows.push({ label: 'Redrawn from', value: `an earlier picture · ${Math.round((st.denoise ?? 0) * 100)}% changed` })
  }
  // The prompt improver, when it ran. Named rather than implied: two models
  // write very different prompts, and "why does this look nothing like what I
  // typed" has exactly one answer and it is this row.
  if (st?.promptOriginal && st.improvedBy) {
    rows.push({ label: 'Prompt improved by', value: st.improvedBy })
  }
  const when = new Date(image.at)
  rows.push({
    label: uploaded ? 'Added' : 'Drawn',
    value: `${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${
      st?.tookMs ? ` · took ${(st.tookMs / 1000).toFixed(0)}s` : ''}`,
  })

  return (
    // Capped and scrollable: a long negative prompt is a paragraph, and the
    // picture below must not be squeezed out of the frame to print it.
    <div className="shrink-0 max-h-[38%] overflow-y-auto px-4 pb-3">
      <div className="rounded-2xl bg-white/[0.06] border border-hairline px-3.5 py-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {rows.map(r => (
            <div key={r.label} className="contents">
              <dt className="text-white/35 whitespace-nowrap">{r.label}</dt>
              {/* selectable-text for the same reason the prompt caption has it:
                  a seed is a number someone copies by hand on a phone. */}
              <dd className="selectable-text text-white/80 tabular-nums break-words min-w-0">{r.value}</dd>
            </div>
          ))}
        </dl>

        {/* The prompt as typed, when the improver replaced it. Above the
            negative because it is the more surprising of the two: the caption
            over the picture is the REWRITTEN prompt (it is what the sampler
            read), so without this there is nowhere to see the sentence that was
            actually asked for. */}
        {st?.promptOriginal && (
          <div className="mt-3 pt-3 border-t border-hairline">
            <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold mb-1">
              You asked for
            </p>
            <p className="selectable-text text-[11px] text-white/45 leading-snug break-words">
              {st.promptOriginal}
            </p>
          </div>
        )}

        {st?.negative && (
          <div className="mt-3 pt-3 border-t border-hairline">
            <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold mb-1">
              Avoided
            </p>
            <p className="selectable-text text-[11px] text-white/45 leading-snug break-words">
              {st.negative}
            </p>
          </div>
        )}

        {/* Walking back up a redraw chain. A button only when the source is
            still there — pruned past the cap or deleted, it is a dead tap, and
            the row above already said the picture was a redraw. */}
        {st?.source && hasSource && (
          <button
            type="button"
            onClick={onOpenSource}
            className="mt-3 h-10 px-4 rounded-full bg-white/10 border border-hairline text-white/70
                       text-[12px] font-semibold flex items-center gap-2
                       active:scale-95 active:bg-white/20 transition"
          >
            <Brush size={14} />
            Show what it started from
          </button>
        )}

        {!st && (
          <p className="mt-3 pt-3 border-t border-hairline text-[11px] text-white/30 leading-snug">
            This picture predates the render details being recorded, so only its
            size, seed and date survive.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One of the two stepping arrows.
 *
 * The same 56px round glass as every other control in this app, pinned to the
 * edge of the image area and vertically centred — where a thumb already expects
 * it from every photo viewer on the device. Sits over the frame's padding rather
 * than the picture for anything but a very wide render, and is translucent so it
 * never hides the middle of one that is.
 */
function NavButton({
  side, label, onClick,
}: {
  side:    'left' | 'right'
  label:   string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 -translate-y-1/2 w-14 h-14 rounded-full
                  bg-black/60 backdrop-blur-md border border-hairline
                  flex items-center justify-center text-white/75
                  active:scale-90 active:bg-white/25 transition ${
        side === 'left' ? 'left-1' : 'right-1'
      }`}
    >
      {side === 'left'
        ? <ChevronLeft  size={28} strokeWidth={2.25} />
        : <ChevronRight size={28} strokeWidth={2.25} />}
    </button>
  )
}

/**
 * The same round 56px glass X as every expanded widget and the game guide.
 * That's the one gesture in this app that already means "done with this screen",
 * and a new overlay inventing its own exit is how a kiosk gets confusing.
 */
function CloseImageButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Close the picture"
      className="w-14 h-14 shrink-0 rounded-full bg-glass-2 border border-hairline flex items-center
                 justify-center text-white/80 active:scale-90 active:bg-white/25 transition-colors">
      <X size={26} strokeWidth={2.25} />
    </button>
  )
}

/**
 * The waiting state.
 *
 * The bar is honest or it isn't there. ComfyUI's real per-step progress only
 * comes over its WebSocket, which the server doesn't hold open — so with a
 * previous render to compare against we show elapsed-against-that, capped below
 * full because a bar that sits at 100% while nothing happens is worse than no
 * bar. With no history (the first render after a restart, which is also the
 * slowest, because the checkpoint has to load) we show the seconds and say so.
 *
 * `waiting` — queued behind other renders — takes the bar away entirely. There
 * is nothing to measure against: how long this picture waits depends on the
 * ones in front of it, and an elapsed-vs-eta bar would fill to 95% while the
 * GPU had not yet touched it.
 */
function Drawing({
  phase, detail, etaMs, etaBasis, waitMs, waiting, elapsedMs,
}: {
  phase:     string
  detail:    string
  etaMs:     number
  etaBasis:  string
  waitMs:    number
  waiting:   boolean
  elapsedMs: number
}) {
  // SSE frames only arrive on phase changes, which can be twenty seconds apart.
  // The seconds have to tick locally or the screen looks frozen.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  // The clock is anchored to the SERVER's own elapsed figure, never to when
  // this component mounted.
  //
  // It used to start at `Date.now()` inside an effect, which measured how long
  // the OVERLAY had been open rather than how long the picture had been
  // drawing — so closing the frame and reopening it to check on a render
  // restarted the count at 0s every time, and something two minutes in read as
  // five seconds.
  //
  // What's stored is the last figure the server sent plus the local instant it
  // arrived, so the seconds are `server elapsed + time since that frame`. Anchoring
  // to a duration rather than to an absolute start timestamp off the wire means
  // no agreement is needed between the server's clock and the browser's — a
  // phone with a skewed clock still counts from the right place — and re-anchoring
  // on every frame makes it self-correcting rather than free-running.
  //
  // `waiting` is deliberately not part of this any more. The server resets its
  // own `startedAt` when the render actually begins, so elapsedMs is queue time
  // while queued and draw time once drawing — the distinction the old effect
  // tried to recreate locally, and got wrong on every remount.
  //
  // The setState sits in the render body rather than an effect on purpose:
  // that's React's "derive state from props" pattern. `now` rather than a fresh
  // Date.now() because reading the clock during render is impure, and `now` is
  // at most one 250ms tick stale — invisible at whole-second resolution.
  const [frame, setFrame] = useState(() => ({ elapsedMs, at: Date.now() }))
  if (frame.elapsedMs !== elapsedMs) setFrame({ elapsedMs, at: now })
  const elapsed = Math.max(0, frame.elapsedMs + (now - frame.at))

  const pct = !waiting && etaMs > 0 ? Math.min(95, (elapsed / etaMs) * 100) : null
  // What is left of the estimate, counted down rather than up. "about 20s to
  // go" is the thing someone standing at the kiosk actually wants; elapsed
  // seconds are what they can already see happening. Clamped at zero rather
  // than going negative, since the estimate is an estimate.
  const remaining = etaMs > 0 ? Math.max(0, etaMs - elapsed) : 0

  return (
    <div className="w-full max-w-[460px] flex flex-col items-center gap-4">
      <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
        {pct === null
          ? <div className="h-full w-1/3 rounded-full bg-white/40 animate-pulse" />
          : <div className="h-full rounded-full bg-white/60 transition-[width] duration-300"
                 style={{ width: `${pct}%` }} />}
      </div>

      <div className="text-center">
        <p className="text-sm text-white/70 capitalize">
          {waiting ? (phase || 'waiting for the GPU') : phase}
        </p>

        {/* The clock line. Elapsed on the left because it is the one number that
            is certainly true; the estimate beside it, and only when there is a
            real one behind it. */}
        <p className="text-xs text-white/45 mt-1.5 tabular-nums">
          {humanMs(elapsed)} elapsed
          {waiting && waitMs > 0 && ` · about ${humanMs(waitMs)} before this one starts`}
          {!waiting && etaMs > 0 && (
            remaining > 0
              ? ` · about ${humanMs(remaining)} to go, of roughly ${humanMs(etaMs)}`
              : ` · past the ${humanMs(etaMs)} estimated, finishing up`
          )}
        </p>

        {/* The verbose status: which style, how many steps, at what size, and
            what the wait is actually being spent on. This frame is an empty
            rectangle for half a minute otherwise, and "Drawing" answers none of
            the questions someone watching it has. */}
        {detail !== '' && (
          <p className="text-[12px] text-white/40 leading-relaxed mt-3 max-w-[400px] mx-auto">
            {detail}
          </p>
        )}

        {/* Where the estimate came from. Small, and last, because it only
            matters when the number looks wrong — at which point "a rough guess,
            nothing drawn with this style yet" is the difference between a bug
            and a cold start. */}
        {etaBasis !== '' && (
          <p className="text-[11px] text-white/25 leading-snug mt-2 max-w-[400px] mx-auto">
            Estimate {etaBasis}.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * "45s", "1m 20s", "12m" — mirrors humanMs() in server/src/image-timing.ts.
 *
 * Duplicated rather than sent as a formatted string, because this one counts
 * down between SSE frames: the server's sentences are written once when a phase
 * changes, and the seconds have to keep moving in between or the screen looks
 * frozen.
 */
function humanMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function Failed({ message, detail, onRetry }: {
  message: string
  detail:  string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center px-6">
      <AlertTriangle size={40} className="text-amber-400/80" />
      {/* The real reason, not "something went wrong". These failures are almost
          always one of two boring things — the GPU box is off, or the workflow
          references a checkpoint that isn't installed — and both are fixable in
          a minute IF the message says which. */}
      <p className="text-sm text-white/70 leading-relaxed max-w-[380px] break-words">{message}</p>
      {/* What to do about it, when the server has something to add. Kept
          separate from the error itself: one says what went wrong, the other
          says what it means and what fixes it. */}
      {detail !== '' && detail !== message && (
        <p className="text-[12px] text-white/40 leading-relaxed max-w-[400px]">{detail}</p>
      )}
      <button type="button" onClick={onRetry}
        className="px-6 h-12 rounded-full bg-white/15 border border-white/25 text-white text-sm
                   font-semibold flex items-center gap-2 active:scale-95 active:bg-white/30 transition">
        <RefreshCw size={18} />
        Try again
      </button>
    </div>
  )
}
