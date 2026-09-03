// Settings → Server: the host the dashboard runs on, and updating it.
//
// Three things from the server, in the order the tab needs them: `info`
// (is this set up, what is the key to install, what tasks exist), `status`
// (what the host says about itself — a few seconds, asked on open and after
// each task), and the live task log — one GET for the backlog plus the
// `host-update` SSE event, merged on the server's line id exactly as the
// guide activity feed is, so a line that streams in during the fetch can't
// land twice.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

export type HostTask =
  | 'apt-refresh' | 'apt-upgrade' | 'firmware-check' | 'firmware-update'
  | 'tailscale-update' | 'containers' | 'self-update' | 'reboot'

export interface HostInfo {
  enabled:   boolean
  target:    string
  publicKey: string
  tasks:     Record<HostTask, string>
  confirm:   HostTask[]
  state:     HostState
}

export interface HostState {
  running:   HostTask | null
  startedAt: string | null
  last: { task: HostTask; ok: boolean; code: number | null; endedAt: string; summary: string } | null
}

export interface HostLine {
  id:     number
  at:     string
  task:   HostTask
  line:   string
  stream: 'out' | 'err'
}

/** The host script's status document. Every block is optional on the wire. */
export interface HostStatus {
  at?: string
  host?: {
    hostname: string; os: string; kernel: string; arch: string; model: string
    uptimeSec: number; load: number; diskUsedPct: number; memUsedPct: number
  }
  reboot?: { required: boolean; packages: string[]; kernelPending: boolean; servicesToRestart: number }
  apt?: { pending: number; packages: { name: string; from: string; to: string }[]; lastRefresh: string; error: string }
  tailscale?: { installed: boolean; version?: string; latest?: string; updateAvailable?: boolean; online?: boolean; ip?: string; health?: string[] }
  firmware?: { installed: boolean; devices: number; updates: { device: string; current: string; to: string }[] }
  containers?: { docker: string; projects: { file: string; name: string; running: number; total: number; services: { name: string; state: string; image: string }[] }[] }
  dashboard?: { dir: string; commit: string; behind: number | null; lastSelfUpdate: string }
}

function isLine(raw: unknown): raw is HostLine {
  const o = raw as HostLine | null
  return !!o && typeof o === 'object' && typeof o.id === 'number' && typeof o.line === 'string'
}

/**
 * Whether the tab should exist at all. Fetched once per mount of the settings
 * panel; a 404 is the server saying HOST_UPDATE_SSH is unset.
 */
export function useHostEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/host')
      .then(r => { if (!cancelled) setEnabled(r.ok) })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

export function useHost() {
  const [info, setInfo] = useState<HostInfo | null>(null)
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [lines, setLines] = useState<HostLine[]>([])
  const [state, setState] = useState<HostState>({ running: null, startedAt: null, last: null })
  const [runError, setRunError] = useState('')

  const refreshStatus = useCallback(async () => {
    setStatusBusy(true)
    try {
      const r = await fetch('/api/host/status')
      const j = await r.json() as { ok: boolean; status: HostStatus | null; error: string }
      if (j.ok && j.status) { setStatus(j.status); setStatusError('') }
      else setStatusError(j.error || `HTTP ${r.status}`)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatusBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/host')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: HostInfo) => { if (!cancelled) { setInfo(j); setState(j.state) } })
      .catch(err => console.warn('[host] info failed:', err))

    const merge = (incoming: HostLine[]) => {
      if (cancelled) return
      setLines(prev => {
        const seen = new Map(prev.map(l => [l.id, l]))
        for (const l of incoming) seen.set(l.id, l)
        return [...seen.values()].sort((a, b) => a.id - b.id).slice(-600)
      })
    }
    fetch('/api/host/log')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { lines: HostLine[]; state: HostState }) => { merge(j.lines.filter(isLine)); if (!cancelled) setState(j.state) })
      .catch(err => console.warn('[host] log failed:', err))

    const off = onServerEvent('host-update', raw => {
      const f = raw as { type?: string; line?: unknown; state?: HostState } | null
      if (!f || typeof f !== 'object') return
      if (f.type === 'line' && isLine(f.line)) merge([f.line])
      if (f.type === 'state' && f.state) setState(f.state)
    })
    // Deferred a tick: the status call writes state, and an effect must not
    // set state synchronously (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => { void refreshStatus() }, 0)
    return () => { cancelled = true; off(); clearTimeout(kick) }
  }, [refreshStatus])

  // A finished task changes the answers on every card, so ask again — except
  // after a self-update or reboot, when the server that would answer is the
  // thing going away; the reconnect below handles those.
  const lastEnded = state.last?.endedAt ?? ''
  useEffect(() => {
    if (!lastEnded || state.running) return
    if (state.last?.task === 'self-update' || state.last?.task === 'reboot') return
    const kick = setTimeout(() => { void refreshStatus() }, 0)
    return () => clearTimeout(kick)
  }, [lastEnded, state.running, state.last?.task, refreshStatus])

  const run = useCallback(async (task: HostTask, confirm = false): Promise<boolean> => {
    setRunError('')
    try {
      const r = await fetch('/api/host/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, confirm }),
      })
      const j = await r.json().catch(() => ({})) as { error?: string; state?: HostState }
      if (j.state) setState(j.state)
      if (!r.ok) { setRunError(j.error || `HTTP ${r.status}`); return false }
      return true
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [])

  return { info, status, statusError, statusBusy, refreshStatus, lines, state, run, runError }
}
