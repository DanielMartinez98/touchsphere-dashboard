// REST surface for ComfyUI image generation. The engine is in ../image.ts.
//
// Everything here is thin on purpose: POST kicks off a background job and hands
// back its id immediately, and the interesting part — progress — arrives on the
// existing SSE bus as `image` events rather than by polling this route. The GET
// endpoints exist for the case SSE can't cover: a screen that was closed while a
// render was running and needs to catch up when it reopens.

import { Router, Request, Response, raw } from 'express'
import fs from 'fs'
import {
  activeJob,
  addUploadedImage,
  cancelJob,
  comfyStats,
  comfyUrl,
  forgetImage,
  getJob,
  imagePath,
  imagesEnabled,
  jobWire,
  listImages,
  listLoras,
  listModels,
  listWorkflowStyles,
  MAX_QUEUED,
  MAX_UPLOAD_BYTES,
  missingFiles,
  pendingJobs,
  pickLora,
  QUALITY_STEPS,
  selectedModel,
  selectedQuality,
  setSelectedModel,
  setSelectedQuality,
  startImage,
  styleDefaults,
  styleNeeds,
  styleLabel,
  stylePromptGuide,
  styleOptimizations,
  styleNegativeFor,
  stylePrefixFor,
  styleUsesNegative,
  supersededCheckpoints,
  WORKFLOW_PREFIX,
} from '../image'
import {
  buildSystemPrompt,
  DEFAULT_TEMPLATE,
  readPrompter,
  writePrompter,
} from '../image-prompt'
import {
  clearParamsFor,
  MEGAPIXEL_CHOICES,
  MULTIPLE_CHOICES,
  paramsFor,
  setParamsFor,
} from '../image-params'

const router = Router()

// GET /api/image/check — is the GPU box actually there?
//
// The sibling of /api/system/check/elevenlabs, but it lives here rather than in
// the system router to avoid a require cycle: image.ts already imports
// broadcast() from routes/system, and having system import image back would
// close the loop for no gain.
//
// /system_stats is ComfyUI's cheapest authenticated-free endpoint and it returns
// the VRAM figures, which is the number you actually want when a render fails —
// "reachable" and "has room to load a checkpoint" are different questions.
router.get('/check', async (_req: Request, res: Response) => {
  const { ok, detail } = await comfyStats()
  if (!ok) {
    res.status(502).json({ error: detail, url: comfyUrl() || null })
    return
  }
  res.json({ ok: true, detail, url: comfyUrl() })
})

// GET /api/image/file/:file — serve a generated PNG off the volume.
//
// Registered FIRST: Express matches in order, and `GET /:id` below would
// otherwise swallow "file" as an image id. Same trap the guides router hit with
// its activity endpoint.
router.get('/file/:file', (req: Request, res: Response) => {
  const file = String(req.params['file'] ?? '')
  // Filenames are always the job id (16 random bytes) + .png. Reject anything
  // else rather than let a crafted name walk out of the images directory.
  if (!/^[a-f0-9]{32}\.png$/.test(file)) {
    res.status(400).json({ error: 'invalid image name' })
    return
  }
  const full = imagePath(file)
  if (!full) {
    res.status(404).json({ error: 'image not found' })
    return
  }
  res.setHeader('Content-Type', 'image/png')
  // The filename embeds a one-shot random id, so the bytes behind it never change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  fs.createReadStream(full).pipe(res)
})

// GET /api/image/models — which checkpoints are installed, and which is picked.
//
// Asked of ComfyUI live rather than configured, so the list is exactly what a
// render can succeed with: drop a new .safetensors on the GPU box and it shows
// up here without touching the dashboard.
router.get('/models', async (_req: Request, res: Response) => {
  if (!imagesEnabled()) {
    res.status(503).json({ error: 'COMFYUI_URL is not set', models: [], selected: '' })
    return
  }
  try {
    // Checkpoints and workflow styles in ONE list. Anima is three files behind
    // three loader nodes rather than a ckpt_name, so it can only appear beside
    // the checkpoints if "style" covers both kinds — which is also what makes a
    // user-supplied workflow selectable instead of a hidden global override.
    const checkpoints = await listModels()
    const workflows = listWorkflowStyles()
    // Which workflow styles can actually run. A `wf:` style is three files on
    // the GPU box's disk, and until this check existed the picker offered every
    // one of them regardless — so choosing "Anima Turbo v1.1" on a box that
    // only has the base model looked fine, queued fine, and failed twenty
    // seconds later with ComfyUI's own "value not in list". One pass over the
    // union of everything they need, so it stays a couple of requests however
    // many styles there are.
    const allNeeds = [...new Set(workflows.flatMap(w => styleNeeds(w.id)))]
    const absent = new Set(await missingFiles(allNeeds))
    // A checkpoint that a `wf:` style wraps is hidden here. It would otherwise
    // appear twice — once as the raw file ComfyUI reports, once as the style —
    // and the raw entry renders through the default SDXL graph with none of the
    // model's own settings, so it is the same model quietly set up to fail.
    const wrapped = supersededCheckpoints()
    const styles = [
      ...checkpoints.filter(n => !wrapped.has(n)).map(name => ({
        id: name, label: name, kind: 'checkpoint' as const, missing: [] as string[],
      })),
      ...workflows.map(w => ({
        id: w.id, label: w.label, kind: 'workflow' as const,
        missing: styleNeeds(w.id).filter(n => absent.has(n)),
      })),
    ]
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      // `models` kept for older clients that predate workflow styles.
      models: checkpoints,
      styles,
      selected: selectedModel(),
      quality: selectedQuality(),
      qualities: Object.keys(QUALITY_STEPS),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[image] listing checkpoints failed:', detail)
    res.status(502).json({ error: detail, models: [], selected: selectedModel() })
  }
})

// POST /api/image/model  { model }
//
// Persists the choice for EVERYONE — the Draw panel and the assistant's
// generate_image both draw with it. Picking a checkpoint means "draw in this
// style", and a style that only applied to typed requests would be a bug.
router.post('/model', async (req: Request, res: Response) => {
  const model = typeof (req.body as { model?: unknown })?.model === 'string'
    ? (req.body as { model: string }).model.trim()
    : ''

  // '' is legitimate — it means "go back to whatever the workflow specifies".
  // Anything else has to be a checkpoint ComfyUI actually has, or every later
  // render fails with a "value not in list" that points nowhere near this route.
  if (model.startsWith(WORKFLOW_PREFIX)) {
    // A workflow style is validated against what this server can build, not
    // against ComfyUI's checkpoint list — it has no ckpt_name at all.
    if (!listWorkflowStyles().some(w => w.id === model)) {
      res.status(400).json({ error: `no such style: ${model}` })
      return
    }
  } else if (model) {
    try {
      const models = await listModels()
      if (!models.includes(model)) {
        res.status(400).json({ error: `no such checkpoint: ${model}`, models })
        return
      }
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
      return
    }
  }
  setSelectedModel(model)
  res.json({ ok: true, selected: model })
})

// POST /api/image/quality  { quality: 'draft' | 'standard' | 'high' }
//
// Sampling steps only — see QUALITY_STEPS. Shared with the assistant for the
// same reason the style is: it's a preference about how pictures get drawn on
// this dashboard, not a property of who asked.
router.post('/quality', (req: Request, res: Response) => {
  const quality = typeof (req.body as { quality?: unknown })?.quality === 'string'
    ? (req.body as { quality: string }).quality.trim()
    : ''
  try {
    setSelectedQuality(quality)
    res.json({ ok: true, quality, steps: QUALITY_STEPS[quality] })
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
      qualities: Object.keys(QUALITY_STEPS),
    })
  }
})

// GET /api/image/params[?style=] — the render knobs for one style.
//
// Returns three things at once because the panel needs all three to draw an
// honest control: the user's saved `values`, the `defaults` the style's own
// graph specifies (so a control sitting on "Auto" can say what auto actually
// is — cfg 8 for SDXL, cfg 4 for Anima), and the installed `loras` the turbo
// toggle can choose from.
//
// `style` defaults to the one currently selected, which is what the Draw panel
// always wants; the query parameter exists so a future settings screen can
// inspect one it isn't using.
router.get('/params', async (req: Request, res: Response) => {
  const style = typeof req.query['style'] === 'string' ? req.query['style'] : selectedModel()
  const values = paramsFor(style)
  // The LoRA list is the only part that needs the GPU box, and it must not be
  // able to blank the whole panel: a dead ComfyUI still has saved knobs worth
  // showing. Empty list, no error.
  let loras: string[] = []
  try {
    if (imagesEnabled()) loras = await listLoras()
  } catch (err) {
    console.warn('[image] listing LoRAs failed:', err instanceof Error ? err.message : err)
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    style,
    styleLabel: styleLabel(style),
    values,
    defaults: styleDefaults(style),
    // The text a style brings of its own, so the Settings fields can show what
    // they are overriding as a placeholder rather than starting blank. A blank
    // box over a model that HAS a published negative reads as "there is none",
    // which is the opposite of true and the reason someone would then type a
    // worse one from memory.
    text: {
      negative:      styleNegativeFor(style),
      optimizations: styleOptimizations(style),
      // Read-only: this is where a card that specifies a lead-in puts it, and
      // it is shown so the appended field's placement makes sense.
      prefix:        stylePrefixFor(style),
      // False for a style with no second text encode at all (FLUX). The field
      // is then shown as not applicable rather than as an empty editable box.
      usesNegative:  styleUsesNegative(style),
    },
    loras,
    // What turbo would use if the user leaves the LoRA on "Auto" — shown in the
    // panel so "Auto" names a file instead of being a shrug.
    autoLora: pickLora(loras, []),
    choices: { megapixels: MEGAPIXEL_CHOICES, multipleOf: MULTIPLE_CHOICES },
    quality: selectedQuality(),
    qualitySteps: QUALITY_STEPS[selectedQuality()] ?? 0,
  })
})

// POST /api/image/params  { style?, reset?, ...knobs }
//
// A PATCH in spirit — every field is optional and anything omitted keeps its
// current value, so the panel can send one knob per tap instead of round-
// tripping the whole object and risking a stale overwrite. `reset: true`
// forgets the style's knobs entirely and hands back the defaults.
router.post('/params', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const style = typeof body['style'] === 'string' ? body['style'] : selectedModel()
  const values = body['reset'] === true ? clearParamsFor(style) : setParamsFor(style, body)
  res.json({ ok: true, style, values, defaults: styleDefaults(style) })
})

// GET /api/image/job/:id — one job's state, for a client that reconnected.
router.get('/job/:id', (req: Request, res: Response) => {
  const job = getJob(String(req.params['id'] ?? ''))
  if (!job) {
    res.status(404).json({ error: 'no such job' })
    return
  }
  res.json(jobWire(job))
})

// GET /api/image/active — whatever is rendering right now, or null.
// This is what lets the overlay show a live job after a page reload.
router.get('/active', (_req: Request, res: Response) => {
  const job = activeJob()
  res.json(job ? jobWire(job) : null)
})

// GET /api/image/queue — everything waiting or drawing, in order.
//
// The catch-up half of the queue, for the same reason /active was: SSE only
// carries what happens from now on, so a panel opened while four renders are
// stacked up would show an empty list and a busy GPU. The client keeps its own
// copy from `image` frames after this.
router.get('/queue', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ max: MAX_QUEUED, jobs: pendingJobs().map(jobWire) })
})

// POST /api/image/job/:id/cancel — drop one render that hasn't started.
//
// 409 rather than 404 when the job exists but is already drawing or done: those
// are different problems for the caller, and "no such job" would send someone
// looking for a bug that isn't there.
router.post('/job/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '')
  const job = cancelJob(id)
  if (job) {
    res.json({ ok: true, job: jobWire(job) })
    return
  }
  if (getJob(id)) {
    res.status(409).json({ error: 'that picture is already being drawn — it can only be deleted after' })
    return
  }
  res.status(404).json({ error: 'no such job' })
})

// POST /api/image/generate  { prompt, negative?, width?, height?, seed?, source?, denoise? }
//
// `source` is the id of a picture already in the gallery and turns this into a
// REDRAW: it is encoded to a latent and the sampler starts from that, with
// `denoise` saying how much of it to throw away. The size then comes from the
// source, so width/height are ignored — see startImage().
// Returns the queued job — NOT the finished image. Renders take seconds to
// minutes and holding the request open for that would tie up the Pi's socket
// and time out behind Caddy.
router.post('/generate', (req: Request, res: Response) => {
  if (!imagesEnabled()) {
    res.status(503).json({ error: 'COMFYUI_URL is not set — no image server is configured' })
    return
  }
  // Checked here as well as in startImage() so the panel gets a status it can
  // act on — the tap half shows this text under the button, where the person
  // who just tapped is looking, rather than opening a frame that says it failed.
  if (pendingJobs().length >= MAX_QUEUED) {
    res.status(429).json({
      error: `The queue is full — ${MAX_QUEUED} pictures are already waiting. Let one finish first.`,
    })
    return
  }
  const body = req.body as Record<string, unknown> | undefined
  const prompt = typeof body?.['prompt'] === 'string' ? body['prompt'].trim() : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' })
    return
  }
  const num = (k: string): number | undefined => {
    const v = body?.[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const job = startImage({
    prompt,
    ...(typeof body?.['model'] === 'string' && body['model'] ? { model: body['model'] } : {}),
    ...(typeof body?.['negative'] === 'string' ? { negative: body['negative'] } : {}),
    ...(num('steps') !== undefined ? { steps: num('steps')! } : {}),
    ...(num('cfg')   !== undefined ? { cfg:   num('cfg')!   } : {}),
    ...(num('width')  !== undefined ? { width:  num('width')!  } : {}),
    ...(num('height') !== undefined ? { height: num('height')! } : {}),
    ...(num('seed')   !== undefined ? { seed:   num('seed')!   } : {}),
    // Validated against the gallery in startImage() rather than here, so the
    // refusal arrives on the same channel every other outcome does — as a
    // failed job with a sentence in it, not as a 400 the overlay has no frame
    // for. The shape check is here because an id is a filename stem.
    ...(typeof body?.['source'] === 'string' && /^[a-f0-9]{32}$/.test(body['source'])
      ? { source: body['source'] } : {}),
    ...(num('denoise') !== undefined ? { denoise: num('denoise')! } : {}),
    // Omitted rather than defaulted when the panel doesn't say: undefined means
    // "use the saved default", which is resolved in startImage() at queue time.
    ...(typeof body?.['improve'] === 'boolean' ? { improve: body['improve'] } : {}),
  })
  res.status(202).json(jobWire(job))
})

// GET /api/image/prompter — the prompt improver's settings.
//
// Returns the template AND what it currently expands to for the style that is
// selected, because a template full of {{placeholders}} is genuinely hard to
// judge in the abstract — the preview is what shows that picking FLUX and
// picking NoobAI produce two different system prompts from the same words.
router.get('/prompter', (_req: Request, res: Response) => {
  const settings = readPrompter()
  const style = selectedModel()
  res.json({
    ...settings,
    defaultTemplate: DEFAULT_TEMPLATE,
    style:      style,
    styleLabel: styleLabel(style),
    // The model-specific half, shown separately so it is obvious it comes from
    // the app rather than from anything the user has to maintain.
    guidance:   stylePromptGuide(style),
    preview:    buildSystemPrompt(settings.template, {
      label:    styleLabel(style),
      guidance: stylePromptGuide(style),
    }),
  })
})

// POST /api/image/prompter — patch one or more of its settings.
router.post('/prompter', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined
  const patch: { enabled?: boolean; template?: string; model?: string } = {}
  if (typeof body?.['enabled']  === 'boolean') patch.enabled  = body['enabled']
  if (typeof body?.['template'] === 'string')  patch.template = body['template']
  if (typeof body?.['model']    === 'string')  patch.model    = body['model']
  const saved = writePrompter(patch)
  console.log(
    `[image] prompt improver ${saved.enabled ? 'on' : 'off'}` +
    `${patch.template !== undefined ? ', template edited' : ''}` +
    `${patch.model !== undefined ? `, model=${saved.model || '(default)'}` : ''}`,
  )
  res.json(saved)
})

// POST /api/image/upload — add a picture of the user's own to the gallery.
//
// Raw PNG bytes, not multipart: the client has already drawn whatever the user
// picked onto a canvas and exported it, so there is exactly one file and no
// fields to go with it — and a multipart parser would be a dependency bought
// for nothing. The canvas step is also what normalises HEIC, JPEG and whatever
// else a phone hands over into the one format the gallery stores.
//
// The caption rides in a header rather than the body for the same reason: the
// body IS the file.
router.post(
  '/upload',
  raw({ type: ['image/png'], limit: MAX_UPLOAD_BYTES }),
  (req: Request, res: Response) => {
    const bytes = req.body as unknown
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      res.status(400).json({ error: 'send the PNG bytes as the request body with Content-Type: image/png' })
      return
    }
    // A header is latin-1 on the wire, so the client sends it URI-encoded.
    let caption = ''
    const raw_caption = req.get('x-image-caption')
    if (raw_caption) {
      try { caption = decodeURIComponent(raw_caption) } catch { caption = raw_caption }
    }
    try {
      res.status(201).json(addUploadedImage(bytes, caption))
    } catch (err) {
      // pngSize() refusing is the expected failure and it is the user's file,
      // not a server fault, so it is a 400 with the reason rather than a 500.
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  },
)

// GET /api/image — the gallery, newest first.
router.get('/', (_req: Request, res: Response) => {
  // Freshly generated images are the whole point of asking, and a heuristically
  // cached list means the newest one is missing from it — the same trap
  // /api/guides hit before it started sending no-store.
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    enabled: imagesEnabled(),
    // `modelLabel` is resolved here rather than stored, so an image drawn before
    // settings were recorded still gets a readable style name — and so the
    // client never has to carry the `wf:` id table to caption a picture.
    images: listImages().map(e => ({
      ...e,
      url: `/api/image/file/${e.file}`,
      modelLabel: styleLabel(e.settings?.style ?? e.model ?? ''),
    })),
  })
})

// DELETE /api/image/:id — drop one image and its file.
router.delete('/:id', (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '')
  if (!/^[a-f0-9]{32}$/.test(id)) {
    res.status(400).json({ error: 'invalid image id' })
    return
  }
  if (!forgetImage(id)) {
    res.status(404).json({ error: 'no such image' })
    return
  }
  res.json({ ok: true })
})

export default router
