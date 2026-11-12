// The collapsed Apps corner: how the apps did yesterday, read at walking speed.
//
// Yesterday, because that is the newest day Apple has published — the pill
// says which day so a number a day old never reads as today's. What they
// earned (sales and ads together) leads, then downloads, across every app
// that is not hidden.

import type { AppStoreView } from '../../../hooks/useAppStore'
import { compact, money, shortDay } from './format'

interface Props {
  view:  AppStoreView | null
  error: string | null
}

export function AppStoreCollapsed({ view, error }: Props) {
  const y = view?.yesterday
  const connected = !!view && (view.configured || view.ads.admob.connected || view.ads.unity.connected)
  const earned = y ? y.proceeds + y.adRevenue : 0

  return (
    <>
      <span className="text-xs font-medium text-white/50 uppercase tracking-[0.14em]">Apps</span>

      {!view ? (
        error
          ? <span className="text-sm text-ink-dim leading-tight">Server offline</span>
          : <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-indigo-400 animate-spin" />
      ) : !connected ? (
        <span className="text-sm text-ink-dim leading-tight">Set up in Settings → App Store</span>
      ) : !y || y.apps === 0 ? (
        <span className="text-sm text-ink-dim leading-tight">{view.syncing || !view.lastRun ? 'Reading from Apple…' : 'No apps yet'}</span>
      ) : (
        <>
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-display tabular-nums text-white leading-none">{money(earned, view.currency, y.approx)}</span>
            <span className="text-sm text-ink-mid leading-none">earned</span>
          </span>
          <span className="text-[13px] text-indigo-200/90 leading-tight tabular-nums">
            {compact(y.downloads)} download{y.downloads === 1 ? '' : 's'}{y.adRevenue > 0 ? ` · ${money(y.adRevenue, view.currency)} ads` : y.impressions !== null ? ` · ${compact(y.impressions)} seen` : ''}
          </span>
          <span className="text-[11px] text-white/40 leading-tight">
            {shortDay(view.asOf)} · {y.apps} app{y.apps === 1 ? '' : 's'}
          </span>
        </>
      )}
    </>
  )
}
