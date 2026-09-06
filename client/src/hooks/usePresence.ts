// Desk presence, from the HC-SR04 on the Pi via the server. One GET for the
// current answer and the settings, then the `presence` / `presence-settings`
// SSE frames. `awayFor` is how long the desk has been empty, which is what the
// dim overlay and the Hardware card both want.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export interface Presence {
  present: boolean | null
  distanceCm: number | null
  thresholdCm: number | null
  since: string | null
  updatedAt: string | null
  /** The reader hasn't reported for a couple of minutes. */
  stale: boolean
  /** A reader has reported at least once since the server started. */
  sensor: boolean
  /** What the reader saw between its last two reports; null from an older reader. */
  stats: { readings: number; noEcho: number; minCm: number | null; maxCm: number | null } | null
  /** Reports received since the server started, and when the first came. */
  reports: number
  firstReportAt: string | null
  /** The last couple of hours of reports, oldest first. */
  recent: { t: number; cm: number | null; present: boolean }[]
  /** The reader is currently sending every reading (a sensor card is open). */
  live: boolean
}

export interface PresenceSettings { dimAfterMin: number }

const EMPTY: Presence = {
  present: null, distanceCm: null, thresholdCm: null, since: null, updatedAt: null, stale: true, sensor: false,
  stats: null, reports: 0, firstReportAt: null, recent: [], live: false,
}

/**
 * Keep the reader in live mode while the calling component is mounted: one
 * request now and one every 10 s, against a 30 s window on the server, so a
 * closed card stops the stream within half a minute on its own.
 */
export function useLiveReadings(on: boolean) {
  useEffect(() => {
    if (!on) return
    const ask = () => { fetch('/api/presence/live', { method: 'POST' }).catch(() => { /* next tick retries */ }) }
    ask()
    const t = setInterval(ask, 10_000)
    return () => clearInterval(t)
  }, [on])
}

export function usePresence() {
  const [presence, setPresence] = useState<Presence>(EMPTY)
  const [settings, setSettings] = useState<PresenceSettings>({ dimAfterMin: 5 })
  // Ticks once a minute so "away for N min" and the dim threshold move
  // without a new report.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    fetch('/api/presence')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Presence & { settings: PresenceSettings }) => {
        if (cancelled) return
        const { settings: s, ...p } = j
        setPresence({ ...EMPTY, ...p }); setSettings(s)
      })
      .catch(() => {})
    const offP = onServerEvent('presence', raw => {
      if (raw && typeof raw === 'object') setPresence({ ...EMPTY, ...(raw as Partial<Presence>) })
    })
    const offS = onServerEvent('presence-settings', raw => { if (raw && typeof raw === 'object') setSettings(raw as PresenceSettings) })
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => { cancelled = true; offP(); offS(); clearInterval(t) }
  }, [])

  const setDimAfter = useCallback(async (dimAfterMin: number) => {
    setSettings({ dimAfterMin })
    try {
      await fetch('/api/presence/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dimAfterMin }) })
    } catch { /* the SSE frame restores the truth */ }
  }, [])

  const live = presence.sensor && !presence.stale
  const awayForMin = live && presence.present === false && presence.since
    ? Math.max(0, (now - new Date(presence.since).getTime()) / 60_000)
    : 0
  /** Dim the screen: away long enough, and the setting is on. */
  const shouldDim = settings.dimAfterMin > 0 && awayForMin >= settings.dimAfterMin

  return { presence, settings, setDimAfter, live, awayForMin, shouldDim, now }
}
