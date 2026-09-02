// The generated-image gallery, and the tap half of drawing.
//
// The voice half already existed (`generate_image` → a display payload →
// ImageOverlay). This is the other half of the rule the rest of the app follows:
// everything reachable by asking is reachable by tapping. Same store on disk,
// same job engine — the widget just POSTs the request the assistant would have.
//
// Refreshes off the shared `image` SSE event rather than polling, so a picture
// the ASSISTANT was asked for appears in the widget's grid too, without the
// widget knowing anything about the conversation.

import { useCallback, useEffect, useState } from 'react'
import { onServerEvent } from './useServerEvents'

/**
 * How a picture was drawn, as the server recorded it at the moment it landed.
 *
 * Every field is optional in practice — anything in the gallery from before the
 * server started recording this has no `settings` at all — so the UI prints
 * what is there and says nothing about what isn't, rather than captioning a
 * picture with a row of zeros. Mirrors ImageSettings in server/src/image.ts.
 */
export interface ImageSettings {
  style:      string
  styleLabel: string
  steps:      number
  cfg:        number
  sampler:    string
  scheduler:  string
  negative:   string
  lora?:         string
  loraStrength?: number
  source?:  string
  denoise?: number
  tookMs:   number
  /** Set only when the prompt improver rewrote the prompt — see image-prompt.ts. */
  promptOriginal?: string
  improvedBy?:     string
  /** Booster text that was appended to the prompt, when there was any. */
  optimizations?:  string
}

/**
 * The prompt improver's settings, plus the read-only context the editor needs.
 *
 * `preview` is what the template actually expands to for the style currently
 * selected — the whole reason it is sent is that a template full of
 * {{placeholders}} cannot be judged on its own, and the same words produce a
 * different system prompt in front of FLUX than in front of NoobAI.
 */
export interface PrompterSettings {
  enabled:  boolean
  template: string
  model:    string
  /** The house default, so "reset" doesn't have to duplicate it on the client. */
  defaultTemplate: string
  style:      string
  styleLabel: string
  /** The selected model's own published prompting guidance. */
  guidance:   string
  preview:    string
}

export interface StoredImage {
  id:     string
  prompt: string
  file:   string
  /** 'upload' for a picture the user added rather than one this app drew. */
  origin?: 'upload'
  url:    string
  width:  number
  height: number
  seed:   number
  /** Style id that drew it. Absent on the very oldest entries. */
  model?:      string
  /** That id made readable, resolved by the server on the way out. */
  modelLabel?: string
  settings?:   ImageSettings
  at:     string
}

export type Orientation = 'portrait' | 'landscape' | 'square'

export type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'

/**
 * One render waiting or in flight.
 *
 * The client keeps its own copy of the queue rather than asking for it: the
 * server pushes a frame whenever ONE job changes, and re-fetching the whole
 * list on every phase tick would be a request every couple of seconds on a Pi.
 * `queuedAt` is what the order is rebuilt from — see the note on the server's
 * wire() for why a position can't just be sent.
 */
export interface QueuedJob {
  id:       string
  prompt:   string
  status:   JobStatus
  /** The server's short label — "loading the model", "drawing", "saving". */
  phase:    string
  /** The same status in full sentences. See ImageJob.detail on the server. */
  detail:   string
  width:    number
  height:   number
  /**
   * How long a render LIKE THIS ONE takes on this box, from the server's timing
   * history — style, steps, size and whether the checkpoint was already loaded.
   * 0 = no usable history yet, and nothing should be shown for a 0.
   */
  etaMs:    number
  /** Time before the GPU reaches this job, summed over the ones ahead of it. */
  waitMs:   number
  /** The server's own elapsed figure, so a countdown anchors to it, not to mount. */
  elapsedMs: number
  queuedAt: number
}

/** Mirrors MAX_QUEUED in server/src/image.ts; the server's own answer wins. */
export const DEFAULT_QUEUE_MAX = 8

export interface ImageStyle {
  /** Checkpoint filename, or `wf:<id>` for a whole-workflow style. */
  id:    string
  label: string
  kind:  'checkpoint' | 'workflow'
  /**
   * Files this style needs that the image server hasn't got, as
   * `<folder>/<filename>`. Empty means it can run.
   *
   * A `wf:` style is three files on the GPU box's disk, and offering one whose
   * files are absent means the choice looks fine, queues fine, and fails
   * twenty seconds later naming a file the user has never heard of. The picker
   * greys these and prints the filename instead.
   */
  missing?: string[]
}

interface StylesResponse {
  models?:  string[]
  styles?:  ImageStyle[]
  selected?: string
  quality?:  string
}

export type SeedMode = 'random' | 'fixed' | 'increment'

/**
 * The advanced render knobs, stored PER STYLE on the server.
 *
 * Every zero means "leave it alone": steps 0 falls through to the quality
 * preset, cfg 0 to whatever the style's graph specifies, megapixels 0 to the
 * fixed orientation sizes. So a panel nobody has opened behaves exactly as it
 * did before these existed.
 */
export interface ImageParams {
  megapixels:   number
  multipleOf:   number
  steps:        number
  cfg:          number
  turbo:        boolean
  lora:         string
  loraStrength: number
  seedMode:     SeedMode
  seed:         number
  /**
   * The four pieces of text the app adds for you, all overridable per style.
   *
   * null means "no override — use what the model's card publishes"; '' means an
   * override that is deliberately empty, i.e. add nothing. They are different
   * answers and the UI has to be able to express both, or a built-in prefix
   * could never be switched off.
   */
  prefix:         string | null
  optimizations:  string | null
  negative:       string | null
  negativePrefix: string | null
}

/** What the selected style's own graph specifies, so "Auto" can name a number. */
export interface StyleDefaults {
  steps:      number
  cfg:        number
  width:      number
  height:     number
  sampler:    string
  scheduler:  string
  hasCfg:     boolean
  turboKnown: boolean
  /** False for a distilled style (Anima Turbo), whose steps come from the model. */
  qualityApplies: boolean
}

export const DEFAULT_PARAMS: ImageParams = {
  megapixels: 0, multipleOf: 8, steps: 0, cfg: 0,
  prefix: null, optimizations: null, negative: null, negativePrefix: null,
  turbo: false, lora: '', loraStrength: 1,
  seedMode: 'random', seed: 0,
}

// Mirrors MEGAPIXEL_CHOICES / MULTIPLE_CHOICES in server/src/image-params.ts.
// Duplicated for the same reason SIZES is: the panel has to draw its buttons
// before it has spoken to the server, and these are a handful of constants.
//
// These are the one-tap PRESETS, not the range. Every numeric knob in the
// Advanced panel can also be typed on the number pad, and the LIMITS below are
// what actually bounds it — kept in step with the server so a typed value is
// clamped identically on both sides. A field that let you type 400 steps and
// then showed 150 without saying so would read as the panel losing the setting.
export const MEGAPIXELS = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]
export const MULTIPLES  = [8, 16, 32, 64, 128]

/**
 * How much of the source picture a redraw throws away, behind three words.
 *
 * Named rather than numbered for the same reason the orientation buttons are
 * shapes rather than pixel counts: nobody standing at a kiosk knows what 0.65
 * means, and a fingertip cannot land it on a slider anyway. The numbers are the
 * model author's own guidance — 0.5-0.6 for a small edit, 0.75-0.85 for a
 * creative reinterpretation — and they match STRENGTH in the server's
 * image-tools.ts, so a redraw asked for out loud and one tapped here land in
 * the same place.
 */
export const STRENGTHS: { id: string; label: string; hint: string; denoise: number }[] = [
  { id: 'light',    label: 'Light',    hint: 'tweak details', denoise: 0.45 },
  { id: 'balanced', label: 'Balanced', hint: 'keep the layout', denoise: 0.65 },
  { id: 'strong',   label: 'Strong',   hint: 'just the idea', denoise: 0.85 },
]

export const LIMITS = {
  megapixels:   { min: 0.25, max: 16  },
  multipleOf:   { min: 8,    max: 512 },
  steps:        { min: 1,    max: 150 },
  cfg:          { min: 1,    max: 30  },
  loraStrength: { min: 0,    max: 2   },
  seed:         { min: 0,    max: 2 ** 31 - 1 },
}

// MIN_DIM / MAX_USER_DIM in server/src/image.ts. Mirrored so the panel's
// resolution readout is the size that will actually be rendered rather than the
// one that was asked for.
const MIN_SIDE = 256
const MAX_SIDE = 6144

/** The text a style brings of its own, before any per-style override. */
export interface StyleText {
  /** The negative actually in effect when nobody overrides it. */
  negative:      string
  /** Booster appended by default. '' for most styles — see styleOptimizations. */
  optimizations: string
  /** The lead-in this model's card puts in FRONT of every prompt. '' for most. */
  prefix:         string
  /** The lead-in in front of the NEGATIVE. Only instruction-tuned models ship one. */
  negativePrefix: string
  /** False for a model with no negative prompt at all (FLUX). Optional: an older server omits it. */
  usesNegative?: boolean
}

export interface ParamsResponse {
  style?:      string
  styleLabel?: string
  values?:     Partial<ImageParams>
  defaults?:   Partial<StyleDefaults>
  text?:       StyleText
  loras?:      string[]
  autoLora?:   string
}

/**
 * Styles from the response, tolerating a server that predates them.
 *
 * The dashboard and the server update independently (Watchtower pulls the image
 * on its own schedule), so a client can briefly be newer than the API it talks
 * to. Falling back to the flat `models` list keeps the picker working instead of
 * rendering empty.
 */
function stylesOf(j: StylesResponse): ImageStyle[] {
  if (j.styles?.length) return j.styles
  return (j.models ?? []).map(m => ({ id: m, label: m, kind: 'checkpoint' as const }))
}

/** Can this style actually draw? A server that predates `missing` says yes. */
export const styleUsable = (st: ImageStyle): boolean => (st.missing?.length ?? 0) === 0

// Mirrors SIZES in server/src/routes/image-tools.ts. Duplicated rather than
// fetched: it's three constants, and the widget has to draw the aspect-ratio
// buttons before it has spoken to the server at all.
export const SIZES: Record<Orientation, { width: number; height: number }> = {
  portrait:  { width: 768,  height: 1152 },
  landscape: { width: 1152, height: 768  },
  square:    { width: 896,  height: 896  },
}

export function useImages() {
  const [images,  setImages]  = useState<StoredImage[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)   // null = not asked yet
  const [loading, setLoading] = useState(true)
  // Everything waiting or drawing, from ANY source — asked for here or out
  // loud. One GPU, one queue: the collapsed pill, the Draw button and the queue
  // strip all read this, so a picture the assistant was asked for takes its
  // place in the same line as one that was typed.
  const [queue,    setQueue]    = useState<QueuedJob[]>([])
  const [queueMax, setQueueMax] = useState(DEFAULT_QUEUE_MAX)
  // Why the last attempt to queue something didn't take. Shown under the Draw
  // button rather than logged: a full queue is a thing the person tapping needs
  // to read, and it was previously visible only in the console.
  const [drawError, setDrawError] = useState('')
  // Installed checkpoints and the one in effect. Asked of the server rather
  // than configured here, because ComfyUI is the only thing that knows what is
  // actually on the GPU box's disk.
  // Styles cover BOTH kinds: a checkpoint filename, and a `wf:` workflow style
  // like Anima that is three files behind three loader nodes and has no
  // ckpt_name to swap. The picker shouldn't care which is which.
  const [styles,  setStyles]     = useState<ImageStyle[]>([])
  const [model,   setModelState] = useState('')
  const [quality, setQualityState] = useState('standard')
  // The advanced knobs for the style currently selected, what that style's own
  // graph specifies underneath them, and the LoRAs turbo mode can choose from.
  // Reloaded whenever `model` changes, because the knobs are stored per style.
  const [params,   setParamsState] = useState<ImageParams>(DEFAULT_PARAMS)
  const [defaults, setDefaults]    = useState<StyleDefaults | null>(null)
  const [loras,    setLoras]       = useState<string[]>([])
  const [autoLora, setAutoLora]    = useState('')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/image')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json() as { enabled: boolean; images: StoredImage[] }
      setImages(j.images ?? [])
      setEnabled(j.enabled)
    } catch (err) {
      console.warn('[images] list failed:', err)
      setEnabled(false)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load. Inlined with a cancelled guard rather than calling refresh(),
  // matching useGuides — an unmount mid-flight must not set state on a dead hook.
  useEffect(() => {
    let cancelled = false
    fetch('/api/image')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { enabled: boolean; images: StoredImage[] }) => {
        if (cancelled) return
        setImages(j.images ?? [])
        setEnabled(j.enabled)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        console.warn('[images] list failed:', err)
        setEnabled(false)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/image/models')
      const j = await res.json() as StylesResponse
      setStyles(stylesOf(j))
      setModelState(j.selected ?? '')
      setQualityState(j.quality ?? 'standard')
    } catch (err) {
      console.warn('[images] model list failed:', err)
    }
  }, [])

  // Initial model list — inlined with a cancelled guard for the same reason as
  // the gallery load above, rather than routed through loadModels().
  useEffect(() => {
    let cancelled = false
    fetch('/api/image/models')
      .then(r => r.json())
      .then((j: StylesResponse) => {
        if (cancelled) return
        setStyles(stylesOf(j))
        setModelState(j.selected ?? '')
        setQualityState(j.quality ?? 'standard')
      })
      .catch(err => { if (!cancelled) console.warn('[images] model list failed:', err) })
    return () => { cancelled = true }
  }, [])

  /**
   * Switch checkpoints.
   *
   * Optimistic, then reconciled: the picker has to feel instant on a touchscreen,
   * but the server validates the name against what ComfyUI actually has, so its
   * answer wins. Nothing is drawn here — the choice applies to the next picture,
   * from this panel or from the assistant.
   */
  const setModel = useCallback(async (next: string) => {
    setModelState(next)
    try {
      const res = await fetch('/api/image/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] setting model failed:', err)
      void loadModels()          // put the real value back
    }
  }, [loadModels])

  /**
   * Fetch the advanced knobs for one style. Returns them rather than setting
   * them, so the caller decides whether its answer is still wanted — see the
   * effect below.
   *
   * Takes the style explicitly rather than reading `model` from state, so a
   * save can reload exactly the style it wrote without waiting for a re-render.
   */
  const fetchParams = useCallback(async (style: string): Promise<ParamsResponse | null> => {
    try {
      const res = await fetch(`/api/image/params?style=${encodeURIComponent(style)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json() as ParamsResponse
    } catch (err) {
      // A server that predates this endpoint 404s. Null falls back to defaults,
      // and every zero in those means "leave it alone" anyway.
      console.warn('[images] params load failed:', err)
      return null
    }
  }, [])

  const applyParams = useCallback((j: ParamsResponse | null) => {
    setParamsState({ ...DEFAULT_PARAMS, ...(j?.values ?? {}) })
    setDefaults(j?.defaults ? { ...j.defaults } as StyleDefaults : null)
    setLoras(j?.loras ?? [])
    setAutoLora(j?.autoLora ?? '')
  }, [])

  // Follow the selected style. Runs on mount too (model starts '' and settles
  // to the real value once /models answers), which is what loads them initially.
  //
  // The cancelled guard is load-bearing rather than hygiene here: tapping
  // through three styles fires three requests, and without it the slowest one
  // wins and the panel ends up describing a style you aren't on — which the
  // next tap would then SAVE against the style you are.
  useEffect(() => {
    let cancelled = false
    void fetchParams(model).then(j => { if (!cancelled) applyParams(j) })
    return () => { cancelled = true }
  }, [model, fetchParams, applyParams])

  /**
   * Change one knob.
   *
   * A PATCH: only the changed field goes up, and the server's normalized answer
   * comes back as the new truth. Optimistic first, like setModel — on a
   * touchscreen a control that waits for a round trip before it moves reads as
   * a control that didn't register the tap.
   */
  const setParams = useCallback(async (patch: Partial<ImageParams>) => {
    const style = model
    setParamsState(prev => ({ ...prev, ...patch }))
    try {
      const res = await fetch('/api/image/params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, ...patch }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json() as ParamsResponse
      if (j.values) setParamsState({ ...DEFAULT_PARAMS, ...j.values })
    } catch (err) {
      console.warn('[images] params save failed:', err)
      void fetchParams(style).then(applyParams)     // put the real values back
    }
  }, [model, fetchParams, applyParams])

  /**
   * Save knobs for a NAMED style rather than the selected one.
   *
   * Settings → Drawing edits every model's negative and booster from one
   * screen, including models that are not currently in effect, so it cannot go
   * through `setParams` — that one is bound to `model` on purpose, because the
   * Draw panel must never write a knob against a style the user has since
   * switched away from.
   */
  const setParamsForStyle = useCallback(async (
    style: string, patch: Partial<ImageParams>,
  ): Promise<ParamsResponse | null> => {
    try {
      const res = await fetch('/api/image/params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, ...patch }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json() as ParamsResponse
      // If it happened to be the style in effect, keep the Draw panel in step
      // rather than letting the two screens disagree until the next reload.
      if (style === model && j.values) setParamsState({ ...DEFAULT_PARAMS, ...j.values })
      return j
    } catch (err) {
      console.warn('[images] params save failed:', err)
      return null
    }
  }, [model])

  /** Forget this style's knobs — back to whatever its own graph specifies. */
  const resetParams = useCallback(async () => {
    const style = model
    setParamsState(DEFAULT_PARAMS)
    try {
      await fetch('/api/image/params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, reset: true }),
      })
    } catch (err) {
      console.warn('[images] params reset failed:', err)
    }
    // Reload regardless: a reset also re-reads the style's own defaults, which
    // is the half of the panel the local DEFAULT_PARAMS above can't guess.
    applyParams(await fetchParams(style))
  }, [model, fetchParams, applyParams])

  /** Change the quality preset. Same optimistic-then-reconciled shape as setModel. */
  const setQuality = useCallback(async (next: string) => {
    setQualityState(next)
    try {
      const res = await fetch('/api/image/quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] setting quality failed:', err)
      void loadModels()
    }
  }, [loadModels])

  // Retry while the image server is down.
  //
  // `enabled` was fetched exactly once at mount, which is wrong for a kiosk in
  // two ways that both really happen: the Pi boots at the same moment as the
  // server and can win the race, and the GPU box gets switched on hours after
  // the dashboard did. Either way the panel latched on "isn't reachable" and
  // stayed there until someone reloaded — which on a kiosk with no keyboard is
  // nobody. One small request every 30s, only while it is actually broken.
  useEffect(() => {
    if (enabled !== false) return
    const t = setInterval(() => { void refresh(); void loadModels() }, 30_000)
    return () => clearInterval(t)
  }, [enabled, refresh, loadModels])

  // Follow every render, from whichever source started it. A frame either puts
  // a job into the queue (queued/running) or takes it out (ready/failed/
  // cancelled); 'ready' additionally refetches the gallery.
  useEffect(() => onServerEvent('image', data => {
    const job = frameToJob(data)
    if (!job) return
    setQueue(prev => mergeJob(prev, job))
    if (job.status === 'ready') void refresh()
  }), [refresh])

  // Catch up on renders already in flight when the dashboard loads or the
  // widget mounts — SSE only carries what happens from now on, and a Pi that
  // reloaded mid-render would otherwise show an idle corner over a busy GPU.
  useEffect(() => {
    let cancelled = false
    fetch('/api/image/queue')
      .then(r => (r.ok ? r.json() : null))
      .then((j: { max?: number; jobs?: unknown[] } | null) => {
        if (cancelled || !j) return
        if (typeof j.max === 'number' && j.max > 0) setQueueMax(j.max)
        const seeded = (j.jobs ?? []).map(frameToJob).filter((x): x is QueuedJob => x !== null)
        // Merged rather than assigned: a frame can land between the request and
        // its answer, and this list is the older of the two.
        setQueue(prev => seeded.reduce(mergeJob, prev))
      })
      .catch(() => { /* offline server; the pill already says so via `enabled` */ })
    return () => { cancelled = true }
  }, [])

  /**
   * Queue a render. Returns the new job id, or null if the server refused.
   *
   * Several may be in flight; the server draws them one at a time. The answer is
   * merged into the queue here rather than waiting for its SSE frame — the two
   * race, and on a touchscreen a tap that appears to do nothing for half a
   * second reads as a tap that missed.
   */
  const generate = useCallback(async (
    prompt: string,
    orientation: Orientation,
    /** Redraw: the id of the gallery picture to start from. '' = draw fresh. */
    source = '',
    /** How much of that source to throw away. Ignored without a source. */
    denoise = 0,
    /**
     * Rewrite the prompt for the chosen style first.
     *
     * `undefined` is meaningful and is NOT the same as false: it means "use the
     * saved default", which the server resolves at queue time. The panel sends
     * a boolean because it has a switch on screen; anything else can leave it
     * out and get the user's setting.
     */
    improve?: boolean,
  ): Promise<string | null> => {
    const size = SIZES[orientation]
    setDrawError('')
    try {
      const res = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Width and height go up regardless, and the server ignores them for a
        // redraw: an img2img latent is the source's own shape. Sending them
        // anyway keeps one request shape instead of two.
        body: JSON.stringify({
          prompt, width: size.width, height: size.height,
          ...(source ? { source, denoise } : {}),
          ...(typeof improve === 'boolean' ? { improve } : {}),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const j = await res.json() as { id: string }
      const job = frameToJob(j)
      if (job) setQueue(prev => mergeJob(prev, job))
      return j.id
    } catch (err) {
      console.error('[images] generate failed:', err)
      setDrawError(err instanceof Error ? err.message : 'could not start that picture')
      return null
    }
  }, [])

  /**
   * Drop a queued render.
   *
   * Optimistic, like the gallery's delete: the row is the user's own tap. Only a
   * job that hasn't started can go — the server answers 409 for the one already
   * on the GPU — so a refused cancel re-reads the queue and puts the row back
   * rather than leaving the list lying about what is coming.
   */
  const cancel = useCallback(async (id: string) => {
    setQueue(prev => prev.filter(j => j.id !== id))
    try {
      const res = await fetch(`/api/image/job/${id}/cancel`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] cancel failed:', err)
      try {
        const r = await fetch('/api/image/queue')
        const j = await r.json() as { jobs?: unknown[] }
        setQueue((j.jobs ?? []).map(frameToJob).filter((x): x is QueuedJob => x !== null))
      } catch { /* offline — the next SSE frame will straighten the list out */ }
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    // Optimistic: the grid is the user's own tap, and a failed DELETE is put
    // back by the next refresh rather than blocking the animation.
    setImages(prev => prev.filter(i => i.id !== id))
    try {
      const res = await fetch(`/api/image/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn('[images] delete failed:', err)
      void refresh()
    }
  }, [refresh])

  const busy = queue.length > 0
  // The head of the queue is the one on the GPU — pendingJobs() on the server is
  // in draw order and mergeJob preserves it. Falling back to [0] covers the
  // moment between a job being queued and run() marking it 'running'.
  const drawing = queue.find(j => j.status === 'running') ?? queue[0]

  // ── The prompt improver ──
  //
  // Loaded once and re-read whenever the style changes, because `preview` and
  // `guidance` are answers ABOUT the selected style — a panel still showing
  // FLUX's guidance after a switch to NoobAI would be describing the wrong
  // model, which is the one thing this feature exists to get right.
  const [prompter, setPrompterState] = useState<PrompterSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/image/prompter')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: PrompterSettings) => { if (!cancelled) setPrompterState(j) })
      .catch(err => console.warn('[images] prompter load failed:', err))
    return () => { cancelled = true }
  }, [model])

  /** Patch the improver's settings. Optimistic — it is the user's own tap. */
  const setPrompter = useCallback(async (patch: Partial<PrompterSettings>) => {
    setPrompterState(prev => (prev ? { ...prev, ...patch } : prev))
    try {
      const res = await fetch('/api/image/prompter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Re-read rather than trusting the echo: editing the template changes
      // `preview`, which is computed server-side and is the point of the panel.
      const fresh = await fetch('/api/image/prompter')
      if (fresh.ok) setPrompterState(await fresh.json() as PrompterSettings)
    } catch (err) {
      console.warn('[images] prompter save failed:', err)
    }
  }, [])

  /**
   * Add a picture from the user's device to the gallery.
   *
   * The file is drawn onto a canvas and re-exported as PNG before it is sent,
   * which is doing three jobs at once: it normalises whatever the phone handed
   * over (HEIC, JPEG, anything the BROWSER can decode) into the one format the
   * gallery stores, it gives the server a file it can size from an IHDR chunk
   * with no image library on an arm64 build, and it caps the dimensions — a
   * 12-megapixel photo is a pointless base for an img2img latent and would eat
   * the upload limit for nothing.
   */
  const upload = useCallback(async (file: File): Promise<StoredImage | null> => {
    setDrawError('')
    try {
      const bitmap = await createImageBitmap(file)
      // Long side capped. Generous enough that a redraw still has real detail
      // to work from, small enough that the POST is a second, not a minute.
      const MAX_SIDE = 2048
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
      // Rounded to even numbers: every latent this app produces is a multiple
      // of 8, and handing the sampler an odd-sized source just makes ComfyUI
      // round it somewhere we can't see.
      const w = Math.max(8, Math.round((bitmap.width  * scale) / 2) * 2)
      const h = Math.max(8, Math.round((bitmap.height * scale) / 2) * 2)

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('this browser would not give us a canvas')
      ctx.drawImage(bitmap, 0, 0, w, h)
      bitmap.close()

      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('the picture could not be converted')

      const res = await fetch('/api/image/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          // Headers are latin-1 on the wire and a filename can be anything.
          'X-Image-Caption': encodeURIComponent(file.name.replace(/\.[^.]+$/, '').slice(0, 200)),
        },
        body: blob,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const stored = await res.json() as StoredImage
      setImages(prev => [stored, ...prev.filter(e => e.id !== stored.id)])
      return stored
    } catch (err) {
      console.error('[images] upload failed:', err)
      setDrawError(err instanceof Error ? err.message : 'could not add that picture')
      return null
    }
  }, [])

  return {
    images, enabled, loading, busy,
    phase: drawing?.phase ?? '',
    // What the collapsed corner counts down: the estimate for the picture
    // actually on the GPU, not for the whole queue, which the pill has no room
    // to explain. Gated on 'running' because a job that is still QUEUED reports
    // its queue wait as `elapsedMs` — counting an estimate of render time down
    // against time spent waiting would run the pill to zero before the GPU had
    // touched it.
    drawingEtaMs: drawing?.status === 'running' ? drawing.etaMs : 0,
    drawingElapsedMs: drawing?.elapsedMs ?? 0,
    queue, queueMax, queueFull: queue.length >= queueMax, drawError, cancel,
    styles, model, setModel,
    quality, setQuality,
    params, defaults, loras, autoLora, setParams, resetParams,
    generate, remove, refresh,
    prompter, setPrompter, upload,
    fetchParams, setParamsForStyle,
  }
}

// -- Queue bookkeeping ------------------------------------------------------

/** One `image` frame (or a /queue entry, or a POST answer) as a queue row. */
function frameToJob(data: unknown): QueuedJob | null {
  const d = data as Record<string, unknown> | null
  if (!d || typeof d['id'] !== 'string' || typeof d['status'] !== 'string') return null
  return {
    id:       d['id'],
    prompt:   typeof d['prompt'] === 'string' ? d['prompt'] : '',
    status:   d['status'] as JobStatus,
    phase:    typeof d['phase'] === 'string' ? d['phase'] : '',
    detail:   typeof d['detail'] === 'string' ? d['detail'] : '',
    width:    typeof d['width']  === 'number' ? d['width']  : 0,
    height:   typeof d['height'] === 'number' ? d['height'] : 0,
    etaMs:    typeof d['etaMs']  === 'number' ? d['etaMs']  : 0,
    waitMs:   typeof d['waitMs'] === 'number' ? d['waitMs'] : 0,
    elapsedMs: typeof d['elapsedMs'] === 'number' ? d['elapsedMs'] : 0,
    // A server that predates the queue sends no queuedAt. Falling back to now
    // puts such a job at the end of the list rather than dropping it.
    queuedAt: typeof d['queuedAt'] === 'number' ? d['queuedAt'] : Date.now(),
  }
}

/**
 * Fold one job into the queue.
 *
 * Anything finished (ready, failed, cancelled) leaves the list — the gallery is
 * where a finished picture lives, and a failure has already been reported to
 * whoever asked for it. Everything else is upserted and the list re-ordered by
 * `queuedAt`, which is the order the server will draw them in.
 */
function mergeJob(list: QueuedJob[], job: QueuedJob): QueuedJob[] {
  const without = list.filter(j => j.id !== job.id)
  if (job.status !== 'queued' && job.status !== 'running') return without
  return [...without, job].sort((a, b) => a.queuedAt - b.queuedAt)
}

/**
 * The size a render will actually come out at.
 *
 * Mirrors sizeForMegapixels() in server/src/image.ts — the server is still the
 * one that decides, but the panel has to be able to say "1.5 MP portrait means
 * 1024×1536" at the moment you tap it, and a round trip per tap to find out
 * would make the control feel broken. The formula is four lines; keeping it in
 * step is cheaper than an endpoint.
 */
export function resolutionFor(o: Orientation, p: ImageParams): { width: number; height: number } {
  const base = SIZES[o]
  if (p.megapixels <= 0) return base
  const mult = p.multipleOf >= 8 ? Math.round(p.multipleOf / 8) * 8 : 8
  const aspect = base.width / base.height
  const target = p.megapixels * 1_000_000
  const snap = (n: number) =>
    Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.max(mult, Math.round(n / mult) * mult)))
  return {
    width:  snap(Math.sqrt(target * aspect)),
    height: snap(Math.sqrt(target / aspect)),
  }
}
