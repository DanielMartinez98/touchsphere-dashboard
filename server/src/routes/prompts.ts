// /api/prompts — every system prompt this app sends, as it stands right now,
// and the one place each of them is edited.
//
// Five different jobs get five different sets of instructions before anything
// is asked of them: the assistant that holds the conversation, the improver
// that rewrites a typed image prompt, the vision model that looks at a picture
// before a redraw, the rewriter for an edit that did nothing, and the planner
// that splits an edit into steps. Each is listed with its editable template,
// the built-in it resets to, and the text it expands to right now — composed
// by the same function the real request uses, so the preview cannot drift from
// what is sent.
//
// The assistant's and the planner's used to be read-only because both carry a
// structural half (the registered tools; the installed tools, the styles and
// the JSON answer contract). That half is now a set of placeholders filled in
// live (prompt-overrides.ts), so the wording is the user's and the structure is
// still the server's.

import { Router, type Request, type Response } from 'express'
import { assistantSystemPrompt, DEFAULT_ASSISTANT_TEMPLATE } from './chat'
import { plannerSystemPrompt, plannerDefaultTemplate } from '../image-plan'
import { imagesEnabled, selectedModel, styleImproverGuide, styleLabel, stylePromptGuide } from '../image'
import {
  buildSystemPrompt, improverSystemPrompt, readPrompter, writePrompter, prompterModel, visionModel, visionUserMessage,
  editModel, editUserMessage, resolvePromptOption, ORIGINAL_OPTION,
  DEFAULT_TEMPLATE, DEFAULT_VISION_TEMPLATE, DEFAULT_EDIT_TEMPLATE,
} from '../image-prompt'
import { readOverrides, writeOverride } from '../prompt-overrides'
import { ASSISTANT_PROFILES, getSelectedProfile } from '../config/assistant'
import { broadcast } from './system'

const router = Router()

const STYLE_PLACEHOLDERS = [
  { name: 'style',    means: 'the selected drawing style’s name' },
  { name: 'guidance', means: 'that model’s own published advice on how to prompt it' },
]

async function view() {
  const style = selectedModel()
  const facts = { label: styleLabel(style), guidance: stylePromptGuide(style), bestPractices: styleImproverGuide(style) }
  const prompter = readPrompter()
  const overrides = readOverrides()
  // The improver's instructions are whichever option the Draw panel has chosen.
  const improver = resolvePromptOption()
  const selected = getSelectedProfile()

  const images = imagesEnabled()
  const [planner, plannerDefault] = images
    ? await Promise.all([
        plannerSystemPrompt().catch(err => `(could not be composed: ${err instanceof Error ? err.message : String(err)})`),
        plannerDefaultTemplate().catch(() => ''),
      ])
    : ['', '']

  return {
    prompts: [
      {
        id: 'assistant',
        group: 'conversation',
        label: 'The assistant',
        what: 'Sent before every spoken or typed conversation: its personality, then how it should ' +
              'answer and which tools it has. Your memories and the desk sensor are added after.',
        model: process.env['OLLAMA_MODEL'] ?? '',
        modelFrom: 'OLLAMA_MODEL',
        template: overrides.assistant ?? DEFAULT_ASSISTANT_TEMPLATE,
        defaultTemplate: DEFAULT_ASSISTANT_TEMPLATE,
        overridden: overrides.assistant !== null,
        placeholders: [
          { name: 'web',     means: 'web search, when a search provider is set up' },
          { name: 'screen',  means: 'opening pages and videos on screen' },
          { name: 'drawing', means: 'the drawing tools, when an image server is set up' },
          { name: 'plex',    means: 'Plex, when the media stack is set up' },
        ],
        personas: (Object.values(ASSISTANT_PROFILES)).map(p => ({
          id: p.id,
          name: p.name,
          text: overrides.personas[p.id] ?? p.persona,
          defaultText: p.persona,
          overridden: overrides.personas[p.id] !== undefined,
          selected: p.id === selected.id,
        })),
        text: assistantSystemPrompt(),
      },
      {
          id: 'improver',
          group: 'pictures',
          label: 'Improve my prompt',
          what: 'Rewrites what you type in the Draw panel into a prompt for the picture model about ' +
                'to draw it, on a brand new conversation every time.',
          model: prompterModel(),
          modelSetting: prompter.model,
          modelFrom: 'OLLAMA_IMAGE_MODEL',
          template: prompter.template,
          defaultTemplate: DEFAULT_TEMPLATE,
          overridden: prompter.template !== DEFAULT_TEMPLATE,
          placeholders: STYLE_PLACEHOLDERS,
          previewName: improver.id === ORIGINAL_OPTION ? '' : improver.name,
          text: improverSystemPrompt(improver.template, facts),
        },
        {
          id: 'vision',
          group: 'pictures',
          label: 'Looking at the picture',
          what: 'Before a redraw, shown the original with what you asked to change, and writes the ' +
                'description of the whole result. Runs when Improve is on, and always for a picture ' +
                'you uploaded.',
          model: visionModel(),
          modelFrom: 'OLLAMA_VISION_MODEL',
          template: prompter.visionTemplate,
          defaultTemplate: DEFAULT_VISION_TEMPLATE,
          overridden: prompter.visionTemplate !== DEFAULT_VISION_TEMPLATE,
          placeholders: STYLE_PLACEHOLDERS,
          text: buildSystemPrompt(prompter.visionTemplate, facts),
          followedBy: visionUserMessage('<what you typed>'),
        },
        {
          id: 'edit',
          group: 'pictures',
          label: 'Rewriting an edit that did nothing',
          what: 'When an instruction edit comes back almost unchanged, this is shown the picture and ' +
                'says the same change the way the editor can act on it. Only runs with the retry ' +
                'floor set under Drawing.',
          model: editModel(),
          modelSetting: prompter.editModel,
          modelPlaceholder: visionModel(),
          template: prompter.editTemplate,
          defaultTemplate: DEFAULT_EDIT_TEMPLATE,
          overridden: prompter.editTemplate !== DEFAULT_EDIT_TEMPLATE,
          placeholders: STYLE_PLACEHOLDERS,
          text: buildSystemPrompt(prompter.editTemplate, facts),
          followedBy: editUserMessage('<what you typed>'),
        },
        ...(planner ? [{
          id: 'planner',
          group: 'pictures',
          label: 'Planning an edit',
          what: 'Shown a picture and a request, and splits it into steps, choosing a tool and a ' +
                'style for each ("Plan it for me" in the Draw panel, and the assistant\'s edits).',
          model: visionModel(),
          modelFrom: 'OLLAMA_VISION_MODEL',
          template: overrides.planner ?? plannerDefault,
          defaultTemplate: plannerDefault,
          overridden: overrides.planner !== null,
          placeholders: [
            { name: 'tools',  means: 'the edit tools installed on the image server' },
            { name: 'styles', means: 'the drawing styles it may pick from' },
            { name: 'answer', means: 'the JSON format its answer is read in' },
          ],
          note: 'The built-in wording follows what is installed. An edited copy keeps your wording ' +
                'if that changes; the three placeholders stay live either way.',
          text: planner,
        }] : []),
    ],
    style: { id: style, label: styleLabel(style) },
  }
}

router.get('/', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(await view())
})

// POST /api/prompts/:id { text?: string|null, profile?: string, model?: string }
// text null or '' resets to the built-in. `profile` edits that assistant's
// personality instead of the shared instructions.
router.post('/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id'])
  const body = (req.body ?? {}) as { text?: unknown; profile?: unknown; model?: unknown }
  const text = typeof body.text === 'string' ? body.text : body.text === null ? null : undefined
  const model = typeof body.model === 'string' ? body.model : undefined
  try {
    if (id === 'assistant' && text !== undefined) {
      if (typeof body.profile === 'string') writeOverride('persona', text, body.profile)
      else writeOverride('assistant', text)
    } else if (id === 'planner' && text !== undefined) {
      writeOverride('planner', text)
    } else if (id === 'improver' || id === 'vision' || id === 'edit') {
      const field = id === 'improver' ? 'template' : id === 'vision' ? 'visionTemplate' : 'editTemplate'
      const patch: Record<string, string> = {}
      // '' is "reset" in the prompter store too.
      if (text !== undefined) patch[field] = text ?? ''
      if (model !== undefined && id !== 'vision') patch[id === 'improver' ? 'model' : 'editModel'] = model
      writePrompter(patch)
      broadcast('image-prompter', {})
    } else {
      res.status(400).json({ error: 'nothing to change' })
      return
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  res.json(await view())
})

export default router
