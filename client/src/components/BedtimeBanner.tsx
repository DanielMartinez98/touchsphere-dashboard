import { useEffect, useState } from 'react'
import { BEDTIME_ALERT_EVENT } from '../hooks/useAutoSchedule'

/**
 * Listens for the global `ts:bedtime-alert` event and shows a dismissible
 * full-width toast at the top of the screen until the user taps it away.
 */
export function BedtimeBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    function onAlert() { setVisible(true) }
    window.addEventListener(BEDTIME_ALERT_EVENT, onAlert)
    return () => window.removeEventListener(BEDTIME_ALERT_EVENT, onAlert)
  }, [])

  if (!visible) return null

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[600] max-w-[92%] w-[480px] bg-indigo-500/25 border border-indigo-400/50 backdrop-blur-md rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4">
      <div className="w-10 h-10 rounded-xl bg-indigo-400/30 flex items-center justify-center flex-shrink-0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-100">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-indigo-50 text-sm font-semibold">Bedtime</p>
        <p className="text-indigo-100/80 text-xs mt-0.5">Time to wind down — get some sleep.</p>
      </div>
      <button
        onClick={() => setVisible(false)}
        className="px-4 py-2 rounded-xl bg-white/15 hover:bg-white/25 active:scale-95 text-white text-sm font-medium transition-all"
        aria-label="Dismiss bedtime alert"
      >
        OK
      </button>
    </div>
  )
}
