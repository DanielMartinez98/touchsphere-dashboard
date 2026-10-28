// The prompt improver: one short model call that rewrites what the user typed
// into a prompt for the picture model that is actually going to draw it.
//
// WHY IT IS ITS OWN MODULE AND ITS OWN MODEL CALL
//
// It deliberately does not go through /api/chat, and it is not the assistant.
// Three properties fall out of that, and all three are the point:
//
//   • **Independent model.** `OLLAMA_IMAGE_MODEL` (or the model named in the
//     store) picks it, falling back to OLLAMA_MODEL only so a box that has
//     configured nothing still works. The chat model is chosen for latency
//     because somebody is standing at the kiosk mid-sentence; this call happens
//     inside a render that already takes a minute, so a slower and better model
//     costs nothing anyone can perceive. Same reasoning as OLLAMA_GUIDE_MODEL.
//   • **A brand new conversation every single time.** There is no history here,
//     no session, nothing module-level that survives a call: `improvePrompt()`
//     builds two messages from scratch and throws them away. That is not an
//     oversight to be optimised later — it is the contract. Rewriting "a cat in
//     a hat" must not be coloured by the fact that the last picture was a
//     cyberpunk street, and session.ts's continue/maybe/new scoring has no
//     business anywhere near it.
//   • **No tools.** It has one job: emit a line of text.
//
// WHY THE TEMPLATE IS THE USER'S
//
// The house default below is a starting point, not a policy. Prompting styles
// are a matter of taste and they move faster than this app does, so the whole
// system prompt is editable in Settings → Drawing and stored on the volume.
// What the user does NOT have to write, and cannot get wrong, is the
// model-specific half: `{{style}}` and `{{guidance}}` are substituted from the
// selected style's own published best practice, so the same template does the
// right thing whether the render is going to a booru-tag model or to FLUX's
// T5-XXL.
//
// Those two strings are passed IN rather than read from image.ts, and that is
// deliberate: image.ts calls this module, so importing back out of it would
// make a require cycle of exactly the kind /api/image/check was moved into the
// image router to avoid. This module knows how to talk to a model; it does not
// need to know what a style is.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { ollamaUrlFor, ollamaUrlSettled } from './ai-devices'

// Where the PICTURE-side models live — the improver, the vision composer, the
// region box finder and (in image-plan.ts) the edit planner. Separate from the
// chat's OLLAMA_URL because the two want different places: the conversation
// wants the cloud model's quality and nobody minds where a prompt rewrite
// runs, while every one of these calls sits inside a render that is already
// spending the GPU box's time — and the cloud's per-session usage limit is
// far better spent on talking than on rewriting "a cat in a hat". Defaults to
// OLLAMA_URL so a setup with one Ollama is unchanged.
//   OLLAMA_IMAGE_URL=http://<gpu-box>:11434
// Resolved per call by ollamaUrlFor('image') (ai-devices.ts): the language-model
// device picked in Settings, else this env var through the AI box.
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']   ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''

/** Where the picture-side model calls go — for the startup log and Settings. */
// Re-pointed per call when that host is one of AI_BOXES (Settings → AI box).
export function imageModelUrl(): string { return ollamaUrlFor('image') }

/** The model that rewrites prompts. See the header for why it is not the chat one. */
const ENV_MODEL = process.env['OLLAMA_IMAGE_MODEL'] ?? ''
/**
 * The model that LOOKS at a picture before a redraw — see composeRedrawPrompt.
 * Falls back to the improver's model and then the chat model, because on the
 * box this was written for the chat model (gemma4) can see, and a separate
 * setting nobody fills in would silently switch the feature off.
 */
const ENV_VISION_MODEL = process.env['OLLAMA_VISION_MODEL'] ?? ''

// Shorter than the guide generator's three minutes and longer than the chat
// route's: a render is already tens of seconds, so a few more for a better
// prompt is a good trade — but a hung improver must not hold a queued job open
// indefinitely, because the picture behind it is what the user actually wanted.
const TIMEOUT_MS = Number(process.env['OLLAMA_IMAGE_TIMEOUT_MS'] ?? 45_000)

// The improver reasons before it answers (see ANSWER_FORMAT). Told to think
// fast it keeps TIMEOUT_MS; told to take as long as it takes it gets this,
// which is not a budget but the line past which a model is assumed hung —
// a queued picture is still waiting behind it.
const THINK_LONG_TIMEOUT_MS = Number(process.env['OLLAMA_IMAGE_THINK_TIMEOUT_MS'] ?? 15 * 60_000)

/** Longer than this and the "prompt" is an essay the sampler will truncate anyway. */
const MAX_PROMPT_CHARS = 1200

export const DEFAULT_TEMPLATE = `You rewrite a short image request into a prompt for one specific image model.

The model is {{style}}.
How this model asks to be prompted:
{{guidance}}

Rules:
- Keep the user's subject, their named characters and their intent exactly. Never swap the subject for something else, and never drop a detail they bothered to type.
- Add only what a good prompt for THIS model needs: composition, lighting, setting, mood, level of detail.
- Do not invent extra people, and do not ask for text, captions, watermarks or signatures.
- Reply with the prompt itself and nothing else — no quotes, no preamble, no explanation, no markdown.`

/**
 * The system prompt for composeRedrawPrompt(): what the vision model is told
 * before it is shown the picture and the change. Editable in Settings for the
 * same reason the improver's template is — it is prompting taste, and the user
 * standing at the kiosk can read the description it produced (the picture's
 * details panel keeps both) and will have opinions about it. The same two
 * placeholders are filled from the selected style, and the user message it is
 * paired with is fixed: "Change wanted: <what they typed>" beside the image.
 */
export const DEFAULT_VISION_TEMPLATE = `You write prompts for an image model that REPAINTS an existing picture. You are shown the picture, and the user says what they want changed about it.

The image model is {{style}}.
How this model asks to be prompted:
{{guidance}}

Rules:
- Describe the WHOLE picture as it should look AFTER the change: the subject, its appearance, pose, clothing, the setting, the lighting and the art style. The model does not see the original — your description is all it gets, so anything you leave out is lost.
- Keep everything the user did not ask to change exactly as it is in the picture. Apply their change fully and literally.
- If the user typed a complete description rather than a change, use it as the description and only add what you can see that it leaves out.
- Do not invent extra people, and do not ask for text, captions, watermarks or signatures.
- Reply with the prompt itself and nothing else — no quotes, no preamble, no explanation, no markdown.`

/**
 * The system prompt for the instruction rewriter — the one model call in the
 * FLUX Kontext path. Kontext itself is a diffusion model and reads no LLM
 * output; this runs only when an edit came back having changed almost
 * nothing, to say the same change the way an editor can act on it.
 *
 * Editable for the same reason the other two are: it decides what the editor
 * is asked, the result is visible on every retried picture, and prompting
 * taste moves faster than this app does. `{{style}}` and `{{guidance}}` are
 * filled in from the selected style, so the model's own published guide can
 * be pulled in by anyone who wants it.
 */
export const DEFAULT_EDIT_TEMPLATE = `You write instructions for an image EDITING model ({{style}}). You are shown a picture and what the user wants changed in it. The editor is literal, so write the change the way it needs it:
- Name the subject as it actually appears in the picture ("the woman with dark hair in the striped top", "the red car on the left"), never "her", "it" or "the character".
- Say the change concretely: what it becomes, its colour, material, position. "Replace her striped top with a blue bikini top" rather than "put a bikini on her".
- To add something, say where it goes and how it is worn or placed. To remove something, say what fills the space.
- Then ONE short clause naming only what is at risk ("Keep her face and pose."). Never a list of everything to keep — that reads as "change nothing".
- Two sentences at most. Plain English. No quality words, no style words unless the user asked for a style. Answer with the instruction only.`

/** The fixed user turn that rides beside the picture, so the whole conversation can be judged. */
export function editUserMessage(request: string): string {
  return `The user wants: ${request}\nThe previous attempt with those exact words changed nothing in the picture. Write the instruction that will.`
}

export interface PrompterSettings {
  /** Whether the Draw panel's toggle starts on. The panel can still override per render. */
  enabled:  boolean
  /** The system prompt. `{{style}}` and `{{guidance}}` are substituted per render. */
  template: string
  /** Overrides OLLAMA_IMAGE_MODEL. '' means "whatever the environment says". */
  model:    string
  /**
   * The system prompt for the redraw's look-at-the-picture step. Same
   * placeholders, same "cleared means reset" rule as `template`.
   */
  visionTemplate: string
  /** The system prompt for the instruction rewriter. Same rules again. */
  editTemplate:   string
  /** Overrides the vision model for the instruction rewriter alone. '' follows it. */
  editModel:      string
  /**
   * Draw an edit again, with the instruction rewritten, when it changed less
   * than this fraction of the picture (the peak-cell measure, see
   * imageChange()). 0 means never: the measured change is shown and nothing
   * is judged. It shipped at 0.05 and was turned off on request — a tiny real
   * edit (an eye colour, a small logo) sits under any floor, and a redraw that
   * the user did not ask for costs a minute of GPU.
   */
  retryBelow:     number
  /**
   * Let the improver reword the request: skip the check that every name and
   * noun the user typed survives the rewrite. Off by default, because that
   * check is what stops "launch from dragon ball" becoming "goku".
   */
  rewordFreely:   boolean
  /**
   * How long the improver may think before it writes the prompt: true = as
   * long as it takes (no length cap, a hung-model deadline only), false =
   * a few quick notes within the usual time limit. Appended after the
   * answer format, never written into the user's instructions.
   */
  thinkLong:      boolean
  /**
   * More ways to ask, beside the original `template`. Each is a named copy of
   * the instructions that can be changed without touching the original, so two
   * approaches can be tried side by side on the same request. Created, renamed,
   * edited and deleted in Settings → Drawing; CHOSEN in the Draw panel, because
   * which way of asking suits a picture is decided while composing it.
   */
  options:        PromptOption[]
  /** Which one rewrites prompts: ORIGINAL_OPTION, or an option's id. */
  active:         string
}

/** One extra way of asking the improver. Same placeholders and rules as `template`. */
export interface PromptOption {
  /** Stable, never shown: `opt-` and six hex. The name can change; the id cannot. */
  id:       string
  /** What the Draw panel's chip says. "Option B" until renamed. */
  name:     string
  /** The system prompt. Cleared means the house default, exactly as for the original. */
  template: string
}

/** The id that means "the original instructions" — `template` itself. */
export const ORIGINAL_OPTION = 'original'
/** What the original is called beside the options. */
export const ORIGINAL_NAME = 'Original'
/** Original plus eight: A to I. More is a list nobody can compare on a 7" screen. */
export const MAX_PROMPT_OPTIONS = 8
const OPTION_ID = /^opt-[a-f0-9]{6}$/
const MAX_NAME = 40

const DEFAULTS: PrompterSettings = {
  enabled:  false,
  template: DEFAULT_TEMPLATE,
  model:    '',
  visionTemplate: DEFAULT_VISION_TEMPLATE,
  editTemplate:   DEFAULT_EDIT_TEMPLATE,
  editModel:      '',
  retryBelow:     0,
  rewordFreely:   false,
  thinkLong:      true,
  options:        [],
  active:         ORIGINAL_OPTION,
}

function storePath(): string {
  const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* already there */ }
  return path.join(dir, 'image-prompter.json')
}

/**
 * Read per request rather than cached, the same shape and reason as the style
 * and quality stores: editing the template in Settings has to affect the NEXT
 * picture, not the next restart.
 */
export function readPrompter(): PrompterSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<PrompterSettings>
    return {
      enabled:  raw.enabled === true,
      // An empty template would silently disable the model-specific half, so it
      // falls back rather than being honoured — "cleared" means "reset" here.
      template: typeof raw.template === 'string' && raw.template.trim()
        ? raw.template.slice(0, 8000)
        : DEFAULTS.template,
      model:    typeof raw.model === 'string' ? raw.model.trim().slice(0, 120) : '',
      visionTemplate: typeof raw.visionTemplate === 'string' && raw.visionTemplate.trim()
        ? raw.visionTemplate.slice(0, 8000)
        : DEFAULTS.visionTemplate,
      editTemplate: typeof raw.editTemplate === 'string' && raw.editTemplate.trim()
        ? raw.editTemplate.slice(0, 8000)
        : DEFAULTS.editTemplate,
      editModel: typeof raw.editModel === 'string' ? raw.editModel.trim().slice(0, 120) : '',
      retryBelow: typeof raw.retryBelow === 'number' && Number.isFinite(raw.retryBelow)
        ? Math.min(0.5, Math.max(0, raw.retryBelow)) : 0,
      rewordFreely: raw.rewordFreely === true,
      thinkLong: raw.thinkLong !== false,
      ...readOptions(raw.options, raw.active),
    }
  } catch {
    return { ...DEFAULTS, options: [] }
  }
}

/**
 * The options as stored, re-validated on every read: a hand-edited file or an
 * older build's must never put a nameless option, a duplicate id or an active
 * choice that no longer exists in front of the Draw panel.
 */
function readOptions(rawOptions: unknown, rawActive: unknown): { options: PromptOption[]; active: string } {
  const options: PromptOption[] = []
  const seen = new Set<string>()
  for (const o of Array.isArray(rawOptions) ? rawOptions : []) {
    if (!o || typeof o !== 'object') continue
    const { id, name, template } = o as Partial<PromptOption>
    if (typeof id !== 'string' || !OPTION_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    options.push({
      id,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : `Option ${optionLetter(options.length + 1)}`,
      template: typeof template === 'string' && template.trim() ? template.slice(0, 8000) : DEFAULT_TEMPLATE,
    })
    if (options.length >= MAX_PROMPT_OPTIONS) break
  }
  const active = typeof rawActive === 'string' && options.some(o => o.id === rawActive) ? rawActive : ORIGINAL_OPTION
  return { options, active }
}

/** A, B, C… by position, the original being A. */
function optionLetter(position: number): string {
  return String.fromCharCode(65 + Math.max(0, Math.min(25, position)))
}

/** Patch one or more fields. Write-then-rename, the memory.ts pattern. */
export function writePrompter(patch: Partial<PrompterSettings>): PrompterSettings {
  const next: PrompterSettings = { ...readPrompter() }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (typeof patch.template === 'string') {
    next.template = patch.template.trim() ? patch.template.slice(0, 8000) : DEFAULTS.template
  }
  if (typeof patch.model === 'string') next.model = patch.model.trim().slice(0, 120)
  if (typeof patch.visionTemplate === 'string') {
    next.visionTemplate = patch.visionTemplate.trim() ? patch.visionTemplate.slice(0, 8000) : DEFAULTS.visionTemplate
  }
  if (typeof patch.editTemplate === 'string') {
    next.editTemplate = patch.editTemplate.trim() ? patch.editTemplate.slice(0, 8000) : DEFAULTS.editTemplate
  }
  if (typeof patch.editModel === 'string') next.editModel = patch.editModel.trim().slice(0, 120)
  if (typeof patch.retryBelow === 'number' && Number.isFinite(patch.retryBelow)) {
    next.retryBelow = Math.min(0.5, Math.max(0, patch.retryBelow))
  }
  if (typeof patch.rewordFreely === 'boolean') next.rewordFreely = patch.rewordFreely
  if (typeof patch.thinkLong === 'boolean') next.thinkLong = patch.thinkLong
  // `options` and `active` are not patched here: each has its own function
  // below with its own rules, and a stray field in a settings patch must not
  // be able to replace the whole list.
  try { return save(next) } catch { return next }   // logged in save(); as before, never a 500
}

function save(next: PrompterSettings): PrompterSettings {
  const p = storePath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image-prompt] failed to write settings:', err)
    throw new Error('could not save the prompt improver settings')
  }
  return next
}

// ── Options: more ways to ask, beside the original ───────────────────────────

/**
 * Add an option. It starts as a COPY of the original's current instructions,
 * because the usual reason to make one is "the same, but…" — and the original
 * itself is never touched by anything an option does.
 */
export function addPromptOption(name?: string): PromptOption {
  const current = readPrompter()
  if (current.options.length >= MAX_PROMPT_OPTIONS) {
    throw new Error(`There can be at most ${MAX_PROMPT_OPTIONS} options besides the original.`)
  }
  const taken = new Set(current.options.map(o => o.name.toLowerCase()))
  // "Option B" for the first, then the next letter nobody is using, so deleting
  // B and adding again gives B back rather than skipping to E.
  let letter = 1
  while (taken.has(`option ${optionLetter(letter).toLowerCase()}`) && letter < 25) letter++
  const option: PromptOption = {
    id: `opt-${crypto.randomBytes(3).toString('hex')}`,
    name: name && name.trim() ? checkName(name, current.options) : `Option ${optionLetter(letter)}`,
    template: current.template,
  }
  save({ ...current, options: [...current.options, option] })
  return option
}

/** A name the Draw panel can show as its own chip: not empty, not the original's, not another option's. */
function checkName(name: string, options: PromptOption[], self?: string): string {
  const n = name.trim().slice(0, MAX_NAME)
  if (!n) throw new Error('An option needs a name — it is what the Draw panel shows.')
  if (n.toLowerCase() === ORIGINAL_NAME.toLowerCase()) throw new Error(`"${ORIGINAL_NAME}" is the name of the original.`)
  if (options.some(o => o.id !== self && o.name.toLowerCase() === n.toLowerCase())) {
    throw new Error(`There is already an option called "${n}".`)
  }
  return n
}

/** Rename an option or change its instructions. Cleared instructions mean the house default. */
export function updatePromptOption(id: string, patch: { name?: unknown; template?: unknown }): PromptOption {
  const current = readPrompter()
  const at = current.options.findIndex(o => o.id === id)
  if (at < 0) throw new Error('That option no longer exists.')
  const option = { ...current.options[at]! }
  if (typeof patch.name === 'string') option.name = checkName(patch.name, current.options, id)
  if (typeof patch.template === 'string') {
    option.template = patch.template.trim() ? patch.template.slice(0, 8000) : DEFAULT_TEMPLATE
  }
  const options = [...current.options]
  options[at] = option
  save({ ...current, options })
  return option
}

/** Delete an option. If it was the one in use, the original takes over. */
export function removePromptOption(id: string): boolean {
  const current = readPrompter()
  if (!current.options.some(o => o.id === id)) return false
  save({
    ...current,
    options: current.options.filter(o => o.id !== id),
    active: current.active === id ? ORIGINAL_OPTION : current.active,
  })
  return true
}

/** Choose which way of asking rewrites prompts from now on. */
export function setActivePrompt(id: string): string {
  const current = readPrompter()
  if (id !== ORIGINAL_OPTION && !current.options.some(o => o.id === id)) {
    throw new Error('That option no longer exists.')
  }
  save({ ...current, active: id })
  return id
}

/**
 * The option a render will be rewritten with: the one asked for, or with none
 * asked for, the one chosen in the Draw panel. One that no longer exists falls
 * back to the original. Never fails, because the improver never fails a render:
 * a deleted option costs the picture its chosen instructions, not the picture.
 */
export function resolvePromptOption(id?: string): { id: string; name: string; template: string } {
  const s = readPrompter()
  const original = { id: ORIGINAL_OPTION, name: ORIGINAL_NAME, template: s.template }
  // Asked for by the picture (including an explicit "original"), else chosen in the panel.
  const want = id ? id : s.active
  if (want === ORIGINAL_OPTION) return original
  const o = s.options.find(x => x.id === want)
  return o ? { id: o.id, name: o.name, template: o.template } : original
}

/** Which model will do the rewriting, by precedence. */
export function prompterModel(): string {
  return readPrompter().model || ENV_MODEL || OLLAMA_MODEL
}

/** What a style is called and how it wants to be prompted. Supplied by image.ts. */
export interface StyleFacts {
  /** Human label, e.g. "FLUX.1 dev". */
  label:    string
  /** That model's published prompting guidance. */
  guidance: string
  /**
   * The improver's best practices for this model (styleImproverGuide() in
   * image.ts): appended after the chosen way of asking, never written into it.
   */
  bestPractices?: string
  /**
   * The longest rewrite accepted, in characters. MAX_PROMPT_CHARS when absent;
   * Infinity for Anima, whose encoder reads a prompt of any length (see
   * promptLimit() in image.ts) — the improver and the redraw composer then
   * keep a long answer instead of refusing it, and the model may write as
   * much as it wants.
   */
  maxChars?: number
}

/**
 * Fill the template for one render.
 *
 * Exported so the settings screen can show the user exactly what their template
 * turns into for the style they are on — a template with a placeholder in it is
 * hard to judge in the abstract, and this is the cheapest possible preview.
 */
export function buildSystemPrompt(template: string, style: StyleFacts): string {
  return template
    .replace(/\{\{\s*style\s*\}\}/gi, style.label || 'an image model')
    .replace(/\{\{\s*guidance\s*\}\}/gi, style.guidance)
}

/**
 * How the improver must hand its answer back — appended by the app AFTER the
 * user's chosen instructions, never part of them, so whichever way of asking
 * is picked in the Draw panel stays exactly as written.
 *
 * It exists because a one-shot "reply with the prompt and nothing else" makes
 * the model compose the picture in the same breath as writing it, and the
 * first thing to suffer is anything with more than one moving part: a fight
 * came back as two characters standing near each other, because nobody had
 * decided who swings, who is hit and in which instant. So the model is told to
 * work that out first, in the open, and then to put only the finished prompt
 * between tags the server can find. The notes never reach the image model;
 * they are kept on the picture so "why did it write that" has an answer.
 */
export const ANSWER_FORMAT = `

HOW TO ANSWER (this replaces any earlier instruction about replying with the prompt alone):
1. First think it through as plain notes, as long as you need. Decide everything the picture must show: who and what is in it, where each is in the frame, and what each is doing at this exact instant. For a fight or any action: who attacks and who defends, the single frozen moment shown (wind-up, impact, dodge, aftermath), each body's pose and facing, what hits what and where, and the motion and effects around it (speed lines, debris, sparks, dust). Check that every word of the request is accounted for.
2. Then write the finished prompt for the image model between <prompt> and </prompt>, following the instructions above. Only the text between those tags is sent to the image model and everything else is thrown away, so the prompt must stand on its own and must not mention your notes.`

/** The last line, from Settings → Drawing → "Take as long as it takes". */
export function thinkingLine(long: boolean): string {
  return long
    ? '\n3. Take as long as it takes. There is no limit on your notes: work through every part of the picture until nothing is left undecided, then write the prompt.'
    : '\n3. Think fast: a few short notes on the essentials only, then the prompt.'
}

/**
 * The model's best practices, appended after the chosen way of asking.
 *
 * A step of its own rather than the {{guidance}} placeholder, because a way of
 * asking the user wrote need not contain that placeholder at all — and then the
 * improver was writing for a model it had been told nothing about. Every way of
 * asking now ends on the same per-model page, which leads with what matters
 * most here: a named character must come out looking like their series.
 */
export function bestPracticesBlock(style: StyleFacts): string {
  const text = style.bestPractices?.trim()
  if (!text) return ''
  return `\n\nBEST PRACTICES FOR ${style.label || 'THIS MODEL'} (added by the app for this model; ` +
    `they take priority over anything above that disagrees with them):\n${text}`
}

/** The improver's whole system prompt: the chosen instructions, the model's best practices, the answer format, how long to think. */
export function improverSystemPrompt(template: string, style: StyleFacts, long = readPrompter().thinkLong): string {
  const built = buildSystemPrompt(template, style)
  // A way of asking that already carries the same page through {{guidance}}
  // (Anima's two are one text) does not need it twice.
  const page = style.bestPractices?.trim()
  const block = page && built.includes(page) ? '' : bestPracticesBlock(style)
  return built + block + ANSWER_FORMAT + thinkingLine(long)
}

/**
 * Split an improver answer into its notes and its prompt. The LAST <prompt>
 * block wins, since a model thinking aloud sometimes drafts one in its notes;
 * an unclosed tag (the answer ran out) takes everything after it. No tag at
 * all is a model that ignored the format: the whole answer is treated as the
 * prompt, which is how this behaved before, and the length check after it
 * catches one that was really an essay.
 */
export function splitAnswer(raw: string): { prompt: string; notes: string } {
  const text = raw.trim()
  const open = text.toLowerCase().lastIndexOf('<prompt>')
  if (open < 0) return { prompt: unwrap(text), notes: '' }
  const close = text.toLowerCase().indexOf('</prompt>', open)
  const body = text.slice(open + '<prompt>'.length, close < 0 ? undefined : close)
  return { prompt: unwrap(body), notes: text.slice(0, open).trim().slice(0, 8000) }
}

/**
 * Strip the wrapping a chat model puts around a one-line answer.
 *
 * Asked for "the prompt and nothing else", a local model still routinely
 * returns it fenced, quoted, or behind "Here's the improved prompt:". Left in,
 * every one of those becomes tokens the text encoder spends on nothing.
 */
function unwrap(raw: string): string {
  let text = raw.trim()
  // A fenced block, with or without a language tag.
  const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) text = fenced[1].trim()
  // A leading "Here is the improved prompt:" style preamble, but only when it
  // is on its own line — a colon inside a real prompt is legitimate.
  text = text.replace(/^[^\n:]{0,60}:\s*\n+/, '').trim()
  // Surrounding quotes, straight or curly.
  const quoted = text.match(/^["'“‘]([\s\S]+)["'”’]$/)
  if (quoted?.[1]) text = quoted[1].trim()
  // Models fond of markdown sometimes bold the whole thing.
  text = text.replace(/^\*\*([\s\S]+)\*\*$/, '$1').trim()
  return text
}

/**
 * A failed call, said the way a person needs it. An abort is our own deadline
 * firing, and "This operation was aborted" read as a crash; the model is loaded
 * fresh for every picture (keep_alive 0), so a slow first answer is usually
 * the load, not the model being gone. Undici hides the real cause of
 * "fetch failed" (refused, unknown host, timeout) one level down.
 */
export function describeCallError(err: unknown, who: string, url: string, timeoutMs = TIMEOUT_MS): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'AbortError' || /aborted/i.test(e?.message ?? '')) {
    return `${who} took longer than ${Math.round(timeoutMs / 1000)}s to answer (it is loaded fresh for each picture, so it may still have been loading)`
  }
  const cause = e?.cause?.code || e?.cause?.message || ''
  let host = url
  try { host = new URL(url).host } catch { /* keep as is */ }
  return `${who} could not be reached at ${host}${cause ? ` (${cause})` : e?.message ? ` (${String(e.message).slice(0, 80)})` : ''}`
}

/**
 * A model that declined, rather than one that broke. Told apart so the
 * picture says "refused" plainly instead of reading as a fault to fix.
 */
export function looksLikeRefusal(text: string): boolean {
  return /^(i'?m sorry|sorry,|i can(?:no|')t|i cannot|i won'?t|i am unable|i'?m unable|as an ai)\b/i.test(text.trim())
}

export interface Improvement {
  /** The prompt to actually render. Always non-empty. */
  prompt:   string
  /** What the user typed, kept so the picture can show both. */
  original: string
  /** True when the rewrite was used; false when it fell back to the original. */
  changed:  boolean
  /** Which model answered — recorded against the picture. */
  model:    string
  /** How long it took, so it can be subtracted from the render's timing sample. */
  ms:       number
  /** Why it fell back, for the job's detail line. '' when it worked. */
  why:      string
  /** Which way of asking the improver used — "Original" or an option's name. Only the improver has options. */
  option?:  string
  /** What the improver worked out before writing the prompt. '' when it wrote none. */
  notes?:   string
}

/**
 * Rewrite one prompt. Never throws and never returns nothing.
 *
 * Every failure path falls back to the prompt the user typed, because the
 * alternative — failing the render over an optional nicety — would make the
 * toggle actively dangerous to leave on. A dead Ollama box should cost you a
 * better prompt, not your picture.
 */
export async function improvePrompt(prompt: string, style: StyleFacts, optionId?: string): Promise<Improvement> {
  const started = Date.now()
  const settings = readPrompter()
  const model = settings.model || ENV_MODEL || OLLAMA_MODEL
  // Which way of asking: the option this picture was queued with, resolved
  // again here so an option deleted while the picture waited falls back to the
  // original instead of failing the render.
  const option = resolvePromptOption(optionId)
  let notes = ''
  const give = (changed: boolean, text: string, why: string): Improvement => ({
    prompt: text, original: prompt, changed, model, ms: Date.now() - started, why, option: option.name, notes,
  })
  const maxChars = style.maxChars ?? MAX_PROMPT_CHARS

  const ctrl = new AbortController()
  const timeoutMs = settings.thinkLong ? THINK_LONG_TIMEOUT_MS : TIMEOUT_MS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let url = imageModelUrl()
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    const ask = async (extra: string, temperature: number): Promise<{ prompt: string; notes: string }> => {
      url = (await ollamaUrlSettled('image')).replace(/\/$/, '')
      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          stream: false,
          // think:false for the same reason as the chat and guide routes — a
          // reasoning model puts its answer in `thinking` and leaves `content`
          // empty, which would read here as "the improver returned nothing".
          think: false,
          // TWO MESSAGES, BUILT HERE, EVERY TIME. No history is threaded in and
          // none is kept: see the header. This is the whole of the conversation.
          messages: [
            { role: 'system', content: improverSystemPrompt(option.template, style, settings.thinkLong) + extra },
            { role: 'user',   content: prompt },
          ],
          // Warmer than the guide generator's 0.3: this is a creative rewrite
          // rather than structured extraction, and a cold model returns the input
          // almost verbatim, which makes the whole feature look broken.
          // num_ctx for the same reason as chat.ts: Ollama's 4096 default
          // truncates from the front, and the front is the instructions.
          // Unloaded the moment it answers: this model shares the card with ComfyUI,
        // and a render that starts while 5 GB of language model is still resident
        // runs in paged mode — a 53 s edit took 6 minutes that way.
        keep_alive: 0,
        // Room for the notes as well as the prompt. Thinking fast, 1000 tokens
        // is a few notes and a full prompt; taking as long as it takes, and on
        // a style with no length limit (Anima), there is no cap — the deadline
        // above still ends a model that never stops. num_ctx is raised with it
        // so a long think is not truncated from the front, where the rules are.
        options: {
          num_ctx: settings.thinkLong ? 16384 : 8192, temperature,
          num_predict: settings.thinkLong || !Number.isFinite(maxChars) ? -1 : 1000,
        },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[image-prompt] ollama ${res.status}: ${body.slice(0, 200)}`)
        throw new Error(`${model} answered HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`)
      }
      const json = (await res.json()) as { message?: { content?: string }; response?: string }
      return splitAnswer(json.message?.content ?? json.response ?? '')
    }
    let text: string
    try {
      const first = await ask('', 0.7)
      text = first.prompt
      notes = first.notes
    } catch (err) {
      const httpErr = err instanceof Error && err.message.startsWith(`${model} answered HTTP`)
      return give(false, prompt, httpErr ? (err as Error).message : describeCallError(err, model, url, timeoutMs))
    }
    if (!text) return give(false, prompt, `${model} returned an empty answer`)
    if (looksLikeRefusal(text)) return give(false, prompt, `${model} refused to rewrite this prompt`)
    // A rewrite that came back enormous is a model that started explaining
    // itself. The sampler would spend its whole context on the explanation.
    // Not checked for Anima (maxChars is Infinity), whose encoder reads it all.
    if (text.length > maxChars) {
      return give(false, prompt, `the rewrite came back ${text.length} characters long`)
    }
    // A model that refuses, or answers the question instead of rewriting it,
    // usually comes back SHORTER than the request. Keeping the user's own words
    // is strictly better than rendering an apology.
    if (text.length < Math.min(12, prompt.length)) {
      return give(false, prompt, 'the rewrite came back too short to be a prompt')
    }
    // THE USER'S SUBJECT SURVIVES OR THE REWRITE IS THROWN AWAY. Asked for
    // "launch from dragon ball", the local model wrote "goku, dragon ball": it
    // did not know the character and substituted the one it did. A rewrite is
    // only ever allowed to add; every significant word the user typed must
    // still be there.
    // A booru-style rewrite that came back as one run of words with no commas
    // is the model ignoring the format ("[count] lunch (dragon ball) dragon
    // ball @toriyama world setting …"); the encoder cannot tell where one
    // tag ends, so the user's own words are safer.
    if (!text.includes(',') && text.split(/\s+/).length > 8 && /\btags?\b/i.test(style.guidance)) {
      return give(false, prompt, 'the rewrite came back as one run of words with no commas, so your own words were kept')
    }
    let lost = settings.rewordFreely ? [] : missingWords(prompt, text)
    if (lost.length > 0) {
      // One more go, colder and told what went wrong. On an 8B model the
      // first answer misspells a surname ("hiyuga") often enough that always
      // falling back would throw away the tag form that draws the character.
      try {
        const again = await ask(
          `\n\nYOUR PREVIOUS ANSWER DROPPED THE WORD(S) "${lost.join('", "')}" FROM THE REQUEST. Every ` +
          `word of the request must appear in the prompt, spelled exactly as the user spelled it or as ` +
          `Danbooru spells that name. Put the corrected prompt between <prompt> and </prompt>.`,
          0.3,
        )
        if (again.prompt && again.prompt.length <= maxChars && missingWords(prompt, again.prompt).length === 0) {
          text = again.prompt
          if (again.notes) notes = again.notes
          lost = []
        }
      } catch { /* the fallback below */ }
    }
    if (lost.length > 0) {
      return give(false, prompt, `the rewrite dropped "${lost.join('", "')}" from your request twice, so your own words were kept`)
    }
    // And it may not invent what the user did not say: a hair or eye colour
    // ("red hair" for a black-haired character), or an artist tag — the
    // dashboard adds the series' creator from a table, and a made-up @ tag
    // would block the right one.
    const cleaned = stripInvented(prompt, text)
    return give(cleaned !== prompt, cleaned, '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[image-prompt] error:', msg)
    return give(false, prompt, describeCallError(err, model, url, timeoutMs))
  } finally {
    clearTimeout(timer)
  }
}

const KEEP_STOPWORDS = new Set([
  'from', 'with', 'and', 'the', 'this', 'that', 'into', 'onto', 'over', 'under', 'near', 'her', 'his',
  'their', 'them', 'they', 'she', 'him', 'who', 'while', 'when', 'where', 'some', 'very', 'like', 'just',
  'please', 'draw', 'make', 'picture', 'image', 'photo', 'render', 'wearing', 'holding', 'sitting',
  'standing', 'looking', 'background', 'style', 'anime', 'original', 'character', 'series', 'version',
  // Intensifiers and hedges: they shade a request but name nothing in it, and
  // a rewrite that says "completely" for "fully" lost nothing worth a fallback.
  'fully', 'really', 'quite', 'totally', 'completely', 'extremely', 'super', 'pretty', 'rather', 'somewhat',
  'slightly', 'highly', 'much', 'more', 'most', 'also', 'even', 'still', 'only', 'then', 'than', 'there',
  'here', 'about', 'around', 'each', 'other', 'both', 'being', 'have', 'having', 'doing', 'going', 'should',
  'would', 'could', 'want', 'need', 'something', 'someone', 'thing', 'things', 'kind', 'sort', 'make',
  'made', 'look', 'looks', 'show', 'showing', 'shows', 'together', 'against', 'behind', 'between',
])

/**
 * Adverbs and -ful adjectives ("beautifully", "colourful"). They shade the
 * subject rather than name it, and the model's synonym keeps the request; a
 * name or a noun still has to survive. Seven letters or more and not -ily, so
 * short names like Emily, Kelly or Holly are never waved through.
 */
const SOFT_ENDINGS = /^(?=.{7,}$).*(?:[^i]ly|ful)$/

/**
 * The significant words of the request that the rewrite no longer contains.
 * Four letters or more, not a filler word, matched loosely (a plural, a
 * possessive, a hyphen) so "hancock's" still counts as "hancock".
 */
export function missingWords(original: string, rewrite: string): string[] {
  // Long vowels folded on both sides, so the Danbooru romanisation the model
  // is asked for ("hyuuga", "joutarou") still counts as the name the user
  // typed ("hyuga", "jotaro").
  const fold = (s: string) => s.replace(/ou/g, 'o').replace(/([aeiou])\1/g, '$1')
  const norm = (s: string) => fold(
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]s/g, '').replace(/[^a-z0-9\s-]/g, ' '),
  )
  const have = norm(rewrite)
  const words = [...new Set(norm(original).split(/[\s-]+/).filter(w =>
    w.length >= 4 && !KEEP_STOPWORDS.has(w) && !/^\d+$/.test(w) && !SOFT_ENDINGS.test(w)))]
  // Matched on the stem as well, so "fighting" survives as "fight" or
  // "fights" and "dueling" as "duel".
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '')
  return words.filter(w => !have.includes(w) && !have.includes(stem(w)))
}

/** Hair and eye colours, and artist tags, that the user never asked for. */
/** An @artist tag as the model writes it: the @ and up to four name words. */
const ARTIST_TAG = /@[a-z0-9_.'-]+(?: [a-z0-9_.'-]+){0,3}/gi

export function stripInvented(original: string, rewrite: string): string {
  const o = original.toLowerCase()
  const saidLook = /\b(hair|eyes?|blonde?|brunette|redhead)\b/.test(o)
  const ownArtists = new Set((original.match(ARTIST_TAG) ?? []).map(a => a.trim().toLowerCase()))
  let text = rewrite
    // "[count]" — the guide's order line copied back as a literal.
    .replace(/\[[a-z /]+\]/gi, ' ')
    // An artist the user did not type, wherever it sits in the text.
    .replace(ARTIST_TAG, a => (ownArtists.has(a.trim().toLowerCase()) ? a : ' '))
  const tags = text.split(',').map(t => t.trim().replace(/\s{2,}/g, ' ')).filter(Boolean)
  const seen = new Set<string>()
  const kept = tags.filter(t => {
    const l = t.toLowerCase().replace(/[.!]+$/, '')
    if (!saidLook && /\b(hair|eyes?)\b/.test(l) && !/\bwet hair\b|\bhair ornament\b|\bhairband\b|\bhair ribbon\b/.test(l)) return false
    // "by masashi kishimoto" is not a tag, and a dangling "by" is the model
    // reaching for one; the creator arrives as an @ tag from the dashboard.
    if (/^by(\s|$)/.test(l)) return false
    // A weighted tag the user did not write — "(haruno sakura:1.4)" copied
    // from the guide's own syntax, on a character nobody asked for.
    if (/:\s*\d+(\.\d+)?\)?$/.test(l) && !o.includes(l.replace(/[():]|\d+(\.\d+)?/g, '').trim())) return false
    // The same tag twice ("boa hancock, one piece, …, boa hancock, one piece") is
    // the model padding, and a repeated tag is a doubled weight.
    if (seen.has(l)) return false
    seen.add(l)
    return true
  })
  return kept.join(', ').replace(/\s+,/g, ',').trim()
}

/** The model composeRedrawPrompt() will use. */
export function visionModel(): string {
  return ENV_VISION_MODEL || prompterModel()
}

/**
 * The model that rewrites a failed edit instruction. Its own setting because
 * it is the only LLM in the editing path and worth being able to change
 * without moving the redraw composer with it; falls back to the vision model,
 * since it is shown a picture and must be able to see.
 */
export function editModel(): string {
  return readPrompter().editModel || visionModel()
}

/**
 * The user turn that rides beside the picture. Exported so the settings screen
 * can show the whole conversation rather than just the system half — a
 * template is judged against what follows it.
 */
export function visionUserMessage(change: string): string {
  return `Change wanted: ${change}`
}

/**
 * Write the full prompt for an img2img redraw by LOOKING at the source picture.
 *
 * Plain img2img has a contract that nobody standing at a kiosk knows about: the
 * prompt has to describe the WHOLE picture that should come out, not the
 * change. The sampler is handed the source's layout as a noised latent and the
 * prompt as the only description of what that layout depicts — so "make it
 * night" over a picture of a fox produces a picture of "make it night", with a
 * fox-shaped composition. And for a picture the user uploaded there is no
 * description at all: its "prompt" is the filename.
 *
 * So this call does the thing the user is being asked to do by hand: it is
 * given the picture and the change, and it returns a description of the
 * picture WITH the change, written in the register the target model wants
 * (booru tags for NoobAI, a T5 paragraph for FLUX) — the same `{{guidance}}`
 * the improver substitutes, because it is the same fact about the same model.
 *
 * Same contract as improvePrompt(): a fresh two-message conversation every
 * time, no tools, never throws, never fails the render. A dead vision model
 * costs a better prompt, not the picture.
 */
export async function composeRedrawPrompt(
  image: Buffer, change: string, style: StyleFacts,
): Promise<Improvement> {
  const started = Date.now()
  const model = visionModel()
  const give = (changed: boolean, text: string, why: string): Improvement => ({
    prompt: text, original: change, changed, model, ms: Date.now() - started, why,
  })
  const maxChars = style.maxChars ?? MAX_PROMPT_CHARS

  // The user's own template (Settings → Drawing), read per call for the same
  // reason the improver's is: an edit has to reach the NEXT redraw.
  const system = buildSystemPrompt(readPrompter().visionTemplate, style)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let url = imageModelUrl()
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    url = (await ollamaUrlSettled('image')).replace(/\/$/, '')
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          { role: 'system', content: system },
          // Ollama's multimodal shape: base64 images ride beside the text.
          { role: 'user', content: visionUserMessage(change), images: [image.toString('base64')] },
        ],
        // Cooler than the improver's 0.7: this is description, not invention,
        // and the whole point is fidelity to what is in the picture.
        // A picture rides in this one, so the window has to hold it too.
        // Unloaded the moment it answers: this model shares the card with ComfyUI,
        // and a render that starts while 5 GB of language model is still resident
        // runs in paged mode — a 53 s edit took 6 minutes that way.
        keep_alive: 0,
        // Uncapped for Anima, as in improvePrompt().
        options: { num_ctx: 8192, temperature: 0.4, num_predict: Number.isFinite(maxChars) ? 500 : -1 },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[image-prompt] vision ${res.status}: ${body.slice(0, 200)}`)
      return give(false, change, `${model} answered HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`)
    }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '')
    if (!text) return give(false, change, `${model} returned an empty answer`)
    if (looksLikeRefusal(text)) return give(false, change, `${model} refused to describe this picture`)
    if (text.length > maxChars) {
      return give(false, change, `the description came back ${text.length} characters long`)
    }
    // A description of a whole picture is never shorter than the change asked
    // for. One that is has refused, or answered a question nobody asked.
    if (text.length < Math.min(24, change.length)) {
      return give(false, change, 'the description came back too short to be a prompt')
    }
    return give(text !== change, text, '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[image-prompt] vision error:', msg)
    return give(false, change, describeCallError(err, model, url))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The instruction an editor (FLUX Kontext) will act on, written by a model
 * that can SEE the picture, after the user's own words changed nothing.
 *
 * Kontext reads an instruction, and it is literal: "put a bikini on woman"
 * works when there is a woman it can find and a garment it can swap, and
 * comes back untouched when the subject is not named the way it appears, the
 * change is vague ("make it better"), or the sentence lists what to keep.
 * This asks the vision model to look at the picture and write the same
 * change as Kontext wants it — the subject named as it appears, the change
 * concrete, one short clause on what is at risk — and it never throws: a
 * failure hands the user's words back with the reason.
 */
export async function composeKontextInstruction(
  image: Buffer, request: string, style: StyleFacts,
): Promise<Improvement> {
  const started = Date.now()
  const model = editModel()
  const give = (changed: boolean, text: string, why: string): Improvement => ({
    prompt: text, original: request, changed, model, ms: Date.now() - started, why,
  })
  const system = buildSystemPrompt(readPrompter().editTemplate, style)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`
    const res = await fetch(`${(await ollamaUrlSettled('image')).replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: editUserMessage(request), images: [image.toString('base64')] },
        ],
        // Unloaded the moment it answers: this model shares the card with
        // ComfyUI, and the render it is about to trigger needs the VRAM.
        keep_alive: 0,
        // No cap on the answer and no length check below: an instruction is
        // used however long it comes back. TIMEOUT_MS still ends a model that
        // never stops.
        options: { num_ctx: 8192, temperature: 0.3, num_predict: -1 },
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return give(false, request, `the ${model} model answered ${res.status}: ${body.slice(0, 80)}`)
    }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return give(false, request, `${model} returned nothing`)
    if (text.toLowerCase() === request.toLowerCase()) return give(false, request, `${model} gave the same words back`)
    return give(true, text, '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return give(false, request, `${model} could not be reached (${msg.slice(0, 80)})`)
  } finally {
    clearTimeout(timer)
  }
}

/** A rectangle in fractions of the picture, 0-1, from the top-left. */
export interface Box { left: number; top: number; right: number; bottom: number }

/**
 * Where a thing is, as a box, by LOOKING — the vision model rather than the
 * segmenter. The segmenter (GroundingDINO + SAM) traces concrete objects to
 * their outline and is the right tool for "the hat"; it cannot locate an
 * AREA ("her torso and arms") or, on drawn pictures, a whole person — asked
 * for "the woman" on an anime still it returned the hair plus wallpaper
 * speckle. A vision model can name that area to within a rectangle, which
 * is exactly enough for "repaint this region": the inpainting model decides
 * what goes inside, and the feathered paste-back hides the rectangle's edge.
 *
 * Asked with NAMED keys in thousandths, because a bare [a,b,c,d] is ambiguous
 * between models — Gemma answers [top, left, bottom, right] where others
 * answer x-first — and named keys were confirmed to be honoured. Never
 * throws; null means "could not locate", and the caller says so.
 */
export async function locateBox(image: Buffer, what: string): Promise<Box | null> {
  const model = visionModel()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`
    const res = await fetch(`${(await ollamaUrlSettled('image')).replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model, stream: false, think: false, format: 'json',
        messages: [
          {
            role: 'system',
            content:
              'You locate things in a picture. Answer ONLY JSON with these keys: ' +
              '{"found":true|false,"left":0-1000,"top":0-1000,"right":0-1000,"bottom":0-1000} where left/right ' +
              'are horizontal positions as thousandths of the image WIDTH from the left edge, and top/bottom are ' +
              'vertical positions as thousandths of the image HEIGHT from the top edge, tightly around the thing. ' +
              'If the thing is not in the picture, answer {"found":false}.',
          },
          { role: 'user', content: `Locate: ${what}`, images: [image.toString('base64')] },
        ],
        // locateBox is shown a picture too — same window as the others.
        options: { num_ctx: 8192, temperature: 0, num_predict: 120 },
      }),
    })
    if (!res.ok) { console.warn(`[image-prompt] locate ${res.status}`); return null }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '')
    const start = text.indexOf('{'), end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (j['found'] === false) return null
    const n = (k: string) => {
      const v = Number(j[k])
      if (!Number.isFinite(v)) return NaN
      return v > 1 ? v / 1000 : v
    }
    const box = { left: n('left'), top: n('top'), right: n('right'), bottom: n('bottom') }
    if ([box.left, box.top, box.right, box.bottom].some(v => !Number.isFinite(v) || v < 0 || v > 1)) return null
    if (box.right - box.left < 0.02 || box.bottom - box.top < 0.02) return null
    console.log(`[image-prompt] "${what}" → box l${(box.left * 100).toFixed(0)} t${(box.top * 100).toFixed(0)} r${(box.right * 100).toFixed(0)} b${(box.bottom * 100).toFixed(0)}% (${model})`)
    return box
  } catch (err) {
    console.warn(`[image-prompt] locate failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
