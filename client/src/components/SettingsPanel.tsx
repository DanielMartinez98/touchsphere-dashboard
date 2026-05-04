import { useState } from 'react'
import { useAudioDevices } from '../hooks/useAudioDevices'
import { useDevice } from '../hooks/useDevice'

type Tab = 'audio' | 'hardware' | 'system'

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
  const [tab, setTab] = useState<Tab>('audio')
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
    fetch('/api/system/restart', { method: 'POST' }).catch(() => {})
  }

  function closePanel() {
    setOpen(false)
    setConfirmClose(false)
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'audio',    label: 'Audio'    },
    { id: 'hardware', label: 'Hardware' },
    { id: 'system',   label: 'System'   },
  ]

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

      {/* Full-screen settings overlay */}
      {open && (
        <div className="fixed inset-0 z-[500] bg-black/90 backdrop-blur-md flex flex-col">

          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
            <h2 className="text-white/80 text-lg font-semibold tracking-wide">Settings</h2>
            <button
              onClick={closePanel}
              className="w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-white/50 hover:text-white/90 hover:bg-white/15 active:scale-90 transition-all"
              aria-label="Close settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* ── Tab bar ── */}
          <div className="flex gap-1 px-6 pb-4 flex-shrink-0">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                  tab === t.id
                    ? 'bg-white/15 text-white border border-white/20'
                    : 'bg-white/5 text-white/40 border border-transparent hover:bg-white/8 hover:text-white/60'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tab content ── */}
          <div className="flex-1 overflow-y-auto px-6 pb-8">

            {/* Audio tab */}
            {tab === 'audio' && (
              <div className="space-y-6 max-w-lg mx-auto">
                <div className="flex items-center justify-between">
                  <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Devices</span>
                  <button
                    onClick={() => void refreshDevices()}
                    disabled={devicesLoading}
                    className="flex items-center gap-1.5 text-white/30 hover:text-white/60 active:scale-90 transition-all disabled:opacity-30 text-xs"
                    aria-label="Refresh audio devices"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      className={devicesLoading ? 'animate-spin' : ''}>
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    Refresh
                  </button>
                </div>

                {/* Microphone */}
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400 flex-shrink-0">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Microphone</span>
                  </div>
                  {devicesError ? (
                    <p className="text-red-400/70 text-sm leading-relaxed">{devicesError}</p>
                  ) : devicesLoading ? (
                    <p className="text-white/30 text-sm">Scanning…</p>
                  ) : inputDevices.length === 0 ? (
                    <p className="text-white/30 text-sm">No microphones found</p>
                  ) : (
                    <select
                      value={selectedInputId}
                      onChange={e => setSelectedInput(e.target.value)}
                      title="Select microphone"
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/80 text-sm appearance-none cursor-pointer focus:outline-none focus:border-cyan-500/50 focus:bg-white/10"
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
                <div className="bg-white/5 rounded-2xl p-5 space-y-3 border border-white/8">
                  <div className="flex items-center gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 flex-shrink-0">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                    <span className="text-white/70 text-sm font-medium">Speaker</span>
                  </div>
                  {devicesError ? (
                    <p className="text-red-400/70 text-sm leading-relaxed">{devicesError}</p>
                  ) : devicesLoading ? (
                    <p className="text-white/30 text-sm">Scanning…</p>
                  ) : outputDevices.length === 0 ? (
                    <p className="text-white/30 text-sm">No speakers found</p>
                  ) : (
                    <select
                      value={selectedOutputId}
                      onChange={e => setSelectedOutput(e.target.value)}
                      title="Select speaker"
                      className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white/80 text-sm appearance-none cursor-pointer focus:outline-none focus:border-amber-500/50 focus:bg-white/10"
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
            )}

            {/* Hardware tab */}
            {tab === 'hardware' && (
              <div className="space-y-4 max-w-lg mx-auto">
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Pi Metrics</span>

                {/* CPU Temp */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-rose-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-400">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">CPU Temperature</p>
                      <p className="text-white/30 text-xs">thermal_zone0</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-base font-mono font-semibold">
                    {device ? (device.cpuTempC !== null ? `${device.cpuTempC}°C` : 'N/A') : '—'}
                  </span>
                </div>

                {/* Memory */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 border border-white/8 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-sky-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sky-400">
                        <rect x="2" y="6" width="20" height="12" rx="2" />
                        <line x1="6" y1="10" x2="6" y2="14" />
                        <line x1="10" y1="10" x2="10" y2="14" />
                        <line x1="14" y1="10" x2="14" y2="14" />
                        <line x1="18" y1="10" x2="18" y2="14" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-white/70 text-sm font-medium">Memory</p>
                      <p className="text-white/30 text-xs">
                        {device ? `${device.memAvailableMB} MB free of ${device.memTotalMB} MB` : '—'}
                      </p>
                    </div>
                    <span className="text-white/80 text-base font-mono font-semibold">
                      {device ? `${device.memUsedPct}%` : '—'}
                    </span>
                  </div>
                  {device && (
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-500/60 rounded-full transition-all"
                        style={{ width: `${device.memUsedPct}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Load Average */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-violet-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-400">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">Load Average</p>
                      <p className="text-white/30 text-xs">{device ? `${device.cpuCount} cores` : '—'}</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-sm font-mono font-semibold">
                    {device ? `${device.loadAvg1} · ${device.loadAvg5} · ${device.loadAvg15}` : '—'}
                  </span>
                </div>

                {/* Uptime */}
                <div className="bg-white/5 rounded-2xl px-5 py-4 flex items-center justify-between border border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-white/70 text-sm font-medium">Uptime</p>
                      <p className="text-white/30 text-xs">{device?.hostname ?? '—'}</p>
                    </div>
                  </div>
                  <span className="text-white/80 text-base font-mono font-semibold">
                    {device ? formatUptime(device.uptimeSeconds) : '—'}
                  </span>
                </div>
              </div>
            )}

            {/* System tab */}
            {tab === 'system' && (
              <div className="space-y-4 max-w-lg mx-auto">
                <span className="text-white/40 text-xs font-semibold uppercase tracking-widest block mb-2">Actions</span>

                <div className="bg-white/5 rounded-2xl border border-white/8 overflow-hidden">
                  {!confirmClose ? (
                    <button
                      onClick={handleCloseApp}
                      className="w-full flex items-center gap-4 px-5 py-5 text-red-400 hover:bg-red-500/10 active:bg-red-500/20 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-xl bg-red-500/15 flex items-center justify-center flex-shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                          <polyline points="16 17 21 12 16 7" />
                          <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-medium">Restart App</p>
                        <p className="text-red-400/50 text-xs mt-0.5">Reloads all connected screens</p>
                      </div>
                    </button>
                  ) : (
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-white/70 text-sm">Reload the app on all connected screens?</p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setConfirmClose(false)}
                          className="flex-1 py-3 rounded-xl bg-white/10 text-white/60 text-sm font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCloseApp}
                          className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold text-sm"
                        >
                          Restart
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </>
  )
}
