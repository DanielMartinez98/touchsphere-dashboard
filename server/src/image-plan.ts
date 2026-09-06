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
  cancelJob, getJob, imageDifference, listImages, listModels, listWorkflowStyles, missingFiles, selectedModel, startImage,
  styleEdits, styleLabel, styleNeeds, stylePromptStyle, supersededCheckpoints,
  segmentationAvailable, inpaintAvailable,
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
const MAX_STEPS = 8
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
  /**
   * The DRAWING style a part/whole step renders with, chosen by the planner
   * to match the picture — an anime still gets an anime model, a photo a
   * photoreal one. Absent for an edit step, which is always the editor. This
   * matters more than it looks: with Kontext selected in the panel, a part
   * step that inherited the selection would have had its mask silently
   * dropped, because an editing style takes none.
   */
  style?:      string
  styleLabel?: string
  /** The planner's one-line reason — shown so a wrong plan can be argued with. */
  why:      string
  status:   'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  jobId?:   string
  /** The gallery id of this step's result, which is also the next step's source. */
  imageId?: string
  error?:   string
  /** Renders this step took; 2 when the first came back unchanged and was retried. */
  attempts?: number
  /** How much the step changed the picture, 0-1, when it could be measured. */
  change?:  number
}

/**
 * Below this PEAK difference (imageDifference: the mean of the top 2% of grid
 * cells, under the better of stretch / centre-crop alignment) an "edit" step
 * is judged to have done nothing. Measured on real renders: an untouched
 * Kontext output peaks at 1.7%, the smallest real edit so far (a recoloured
 * fringe, 1% of the picture) at 14%, a background swap at 31%.
 */
const NO_CHANGE = 0.05

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

/** A style a part/whole step can render with, and the register its prompt wants. */
export interface DrawStyle { id: string; label: string; register: 'tags' | 'prose' }

/**
 * Every installed style that DRAWS (not the editor): workflow styles whose
 * files are present, plus bare checkpoints not wrapped by one. The same list
 * the picker shows, minus the editor.
 */
export async function usableDrawStyles(): Promise<DrawStyle[]> {
  const workflows = listWorkflowStyles().filter(w => !styleEdits(w.id))
  const allNeeds = [...new Set(workflows.flatMap(w => styleNeeds(w.id)))]
  const absent = new Set(await missingFiles(allNeeds).catch(() => allNeeds))
  const wrapped = supersededCheckpoints()
  const checkpoints = await listModels().catch(() => [] as string[])
  return [
    ...workflows
      .filter(w => styleNeeds(w.id).every(n => !absent.has(n)))
      .map(w => ({ id: w.id, label: w.label, register: stylePromptStyle(w.id) })),
    ...checkpoints
      .filter(n => !wrapped.has(n))
      .map(n => ({ id: n, label: n, register: stylePromptStyle(n) })),
  ]
}

/**
 * The drawing style to fall back on when the selected one is the editor: the
 * selection itself when it draws, else the first installed drawing style.
 */
export async function pickDrawStyle(): Promise<string> {
  const sel = selectedModel()
  if (sel && !styleEdits(sel)) return sel
  const styles = await usableDrawStyles()
  return styles[0]?.id ?? ''
}

/** Which of the three tools this box can run right now, the editor's id, and the drawing styles. */
async function availableTools(): Promise<{ tools: PlanMode[]; editor: string; styles: DrawStyle[] }> {
  const tools: PlanMode[] = ['whole']
  const [seg, inpaint, styles] = await Promise.all([segmentationAvailable(), inpaintAvailable(), usableDrawStyles()])
  if (seg && inpaint) tools.unshift('part')
  let editor = ''
  const candidate = listWorkflowStyles().find(w => styleEdits(w.id))
  if (candidate) {
    const absent = await missingFiles(styleNeeds(candidate.id)).catch(() => ['?'])
    if (absent.length === 0) { editor = candidate.id; tools.unshift('edit') }
  }
  return { tools, editor, styles }
}

function plannerSystem(tools: PlanMode[], styles: DrawStyle[]): string {
  const lines: string[] = []
  lines.push(
    'You plan edits to a picture for an image pipeline. You are shown the picture and told what the ' +
    'user wants changed. Your job is the BEST RESULT, and that comes from small, precise steps: a ' +
    'tool asked for one thing does it well, a tool asked for three does one of them. So first list ' +
    'the atomic changes the request implies — even a single sentence usually implies several — then ' +
    'write one or more steps per change. Each step is done by ONE tool and works on the previous ' +
    'step\'s result.',
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
  )
  if (styles.length > 0 && (tools.includes('part') || tools.includes('whole'))) {
    lines.push(
      'Drawing styles for "part" and "whole" steps — set "style" to one id per such step, MATCHING THE ' +
      'PICTURE: an anime or illustrated picture gets an anime style, a photograph or realistic render a ' +
      'photoreal one. Write that step\'s prompt in the register the style wants:',
      ...styles.map(st =>
        `- ${st.id} — "${st.label}": ` + (st.register === 'tags'
          ? 'anime / illustration model; prompt as comma-separated booru tags describing what is IN the ' +
            'region ("pink jacket, open jacket, zipper, long sleeves, striped shirt underneath").'
          : 'photoreal / general model; prompt as a plain-English description of what is in the region.')),
      '',
    )
  }
  lines.push(
    'How to write "edit" prompts (these go to Kontext verbatim, so this decides the result):',
    '- Name the subject explicitly — "the woman with orange hair", never "her" or "it".',
    '- State the RESULT, concretely: "The woman with orange hair now wears an open pink zip-up jacket over ' +
    'her striped top, sleeves on both arms." Type, colour, material, how it is worn or placed.',
    '- Then ONE short clause naming only what is at risk: "Keep her pose and face unchanged." NEVER a list ' +
    'of everything to keep — an editor told to keep everything changes nothing, and the picture comes ' +
    'back untouched.',
    '- One instruction per step. Vague verbs ("put", "make it nice") produce vague results.',
    '- Kontext is weak at adding clothing to a drawn character in a foreshortened pose. On an anime or ' +
    'illustrated picture, prefer a "part" step with an anime style for garments: region = the area the ' +
    'garment will cover (e.g. "her striped top and shoulders"), prompt = the garment over what is there.',
    '',
    'How to decompose (this is the important part):',
    '- Something NEW that is not in the picture (a garment, an object, a sign, a background) is CREATED ' +
    'first with "edit" in its plainest form, and its exact colour / material / pattern is set in a ' +
    'SEPARATE step afterwards' + (tools.includes('part') ? ' with "part" on the thing just created' : ' with a second "edit"') + '.',
    '- Something that EXISTS and keeps its outline (recolour the jacket, change the sky) is one ' +
    (tools.includes('part') ? '"part"' : '"edit"') + ' step; if the request also changes its shape or style, that is another step.',
    '- Text on a sign or a label is always its own "edit" step, after the sign itself exists.',
    '- Background / setting, lighting / time of day, weather, and the subject\'s pose or expression are ' +
    'each their own step, never combined.',
    '- Removing something is its own "edit" step ("remove the hat"), before anything is added in its place.',
    '- When ADDING clothing to a character with "part", the region must cover where the garment will BE — ' +
    '"her upper body" or "her torso, shoulders and arms" — not only the old garment, or the sleeves have ' +
    'nowhere to be drawn. When only recolouring an existing garment, the region is the garment itself.',
    '',
    'Examples:',
    '- "give her a pink jacket" (she wears a blue coat) → 1 ' + (tools.includes('part') ? 'part, region "the blue coat", prompt "a pink jacket", strength strong' : 'edit "change the blue coat into a pink jacket"') +
    '; 2 edit "make the jacket a clean pastel pink, fabric texture" (a precision pass).',
    '- "give her a pink jacket" (an anime still, she wears a striped top, no jacket) → ' +
    (tools.includes('part')
      ? '1 part, region "her striped top and shoulders", style an anime one, prompt "pink jacket, open jacket, zipper, long sleeves, striped shirt underneath", strength strong.'
      : '1 edit "The woman now wears an open pink jacket over her striped top, sleeves on both arms. Keep her pose and face unchanged."') +
    '\n- "give him a pink jacket" (a photo, he wears a t-shirt) → 1 edit "The man now wears an open pink jacket over his t-shirt, sleeves on both arms. Keep his pose and face unchanged."; ' +
    '2 ' + (tools.includes('part') ? 'part, region "the jacket", prompt "a pastel pink cotton jacket", strength light' : 'edit "Make the jacket a clean pastel pink."') + '.',
    '- "put him in jail with a sign that says MATRIX above the cell" → 1 edit "change the background to a prison cell with bars, keep the man as he is"; ' +
    '2 edit "add a blank rectangular sign above the cell bars"; 3 edit "write MATRIX on the sign in bold capital letters".',
    '',
    'Rules:',
    `- Up to ${MAX_STEPS} steps. Never merge two changes into one step; "a red jacket and a hat" is two steps.`,
    '- A "part" step covers exactly one region. An "edit" step carries exactly one instruction.',
    '- A one-step plan is only right for a request that truly implies one atomic change.',
    '- Do "part" steps BEFORE "edit" steps when a plan has both, since an edit reconstructs pixels.',
    '- Only change what was asked for. Do not add improvements of your own.',
    '- Name things as they actually appear in THIS picture (say "the man\'s jacket" only if there is one).',
    '- Prompts are in English, short and concrete.',
    '',
    'Answer with ONLY this JSON, no prose. List the atomic changes FIRST, then the steps:',
    '{"changes":["one atomic change","another"],"summary":"one sentence of what you will do",' +
    '"steps":[{"mode":"edit|part|whole","prompt":"...","region":"only for part",' +
    '"strength":"light|balanced|strong","style":"a drawing style id, part/whole only","why":"one short reason"}]}',
  )
  return lines.join('\n')
}

function unwrapJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = (fenced ? fenced[1]! : raw).trim()
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

async function askPlanner(image: Buffer, request: string, tools: PlanMode[], styles: DrawStyle[], model: string, minSteps = 0): Promise<{ summary: string; steps: PlanStep[]; changes: string[] }> {
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
          { role: 'system', content: plannerSystem(tools, styles) },
          {
            role: 'user',
            content: `Change wanted: ${request}` + (minSteps > 1 ? `\n\n(Write AT LEAST ${minSteps} steps: split the work finer, one precise change per step.)` : ''),
            images: [image.toString('base64')],
          },
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
    let parsed: { summary?: unknown; steps?: unknown; changes?: unknown }
    try { parsed = JSON.parse(text) as typeof parsed } catch { throw new Error('the planning model did not answer with a plan') }
    const changes = Array.isArray(parsed.changes)
      ? (parsed.changes as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(c => c.trim().slice(0, 160))
      : []
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
      // The drawing style, validated against what is installed; a made-up id
      // falls through to the fallback in execute().
      const styleRaw = String(s['style'] ?? '').trim()
      const style = use !== 'edit' ? styles.find(x => x.id === styleRaw) : undefined
      steps.push({
        n: steps.length + 1, mode: use, prompt,
        ...(use === 'part' ? { region } : {}),
        ...(use !== 'edit' ? { strength: strength ?? (use === 'part' ? 'strong' : 'balanced') } : {}),
        ...(style ? { style: style.id, styleLabel: style.label } : {}),
        why: String(s['why'] ?? '').trim().slice(0, 200),
        status: 'pending',
      })
    }
    if (steps.length === 0) throw new Error('the planning model returned no steps')
    return { summary: String(parsed.summary ?? '').trim().slice(0, 300), steps, changes }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How many separate changes the request names, roughly — clauses split on
 * commas, "and", "then", semicolons. Only used to notice a plan that is
 * coarser than the request and ask once more; the model still decides.
 */
function clauseCount(request: string): number {
  return request
    .split(/,|;|\band\b|\bthen\b|\bplus\b|\balso\b|\n/i)
    .map(x => x.trim())
    .filter(x => x.length > 2).length
}

async function planWithRetry(image: Buffer, request: string, tools: PlanMode[], styles: DrawStyle[], model: string, minSteps = 0) {
  const first = await askPlanner(image, request, tools, styles, model, minSteps)
  // How many changes the request implies: the model's own list, the clause
  // count as a floor, and whatever the user asked for with "More steps".
  const wanted = Math.min(MAX_STEPS, Math.max(minSteps, first.changes.length, Math.min(clauseCount(request), 3)))
  if (first.steps.length >= wanted) return first
  // Fewer steps than changes: say so and ask again. The model that collapsed
  // them will usually split them when told the number.
  console.log(`[image-plan] ${first.steps.length} step(s) for ${wanted} changes (${first.changes.join(' / ') || 'unlisted'}) — asking for a finer plan`)
  const nudged =
    `${request}\n\n(The changes are: ${first.changes.join('; ') || 'as listed'}. Write ONE OR MORE STEPS PER CHANGE — ` +
    `at least ${wanted} steps — do not merge them.)`
  try {
    const second = await askPlanner(image, nudged, tools, styles, model, wanted)
    return second.steps.length > first.steps.length ? second : first
  } catch {
    return first
  }
}

/**
 * Start a plan: look at the picture, write the steps, and — when `run` — go.
 * Returns at once with the plan in `planning`; the rest arrives over the
 * `image-plan` SSE event, the same way a render reports.
 */
export function createPlan(source: string, request: string, run: boolean, minSteps = 0): EditPlan {
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
      const { tools, editor, styles } = await availableTools()
      plan.tools = tools
      const bytes = fs.readFileSync(path.join(process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache', 'images', entry.file))
      const { summary, steps } = await planWithRetry(bytes, plan.request, tools, styles, plan.model, Math.max(0, Math.min(MAX_STEPS, Math.round(minSteps))))
      // Every drawing step needs a drawing style. One the planner didn't pick
      // gets the fallback here, so execute() never inherits the panel's
      // selection — which may be the editor, which would drop the mask.
      const fallback = await pickDrawStyle()
      for (const st of steps) {
        if (st.mode !== 'edit' && !st.style && fallback) { st.style = fallback; st.styleLabel = styleLabel(fallback) }
      }
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

/**
 * The second try at an edit that did nothing: drop any "keep … the same"
 * tail, which is the usual reason, and say plainly that a visible change is
 * wanted.
 */
function pushHarder(prompt: string): string {
  const stripped = prompt
    .replace(/,?\s*(while\s+)?keep(ing)?\s+[^.]*?(the\s+same|unchanged)[^.]*\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `Make a clear, visible change: ${stripped || prompt}`
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
    // A part step's prompt is used verbatim (it describes what goes in the
    // region, in the style's own register). A whole step turns the improver
    // ON: img2img needs a description of the entire resulting picture, and
    // the vision composer writes exactly that from the picture plus the change.
    const req = {
      prompt: step.prompt,
      source,
      improve: step.mode === 'whole',
      ...(step.mode === 'edit'
        ? { model: editor, denoise: 1 }
        : step.mode === 'part'
          ? { model: step.style ?? '', region: step.region ?? '', denoise: PART_STRENGTH[step.strength ?? 'strong'] }
          : { model: step.style ?? '', denoise: STRENGTH[step.strength ?? 'balanced'] }),
    }
    let done: ImageJob | null = null
    step.attempts = 0
    // An edit step that comes back unchanged is retried ONCE with the
    // instruction pushed harder — the usual cause is a preservation clause
    // the editor read as "change nothing" — and fails the plan if it still
    // does nothing, rather than handing the untouched picture to the next
    // step, which then goes looking for a jacket that was never drawn.
    for (let attempt = 1; attempt <= 2; attempt++) {
      step.attempts = attempt
      const prompt = attempt === 1 ? step.prompt : pushHarder(step.prompt)
      const job = startImage({ ...req, prompt })
      step.jobId = job.id
      plan.currentJobId = job.id
      if (attempt === 2) step.prompt = prompt
      push(plan)
      if (job.status === 'failed') {
        step.status = 'failed'; step.error = job.error ?? 'could not start'
        plan.status = 'failed'; plan.error = `step ${step.n} could not start: ${step.error}`
        push(plan)
        return
      }
      step.status = 'running'
      push(plan)
      try {
        done = await waitForJob(job.id)
      } catch (err) {
        step.status = 'failed'; step.error = err instanceof Error ? err.message : String(err)
        plan.status = 'failed'; plan.error = `step ${step.n}: ${step.error}`
        push(plan)
        return
      }
      if (step.mode !== 'edit' || done.status !== 'ready') break
      const srcEntry = listImages().find(e => e.id === source)
      const outEntry = listImages().find(e => e.id === done!.id)
      const diff = srcEntry && outEntry ? imageDifference(srcEntry.file, outEntry.file) : null
      if (diff !== null) step.change = diff
      if (diff === null || diff >= NO_CHANGE) break
      console.log(`[image-plan] ${plan.id} step ${step.n} changed ${(diff * 100).toFixed(1)}% of the picture — ${attempt === 1 ? 'retrying harder' : 'giving up'}`)
      if (attempt === 2) {
        step.status = 'failed'
        step.error = 'the editor returned the picture unchanged twice — say the change differently, or use "Just a part"'
        plan.status = 'failed'; plan.error = `step ${step.n}: ${step.error}`
        push(plan)
        return
      }
    }
    if (!done) return
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
