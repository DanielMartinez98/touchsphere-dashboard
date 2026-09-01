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
  imagesEnabled, listImages, pendingJobs, selectedModel, startImage, stylePromptStyle,
  type ImageJob, type StoredImage,
} from '../image'
import type { BrowseToolResult, DisplayPayload } from './browse'

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
  if (!imagesEnabled()) return ''
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
              'A full description of the picture you want OUT — not just the change. The model ' +
              'redraws from the description, so "a ginger cat in a spacesuit, floating in a ' +
              'nebula, at night" is right and "make it night" is not. Start from what the ' +
              'original was of and fold the change into it, as a comma-separated list of details.',
          },
          about: {
            type: 'string',
            description:
              'Words from what the ORIGINAL picture was of, to pick it out of the recent ones. ' +
              'Omit for the most recent picture, which is usually what "it" means.',
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
  const job: ImageJob = startImage({ prompt: prompt.trim(), width: size.width, height: size.height })

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

function redraw(prompt: string, about: string, strength: string): BrowseToolResult {
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
  const job: ImageJob = startImage({
    prompt:  prompt.trim(),
    source:  source.id,
    denoise: STRENGTH[strength] ?? STRENGTH['balanced']!,
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
      `Started redrawing the picture of "${source.prompt.slice(0, 60)}" as "${job.prompt}". ` +
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
    case 'redraw_image':    return redraw(str('prompt'), str('about'), str('strength'))
    case 'show_last_image': return showLast(str('about'))
    default: return null
  }
}
