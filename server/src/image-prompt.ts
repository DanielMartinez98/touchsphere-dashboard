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

// Where the PICTURE-side models live — the improver, the vision composer, the
// region box finder and (in image-plan.ts) the edit planner. Separate from the
// chat's OLLAMA_URL because the two want different places: the conversation
// wants the cloud model's quality and nobody minds where a prompt rewrite
// runs, while every one of these calls sits inside a render that is already
// spending the GPU box's time — and the cloud's per-session usage limit is
// far better spent on talking than on rewriting "a cat in a hat". Defaults to
// OLLAMA_URL so a setup with one Ollama is unchanged.
//   OLLAMA_IMAGE_URL=http://<gpu-box>:11434
const OLLAMA_URL     = process.env['OLLAMA_IMAGE_URL'] ?? process.env['OLLAMA_URL'] ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']   ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''

/** Where the picture-side model calls go — for the startup log and Settings. */
export function imageModelUrl(): string { return OLLAMA_URL }

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

    const ask = async (extra: string, temperature: number): Promise<string> => {
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
            { role: 'system', content: buildSystemPrompt(settings.template, style) + extra },
            { role: 'user',   content: prompt },
          ],
          // Warmer than the guide generator's 0.3: this is a creative rewrite
          // rather than structured extraction, and a cold model returns the input
          // almost verbatim, which makes the whole feature look broken.
          // num_ctx for the same reason as chat.ts: Ollama's 4096 default
          // truncates from the front, and the front is the instructions.
          options: { num_ctx: 8192, temperature, num_predict: 400 },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[image-prompt] ollama ${res.status}: ${body.slice(0, 200)}`)
        throw new Error(`the prompt model answered ${res.status}`)
      }
      const json = (await res.json()) as { message?: { content?: string }; response?: string }
      return unwrap(json.message?.content ?? json.response ?? '')
    }
    let text: string
    try {
      text = await ask('', 0.7)
    } catch (err) {
      return give(false, prompt, err instanceof Error ? err.message : String(err))
    }
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
    let lost = missingWords(prompt, text)
    if (lost.length > 0) {
      // One more go, colder and told what went wrong. On an 8B model the
      // first answer misspells a surname ("hiyuga") often enough that always
      // falling back would throw away the tag form that draws the character.
      try {
        const again = await ask(
          `\n\nYOUR PREVIOUS ANSWER DROPPED THE WORD(S) "${lost.join('", "')}" FROM THE REQUEST. Every ` +
          `word of the request must appear in the prompt, spelled exactly as the user spelled it or as ` +
          `Danbooru spells that name. Answer with the prompt only.`,
          0.3,
        )
        if (again && again.length <= MAX_PROMPT_CHARS && missingWords(prompt, again).length === 0) {
          text = again
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
    return give(false, prompt, `the prompt model could not be reached (${msg.slice(0, 80)})`)
  } finally {
    clearTimeout(timer)
  }
}

const KEEP_STOPWORDS = new Set([
  'from', 'with', 'and', 'the', 'this', 'that', 'into', 'onto', 'over', 'under', 'near', 'her', 'his',
  'their', 'them', 'they', 'she', 'him', 'who', 'while', 'when', 'where', 'some', 'very', 'like', 'just',
  'please', 'draw', 'make', 'picture', 'image', 'photo', 'render', 'wearing', 'holding', 'sitting',
  'standing', 'looking', 'background', 'style', 'anime', 'original', 'character', 'series', 'version',
])

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
  const words = [...new Set(norm(original).split(/[\s-]+/).filter(w => w.length >= 4 && !KEEP_STOPWORDS.has(w) && !/^\d+$/.test(w)))]
  return words.filter(w => !have.includes(w) && !have.includes(w.replace(/s$/, '')))
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
        // A picture rides in this one, so the window has to hold it too.
        options: { num_ctx: 8192, temperature: 0.4, num_predict: 500 },
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
export async function composeKontextInstruction(image: Buffer, request: string): Promise<Improvement> {
  const started = Date.now()
  const model = visionModel()
  const give = (changed: boolean, text: string, why: string): Improvement => ({
    prompt: text, original: request, changed, model, ms: Date.now() - started, why,
  })
  const system =
    'You write instructions for an image EDITING model (FLUX Kontext). You are shown a picture and ' +
    'what the user wants changed in it. The editor is literal, so write the change the way it ' +
    'needs it:\n' +
    '- Name the subject as it actually appears in the picture ("the woman with dark hair in the ' +
    'striped top", "the red car on the left"), never "her", "it" or "the character".\n' +
    '- Say the change concretely: what it becomes, its colour, material, position. "Replace her ' +
    'striped top with a blue bikini top" rather than "put a bikini on her".\n' +
    '- To add something, say where it goes and how it is worn or placed. To remove something, say ' +
    'what fills the space.\n' +
    '- Then ONE short clause naming only what is at risk ("Keep her face and pose."). Never a list ' +
    'of everything to keep — that reads as "change nothing".\n' +
    '- Two sentences at most. Plain English. No quality words, no style words unless the user asked ' +
    'for a style. Answer with the instruction only.'
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
          { role: 'user', content: `The user wants: ${request}\nThe previous attempt with those exact words changed nothing in the picture. Write the instruction that will.`, images: [image.toString('base64')] },
        ],
        options: { num_ctx: 8192, temperature: 0.3, num_predict: 200 },
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return give(false, request, `the vision model answered ${res.status}: ${body.slice(0, 80)}`)
    }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    const text = unwrap(json.message?.content ?? json.response ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return give(false, request, 'the vision model returned nothing')
    if (text.length > 600) return give(false, request, `the instruction came back ${text.length} characters long`)
    if (text.toLowerCase() === request.toLowerCase()) return give(false, request, 'the vision model gave the same words back')
    return give(true, text, '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return give(false, request, `the vision model could not be reached (${msg.slice(0, 80)})`)
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
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
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
