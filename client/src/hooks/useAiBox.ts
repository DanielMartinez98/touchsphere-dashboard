// Settings → AI box: which GPU box the local AI services go to.
//
// The server owns the answer (server/src/ai-box.ts) because it is the one
// making the calls; this mirrors it. One GET on mount, then the `ai-box` SSE
// frame the server sends when a box goes up or down or a service moves, plus a
// slow poll while the tab is open so the "checked 20 s ago" line stays true.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export type AiBoxChoice = 'auto' | string

export interface AiBoxPort {
  port: number
  up: boolean | null
  ms: number | null
  checkedAt: string | null
  error: string | null
}

/** What a box's power agent reports (server/src/ai-box.ts AgentStatus). */
export interface AiBoxAgentStatus {
  desired: 'on' | 'off'
  phase: 'on' | 'off' | 'starting' | 'stopping'
  since: string
  detail: string
  services: Record<string, boolean>
  gpu: { name: string; usedMb: number; totalMb: number } | null
  ollamaLoaded: { name: string; vramMb: number }[]
  models: { total: number; done: number; current: string | null; failed: string[] }
}

export interface AiBoxPower {
  status: AiBoxAgentStatus | null
  checkedAt: string | null
  error: string | null
  /** offline = the PC is off or asleep; agent-down = the PC is on and its agent is not running. */
  reach: 'ok' | 'offline' | 'agent-down' | 'error' | null
}

export interface AiBoxView {
  enabled: boolean
  selected: AiBoxChoice
  boxes: { id: string; name: string; host: string; ports: AiBoxPort[]; power: AiBoxPower | null }[]
  services: { key: string; label: string; port: number; box: string | null; url: string }[]
}

/** Whether the tab should exist. A 404 is the server saying AI_BOXES is unset. */
export function useAiBoxEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/ai-box')
      .then(r => { if (!cancelled) setEnabled(r.ok) })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

async function fetchAiBox(): Promise<AiBoxView> {
  const res = await fetch('/api/ai-box', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as AiBoxView
}

export function useAiBox() {
  const [view, setView] = useState<AiBoxView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchAiBox()
        .then(v => { if (!cancelled) { setView(v); setError(null) } })
        .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    }
    load()
    const off = onServerEvent('ai-box', load)
    const t = setInterval(load, 15_000)
    return () => { cancelled = true; off(); clearInterval(t) }
  }, [])

  // While a PC is starting or stopping, follow it every few seconds: those are
  // the minutes somebody is standing at the screen waiting to see it land.
  const switching = view?.boxes.some(b => b.power?.status?.phase === 'starting' || b.power?.status?.phase === 'stopping') ?? false
  useEffect(() => {
    if (!switching) return
    let cancelled = false
    const t = setInterval(() => {
      fetchAiBox().then(v => { if (!cancelled) setView(v) }).catch(() => {})
    }, 3_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [switching])

  const post = useCallback(async (path: string, body: unknown, kind: string) => {
    setBusy(kind)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({})) as AiBoxView & { error?: string }
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setView(j)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const select = useCallback((selected: AiBoxChoice) => post('/api/ai-box', { selected }, 'select'), [post])
  const check = useCallback(() => post('/api/ai-box/check', {}, 'check'), [post])
  const power = useCallback((id: string, on: boolean) =>
    post(`/api/ai-box/${encodeURIComponent(id)}/power`, { on }, `power:${id}`), [post])

  return { view, error, busy, select, check, power }
}
