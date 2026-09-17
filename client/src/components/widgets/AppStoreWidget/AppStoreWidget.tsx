// The collapsed Apps corner: how the apps did yesterday, read at walking speed.
//
// Yesterday, because that is the newest day Apple has published — the pill
// says which day so a number a day old never reads as today's. One line of
// downloads and money across every app, and impressions when the analytics
// have started arriving.

import type { AppStoreView } from '../../../hooks/useAppStore'
import { compact, headlineMoney, shortDay } from './format'

interface Props {
  view:  AppStoreView | null
  error: string | null
}

export function AppStoreCollapsed({ view, error }: Props) {
  const sum = (pick: (t: AppStoreView['apps'][number]['periods']['yesterday']) => number | null) =>
    view ? view.apps.reduce((n, a) => { const v = pick(a.periods.yesterday); return v === null ? n : (n ?? 0) + v }, null as number | null) : null
  const downloads = sum(t => t.downloads) ?? 0
  const impressions = sum(t => t.impressions)
  const proceeds: Record<string, number> = {}
  for (const a of view?.apps ?? []) for (const [c, v] of Object.entries(a.periods.yesterday.proceeds)) proceeds[c] = (proceeds[c] ?? 0) + v
  const earned = headlineMoney(proceeds, view?.currency ?? null)

  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Apps</span>

      {!view ? (
        error
          ? <span className="text-sm text-ink-dim leading-tight">Server offline</span>
          : <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-indigo-400 animate-spin" />
      ) : !view.configured ? (
        <span className="text-sm text-ink-dim leading-tight">Set up in Settings → Apps</span>
      ) : view.apps.length === 0 ? (
        <span className="text-sm text-ink-dim leading-tight">{view.syncing || !view.lastRun ? 'Reading from Apple…' : 'No apps yet'}</span>
      ) : (
        <>
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">{compact(downloads)}</span>
            <span className="text-sm text-ink-mid leading-none">download{downloads === 1 ? '' : 's'}</span>
          </span>
          <span className="text-[13px] text-indigo-200/90 leading-tight tabular-nums">
            {earned.text} earned{impressions !== null ? ` · ${compact(impressions)} seen` : ''}
          </span>
          <span className="text-[11px] text-white/40 leading-tight">
            {shortDay(view.asOf)} · {view.apps.length} app{view.apps.length === 1 ? '' : 's'}
          </span>
        </>
      )}
    </>
  )
}
