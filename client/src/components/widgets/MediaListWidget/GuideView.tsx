// The game guide, full screen.
//
// A researched walkthrough for one game: a 100% bar across the top, then the
// sections the way that game's community organizes them (a section per dungeon
// or chapter, then collectibles and side quests), each with its own count, its
// own YouTube walkthrough, and steps you tick off as you play.
//
// Rendered inside the media widget's expanded overlay (which is already
// full-screen and portalled to body), so it's an absolute layer here rather than
// another portal. Generation streams in: sections arrive one at a time, and a
// section is usable the moment it lands.

import { useState } from 'react'
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Play, RefreshCw, ListOrdered, Trash2, Loader2, AlertTriangle,
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

// Colour carries the same meaning as the label so the eye can group sections
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

/** Thin progress track. `accent` picks the fill colour. */
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
      className="w-full flex items-center gap-3 px-3 h-13 rounded-xl bg-red-500/12 border border-red-500/25 active:bg-red-500/20 text-left">
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

// ── One section ──────────────────────────────────────────────────────────────

function Section({
  section, index, open, onToggleOpen, onToggleStep,
}: {
  section:      GuideSection
  index:        number
  open:         boolean
  onToggleOpen: () => void
  onToggleStep: (stepId: string) => void
}) {
  const done  = section.steps.filter(s => s.done).length
  const total = section.steps.length
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0
  const complete = total > 0 && done === total

  return (
    <div className={`rounded-2xl border overflow-hidden ${
      complete ? 'bg-emerald-500/[0.07] border-emerald-500/25' : 'bg-glass border-hairline'
    }`}>
      <button type="button" onClick={onToggleOpen}
        className="w-full flex items-start gap-3 p-3.5 text-left active:bg-white/[0.04]">
        <span className="mt-0.5 text-white/40 shrink-0">
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-white leading-tight">
              {index + 1}. {section.title}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${KIND_CLASS[section.kind]}`}>
              {KIND_LABEL[section.kind]}
            </span>
            {!section.counts && (
              <span className="text-[10px] text-white/35 uppercase tracking-wider">not counted</span>
            )}
          </span>
          {section.summary && (
            <span className="block text-xs text-white/45 mt-1 leading-snug">{section.summary}</span>
          )}
          {section.state === 'pending' ? (
            <span className="flex items-center gap-2 mt-2 text-xs text-white/40">
              <Loader2 size={12} className="animate-spin" /> waiting to be researched
            </span>
          ) : section.state === 'failed' && total === 0 ? (
            <span className="flex items-center gap-2 mt-2 text-xs text-amber-300/70">
              <AlertTriangle size={12} /> couldn’t research this section
            </span>
          ) : (
            <span className="flex items-center gap-2 mt-2">
              <Bar pct={pct} height="h-1.5"
                   accent={complete ? 'bg-emerald-400/80' : 'bg-[var(--accent,#06b6d4)]'} />
              <span className="text-xs tabular-nums text-white/50 shrink-0">{done}/{total}</span>
            </span>
          )}
        </span>
        {complete && <Check size={18} className="text-emerald-400 shrink-0 mt-0.5" />}
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 flex flex-col gap-2">
          {section.video && <WatchRow video={section.video} label="Watch this section" />}

          {section.steps.map((step, i) => (
            <button key={step.id} type="button" onClick={() => onToggleStep(step.id)}
              className="flex items-start gap-3 py-2.5 px-1 min-h-11 text-left active:bg-white/[0.04] rounded-lg">
              <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-md border-2 flex items-center justify-center transition-colors ${
                step.done
                  ? 'bg-emerald-500/30 border-emerald-500/60 text-emerald-300'
                  : 'border-white/30'
              }`}>
                {step.done && <Check size={14} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm leading-snug ${
                  step.done ? 'line-through text-white/35' : 'text-white/85'
                }`}>
                  <span className="text-white/30 tabular-nums mr-1.5">{i + 1}</span>
                  {step.text}
                </span>
                {step.note && !step.done && (
                  <span className="block text-xs text-white/40 mt-1 leading-snug">{step.note}</span>
                )}
              </span>
            </button>
          ))}

          {section.source && (
            <p className="text-[11px] text-white/25 px-1 pt-1">source: {section.source.site}</p>
          )}
        </div>
      )}
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

// ── The view ─────────────────────────────────────────────────────────────────

interface Props {
  item:         MediaItem
  guide:        Guide | null
  loading:      boolean
  onClose:      () => void
  onToggleStep: (sectionId: string, stepId: string) => void
  /** Start or rebuild. `order` overrides the community ordering. */
  onGenerate:   (order?: string) => void
  onDelete:     () => void
}

export function GuideView({
  item, guide, loading, onClose, onToggleStep, onGenerate, onDelete,
}: Props) {
  // null = the user hasn't opened or closed anything yet, so the default applies.
  const [openSections, setOpenSections] = useState<Set<string> | null>(null)
  const [showReorder, setShowReorder]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const generating = guide?.status === 'generating'

  // Default: the first section that actually has steps is open. While a guide is
  // still generating that's the newest arrival, so the work in progress is what
  // you're looking at without having to chase it down the list. Derived rather
  // than an effect, so a section landing mid-read never yanks the view about.
  const autoOpenId = guide?.sections.find(s => s.steps.length > 0)?.id
  const isOpen = (id: string) => openSections ? openSections.has(id) : id === autoOpenId

  const toggleSection = (id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev ?? (autoOpenId ? [autoOpenId] : []))
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const progress = guide ? guideProgress(guide) : null

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#07090f]">
      {/* Header — stays put while the sections scroll */}
      <div className="shrink-0 px-4 pt-16 pb-3 border-b border-hairline">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onClose} aria-label="Back"
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

      {/* Body */}
      <div className="flex-1 overflow-auto scroll-fade-y px-4 py-3 flex flex-col gap-2.5">
        {loading && !guide && (
          <p className="text-white/45 text-sm text-center py-12">Loading guide…</p>
        )}

        {/* No guide yet — the generate call to action. */}
        {!loading && !guide && (
          <div className="flex flex-col items-center text-center gap-4 py-10 px-4">
            <ListOrdered size={40} className="text-white/25" />
            <div>
              <p className="text-base font-semibold text-white">No guide yet</p>
              <p className="text-sm text-white/45 mt-1.5 leading-snug">
                I’ll read what this game’s community has written and build a checklist the way they
                organize it — dungeons or chapters first, then the collectibles and side quests that
                count toward 100%. Each section gets a video too.
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

        {guide?.sections.map((section, i) => (
          <Section
            key={section.id}
            section={section}
            index={i}
            open={isOpen(section.id)}
            onToggleOpen={() => toggleSection(section.id)}
            onToggleStep={stepId => onToggleStep(section.id, stepId)}
          />
        ))}

        {generating && (guide?.sections.length ?? 0) === 0 && (
          <div className="flex flex-col gap-2.5">
            {/* Skeletons, so the wait for the outline has a shape to it. */}
            {[0, 1, 2].map(i => (
              <div key={i} className="h-20 rounded-2xl bg-white/[0.04] border border-hairline animate-pulse" />
            ))}
          </div>
        )}

        {/* Footer actions + attribution */}
        {guide && (
          <div className="mt-4 pt-4 border-t border-hairline flex flex-col gap-3">
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
