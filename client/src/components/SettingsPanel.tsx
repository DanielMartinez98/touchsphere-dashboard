import { useState } from 'react'
import { useAudioDevices } from '../hooks/useAudioDevices'
import { useDevice } from '../hooks/useDevice'

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const { metrics: device } = useDevice()

  const {
    inputDevices,
    outputDevices,
    selectedInputId,
    selectedOutputId,
    setSelectedInput,
    setSelectedOutput,
    loading: devicesLoading,
    error:   devicesError,
    refresh: refreshDevices,
  } = useAudioDevices()

  function handleCloseApp() {
    if (!confirmClose) {
      setConfirmClose(true)
      return
    }
    // Server broadcasts a reload SSE event to all connected clients.
    fetch('/api/system/restart', { method: 'POST' }).catch(() => {})
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
          <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[600] w-80 bg-[#111] border border-white/15 rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh]"
            onClick={e => e.stopPropagation()}>

            {/* Handle */}
            <div className="pt-4 px-4 flex-shrink-0">
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-4" />
              <h3 className="text-white/60 text-xs font-semibold uppercase tracking-widest mb-3 px-1">Settings</h3>
            </div>

            {/* Scrollable content */}
            <div className="overflow-y-auto flex-1 px-4 pb-6 space-y-4">

              {/* ── Audio Devices ── */}
              <div>
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Audio</span>
                  <button
                    onClick={() => void refreshDevices()}
                    disabled={devicesLoading}
                    className="text-white/30 hover:text-white/60 active:scale-90 transition-all disabled:opacity-30"
                    aria-label="Refresh audio devices"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      className={devicesLoading ? 'animate-spin' : ''}>
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                  </button>
                </div>

                <div className="bg-white/5 rounded-xl overflow-hidden divide-y divide-white/5">
                  {/* Microphone */}
                  <div className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400 flex-shrink-0">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="23" />
                        <line x1="8" y1="23" x2="16" y2="23" />
                      </svg>
                      <span className="text-white/50 text-xs">Microphone</span>
                    </div>
                    {devicesError ? (
                      <p className="text-red-400/60 text-xs leading-relaxed">{devicesError}</p>
                    ) : devicesLoading ? (
                      <p className="text-white/25 text-xs">Scanning…</p>
                    ) : inputDevices.length === 0 ? (
                      <p className="text-white/25 text-xs">No microphones found</p>
                    ) : (
                      <select
                        value={selectedInputId}
                        onChange={e => setSelectedInput(e.target.value)}
                        title="Select microphone"
                        className="w-full bg-white/8 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/80 text-xs appearance-none cursor-pointer focus:outline-none focus:border-cyan-500/50 focus:bg-white/10"
                      >
                        {inputDevices.map(d => (
                          <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">
                            {d.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Speaker */}
                  <div className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 flex-shrink-0">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                      <span className="text-white/50 text-xs">Speaker</span>
                    </div>
                    {devicesError ? (
                      <p className="text-red-400/60 text-xs leading-relaxed">{devicesError}</p>
                    ) : devicesLoading ? (
                      <p className="text-white/25 text-xs">Scanning…</p>
                    ) : outputDevices.length === 0 ? (
                      <p className="text-white/25 text-xs">No speakers found</p>
                    ) : (
                      <select
                        value={selectedOutputId}
                        onChange={e => setSelectedOutput(e.target.value)}
                        title="Select speaker"
                        className="w-full bg-white/8 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/80 text-xs appearance-none cursor-pointer focus:outline-none focus:border-amber-500/50 focus:bg-white/10"
                      >
                        {outputDevices.map(d => (
                          <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">
                            {d.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Hardware Metrics ── */}
              <div>
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-2 px-1 block">Hardware</span>
                <div className="bg-white/5 rounded-xl overflow-hidden divide-y divide-white/5">
                  {/* CPU Temp */}
                  <div className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-400 flex-shrink-0">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
                      </svg>
                      <span className="text-white/50 text-xs">CPU Temp</span>
                    </div>
                    <span className="text-white/80 text-xs font-mono">
                      {device ? (device.cpuTempC !== null ? `${device.cpuTempC}°C` : 'N/A') : '—'}
                    </span>
                  </div>
                  {/* Memory */}
                  <div className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sky-400 flex-shrink-0">
                        <rect x="2" y="6" width="20" height="12" rx="2" />
                        <line x1="6" y1="10" x2="6" y2="14" />
                        <line x1="10" y1="10" x2="10" y2="14" />
                        <line x1="14" y1="10" x2="14" y2="14" />
                        <line x1="18" y1="10" x2="18" y2="14" />
                      </svg>
                      <span className="text-white/50 text-xs">Memory</span>
                    </div>
                    <span className="text-white/80 text-xs font-mono">
                      {device ? `${device.memUsedPct}% · ${device.memAvailableMB} MB free` : '—'}
                    </span>
                  </div>
                  {/* Uptime */}
                  <div className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400 flex-shrink-0">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span className="text-white/50 text-xs">Uptime</span>
                    </div>
                    <span className="text-white/80 text-xs font-mono">
                      {device ? formatUptime(device.uptimeSeconds) : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Close App ── */}
              <div>
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-2 px-1 block">System</span>
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
                      Restart App
                    </button>
                  ) : (
                    <div className="px-4 py-4 flex flex-col gap-3">
                      <p className="text-white/70 text-sm">Reload the app on all connected screens?</p>
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
                          Restart
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Dismiss */}
              <button
                onClick={closePanel}
                className="w-full py-3 rounded-xl bg-white/5 text-white/40 text-sm"
              >
                Dismiss
              </button>

            </div>{/* end scrollable */}
          </div>
        </>
      )}
    </>
  )
}
