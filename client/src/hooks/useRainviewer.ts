import { useEffect, useState } from 'react'

export interface RvFrame {
  time: number   // unix seconds
  path: string   // e.g. "/v2/radar/abc123def456"
  host: string   // e.g. "https://tilecache.rainviewer.com"
}

const CACHE_KEY = 'ts_rainviewer'
const TTL_MS    = 10 * 60 * 1000  // refresh every 10 min (same cadence as new frames)

export function useRainviewer(): { frames: RvFrame[]; nowcast: RvFrame[] } {
  const [frames,  setFrames]  = useState<RvFrame[]>([])
  const [nowcast, setNowcast] = useState<RvFrame[]>([])

  useEffect(() => {
    let cancelled = false

    async function load() {
      // Try localStorage cache first
      try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (raw) {
          const { frames: f, nowcast: n, ts } = JSON.parse(raw)
          if (Date.now() - ts < TTL_MS) {
            if (!cancelled) { setFrames(f); setNowcast(n ?? []) }
            return
          }
        }
      } catch { /* corrupt cache – ignore */ }

      try {
        const resp = await fetch('https://api.rainviewer.com/public/weather-maps.json')
        if (!resp.ok) return
        const data = await resp.json()
        const host: string = data.host ?? 'https://tilecache.rainviewer.com'
        const past: RvFrame[] = (data.radar?.past    ?? []).map((f: any) => ({ ...f, host }))
        const nc:   RvFrame[] = (data.radar?.nowcast ?? []).map((f: any) => ({ ...f, host }))
        localStorage.setItem(CACHE_KEY, JSON.stringify({ frames: past, nowcast: nc, ts: Date.now() }))
        if (!cancelled) { setFrames(past); setNowcast(nc) }
      } catch (err) {
        console.warn('[useRainviewer] fetch failed', err)
      }
    }

    load()
    const id = setInterval(load, TTL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return { frames, nowcast }
}

/**
 * Find the nearest RainViewer frame for a target Unix timestamp (seconds).
 * Returns null when no frame is within 15 minutes — at that point callers
 * should fall back to the live OWM cloud tile.
 */
export function nearestRvFrame(frames: RvFrame[], targetSec: number): RvFrame | null {
  if (!frames.length) return null
  let best: RvFrame | null = null
  let bestDiff = Infinity
  for (const f of frames) {
    const diff = Math.abs(f.time - targetSec)
    if (diff < bestDiff) { bestDiff = diff; best = f }
  }
  return best && bestDiff <= 15 * 60 ? best : null
}
