// Edit PLANS: one request, several renders, each done with the right tool.
//
// "Give him a red leather jacket, make it night and add rain" is three
// different kinds of change. The jacket keeps its outline, so it is a masked
// repaint of one region ("Just a part"); night and rain change the whole
// scene, so they are an instruction edit (Kontext). Asking one tool to do all
// three either repaints what should have been kept or clips what should have
// grown. So a model that can SEE the picture is shown it with the request and
// the tools this GPU box actually has, and writes the steps; each step is an
// ordinary render job whose result is the next step's source, so nothing
// about rendering is duplicated here — a plan is a small state machine over
// startImage().
//
// Three properties, each deliberate:
//
//   • The plan is shown before it runs (the panel), or run at once (the
//     assistant). Five renders is several minutes of GPU, and a plan that
//     misread "the hat" as "the head" is cheaper to fix as a sentence than as
//     three pictures.
//   • Steps run strictly in order and the chain stops at the first failure,
//     because step 3 starting from step 1's picture would silently drop step
//     2's change, which is the one substitution this feature must not make.
//   • Every intermediate picture is a real gallery entry. Nothing is hidden:
//     if step 2 was the good one, it is there to keep.
//
// State is in memory, like the render jobs it wraps — a plan is minutes long
// and a restart mid-plan loses it, which the panel says rather than spins.

import { broadcast } from './routes/system'
import {
  cancelJob, getJob, listImages, listWorkflowStyles, missingFiles, startImage,
  styleEdits, styleNeeds, segmentationAvailable, inpaintAvailable,
  type ImageJob,
} from './image'
import { visionModel } from './image-prompt'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const OLLAMA_URL     = process.env['OLLAMA_URL']     ?? 'http://host.docker.internal:11434'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''
const PLAN_TIMEOUT_MS = Number(process.env['OLLAMA_IMAGE_TIMEOUT_MS'] ?? 45_000) * 2
/** Per step. A cold FLUX render with segmentation in front of it is ~2 min; this is a wedge guard. */
const STEP_TIMEOUT_MS = 20 * 60_000
const MAX_STEPS = 5
const MAX_PLANS = 30

export type PlanMode = 'edit' | 'part' | 'whole'
export type Strength = 'light' | 'balanced' | 'strong'
const STRENGTH: Record<Strength, number> = { light: 0.45, balanced: 0.65, strong: 0.85 }
const PART_STRENGTH: Record<Strength, number> = { light: 0.6, balanced: 0.85, strong: 1 }

export interface PlanStep {
  n:        number
  mode:     PlanMode
  prompt:   string
  region?:  string
  strength?: Strength
  /** The planner's one-line reason — shown so a wrong plan can be argued with. */
  why:      string
  status:   'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  jobId?:   string
  /** The gallery id of this step's result, which is also the next step's source. */
  imageId?: string
  error?:   string
}

export type PlanStatus = 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled'

export interface EditPlan {
  id:        string
  source:    string
  sourceUrl: string
  request:   string
  status:    PlanStatus
  steps:     PlanStep[]
  /** The planner's own one-sentence account of what it will do. */
  summary:   string
  /** The job on the GPU (or queued) right now, so a frame can follow the plan. */
  currentJobId: string
  /** The last step's picture, once there is one. */
  resultId:  string
  resultUrl: string
  error:     string
  model:     string
  createdAt: number
  /** Which tools were on offer when this was planned — explains a plan with no 'part' steps. */
  tools:     PlanMode[]
}

const plans = new Map<string, EditPlan>()

export function getPlan(id: string): EditPlan | undefined { return plans.get(id) }
export function listPlans(): EditPlan[] { return [...plans.values()].sort((a, b) => b.createdAt - a.createdAt) }

function push(plan: EditPlan): void {
  broadcast('image-plan', plan)
}

function prune(): void {
  const finished = listPlans().filter(p => p.status === 'done' || p.status === 'failed' || p.status === 'cancelled')
  for (const old of finished.slice(MAX_PLANS)) plans.delete(old.id)
}

/** Which of the three tools this box can run right now, and the editor style's id. */
async function availableTools(): Promise<{ tools: PlanMode[]; editor: string }> {
  const tools: PlanMode[] = ['whole']
  const [seg, inpaint] = await Promise.all([segmentationAvailable(), inpaintAvailable()])
  if (seg && inpaint) tools.unshift('part')
  let editor = ''
  const candidate = listWorkflowStyles().find(w => styleEdits(w.id))
  if (candidate) {
    const absent = await missingFiles(styleNeeds(candidate.id)).catch(() => ['?'])
    if (absent.length === 0) { editor = candidate.id; tools.unshift('edit') }
  }
  return { tools, editor }
}

function plannerSystem(tools: PlanMode[]): string {
  const lines: string[] = []
  lines.push(
    'You plan edits to a picture for an image pipeline. You are shown the picture and told what the ' +
    'user wants changed. Split the request into the FEWEST steps that give the best result. Each step ' +
    'is done by ONE tool, and each step works on the previous step\'s result.',
    '',
    'Tools available on this machine:',
  )
  if (tools.includes('edit')) {
    lines.push(
      '- "edit": an instruction edit (FLUX Kontext). Best for changes that alter shapes, add or remove ' +
      'things, change pose, expression, lighting, weather, season, time of day, or the style of the whole ' +
      'picture — anything that spans many regions or has no fixed outline. The prompt is a short literal ' +
      'instruction that names the subject ("make it night", "add rain", "put a leather jacket on the man"). ' +
      'What the instruction does not mention is kept, but every pixel is reconstructed rather than copied.',
    )
  }
  if (tools.includes('part')) {
    lines.push(
      '- "part": repaint ONE visible thing and keep everything else pixel for pixel. Needs "region": two ' +
      'to four plain words naming something visible in the picture ("the hat", "the sky", "his shirt"), ' +
      'and "prompt": what should be IN that region only ("a red woolly hat"), plus "strength": "light" ' +
      '(keep its shape, change colour or material), "balanced", or "strong" (draw it anew). Best for ' +
      'colour, material and texture changes to a thing that keeps its outline. Not for things that must ' +
      'grow past the old outline.',
    )
  }
  lines.push(
    '- "whole": repaint the entire picture from a full description of the result, at a "strength". ' +
    'Rarely the best choice; use it only for a global restyle when "edit" is not available.',
    '',
    'Rules:',
    `- 1 to ${MAX_STEPS} steps. If one tool can do the whole request well in one step, use one step.`,
    '- Do "part" steps BEFORE "edit" steps when a plan has both, since an edit reconstructs pixels.',
    '- Only change what was asked for. Do not add improvements of your own.',
    '- Name things as they actually appear in THIS picture (say "the man\'s jacket" only if there is one).',
    '- Prompts are in English, short and concrete.',
    '',
    'Answer with ONLY this JSON, no prose:',
    '{"summary":"one sentence of what you will do","steps":[{"mode":"edit|part|whole","prompt":"...",' +
    '"region":"only for part","strength":"light|balanced|strong","why":"one short reason"}]}',
  )
  return lines.join('\n')
}

function unwrapJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = (fenced ? fenced[1]! : raw).trim()
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

async function askPlanner(image: Buffer, request: string, tools: PlanMode[], model: string): Promise<{ summary: string; steps: PlanStep[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PLAN_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model, stream: false, think: false, format: 'json',
        messages: [
          { role: 'system', content: plannerSystem(tools) },
          { role: 'user', content: `Change wanted: ${request}`, images: [image.toString('base64')] },
        ],
        options: { temperature: 0.3, num_predict: 900 },
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`the planning model answered ${res.status}: ${body.slice(0, 160)}`)
    }
    const json = await res.json() as { message?: { content?: string }; response?: string }
    const text = unwrapJson(json.message?.content ?? json.response ?? '')
    let parsed: { summary?: unknown; steps?: unknown }
    try { parsed = JSON.parse(text) as typeof parsed } catch { throw new Error('the planning model did not answer with a plan') }
    const raw = Array.isArray(parsed.steps) ? parsed.steps as Record<string, unknown>[] : []
    const steps: PlanStep[] = []
    for (const s of raw.slice(0, MAX_STEPS)) {
      const mode = String(s['mode'] ?? '').toLowerCase() as PlanMode
      const prompt = String(s['prompt'] ?? '').trim().slice(0, 600)
      if (!prompt) continue
      const region = String(s['region'] ?? '').trim().slice(0, 120)
      const strengthRaw = String(s['strength'] ?? '').toLowerCase()
      const strength = (['light', 'balanced', 'strong'] as const).find(x => x === strengthRaw)
      let use: PlanMode = tools.includes(mode) ? mode : tools[0]!
      // A "part" step with no region is a whole-picture repaint in disguise;
      // an editor does it better when there is one.
      if (use === 'part' && !region) use = tools.includes('edit') ? 'edit' : 'whole'
      steps.push({
        n: steps.length + 1, mode: use, prompt,
        ...(use === 'part' ? { region } : {}),
        ...(use !== 'edit' ? { strength: strength ?? (use === 'part' ? 'strong' : 'balanced') } : {}),
        why: String(s['why'] ?? '').trim().slice(0, 200),
        status: 'pending',
      })
    }
    if (steps.length === 0) throw new Error('the planning model returned no steps')
    return { summary: String(parsed.summary ?? '').trim().slice(0, 300), steps }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start a plan: look at the picture, write the steps, and — when `run` — go.
 * Returns at once with the plan in `planning`; the rest arrives over the
 * `image-plan` SSE event, the same way a render reports.
 */
export function createPlan(source: string, request: string, run: boolean): EditPlan {
  const entry = listImages().find(e => e.id === source)
  const id = crypto.randomBytes(16).toString('hex')
  const plan: EditPlan = {
    id, source, sourceUrl: entry ? `/api/image/file/${entry.file}` : '', request: request.trim().slice(0, 1000),
    status: 'planning', steps: [], summary: '', currentJobId: '', resultId: '', resultUrl: '',
    error: '', model: visionModel(), createdAt: Date.now(), tools: [],
  }
  plans.set(id, plan)
  prune()
  if (!entry) {
    plan.status = 'failed'; plan.error = 'that picture is not in the gallery'
    push(plan)
    return plan
  }
  if (!plan.request) {
    plan.status = 'failed'; plan.error = 'say what should change'
    push(plan)
    return plan
  }
  push(plan)
  void (async () => {
    try {
      const { tools, editor } = await availableTools()
      plan.tools = tools
      const bytes = fs.readFileSync(path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'images', entry.file))
      const { summary, steps } = await askPlanner(bytes, plan.request, tools, plan.model)
      plan.summary = summary
      plan.steps = steps
      plan.status = 'ready'
      console.log(`[image-plan] ${id} ${steps.length} step(s) for "${plan.request.slice(0, 60)}": ${steps.map(s => s.mode).join(' → ')}`)
      push(plan)
      if (run) await execute(plan, editor)
    } catch (err) {
      plan.status = 'failed'
      plan.error = err instanceof Error ? err.message : String(err)
      console.warn(`[image-plan] ${id} failed: ${plan.error}`)
      push(plan)
    }
  })()
  return plan
}

/** Run a plan that was shown first. */
export async function runPlan(id: string): Promise<EditPlan | undefined> {
  const plan = plans.get(id)
  if (!plan) return undefined
  if (plan.status !== 'ready') return plan
  const { editor } = await availableTools()
  void execute(plan, editor)
  return plan
}

export function cancelPlan(id: string): EditPlan | undefined {
  const plan = plans.get(id)
  if (!plan) return undefined
  if (plan.status === 'done' || plan.status === 'failed' || plan.status === 'cancelled') return plan
  plan.status = 'cancelled'
  // A queued step's job can be dropped; one on the GPU finishes — same rule as
  // cancelJob itself, and the picture it makes is a real gallery entry.
  const cur = plan.currentJobId ? getJob(plan.currentJobId) : undefined
  if (cur && cur.status === 'queued') cancelJob(cur.id)
  for (const s of plan.steps) if (s.status === 'pending') s.status = 'skipped'
  push(plan)
  return plan
}

function waitForJob(id: string): Promise<ImageJob> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const tick = () => {
      const job = getJob(id)
      if (!job) { reject(new Error('the render disappeared (server restarted?)')); return }
      if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') { resolve(job); return }
      if (Date.now() > deadline) { reject(new Error('the step took too long')); return }
      setTimeout(tick, 1000)
    }
    tick()
  })
}

async function execute(plan: EditPlan, editor: string): Promise<void> {
  if (plan.status !== 'ready') return
  plan.status = 'running'
  push(plan)
  let source = plan.source
  for (const step of plan.steps) {
    if ((plan.status as PlanStatus) === 'cancelled') return
    step.status = 'queued'
    const req = {
      prompt: step.prompt,
      source,
      improve: false,
      ...(step.mode === 'edit'
        ? { model: editor, denoise: 1 }
        : step.mode === 'part'
          ? { region: step.region ?? '', denoise: PART_STRENGTH[step.strength ?? 'strong'] }
          : { denoise: STRENGTH[step.strength ?? 'balanced'] }),
    }
    const job = startImage(req)
    step.jobId = job.id
    plan.currentJobId = job.id
    push(plan)
    if (job.status === 'failed') {
      step.status = 'failed'; step.error = job.error ?? 'could not start'
      plan.status = 'failed'; plan.error = `step ${step.n} could not start: ${step.error}`
      push(plan)
      return
    }
    step.status = 'running'
    push(plan)
    let done: ImageJob
    try {
      done = await waitForJob(job.id)
    } catch (err) {
      step.status = 'failed'; step.error = err instanceof Error ? err.message : String(err)
      plan.status = 'failed'; plan.error = `step ${step.n}: ${step.error}`
      push(plan)
      return
    }
    if ((plan.status as PlanStatus) === 'cancelled') { step.status = done.status === 'ready' ? 'done' : 'skipped'; push(plan); return }
    if (done.status !== 'ready') {
      step.status = 'failed'; step.error = done.error ?? (done.status === 'cancelled' ? 'cancelled' : 'failed')
      plan.status = 'failed'; plan.error = `step ${step.n} (${step.mode}) failed: ${step.error}`
      push(plan)
      return
    }
    // A finished job's picture keeps the job's id in the gallery.
    const stored = listImages().find(e => e.id === done.id)
    if (!stored) {
      step.status = 'failed'; step.error = 'the picture did not land in the gallery'
      plan.status = 'failed'; plan.error = `step ${step.n}: ${step.error}`
      push(plan)
      return
    }
    step.status = 'done'
    step.imageId = stored.id
    source = stored.id
    plan.resultId = stored.id
    plan.resultUrl = `/api/image/file/${stored.file}`
    push(plan)
  }
  plan.status = 'done'
  plan.currentJobId = ''
  console.log(`[image-plan] ${plan.id} done → ${plan.resultId}`)
  push(plan)
}
