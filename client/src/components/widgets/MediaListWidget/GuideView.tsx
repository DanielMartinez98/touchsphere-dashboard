// The game guide, full screen, in two layers.
//
//   1. The chapter list — nothing but the chapters, the way that game's community
//      divides it up, each with its own progress. Short enough to take in at a
//      glance from arm's length.
//   2. One chapter — tap a chapter and its whole checklist gets the screen, with
//      its walkthrough video and its own scroll.
//
// Steps deliberately do NOT appear in the list: a 12-chapter game is a few
// hundred of them, and inline expansion turned the guide into an endless page you
// had to scroll past to find anything.
//
// Both layers live inside the media widget's expanded overlay (already
// full-screen and portalled to body), so they're absolute layers here rather than
// portals of their own.

import { useState } from 'react'
import {
  ArrowLeft, Check, CheckCheck, ChevronRight, Play, RefreshCw, ListOrdered, Square, Trash2,
  Loader2, AlertTriangle,
} from 'lucide-react'
import type { Guide, GuideSection, GuideVideo, MediaItem, SectionKind } from '../../../types'
import { guideProgress } from '../../../types'
import { openBrowse } from '../../../hooks/useBrowse'
import { MediaCover } from './MediaCover'
import { TouchKeyboard } from '../../TouchKeyboard'

const KIND_LABEL: Record<SectionKind, string> = {
  progression: 'Walkthrough',
  collectible: 'Collectibles',
  sidequest:   'Side quests',
  reference:   'Reference',
}

// Colour carries the same meaning as the label so the eye can group chapters
// without reading them: cyan for the critical path, amber for things to find,
// violet for optional quests, grey for material you don't "complete".
const KIND_CLASS: Record<SectionKind, string> = {
  progression: 'bg-cyan-400/20 text-cyan-200',
  collectible: 'bg-amber-400/20 text-amber-200',
  sidequest:   'bg-violet-400/20 text-violet-200',
  reference:   'bg-white/10 text-white/50',
}

function playVideo(video: GuideVideo) {
  openBrowse({
    kind: 'video',
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    title: video.title,
    videoId: video.videoId,
    ...(video.channel ? { channel: video.channel } : {}),
  })
}

const sectionCounts = (s: GuideSection) => {
  const done = s.steps.filter(x => x.done).length
  const total = s.steps.length
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0, complete: total > 0 && done === total }
}

/** Thin progress track. */
function Bar({ pct, accent = 'bg-[var(--accent,#06b6d4)]', height = 'h-2' }: {
  pct: number
  accent?: string
  height?: string
}) {
  return (
    <div className={`${height} w-full bg-white/10 rounded-full overflow-hidden`}>
      <div className={`h-full ${accent} rounded-full transition-all duration-300`}
           style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}

function WatchRow({ video, label }: { video: GuideVideo; label: string }) {
  return (
    <button type="button" onClick={() => playVideo(video)}
      className="w-full flex items-center gap-3 px-3 h-14 rounded-xl bg-red-500/12 border border-red-500/25 active:bg-red-500/20 text-left">
      <span className="w-8 h-8 shrink-0 rounded-full bg-red-500/80 text-white flex items-center justify-center">
        <Play size={14} fill="currentColor" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white/90 truncate">{label}</span>
        <span className="block text-xs text-white/45 truncate">
          {video.title}{video.channel ? ` · ${video.channel}` : ''}
        </span>
      </span>
    </button>
  )
}

// ── Layer 2: one chapter ─────────────────────────────────────────────────────

function ChapterPage({
  section, index, total, busy, onBack, onToggleStep, onToggleAll, onRebuild, onJump,
}: {
  section:      GuideSection
  index:        number
  total:        number
  /** Something is already generating for this guide — no second rebuild. */
  busy:         boolean
  onBack:       () => void
  onToggleStep: (stepId: string) => void
  onToggleAll:  (done: boolean) => void
  onRebuild:    () => void
  /** Move to the previous/next chapter without going back to the list. */
  onJump:       (delta: number) => void
}) {
  const { done, total: steps, pct, complete } = sectionCounts(section)
  const rebuilding = busy && section.state === 'pending'

  return (
    <div className="absolute inset-0 z-[55] flex flex-col bg-[#07090f]">
      <div className="shrink-0 px-4 pt-16 pb-3 border-b border-hairline">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onBack} aria-label="Back to chapters"
            className="w-11 h-11 shrink-0 rounded-full bg-glass-2 text-white/70 flex items-center justify-center active:scale-90">
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
              Chapter {index + 1} of {total}
            </p>
            <p className="text-lg font-semibold text-white leading-tight mt-0.5">{section.title}</p>
            <span className={`inline-block mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${KIND_CLASS[section.kind]}`}>
              {KIND_LABEL[section.kind]}
            </span>
            {!section.counts && (
              <span className="ml-2 text-[10px] text-white/35 uppercase tracking-wider">not counted</span>
            )}
          </div>
          {complete && <Check size={22} className="text-emerald-400 shrink-0 mt-1" />}
        </div>

        {steps > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <Bar pct={pct} accent={complete ? 'bg-emerald-400/80' : 'bg-[var(--accent,#06b6d4)]'} height="h-1.5" />
            <span className="text-sm font-semibold text-white/70 tabular-nums shrink-0">{done}/{steps}</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-fade-y px-4 py-3 flex flex-col gap-3">
        {section.summary && (
          <p className="text-sm text-white/55 leading-snug">{section.summary}</p>
        )}

        {section.video && <WatchRow video={section.video} label="Watch this chapter" />}

        {/* Both live at the top rather than under the steps: the whole point of
            "I already did this one" is not having to scroll past sixty boxes to
            say so, and a chapter you want rewritten is one you don't want to read. */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={steps === 0} onClick={() => onToggleAll(!complete)}
            className={`h-13 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-30 ${
              complete
                ? 'bg-white/[0.06] text-white/70 active:bg-white/10'
                : 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 active:bg-emerald-500/25'
            }`}>
            {complete ? <><Square size={16} /> Clear all</> : <><CheckCheck size={16} /> Mark all done</>}
          </button>
          <button type="button" disabled={busy} onClick={onRebuild}
            className="h-13 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 disabled:opacity-40 flex items-center justify-center gap-2">
            {rebuilding
              ? <><Loader2 size={16} className="animate-spin" /> Rewriting…</>
              : <><RefreshCw size={16} /> Redo this chapter</>}
          </button>
        </div>

        {steps === 0 && (
          <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
              {rebuilding
                ? <><Loader2 size={16} className="animate-spin" /> Researching this chapter…</>
                : <><AlertTriangle size={16} /> Nothing researched for this chapter</>}
            </p>
            <p className="text-xs text-amber-100/60 mt-1.5 leading-snug">
              {rebuilding
                ? 'Reading what the community has written about this part. It fills in here when it lands.'
                : section.state === 'pending'
                  ? 'It hasn’t been researched yet — this fills in while the guide is being built.'
                  : '“Redo this chapter” searches again with wider terms. It only touches this chapter — ' +
                    'the rest of the guide and everything you’ve ticked off stays put.'}
            </p>
          </div>
        )}

        <div className="flex flex-col">
          {section.steps.map((step, i) => (
            <button key={step.id} type="button" onClick={() => onToggleStep(step.id)}
              className="flex items-start gap-3 py-3 px-1 min-h-13 text-left active:bg-white/[0.05] rounded-lg border-b border-white/[0.04] last:border-0">
              <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-md border-2 flex items-center justify-center transition-colors ${
                step.done
                  ? 'bg-emerald-500/30 border-emerald-500/60 text-emerald-300'
                  : 'border-white/30'
              }`}>
                {step.done && <Check size={16} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[15px] leading-snug ${
                  step.done ? 'line-through text-white/35' : 'text-white/90'
                }`}>
                  <span className="text-white/30 tabular-nums mr-2">{i + 1}</span>
                  {step.text}
                </span>
                {step.note && (
                  <span className={`block text-xs mt-1 leading-snug ${step.done ? 'text-white/20' : 'text-white/45'}`}>
                    {step.note}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {section.source && (
          <button type="button"
            onClick={() => openBrowse({ kind: 'web', url: section.source!.url, title: section.title, site: section.source!.site, embeddable: false })}
            className="text-left text-[11px] text-white/30 active:text-white/60 pt-1">
            researched from {section.source.site} — open the page
          </button>
        )}

        {/* Straight into the next chapter, so a play session doesn't bounce back
            through the list every time. */}
        <div className="grid grid-cols-2 gap-2 pt-2 pb-4">
          <button type="button" disabled={index === 0} onClick={() => onJump(-1)}
            className="h-13 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 disabled:opacity-30">
            ← Previous
          </button>
          <button type="button" disabled={index === total - 1} onClick={() => onJump(1)}
            className="h-13 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 disabled:opacity-30">
            Next →
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reorder sheet ────────────────────────────────────────────────────────────
// Regenerating with a custom order is the UI half of what the assistant does
// when you say "order it by boss instead" — same `order` field on the server.

function ReorderSheet({
  guide, onClose, onSubmit,
}: {
  guide:    Guide
  onClose:  () => void
  onSubmit: (order: string) => void
}) {
  const [value, setValue] = useState(guide.orderOverride ?? '')

  const commit = () => {
    onSubmit(value.trim())
    onClose()
  }

  return (
    <div className="absolute inset-0 z-[60] flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#0e1117] border-t border-hairline rounded-t-3xl notion-sheet"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-3 pb-4">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4" />
          <p className="text-base font-semibold text-white mb-1">Rebuild in a different order</p>
          <p className="text-xs text-white/45 mb-3">
            e.g. “by boss order”, “speedrun route”, “just the side quests”. Leave empty to use however
            the community organizes it. This replaces the guide and every ticked step.
          </p>
          <div className="flex gap-2">
            <input type="text" inputMode="none" readOnly value={value}
              placeholder="how should it be organized?"
              className="flex-1 bg-glass-2 text-white rounded-xl px-4 py-3 text-base outline-none placeholder:text-white/25" />
            <button type="button" onClick={commit}
              className="px-5 bg-[var(--accent,#06b6d4)] text-black font-bold rounded-xl active:scale-95">
              Rebuild
            </button>
          </div>
        </div>
        <TouchKeyboard value={value} onChange={setValue} onDone={commit} />
      </div>
    </div>
  )
}

// ── Layer 1: the chapter list ────────────────────────────────────────────────

/**
 * Resolve a chapter the assistant named: a section id, a 1-based number
 * ("chapter 3"), an exact title, or a distinctive part of one.
 */
function resolveChapter(guide: Guide | null, hint: string | undefined): string | null {
  if (!guide || !hint) return null
  const h = hint.trim().toLowerCase()
  if (!h) return null
  const byId = guide.sections.find(s => s.id === hint)
  if (byId) return byId.id
  const num = Number(h.replace(/^chapter\s*/, ''))
  if (Number.isInteger(num) && num >= 1 && num <= guide.sections.length) {
    return guide.sections[num - 1]!.id
  }
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    guide.sections.find(s => s.title.toLowerCase() === h) ??
    guide.sections.find(s => loose(s.title) === loose(h)) ??
    guide.sections.find(s => loose(s.title).includes(loose(h))) ??
    guide.sections.find(s => loose(h).includes(loose(s.title)))
  )?.id ?? null
}

interface Props {
  item:         MediaItem
  guide:        Guide | null
  loading:      boolean
  onClose:      () => void
  onToggleStep: (sectionId: string, stepId: string) => void
  /** Tick or clear every step in one chapter at once. */
  onToggleSection: (sectionId: string, done: boolean) => void
  /** Re-research one chapter, leaving the rest of the guide alone. */
  onRebuildSection: (sectionId: string) => void
  /** Start or rebuild. `order` overrides the community ordering. */
  onGenerate:   (order?: string) => void
  onDelete:     () => void
  /** Chapter the assistant asked for — name, number, or id. */
  chapterHint?: string | undefined
  /** Bumped per command, so saying it again re-applies the hint after browsing. */
  hintSeq?:     number
}

export function GuideView({
  item, guide, loading, onClose, onToggleStep, onToggleSection, onRebuildSection,
  onGenerate, onDelete, chapterHint, hintSeq = 0,
}: Props) {
  // Taps win over the assistant's hint, but only until the next command: a new
  // hintSeq makes the tap stale and the hint takes over again. Derived rather
  // than an effect, so no render is spent syncing one to the other.
  const [tapped, setTapped] = useState<{ seq: number; id: string | null } | null>(null)
  const [showReorder, setShowReorder]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const generating = guide?.status === 'generating'
  const progress = guide ? guideProgress(guide) : null

  const openId = tapped?.seq === hintSeq ? tapped.id : resolveChapter(guide, chapterHint)
  const setOpenId = (id: string | null) => setTapped({ seq: hintSeq, id })

  const openIndex = guide ? guide.sections.findIndex(s => s.id === openId) : -1
  const openSection = openIndex >= 0 ? guide!.sections[openIndex]! : null

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#07090f]">
      {/* Header — fixed, so the 100% bar is always in view while the list scrolls */}
      <div className="shrink-0 px-4 pt-16 pb-3 border-b border-hairline">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onClose} aria-label="Back to the list"
            className="w-11 h-11 shrink-0 rounded-full bg-glass-2 text-white/70 flex items-center justify-center active:scale-90">
            <ArrowLeft size={20} />
          </button>
          <MediaCover item={item} className="w-[44px] h-[66px] rounded-lg" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-white leading-tight">{item.title}</p>
            <p className="text-xs text-white/40 mt-0.5 leading-snug line-clamp-2">
              {guide?.organization || 'Game guide'}
            </p>
          </div>
        </div>

        {progress && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/50">
                Toward 100%
              </span>
              <span className="text-lg font-bold text-white tabular-nums leading-none">
                {progress.percent}%
              </span>
            </div>
            <Bar pct={progress.percent} />
            <p className="text-xs text-white/40 mt-1.5 tabular-nums">
              {progress.counted.done} / {progress.counted.total} steps that count
              {progress.all.total !== progress.counted.total &&
                ` · ${progress.all.total - progress.counted.total} reference`}
            </p>
          </div>
        )}

        {generating && (
          <div className="mt-3 flex items-center gap-2 text-sm text-[var(--accent,#06b6d4)]">
            <Loader2 size={15} className="animate-spin shrink-0" />
            <span className="truncate">{guide?.phase ?? 'Researching…'}</span>
          </div>
        )}
      </div>

      {/* Chapter list — the scrolling part */}
      <div className="flex-1 min-h-0 overflow-auto scroll-fade-y px-4 py-3 flex flex-col gap-2.5">
        {loading && !guide && (
          <p className="text-white/45 text-sm text-center py-12">Loading guide…</p>
        )}

        {!loading && !guide && (
          <div className="flex flex-col items-center text-center gap-4 py-10 px-4">
            <ListOrdered size={40} className="text-white/25" />
            <div>
              <p className="text-base font-semibold text-white">No guide yet</p>
              <p className="text-sm text-white/45 mt-1.5 leading-snug">
                I’ll read what this game’s community has written and build a chapter list the way they
                organize it — dungeons or chapters first, then the collectibles and side quests that
                count toward 100%. Each chapter gets its own checklist and a video.
              </p>
              <p className="text-xs text-white/30 mt-2">Takes a few minutes. You can close this and come back.</p>
            </div>
            <button type="button" onClick={() => onGenerate()}
              className="h-13 px-6 rounded-xl bg-[var(--accent,#06b6d4)] text-black font-bold active:scale-95">
              Build the guide
            </button>
          </div>
        )}

        {guide?.status === 'failed' && (
          <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
              <AlertTriangle size={16} /> Couldn’t finish this guide
            </p>
            <p className="text-xs text-amber-100/60 mt-1.5 leading-snug">{guide.error}</p>
            <button type="button" onClick={() => onGenerate(guide.orderOverride)}
              className="mt-3 h-11 px-4 rounded-xl bg-amber-400/25 text-amber-100 text-sm font-semibold active:scale-95 flex items-center gap-2">
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        )}

        {guide?.video && <WatchRow video={guide.video} label="Watch the full walkthrough" />}

        {guide && guide.sections.length > 0 && (
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/40 px-1 pt-1">
            {guide.sections.length} chapters
          </p>
        )}

        {/* A row is two targets, not one: the body opens the chapter, the trailing
            circle ticks the whole thing off where it stands. Sitting down with a
            guide for a game you're part-way through means marking four chapters
            done before you read anything, and that shouldn't cost four screens
            and two hundred taps. Nested buttons aren't legal, hence the div. */}
        {guide?.sections.map((section, i) => {
          const { done, total, pct, complete } = sectionCounts(section)
          return (
            <div key={section.id}
              className={`w-full rounded-2xl border flex items-stretch transition-colors ${
                complete ? 'bg-emerald-500/[0.07] border-emerald-500/25' : 'bg-glass border-hairline'
              }`}>
              <button type="button" onClick={() => setOpenId(section.id)}
                className="min-w-0 flex-1 text-left p-3.5 flex items-center gap-3 active:bg-white/[0.05] rounded-l-2xl">
                <span className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-sm font-bold tabular-nums ${
                  complete ? 'bg-emerald-500/25 text-emerald-300' : 'bg-white/[0.07] text-white/50'
                }`}>
                  {complete ? <Check size={18} strokeWidth={3} /> : i + 1}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-[15px] font-semibold text-white leading-tight">{section.title}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${KIND_CLASS[section.kind]}`}>
                      {KIND_LABEL[section.kind]}
                    </span>
                    {section.video && <Play size={11} className="text-red-400/80" fill="currentColor" />}
                  </span>

                  {section.state === 'pending' ? (
                    <span className="flex items-center gap-2 mt-1.5 text-xs text-white/40">
                      <Loader2 size={12} className="animate-spin" />
                      {generating ? 'being researched…' : 'waiting to be researched'}
                    </span>
                  ) : total === 0 ? (
                    <span className="flex items-center gap-1.5 mt-1.5 text-xs text-amber-300/70">
                      <AlertTriangle size={12} /> nothing found — open it to redo this chapter
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 mt-1.5">
                      <Bar pct={pct} height="h-1.5"
                           accent={complete ? 'bg-emerald-400/80' : 'bg-[var(--accent,#06b6d4)]'} />
                      <span className="text-xs tabular-nums text-white/50 shrink-0">{done}/{total}</span>
                    </span>
                  )}
                </span>

                <ChevronRight size={20} className="text-white/25 shrink-0" />
              </button>

              <button type="button" disabled={total === 0}
                onClick={() => onToggleSection(section.id, !complete)}
                aria-label={complete ? `Clear ${section.title}` : `Mark ${section.title} complete`}
                className="w-16 shrink-0 flex items-center justify-center rounded-r-2xl border-l border-white/[0.06] active:bg-white/[0.07] disabled:opacity-20">
                <span className={`w-9 h-9 rounded-full border-2 flex items-center justify-center transition-colors ${
                  complete
                    ? 'bg-emerald-500/30 border-emerald-500/60 text-emerald-300'
                    : 'border-white/25 text-transparent'
                }`}>
                  <Check size={18} strokeWidth={3} />
                </span>
              </button>
            </div>
          )
        })}

        {generating && (guide?.sections.length ?? 0) === 0 && (
          <div className="flex flex-col gap-2.5">
            {/* Skeletons, so the wait for the chapter list has a shape to it. */}
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="h-[76px] rounded-2xl bg-white/[0.04] border border-hairline animate-pulse" />
            ))}
          </div>
        )}

        {guide && (
          <div className="mt-4 pt-4 border-t border-hairline flex flex-col gap-3 pb-4">
            {guide.sources.length > 0 && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/35 mb-1.5">
                  Researched from
                </p>
                <div className="flex flex-col gap-1">
                  {guide.sources.map(s => (
                    <button key={s.url} type="button"
                      onClick={() => openBrowse({ kind: 'web', url: s.url, title: s.title || s.site, site: s.site, embeddable: false })}
                      className="text-left text-xs text-white/45 active:text-white/70 truncate">
                      {s.site} — {s.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setShowReorder(true)} disabled={generating}
                className="h-13 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 disabled:opacity-40 flex items-center justify-center gap-2">
                <ListOrdered size={16} /> Reorder
              </button>
              <button type="button" onClick={() => onGenerate(guide.orderOverride)} disabled={generating}
                className="h-13 rounded-xl text-sm font-semibold bg-white/[0.06] text-white/70 active:bg-white/10 disabled:opacity-40 flex items-center justify-center gap-2">
                <RefreshCw size={16} /> Rebuild
              </button>
            </div>
            <button type="button"
              onClick={() => { if (confirmDelete) { onDelete(); onClose() } else setConfirmDelete(true) }}
              className={`h-13 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${
                confirmDelete
                  ? 'bg-red-500/30 text-red-200 active:bg-red-500/40'
                  : 'bg-red-500/12 text-red-400/80 active:bg-red-500/20'
              }`}>
              <Trash2 size={16} />
              {confirmDelete ? 'Tap again to delete this guide' : 'Delete guide'}
            </button>
            <p className="text-[11px] text-white/25 leading-snug">
              Written by an AI from the pages above — it can be wrong or out of date. Rebuilding
              starts from scratch and clears every tick.
            </p>
          </div>
        )}
      </div>

      {openSection && guide && (
        <ChapterPage
          section={openSection}
          index={openIndex}
          total={guide.sections.length}
          busy={generating}
          onBack={() => setOpenId(null)}
          onToggleStep={stepId => onToggleStep(openSection.id, stepId)}
          onToggleAll={done => onToggleSection(openSection.id, done)}
          onRebuild={() => onRebuildSection(openSection.id)}
          onJump={delta => {
            const next = guide.sections[openIndex + delta]
            if (next) setOpenId(next.id)
          }}
        />
      )}

      {showReorder && guide && (
        <ReorderSheet
          guide={guide}
          onClose={() => setShowReorder(false)}
          onSubmit={order => onGenerate(order || undefined)}
        />
      )}
    </div>
  )
}
