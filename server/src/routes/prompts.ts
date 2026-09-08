// /api/prompts — every system prompt this app sends, as it stands right now.
//
// Four different models are given four different sets of instructions before
// they are asked anything: the assistant that holds the conversation, the
// improver that rewrites a typed image prompt, the vision model that looks at
// a picture before a redraw, and the planner that splits an edit into steps.
// Two of them were already readable and editable under Settings → Drawing;
// the other two only existed in the source, which is the wrong place for
// something that decides what the app says and draws.
//
// Composed live rather than described: each one is built by the same function
// the real request uses, so what is shown is what is sent, including the parts
// that change with the selected style, the installed tools and what is in
// memory. Read-only for the two that are structural — the planner's answer is
// parsed as JSON against a fixed contract, and the assistant's tool
// instructions have to match the tools actually registered.

import { Router, type Request, type Response } from 'express'
import { assistantSystemPrompt } from './chat'
import { plannerSystemPrompt } from '../image-plan'
import { imagesEnabled, selectedModel, styleLabel, stylePromptGuide } from '../image'
import { buildSystemPrompt, readPrompter, prompterModel, visionModel, visionUserMessage, editModel, editUserMessage,
} from '../image-prompt'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  const style = selectedModel()
  const facts = { label: styleLabel(style), guidance: stylePromptGuide(style) }
  const prompter = readPrompter()

  const planner = imagesEnabled()
    ? await plannerSystemPrompt().catch(err => `(could not be composed: ${err instanceof Error ? err.message : String(err)})`)
    : ''

  res.setHeader('Cache-Control', 'no-store')
  res.json({
    prompts: [
      {
        id: 'assistant',
        label: 'The assistant',
        what: 'Sent before every spoken or typed conversation. Its personality comes from the ' +
              'selected assistant profile; the rest is how it should answer, which tools exist, ' +
              'and what it remembers about you.',
        model: process.env['OLLAMA_MODEL'] ?? '',
        text: assistantSystemPrompt(),
        editable: false,
        note: 'Read-only: the tool instructions have to match the tools actually registered. ' +
              'The personality half is per profile in the code, and the memory lines come from ' +
              'the Memory tab.',
      },
      {
        id: 'improver',
        label: 'The prompt improver',
        what: 'Rewrites what you type in the Draw panel into a prompt for the picture model ' +
              'about to draw it. A brand new conversation every time.',
        model: prompterModel(),
        text: buildSystemPrompt(prompter.template, facts),
        editable: true,
        editIn: 'Drawing',
      },
      {
        id: 'vision',
        label: 'Looking at the picture',
        what: 'Shown the original before a redraw, with what you asked to change, and writes the ' +
              'description of the whole result. Runs when Improve is on, and always for a ' +
              'picture you uploaded.',
        model: visionModel(),
        text: buildSystemPrompt(prompter.visionTemplate, facts),
        followedBy: visionUserMessage('<what you typed>'),
        editable: true,
        editIn: 'Drawing',
      },
      {
        id: 'edit',
        label: 'Rewriting an edit that did nothing',
        what: 'The only model call in the FLUX Kontext path. When an edit comes back having ' +
              'changed almost nothing, this is shown the picture and asked to say the same ' +
              'change the way an editor can act on it, and the edit is drawn once more.',
        model: editModel(),
        text: buildSystemPrompt(prompter.editTemplate, facts),
        followedBy: editUserMessage('<what you typed>'),
        editable: true,
        editIn: 'Drawing',
      },
      {
        id: 'planner',
        label: 'The edit planner',
        what: 'Shown a picture and a request, and splits it into steps, choosing a tool and a ' +
              'style for each. What it lists depends on what the image server can actually do, ' +
              'so this changes with the machine.',
        model: visionModel(),
        text: planner,
        editable: false,
        note: 'Read-only: its answer is parsed as JSON against a fixed contract, and the tool ' +
              'and style lists are built from what is installed.',
      },
    ].filter(p => p.text !== ''),
    style: { id: style, label: styleLabel(style) },
  })
})

export default router
