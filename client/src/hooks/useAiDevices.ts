// Settings → Devices: which machine does each piece of AI work.
//
// Five services (the language model, pictures, voice out, voice in, Miku's
// conversion), each resolved on the server to a URL — the device chosen here,
// else the server's own .env. One GET gives the whole table; each change is a
// small POST that answers with the same table, so the panel never guesses.

import { useCallback, useEffect, useState } from 'react'

export type AiService = 'chat' | 'image' | 'tts' | 'stt' | 'rvc'

export interface AiDevice {
  id:      string
  name:    string
  host:    string
  ports:   Partial<Record<AiService, number>>
  addedAt: string
}

export type UrlSource = 'device' | 'env' | 'default' | 'off'

export interface ResolvedService {
  id:      AiService
  label:   string
  hint:    string
  env:     string
  url:     string
  source:  UrlSource
  device?: { id: string; name: string }
  envUrl:  string
}

export interface ProbeResult {
  service: AiService
  url:     string
  ok:      boolean
  ms:      number
  detail:  string
}

export interface AiDevicesData {
  devices:  AiDevice[]
  assign:   Partial<Record<AiService, string>>
  services: ResolvedService[]
}

async function call(path: string, init?: RequestInit): Promise<AiDevicesData> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({})) as AiDevicesData & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export function useAiDevices() {
  const [data,  setData]  = useState<AiDevicesData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy,  setBusy]  = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await call('/api/ai-devices'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // The first load, in the shape the lint rule wants (no setState call in the
  // effect body itself): a cancelled flag so an unmounted tab sets nothing.
  useEffect(() => {
    let cancelled = false
    call('/api/ai-devices')
      .then(d => { if (!cancelled) { setData(d); setError(null) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [])

  const mutate = useCallback(async (path: string, init: RequestInit) => {
    setBusy(true)
    try {
      setData(await call(path, init))
      setError(null)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const json = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  /** Add (or, for a host already listed, rename) a device. `assign: 'answering'`
   *  also points every service the device answers at it. */
  const addDevice = useCallback((name: string, host: string, assign?: AiService[] | 'answering') =>
    mutate('/api/ai-devices', json({ name, host, assign })), [mutate])

  const removeDevice = useCallback((id: string) =>
    mutate(`/api/ai-devices/${encodeURIComponent(id)}`, { method: 'DELETE' }), [mutate])

  /** Point a service at a device, or at '' to go back to the server's .env. */
  const assign = useCallback((service: AiService, deviceId: string) =>
    mutate('/api/ai-devices/assign', json({ service, deviceId })), [mutate])

  /** Ask a device which of the five services it is running. Never throws. */
  const probe = useCallback(async (id: string): Promise<ProbeResult[] | string> => {
    try {
      const res = await fetch(`/api/ai-devices/${encodeURIComponent(id)}/probe`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { results?: ProbeResult[]; error?: string }
      if (!res.ok || !body.results) return body.error ?? `HTTP ${res.status}`
      return body.results
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, [])

  return { data, error, busy, reload: load, addDevice, removeDevice, assign, probe }
}
