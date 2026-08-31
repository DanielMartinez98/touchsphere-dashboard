// The expanded top-right corner: calendar and clock as two tabs.
//
// Both panels are the ORIGINAL components, unchanged and unmoved — merging the
// two corners is a layout decision, and rewriting a working month grid or the
// timer tools to achieve it would be a much larger change than the one that was
// asked for. This file is only the switch between them.
//
// Which tab opens first is a real choice: the clock lands first because the
// collapsed pill already shows the next event, so someone who opened this corner
// having seen that line usually wants the timers, not to re-read the agenda.

import { useState } from 'react'
import { CalendarDays, Clock } from 'lucide-react'
import CalendarExpanded from '../CalendarWidget/CalendarExpanded'
import WorldClock from '../ClockWidget/WorldClock'
import type { TimersApi } from '../../../hooks/useTimers'
import type { StopwatchApi } from '../../../hooks/useStopwatch'

type Tab = 'clock' | 'calendar'

export default function TimeExpanded({ timers, stopwatch }: { timers?: TimersApi; stopwatch?: StopwatchApi }) {
  const [tab, setTab] = useState<Tab>('clock')

  const TABS: { id: Tab; label: string; icon: React.ReactElement }[] = [
    { id: 'clock',    label: 'Clock',    icon: <Clock size={18} /> },
    { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={18} /> },
  ]

  return (
    // Natural height so Widget's wrapper is the only scroll container — see the
    // note below. The tab bar stays reachable by being sticky rather than by
    // pinning the panel to h-full, which clipped a long month instead of
    // scrolling it.
    <div className="flex flex-col">
      {/* pt-16 clears the grab handle and the close button, matching what each
          panel used to reserve for itself when it owned the whole screen. */}
      <div
        className="sticky top-0 z-10 flex gap-2 pt-16 pb-3 bg-black/95 backdrop-blur-xl"
        style={{
          paddingLeft:  'max(1.5rem, env(safe-area-inset-left))',
          paddingRight: 'max(1.5rem, env(safe-area-inset-right))',
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            // 56px tall: this is a corner someone reaches for mid-task, and
            // these are the two targets everything else here is behind.
            className={`flex-1 h-14 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold
                        transition-colors active:scale-95 ${
              tab === t.id
                ? 'bg-white/20 text-white border border-white/25'
                : 'bg-white/5 text-white/50 border border-transparent'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* No overflow of its own: Widget's wrapper is the single scroll container
          for this whole panel. A nested scroller here meant a drag that started
          on the calendar grid scrolled nothing, because the inner region was
          already at its own scroll extent. `nested` tells each panel not to
          reserve room for the widget chrome — the tab bar above already did. */}
      <div style={{ paddingBottom: 'max(0px, env(safe-area-inset-bottom))' }}>
        {tab === 'clock'
          ? <WorldClock timers={timers} stopwatch={stopwatch} nested />
          : <CalendarExpanded nested />}
      </div>
    </div>
  )
}
