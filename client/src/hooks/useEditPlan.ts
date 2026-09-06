// Edit plans, as the server reports them.
//
// One module store keyed by plan id, fed by the `image-plan` SSE event and by
// the answers to our own POSTs. The Draw panel shows the plan it made and the
// full-screen frame follows whichever step is on the GPU; both read from here,
// which is what lets the frame keep following a plan after the panel that
// started it has been closed.

import { useEffect, useSyncExternalStore } from 'react'
import { onServerEvent } from './useServerEvents'

export type PlanMode = 'edit' | 'part' | 'whole'
export type PlanStatus = 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled'

export interface PlanStep {
  n:        number
  mode:     PlanMode
  prompt:   string
  region?:  string
  strength?: 'light' | 'balanced' | 'strong'
  style?:      string
  styleLabel?: string
  why:      string
  status:   'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  jobId?:   string
  imageId?: string
  error?:   string
  attempts?: number
  change?:  number
}

export interface EditPlan {
  id:        string
  source:    string
  sourceUrl: string
  request:   string
  status:    PlanStatus
  steps:     PlanStep[]
  summary:   string
  currentJobId: string
  resultId:  string
  resultUrl: string
  error:     string
  model:     string
  createdAt: number
  tools:     PlanMode[]
}

const plans = new Map<string, EditPlan>()
const listeners = new Set<() => void>()
function emit() { listeners.forEach(cb => cb()) }
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function isPlan(x: unknown): x is EditPlan {
  const d = x as Record<string, unknown> | null
  return !!d && typeof d['id'] === 'string' && typeof d['status'] === 'string' && Array.isArray(d['steps'])
}

function put(plan: EditPlan) {
  plans.set(plan.id, plan)
  emit()
}

// One SSE subscription for the module, opened on first use.
let listening = false
function listen() {
  if (listening) return
  listening = true
  onServerEvent('image-plan', data => { if (isPlan(data)) put(data) })
}

/** The plan with this id, live. null while unknown. */
export function usePlan(id: string | null): EditPlan | null {
  useEffect(() => {
    listen()
    if (!id || plans.has(id)) return
    // Missed frames (the plan was made before this page loaded): ask once.
    let cancelled = false
    fetch(`/api/image/plan/${id}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!cancelled && isPlan(j)) put(j) })
      .catch(() => { /* the panel shows nothing until a frame arrives */ })
    return () => { cancelled = true }
  }, [id])
  return useSyncExternalStore(subscribe, () => (id ? plans.get(id) ?? null : null), () => null)
}

async function post(url: string, body?: unknown): Promise<EditPlan> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const j = await res.json().catch(() => ({})) as unknown
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`)
  if (!isPlan(j)) throw new Error('unexpected answer from the server')
  put(j)
  return j
}

/** Ask for a plan. `run` false shows it first; true runs it as soon as it exists. */
export function planEdit(source: string, request: string, run = false, minSteps = 0): Promise<EditPlan> {
  listen()
  return post('/api/image/plan', { source, request, run, ...(minSteps > 0 ? { minSteps } : {}) })
}
export function runPlan(id: string): Promise<EditPlan> { return post(`/api/image/plan/${id}/run`) }
export function cancelPlan(id: string): Promise<EditPlan> { return post(`/api/image/plan/${id}/cancel`) }
