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

import { imagesEnabled, listImages, pendingJobs, startImage, type ImageJob } from '../image'
import type { BrowseToolResult, DisplayPayload } from './browse'

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

function showLast(about: string): BrowseToolResult {
  const all = listImages()
  if (all.length === 0) {
    return noDisplay("You haven't drawn any pictures yet. Offer to make one with generate_image.")
  }

  let hit = all[0]!
  if (about.trim()) {
    // Cheapest thing that works: count how many of the asked-for words appear in
    // each stored prompt. These are a handful of entries the user described out
    // loud a minute ago, not a corpus — a real index would be overkill.
    const words = loose(about).split(' ').filter(w => w.length > 2)
    let best = 0
    for (const img of all) {
      const hay = loose(img.prompt)
      const score = words.filter(w => hay.includes(w)).length
      if (score > best) { best = score; hit = img }
    }
    if (best === 0) {
      return noDisplay(
        `None of the recent pictures look like "${about}". The recent ones are: ` +
        `${all.slice(0, 5).map(i => `"${i.prompt.slice(0, 50)}"`).join(', ')}. ` +
        `Ask which one they meant, or offer to draw it.`,
      )
    }
  }

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
    case 'show_last_image': return showLast(str('about'))
    default: return null
  }
}
