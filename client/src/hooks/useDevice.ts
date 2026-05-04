import { useState, useEffect, useRef } from 'react'

const POLL_INTERVAL_MS = 30_000
const API = '/api/device'

export interface DeviceMetrics {
  cpuTempC:       number | null
  memTotalMB:     number
  memAvailableMB: number
  memUsedPct:     number
  loadAvg1:       number
  loadAvg5:       number
  loadAvg15:      number
  cpuCount:       number
  uptimeSeconds:  number
  platform:       string
  arch:           string
  hostname:       string
  collectedMs:    number
}

interface UseDeviceReturn {
  metrics: DeviceMetrics | null
  error:   string | null
  loading: boolean
}

export function useDevice(): UseDeviceReturn {
  const [metrics, setMetrics]  = useState<DeviceMetrics | null>(null)
  const [error, setError]      = useState<string | null>(null)
  const [loading, setLoading]  = useState(true)
  const timerRef               = useRef<ReturnType<typeof setTimeout> | null>(null)

  function fetchMetrics() {
    console.log('[Device] fetching metrics from /api/device…')
    fetch(API)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<DeviceMetrics>
      })
      .then(data => {
        console.log(
          `[Device] metrics OK — ` +
          `temp=${data.cpuTempC ?? 'n/a'}°C ` +
          `mem=${data.memAvailableMB}/${data.memTotalMB}MB (${data.memUsedPct}% used) ` +
          `load=${data.loadAvg1} ` +
          `uptime=${data.uptimeSeconds}s`
        )
        setMetrics(data)
        setError(null)
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Device] fetch failed:', msg)
        setError(msg)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchMetrics()

    timerRef.current = setInterval(() => {
      console.log('[Device] polling interval triggered')
      fetchMetrics()
    }, POLL_INTERVAL_MS)

    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return { metrics, error, loading }
}
