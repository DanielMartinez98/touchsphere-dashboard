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
    <div className="flex flex-col h-full min-h-0">
      {/* pt-16 clears the grab handle and the close button, matching what each
          panel used to reserve for itself when it owned the whole screen. */}
      <div className="flex gap-2 px-6 pt-16 pb-3 shrink-0">
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

      {/* min-h-0 so the panel below scrolls inside this column rather than
          pushing the tab bar off the top. `nested` tells each panel not to
          reserve room for the widget chrome — the tab bar above already did. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'clock'
          ? <WorldClock timers={timers} stopwatch={stopwatch} nested />
          : <CalendarExpanded nested />}
      </div>
    </div>
  )
}
