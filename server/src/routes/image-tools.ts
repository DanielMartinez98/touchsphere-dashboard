// Tools that let the assistant draw something and put it on the kiosk's screen.
//
// Same family as the browse and guide-view tools: they return a `display`
// payload alongside the model's text (the BrowseToolResult shape), which
// chat.ts forwards to the client and BrowserOverlay's sibling ImageOverlay
// renders. Anything reachable by tapping stays reachable by asking.
//
// The tools are only EXPOSED when COMFYUI_URL is set. That's deliberate and
// it's the opposite of how TTS works: the voice chain always has espeak
// underneath it, so advertising it can never write a cheque nothing can cash.
// There is no espeak for image generation — an unconfigured box can't draw at
// all — and a model that can see a `generate_image` tool will cheerfully
// promise a picture before discovering there's no GPU behind it.

import {
  imagesEnabled, listImages, pendingJobs, selectedModel, startImage, styleEdits, stylePromptStyle,
  segmentationCached,
  type ImageJob, type StoredImage,
} from '../image'
import type { BrowseToolResult, DisplayPayload } from './browse'
import { createPlan, pickDrawStyle } from '../image-plan'

/**
 * How to write a prompt for the style selected RIGHT NOW.
 *
 * This is the half of the model story the tool schema cannot carry. The
 * `prompt` argument's description is fixed at module load, but the selected
 * style is a runtime choice, and the two families want opposite things:
 *
 *   • a Danbooru-trained model (NoobAI, NetaYume) summons a character by its
 *     TAG — `hatsune_miku, vocaloid`. Describing the character instead
 *     ("a girl with teal twintails") asks it to invent someone who merely looks
 *     similar, and the character knowledge it demonstrably has is never reached;
 *   • Anima reads its prompt through a Qwen-3 text encoder, so it wants an
 *     English sentence and gains nothing from underscored tags.
 *
 * Appended to the system prompt per request, because the user can change style
 * between one drawing and the next.
 */
export function imagePromptGuidance(): string {
  return baseImagePromptGuidance() + regionGuidance()
}

/**
 * Whether "change only the hat" is possible is a fact about the GPU box, so
 * it is said per request rather than baked into the tool schema. Uses the
 * last cached answer, since a system prompt cannot await.
 */
function regionGuidance(): string {
  if (!imagesEnabled() || !segmentationCached()) return ''
  return (
    ' When the user wants ONE PART of an existing picture changed and the rest kept' +
    ' ("make the hat red", "change the sky"), call redraw_image with `region` naming the part' +
    ' in a few plain words and `prompt` describing what goes in that part only.'
  )
}

function baseImagePromptGuidance(): string {
  if (!imagesEnabled()) return ''
  // An editing style turns the two tools around: redraw_image is the one that
  // works, generate_image cannot (there is nothing to edit), and the prompt is
  // an instruction rather than a description. The tool schemas are fixed at
  // module load, so this is the only place that can say so.
  if (styleEdits(selectedModel())) {
    return ' DRAWING STYLE: the current picture model is an EDITOR (FLUX Kontext). It changes ' +
      'an existing picture and cannot draw one from nothing, so generate_image will be refused ' +
      '— offer redraw_image instead, or tell the user to pick a drawing style. For ' +
      "redraw_image write the prompt as a plain-English INSTRUCTION saying what to change, " +
      'not a description of the whole picture: "make it night time while keeping everything ' +
      'else the same", "change the car to red", "put a straw hat on the cat, keep the same pose ' +
      'and expression". Name the subject explicitly rather than saying "it" or "her". The ' +
      'strength argument is ignored for this style.'
  }
  if (stylePromptStyle(selectedModel()) !== 'tags') {
    return ' DRAWING STYLE: the current picture model reads plain English, so write ' +
      "generate_image's prompt as a descriptive phrase — subject, setting, lighting, style."
  }
  return ' DRAWING STYLE: the current picture model is trained on Danbooru tags, so write ' +
    "generate_image's prompt as lowercase comma-separated tags, not a sentence. " +
    'For a named character use its booru tag AND its series, both underscored ' +
    '(hatsune_miku, vocaloid — haruno_sakura, naruto_(series) — nami_(one_piece), one_piece), ' +
    'then scene tags (1girl, solo, cafe, sitting, looking at viewer). ' +
    'Describing a character in a sentence does NOT summon it — the tag does.'
}

// ── Framing ──────────────────────────────────────────────────────────────────
// The kiosk is a 720×1280 portrait screen, so these are sized to fill it rather
// than to the usual square. Kept coarse on purpose: a model asked for raw pixel
// dimensions returns 512×512 for everything, or 4096 for a laugh.
const SIZES: Record<string, { width: number; height: number }> = {
  portrait:  { width: 768,  height: 1152 },
  landscape: { width: 1152, height: 768  },
  square:    { width: 896,  height: 896  },
}

export const IMAGE_TOOLS = !imagesEnabled() ? [] : [
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Draw a picture and put it full screen on the dashboard. Use when the user asks you to ' +
        'draw, paint, generate, or show them a picture of something that does not exist yet — ' +
        '"draw me a cat in a spacesuit", "what would that look like?", "make me a wallpaper". ' +
        'For a picture of something REAL that already exists (a person, a place, a product), use ' +
        'open_website or play_video instead — this invents images, it does not find them. ' +
        'It takes several seconds and appears on screen by itself as it finishes, so say one short ' +
        'sentence and do NOT claim it is already done.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'A rich visual description of the image, in English, as a comma-separated list of ' +
              'details rather than a sentence — subject, setting, lighting, style. Expand on what ' +
              'the user said; "a cat" makes a dull picture, "a ginger cat in a spacesuit, floating ' +
              'in a nebula, cinematic lighting, detailed" makes a good one.',
          },
          orientation: {
            type: 'string',
            enum: ['portrait', 'landscape', 'square'],
            description:
              'Shape of the picture. The screen is tall, so prefer portrait unless the subject is ' +
              'obviously wide (a landscape, a car) or the user asks for a wallpaper for something else.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redraw_image',
      description:
        'Draw a NEW picture that starts from one you already drew, instead of from nothing. Use ' +
        'when the user wants a change to a picture that is on screen or was just made — "make it ' +
        'night time", "same cat but blue", "try that again with more detail", "add a hat". The ' +
        'original is kept; this makes another one beside it. Takes the same few seconds as ' +
        'generate_image and appears on screen by itself, so say one short sentence and do NOT ' +
        'claim it is done. For something unrelated to any existing picture, use generate_image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'For a drawing style: a full description of the picture you want OUT — not just ' +
              'the change. The model redraws from the description, so "a ginger cat in a ' +
              'spacesuit, floating in a nebula, at night" is right and "make it night" is not. ' +
              'Start from what the original was of and fold the change into it. For an EDITING ' +
              'style (the DRAWING STYLE note says which is current): the opposite — a plain ' +
              'instruction saying only what to change and what to keep.',
          },
          about: {
            type: 'string',
            description:
              'Words from what the ORIGINAL picture was of, to pick it out of the recent ones. ' +
              'Omit for the most recent picture, which is usually what "it" means.',
          },
          region: {
            type: 'string',
            description:
              'ONLY when the user wants ONE PART of the picture changed and the rest kept exactly — ' +
              '"make the hat red", "change the sky to sunset", "give the cat blue eyes". Name the part ' +
              'in two or three plain words ("the hat", "the sky", "the cat\'s eyes"); it is found in the ' +
              'picture and only that part is repainted. Then `prompt` describes what should be IN that ' +
              'part ("a red hat"), not the whole picture. Omit to repaint the whole picture.',
          },
          strength: {
            type: 'string',
            enum: ['light', 'balanced', 'strong'],
            description:
              'How far from the original to go. "light" keeps the composition and changes ' +
              'details (a colour, the lighting); "balanced" is the default and repaints the ' +
              'subject while keeping the layout; "strong" keeps only the rough idea. Prefer ' +
              'light for a small fix and strong when they ask for something quite different.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_image_edit',
      description:
        'Change an existing picture in SEVERAL ways at once, or in a way that needs more than one ' +
        'kind of edit — "give him a red jacket, make it night and add rain", "make her older and ' +
        'change the background to a beach". A model looks at the picture, splits the request into ' +
        'steps, picks the right tool for each (an instruction edit, a repaint of one part, or a ' +
        'whole redraw) and runs them in order, each on the previous result. For ONE simple change ' +
        'use redraw_image instead — this takes several renders and a few minutes. The frame appears ' +
        'on screen and follows the steps by itself.',
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'Everything the user wants changed, in plain English, as they said it.',
          },
          about: {
            type: 'string',
            description:
              'Which picture: a few words from its prompt, or "last" / "latest" for the most ' +
              'recent one. Omit for the most recent.',
          },
        },
        required: ['request'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_last_image',
      description:
        'Put a picture you generated earlier back on screen. Use when the user asks to see it ' +
        'again ("show me that picture", "put the cat back up"). Does not draw anything new.',
      parameters: {
        type: 'object',
        properties: {
          about: {
            type: 'string',
            description:
              'Words from what the picture was of, to pick it out of the recent ones. ' +
              'Omit for the most recent picture.',
          },
        },
      },
    },
  },
] as const

// ── Handlers ─────────────────────────────────────────────────────────────────

const noDisplay = (text: string): BrowseToolResult => ({ text, display: null })

function generate(prompt: string, orientation: string): BrowseToolResult {
  if (!imagesEnabled()) {
    return noDisplay(
      'Image generation is not configured on this server (COMFYUI_URL is unset). ' +
      'Tell the user you cannot draw right now and why, in one sentence.',
    )
  }
  if (!prompt.trim()) {
    return noDisplay('generate_image error: pass a `prompt` describing the picture.')
  }

  const size = SIZES[orientation] ?? SIZES['portrait']!
  // Pictures already waiting or drawing when this one was asked for. Counted
  // BEFORE the call, so it is the number in front of the new job.
  const ahead = pendingJobs().length
  // improve:false, explicitly. The prompt improver exists for the person
  // typing into the Draw panel; a spoken request has already been through a
  // model that had this style's own prompting guidance in its system prompt
  // (see imagePromptGuidance below), so running a second model over it is one
  // paraphrasing another for no gain and several seconds of extra silence
  // while somebody stands at the kiosk waiting to be answered.
  const job: ImageJob = startImage({
    prompt: prompt.trim(), width: size.width, height: size.height, improve: false,
  })

  // startImage refuses rather than throws when the queue is full, and hands
  // back an already-failed job. Nothing is coming, so there is no frame worth
  // putting on screen — say why instead.
  if (job.status === 'failed') {
    return noDisplay(
      `Could not start that picture: ${job.error ?? 'the render queue is full'}. ` +
      `Tell the user in one sentence and offer to draw it once the ones already going have finished.`,
    )
  }

  const display: DisplayPayload = {
    kind:   'image',
    jobId:  job.id,
    prompt: job.prompt,
  }
  console.log(
    `[chat:tool] generate_image → ${job.id} (${orientation || 'portrait'})` +
    `${ahead > 0 ? ` behind ${ahead}` : ''}`,
  )

  return {
    // The frame is already on screen with a progress state in it, so the one
    // thing the model must not do is narrate a finished picture it can't see.
    text:
      `Started drawing "${job.prompt}". A frame is already on the user's screen and the picture ` +
      `will appear in it by itself when it is done, usually in a few seconds. ` +
      (ahead > 0
        // Renders are drawn one at a time, so a picture asked for while another
        // is going is genuinely later than usual — saying "a few seconds" then
        // would be a promise the GPU can't keep.
        ? `It is QUEUED behind ${ahead} other picture${ahead === 1 ? '' : 's'}, so mention that it is ` +
          `in the queue and will take a little longer. `
        : '') +
      `Say ONE short sentence telling them it's coming — do not describe the picture, ` +
      `you have not seen it, and do not say it is ready.`,
    display,
  }
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * How much of the original a redraw throws away.
 *
 * Three words rather than a number, because a language model asked for a
 * denoise value returns 0.5 for everything, and the difference between 0.45 and
 * 0.85 is the difference between "the same picture at night" and "a different
 * picture of roughly that". The numbers are the model author's own guidance:
 * 0.5-0.6 for a small edit, 0.75-0.85 for a creative reinterpretation.
 */
const STRENGTH: Record<string, number> = {
  light:    0.45,
  balanced: 0.65,
  strong:   0.85,
}

/**
 * Pick a stored picture out of the recent ones by what it was of.
 *
 * The cheapest thing that works: count how many of the asked-for words appear
 * in each stored prompt. These are a handful of entries the user described out
 * loud a minute ago, not a corpus. Shared by redraw_image and show_last_image,
 * which ask the same question of the same list.
 */
function findImage(about: string): StoredImage | null {
  const all = listImages()
  if (all.length === 0) return null
  if (!about.trim()) return all[0]!

  const words = loose(about).split(' ').filter(w => w.length > 2)
  let best = 0
  let hit: StoredImage | null = null
  for (const img of all) {
    const hay = loose(img.prompt)
    const score = words.filter(w => hay.includes(w)).length
    if (score > best) { best = score; hit = img }
  }
  return hit
}

/** "None of them look like that, here are the ones there are" — used by both tools. */
function noMatch(about: string): BrowseToolResult {
  const all = listImages()
  return noDisplay(
    `None of the recent pictures look like "${about}". The recent ones are: ` +
    `${all.slice(0, 5).map(i => `"${i.prompt.slice(0, 50)}"`).join(', ')}. ` +
    `Ask which one they meant, or offer to draw it.`,
  )
}

async function redraw(prompt: string, about: string, strength: string, region = ''): Promise<BrowseToolResult> {
  if (!imagesEnabled()) {
    return noDisplay(
      'Image generation is not configured on this server (COMFYUI_URL is unset). ' +
      'Tell the user you cannot draw right now and why, in one sentence.',
    )
  }
  if (!prompt.trim()) {
    return noDisplay('redraw_image error: pass a `prompt` describing the picture you want out.')
  }

  const all = listImages()
  if (all.length === 0) {
    return noDisplay(
      "There are no pictures to redraw yet — nothing has been drawn on this dashboard. " +
      'Offer to draw it from scratch with generate_image instead.',
    )
  }
  const source = findImage(about)
  if (!source) return noMatch(about)

  const ahead = pendingJobs().length
  const part = region.trim()
  // A part is repainted by a DRAWING style. With the editor selected in the
  // panel, startImage would drop the region (an editor takes no mask) and
  // quietly turn "make the hat red" into a Kontext edit of "a red hat".
  const drawStyle = part && styleEdits(selectedModel()) ? await pickDrawStyle() : ''
  const job: ImageJob = startImage({
    prompt:  prompt.trim(),
    source:  source.id,
    ...(drawStyle ? { model: drawStyle } : {}),
    // A named part is repainted fully by default; a whole-picture redraw keeps
    // the strength word. See startImage on why the two default differently.
    ...(part ? { region: part } : { denoise: STRENGTH[strength] ?? STRENGTH['balanced']! }),
    // Same reasoning as generate_image above.
    improve: false,
  })

  if (job.status === 'failed') {
    return noDisplay(
      `Could not start that picture: ${job.error ?? 'the render queue is full'}. ` +
      `Tell the user in one sentence and offer to try again once the ones already going are done.`,
    )
  }

  const display: DisplayPayload = { kind: 'image', jobId: job.id, prompt: job.prompt }
  console.log(`[chat:tool] redraw_image → ${job.id} from ${source.id} (${strength || 'balanced'})`)

  return {
    text:
      (part
        ? `Started changing just "${part}" in the picture of "${source.prompt.slice(0, 60)}" to "${job.prompt}"; the rest is kept as it is. `
        : `Started redrawing the picture of "${source.prompt.slice(0, 60)}" as "${job.prompt}". `) +
      `A frame is already on the user's screen and the new picture will appear in it by itself, ` +
      `usually in a few seconds. The original is untouched and still in the gallery. ` +
      (ahead > 0
        ? `It is QUEUED behind ${ahead} other picture${ahead === 1 ? '' : 's'}, so mention it will ` +
          `take a little longer. `
        : '') +
      `Say ONE short sentence telling them it's coming — do not describe the picture, ` +
      `you have not seen it, and do not say it is ready.`,
    display,
  }
}

function planEdit(request: string, about: string): BrowseToolResult {
  if (!imagesEnabled()) {
    return noDisplay('Image generation is not configured on this server (COMFYUI_URL is unset). Say so in one sentence.')
  }
  if (!request.trim()) return noDisplay('plan_image_edit error: pass `request` saying what should change.')
  if (listImages().length === 0) {
    return noDisplay('There are no pictures to change yet. Offer to draw one with generate_image instead.')
  }
  const source = findImage(about)
  if (!source) return noMatch(about)

  const plan = createPlan(source.id, request, true)
  if (plan.status === 'failed') {
    return noDisplay(`Could not plan that edit: ${plan.error}. Tell the user in one sentence.`)
  }
  const display: DisplayPayload = { kind: 'image', jobId: '', prompt: request.trim(), planId: plan.id }
  console.log(`[chat:tool] plan_image_edit → ${plan.id} on ${source.id}`)
  return {
    text:
      `Started planning the changes to the picture of "${source.prompt.slice(0, 60)}": "${request.trim()}". ` +
      'A model is looking at the picture and splitting the request into steps; each step is a render ' +
      'of a minute or two and the frame on screen follows them by itself. Say ONE short sentence that it ' +
      'is being worked on in a few steps and will take a few minutes — do not describe the result, and do ' +
      'not say it is done.',
    display,
  }
}

function showLast(about: string): BrowseToolResult {
  if (listImages().length === 0) {
    return noDisplay("You haven't drawn any pictures yet. Offer to make one with generate_image.")
  }
  const hit = findImage(about)
  if (!hit) return noMatch(about)

  console.log(`[chat:tool] show_last_image → ${hit.id}`)
  return {
    text:
      `Put the picture of "${hit.prompt}" back on the user's screen. ` +
      `Acknowledge it in a few words — don't describe the picture.`,
    display: {
      kind:   'image',
      jobId:  hit.id,
      prompt: hit.prompt,
      url:    `/api/image/file/${hit.file}`,
    },
  }
}

export async function runImageTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BrowseToolResult | null> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'generate_image':  return generate(str('prompt'), str('orientation'))
    case 'redraw_image':    return redraw(str('prompt'), str('about'), str('strength'), str('region'))
    case 'plan_image_edit': return planEdit(str('request'), str('about'))
    case 'show_last_image': return showLast(str('about'))
    default: return null
  }
}
