import { useState } from 'react'

export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  function handleCloseApp() {
    if (!confirmClose) {
      setConfirmClose(true)
      return
    }
    // Attempt graceful server shutdown, then close the browser window.
    // On Chromium kiosk the window may not close via JS — in that case the
    // server will have stopped and the page will show a network error, which
    // effectively ends the session.
    fetch('/api/system/shutdown', { method: 'POST' }).catch(() => {})
    setTimeout(() => window.close(), 300)
  }

  function closePanel() {
    setOpen(false)
    setConfirmClose(false)
  }

  return (
    <>
      {/* Settings gear button — bottom center */}
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-10 h-10 rounded-full bg-white/8 border border-white/15 flex items-center justify-center text-white/40 hover:bg-white/15 hover:text-white/70 active:scale-90 transition-all backdrop-blur-md"
        aria-label="Settings"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Settings panel */}
      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[500]" onClick={closePanel} />

          {/* Panel — slides up from bottom center */}
          <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[600] w-80 bg-[#111] border border-white/15 rounded-t-2xl pb-6 pt-4 px-4 shadow-2xl"
            onClick={e => e.stopPropagation()}>

            {/* Handle */}
            <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-4" />

            <h3 className="text-white/60 text-xs font-semibold uppercase tracking-widest mb-3 px-1">Settings</h3>

            {/* ── Close App ── */}
            <div className="bg-white/5 rounded-xl overflow-hidden">
              {!confirmClose ? (
                <button
                  onClick={handleCloseApp}
                  className="w-full flex items-center gap-3 px-4 py-4 text-red-400 hover:bg-red-500/10 active:bg-red-500/20 transition-colors text-sm font-medium"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Close Application
                </button>
              ) : (
                <div className="px-4 py-4 flex flex-col gap-3">
                  <p className="text-white/70 text-sm">Stop the server and close the app?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmClose(false)}
                      className="flex-1 py-2.5 rounded-xl bg-white/10 text-white/60 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCloseApp}
                      className="flex-1 py-2.5 rounded-xl bg-red-500 text-white font-bold text-sm"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Dismiss */}
            <button
              onClick={closePanel}
              className="w-full mt-3 py-3 rounded-xl bg-white/5 text-white/40 text-sm"
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </>
  )
}
