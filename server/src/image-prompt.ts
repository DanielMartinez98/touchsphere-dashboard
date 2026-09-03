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

import fs from 'fs'
import path from 'path'

const OLLAMA_URL     = process.env['OLLAMA_URL']     ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']   ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''

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
}

const DEFAULTS: PrompterSettings = {
  enabled:  false,
  template: DEFAULT_TEMPLATE,
  model:    '',
  visionTemplate: DEFAULT_VISION_TEMPLATE,
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
    }
  } catch {
    return { ...DEFAULTS }
  }
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

  const p = storePath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.error('[image-prompt] failed to write settings:', err)
  }
  return next
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
}

/**
 * Rewrite one prompt. Never throws and never returns nothing.
 *
 * Every failure path falls back to the prompt the user typed, because the
 * alternative — failing the render over an optional nicety — would make the
 * toggle actively dangerous to leave on. A dead Ollama box should cost you a
 * better prompt, not your picture.
 */
export async function improvePrompt(prompt: string, style: StyleFacts): Promise<Improvement> {
  const started = Date.now()
  const settings = readPrompter()
  const model = settings.model || ENV_MODEL || OLLAMA_MODEL
  const give = (changed: boolean, text: string, why: string): Improvement => ({
    prompt: text, original: prompt, changed, model, ms: Date.now() - started, why,
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
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
          { role: 'system', content: buildSystemPrompt(settings.template, style) },
          { role: 'user',   content: prompt },
        ],
        // Warmer than the guide generator's 0.3: this is a creative rewrite
        // rather than structured extraction, and a cold model returns the input
        // almost verbatim, which makes the whole feature look broken.
        options: { temperature: 0.7, num_predict: 400 },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[image-prompt] ollama ${res.status}: ${body.slice(0, 200)}`)
      return give(false, prompt, `the prompt model answered ${res.status}`)
    }

    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '')

    if (!text) return give(false, prompt, 'the prompt model returned nothing')
    // A rewrite that came back enormous is a model that started explaining
    // itself. The sampler would spend its whole context on the explanation.
    if (text.length > MAX_PROMPT_CHARS) {
      return give(false, prompt, `the rewrite came back ${text.length} characters long`)
    }
    // A model that refuses, or answers the question instead of rewriting it,
    // usually comes back SHORTER than the request. Keeping the user's own words
    // is strictly better than rendering an apology.
    if (text.length < Math.min(12, prompt.length)) {
      return give(false, prompt, 'the rewrite came back too short to be a prompt')
    }
    return give(text !== prompt, text, '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[image-prompt] error:', msg)
    return give(false, prompt, `the prompt model could not be reached (${msg.slice(0, 80)})`)
  } finally {
    clearTimeout(timer)
  }
}

/** The model composeRedrawPrompt() will use. */
export function visionModel(): string {
  return ENV_VISION_MODEL || prompterModel()
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

  // The user's own template (Settings → Drawing), read per call for the same
  // reason the improver's is: an edit has to reach the NEXT redraw.
  const system = buildSystemPrompt(readPrompter().visionTemplate, style)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
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
        options: { temperature: 0.4, num_predict: 500 },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[image-prompt] vision ${res.status}: ${body.slice(0, 200)}`)
      return give(false, change, `the vision model answered ${res.status}`)
    }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '')
    if (!text) return give(false, change, 'the vision model returned nothing')
    if (text.length > MAX_PROMPT_CHARS) {
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
    return give(false, change, `the vision model could not be reached (${msg.slice(0, 80)})`)
  } finally {
    clearTimeout(timer)
  }
}
