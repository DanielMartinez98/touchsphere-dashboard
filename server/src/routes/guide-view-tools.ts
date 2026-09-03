// Tools that let the assistant drive the game-guide UI, not just its data.
//
// The tools in dashboard-tools.ts answer questions and edit the store. These put
// things on the kiosk's screen and operate the guide as if a finger were doing
// it — open it, jump to a chapter, play a chapter's video, tick a whole chapter
// off, close it again — so anything reachable by tapping is also reachable by
// asking.
//
// They live here rather than in dashboard-tools because they return a
// `display` payload alongside the model's text (the BrowseToolResult shape), and
// chat.ts dispatches that family separately.

import {
  deleteGuide,
  guideProgress,
  loadGuide,
  setSectionDone,
  setStepDone,
  type Guide,
  type GuideSection,
  type GuideStep,
} from '../guides'
import { isGenerating, regenerateSection } from '../guide-generator'
import { pushGuide } from '../guide-events'
import { note } from '../guide-activity'
import { findByTitle, readMedia, type MediaItem } from './dashboard-tools'
import type { BrowseToolResult, DisplayPayload } from './browse'

// ── Resolving what the user said ─────────────────────────────────────────────

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The game plus its guide, or a sentence explaining why not. */
function resolveGuide(title: string): { item: MediaItem; guide: Guide } | string {
  const items = readMedia()
  const games = items.filter(i => i.type === 'game')
  const hit = title.trim()
    ? findByTitle(items, title)
    // No title given: if exactly one game has a guide, that's obviously the one.
    : (() => {
        const withGuides = games.filter(g => loadGuide(g.id))
        return withGuides.length === 1 ? withGuides[0] : undefined
      })()

  if (!hit) {
    const withGuides = games.filter(g => loadGuide(g.id))
    if (withGuides.length === 0) return 'There are no game guides yet. Offer to make one with create_game_guide.'
    return `Which game? There are guides for: ${withGuides.map(g => g.title).join(', ')}. Ask the user.`
  }
  const guide = loadGuide(hit.id)
  if (!guide) {
    return isGenerating(hit.id)
      ? `The guide for "${hit.title}" is still being built. Tell the user it isn't ready yet.`
      : `There is no guide for "${hit.title}" yet. Offer to make one with create_game_guide.`
  }
  return { item: hit, guide }
}

/** Find a chapter by number ("chapter 3"), exact title, or a distinctive part of one. */
function findChapter(guide: Guide, hint: string): GuideSection | undefined {
  const h = hint.trim()
  if (!h) return undefined
  const num = Number(h.replace(/^chapter\s*/i, '').trim())
  if (Number.isInteger(num) && num >= 1 && num <= guide.sections.length) {
    return guide.sections[num - 1]
  }
  return guide.sections.find(s => s.title.toLowerCase() === h.toLowerCase())
    ?? guide.sections.find(s => loose(s.title) === loose(h))
    ?? guide.sections.find(s => loose(s.title).includes(loose(h)))
    ?? guide.sections.find(s => loose(h).includes(loose(s.title)))
}

const chapterLine = (s: GuideSection, i: number) => {
  const done = s.steps.filter(x => x.done).length
  return `${i + 1}. ${s.title} (${done}/${s.steps.length})`
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const GUIDE_VIEW_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_guide_step',
      description:
        'Read the CURRENT step of a game guide aloud — the first unticked step of the chapter the player is ' +
        'on (or a chapter they name), with its explanation. For "read me the next step", "what do I do now", ' +
        '"where was I in the guide". Opens the guide on that chapter as well. Hands are on a controller: read ' +
        'the step as given, then stop and listen — "next" or "done" means next_guide_step.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: 'The game, if said. Omit when only one guide exists or one is on screen.' },
          chapter: { type: 'string', description: 'A chapter name or number, if they named one.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'next_guide_step',
      description:
        'Tick off the current step of a game guide and read the one after it. For "next", "done", "got it", ' +
        '"that\'s done" while working through a guide by voice. Same chapter as the last read_guide_step.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: 'The game, if said.' },
          chapter: { type: 'string', description: 'A chapter name or number, if they named one.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_game_guide',
      description:
        'Put a game guide FULL SCREEN on the dashboard so the user can read and tick it off. ' +
        'Use whenever they ask to see, open, pull up, or show a guide, walkthrough or checklist for a ' +
        'game they already have one for ("put the Majora\'s Mask guide up", "show me my Hollow Knight ' +
        'checklist"), and when they ask for a specific part of it ("open the Woodfall Temple chapter", ' +
        '"show me chapter 3", "what\'s left in the masks list"). Pass `chapter` to open straight to that ' +
        'chapter — by its name or its number. Without `chapter` it shows the chapter list. ' +
        'This only displays an existing guide; use create_game_guide to research a new one.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: "The game's title. Omit if only one game has a guide." },
          chapter: { type: 'string', description: 'Optional chapter name or number to open directly.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_screen',
      description:
        'Clear whatever you have put on the dashboard screen — a video, a web page, or a game guide. ' +
        'Use when the user says "close that", "clear the screen", "I\'m done with the guide", "turn it off".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_guide_video',
      description:
        'Play the walkthrough video that belongs to a game guide, or to one chapter of it. ' +
        'Use for "play the video for this chapter", "show me the Woodfall Temple walkthrough video", ' +
        '"put the full walkthrough on". Pass `chapter` for that chapter\'s video, or omit it for the ' +
        "whole game's walkthrough. Prefer this over play_video when the game has a guide, because these " +
        'videos were already picked during research.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: "The game's title. Omit if only one game has a guide." },
          chapter: { type: 'string', description: "Chapter name or number. Omit for the whole game's walkthrough." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_off_guide_chapter',
      description:
        'Tick off (or clear) EVERY step in one chapter of a game guide at once. Use when the user reports ' +
        'finishing a whole chapter — "I finished Woodfall Temple", "done with chapter 2", "I\'ve got all ' +
        'the masks". Pass done=false to clear a chapter they want to redo. ' +
        'For a single step use check_off_guide_step instead.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: "The game's title. Omit if only one game has a guide." },
          chapter: { type: 'string', description: 'Chapter name or number.' },
          done:    { type: 'boolean', description: 'true to tick the whole chapter off (default), false to clear it.' },
        },
        required: ['chapter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerate_guide_chapter',
      description:
        'Research and rewrite ONE chapter of a game guide, leaving the rest of the guide and every ' +
        'other ticked step alone. Use when the user complains about one part of a guide — "the Snowhead ' +
        'Temple chapter is empty", "chapter 4 has no detail", "redo the masks list". ' +
        'Prefer this strongly over create_game_guide when the problem is one chapter: rebuilding the ' +
        'whole guide throws away all of their progress. It takes a minute or two and fills in on screen.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string', description: "The game's title. Omit if only one game has a guide." },
          chapter: { type: 'string', description: 'Chapter name or number to rewrite.' },
        },
        required: ['chapter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_guide_chapters',
      description:
        "Read out a game guide's chapters with each one's progress, so you can tell the user what a guide " +
        'contains or what to do next ("what chapters are in my guide?", "what should I do next?"). ' +
        'This does not put anything on screen — use show_game_guide for that.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "The game's title. Omit if only one game has a guide." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_game_guide',
      description:
        'Delete a game guide and everything ticked off in it. Only when the user clearly asks to get rid ' +
        'of it ("delete the Celeste guide", "throw that guide away"). To make a fresh one in a different ' +
        'order, use create_game_guide with `order` instead — that replaces it without a separate delete.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "The game's title." },
        },
        required: ['title'],
      },
    },
  },
] as const

// ── Handlers ─────────────────────────────────────────────────────────────────

const noDisplay = (text: string): BrowseToolResult => ({ text, display: null })

function showGuide(title: string, chapterHint: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found

  let chapter: GuideSection | undefined
  if (chapterHint.trim()) {
    chapter = findChapter(guide, chapterHint)
    if (!chapter) {
      return noDisplay(
        `"${chapterHint}" isn't a chapter in the guide for ${guide.title}. Its chapters are: ` +
        `${guide.sections.map((s, i) => chapterLine(s, i)).join('; ')}. Ask which one they meant.`,
      )
    }
  }

  const display: DisplayPayload = {
    kind: 'guide',
    itemId: item.id,
    title: guide.title || item.title,
    ...(chapter ? { chapter: chapter.id } : {}),
  }
  const p = guideProgress(guide)
  console.log(`[chat:tool] show_game_guide → ${item.id}${chapter ? ` § ${chapter.title}` : ''}`)

  if (chapter) {
    const done = chapter.steps.filter(s => s.done).length
    const remaining = chapter.steps.filter(s => !s.done).slice(0, 3).map(s => `"${s.text}"`)
    return {
      text:
        `The "${chapter.title}" chapter of the guide for ${guide.title} is now full screen on the user's ` +
        `dashboard — ${done} of ${chapter.steps.length} steps ticked off` +
        `${remaining.length > 0 ? `, next up: ${remaining.join(', ')}` : ', all done'}. ` +
        `Say one short sentence about what is on screen. Do not read the whole list aloud.`,
      display,
    }
  }
  return {
    text:
      `The guide for ${guide.title} is now full screen on the user's dashboard: ${guide.sections.length} ` +
      `chapters, ${p.percent}% complete (${p.counted.done} of ${p.counted.total} steps). ` +
      `Say one short sentence about what is on screen. Do not read the chapter list aloud.`,
    display,
  }
}

/**
 * Where the player is: the named chapter, else the first chapter with a step
 * left, else nothing. A chapter that is still generating has no steps yet
 * and is skipped over rather than read as "done".
 */
function currentChapter(guide: Guide, hint: string): GuideSection | undefined {
  if (hint.trim()) return findChapter(guide, hint)
  return guide.sections.find(s => s.steps.some(x => !x.done))
}

function stepText(guide: Guide, chapter: GuideSection, step: GuideStep, i: number): string {
  const sub = step.subs?.filter(x => !x.done).map(x => x.text) ?? []
  return (
    `Chapter "${chapter.title}", step ${i + 1} of ${chapter.steps.length}: ${step.text}.` +
    `${step.note ? ` ${step.note}` : ''}` +
    `${sub.length ? ` It breaks down into: ${sub.join('; ')}.` : ''}` +
    ` (${guide.title}.) Read the step and its explanation aloud, close to as written, then stop — ` +
    `they will say "next" or "done" when ready, which means next_guide_step.`
  )
}

function readStep(title: string, chapterHint: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found
  const chapter = currentChapter(guide, chapterHint)
  if (!chapter) {
    return chapterHint.trim()
      ? noDisplay(`"${chapterHint}" isn't a chapter in the guide for ${guide.title}. Its chapters are: ${guide.sections.map((s, i) => chapterLine(s, i)).join('; ')}.`)
      : noDisplay(`Every step in the guide for ${guide.title} is ticked off. Congratulate them, or ask which chapter to redo.`)
  }
  const i = chapter.steps.findIndex(s => !s.done)
  if (i < 0) return noDisplay(`Every step in "${chapter.title}" is done. Offer the next chapter: ${guide.sections.map((s, k) => chapterLine(s, k)).join('; ')}.`)
  const shown = showGuide(item.title, chapter.title)
  return { text: stepText(guide, chapter, chapter.steps[i]!, i), display: shown.display }
}

function nextStep(title: string, chapterHint: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found
  const chapter = currentChapter(guide, chapterHint)
  if (!chapter) return noDisplay(`Nothing left to tick off in the guide for ${guide.title}.`)
  const i = chapter.steps.findIndex(s => !s.done)
  if (i < 0) return noDisplay(`"${chapter.title}" is already complete. Offer the next chapter.`)
  const step = chapter.steps[i]!
  // Same store write as a tap on the box, so the bar on screen moves under
  // their eyes and the tick survives a restart.
  const saved = setStepDone(item.id, chapter.id, step.id, true)
  if (!saved) return noDisplay(`Couldn't tick "${step.text}" — try again.`)
  pushGuide(saved)
  note({ itemId: item.id, title: saved.title, section: chapter.title, stage: 'progress', level: 'info', message: `Ticked "${step.text}" by voice` })
  const fresh = saved.sections.find(s => s.id === chapter.id) ?? chapter
  const j = fresh.steps.findIndex(s => !s.done)
  const p = guideProgress(saved)
  console.log(`[chat:tool] next_guide_step → ${chapter.title} #${i + 1} done (${p.percent}%)`)
  if (j < 0) {
    const after = saved.sections.find(s => s.steps.some(x => !x.done))
    return noDisplay(
      `Ticked "${step.text}" — that finishes "${chapter.title}"` +
      `${after ? `. The next chapter is "${after.title}"; offer to read its first step` : `, and the whole guide is ${p.percent}% done`}.`,
    )
  }
  const shown = showGuide(item.title, chapter.title)
  return { text: `Ticked "${step.text}". ` + stepText(saved, fresh, fresh.steps[j]!, j), display: shown.display }
}

function closeScreen(): BrowseToolResult {
  console.log('[chat:tool] close_screen')
  return {
    text: "Cleared the dashboard screen. Acknowledge it in a few words — don't describe what was there.",
    display: { kind: 'close' },
  }
}

function playGuideVideo(title: string, chapterHint: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { guide } = found

  let label = guide.title
  let video = guide.video
  if (chapterHint.trim()) {
    const chapter = findChapter(guide, chapterHint)
    if (!chapter) {
      return noDisplay(
        `"${chapterHint}" isn't a chapter in the guide for ${guide.title}. Its chapters are: ` +
        `${guide.sections.map(s => s.title).join(', ')}.`,
      )
    }
    label = `${guide.title} — ${chapter.title}`
    video = chapter.video
    if (!video) {
      return noDisplay(
        `The "${chapter.title}" chapter has no video saved. Offer to search YouTube for one with play_video.`,
      )
    }
  }
  if (!video) {
    return noDisplay(
      `The guide for ${guide.title} has no overall walkthrough video saved. Offer to search for one with play_video.`,
    )
  }

  console.log(`[chat:tool] play_guide_video → ${video.videoId} (${label})`)
  return {
    text:
      `Now playing on the user's screen: "${video.title}"${video.channel ? ` by ${video.channel}` : ''} ` +
      `(the ${label} walkthrough). Name it in one short sentence — do not read out the URL.`,
    display: {
      kind: 'video',
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      title: video.title,
      videoId: video.videoId,
      ...(video.channel ? { channel: video.channel } : {}),
    },
  }
}

function checkOffChapter(title: string, chapterHint: string, done: boolean): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found

  const chapter = findChapter(guide, chapterHint)
  if (!chapter) {
    return noDisplay(
      `"${chapterHint}" isn't a chapter in the guide for ${guide.title}. Its chapters are: ` +
      `${guide.sections.map((s, i) => chapterLine(s, i)).join('; ')}. Ask which one they meant.`,
    )
  }
  if (chapter.steps.length === 0) {
    return noDisplay(`The "${chapter.title}" chapter has no steps to tick off.`)
  }

  const changed = chapter.steps.filter(s => s.done !== done).length
  if (changed === 0) {
    return noDisplay(`Every step in "${chapter.title}" is already marked ${done ? 'done' : 'not done'}.`)
  }

  // Shares the store's bulk write with the tap path, so a spoken "I finished
  // Woodfall" and the chapter list's tick button do exactly the same thing.
  const saved = setSectionDone(item.id, chapter.id, done)
  if (!saved) return noDisplay(`Couldn't update the "${chapter.title}" chapter — try again.`)
  pushGuide(saved)
  note({
    itemId: item.id, title: saved.title, section: chapter.title, stage: 'progress', level: 'info',
    message: `Marked the whole chapter ${done ? 'done' : 'not done'} (${chapter.steps.length} steps) by voice`,
  })

  const p = guideProgress(saved)
  console.log(`[chat:tool] check_off_guide_chapter → ${chapter.title} ${done ? 'done' : 'cleared'} (${p.percent}%)`)
  return noDisplay(
    `Marked all ${chapter.steps.length} steps in "${chapter.title}" as ${done ? 'done' : 'not done'} ` +
    `(${changed} changed). ${guide.title} is now ${p.percent}% complete ` +
    `(${p.counted.done} of ${p.counted.total} steps). Confirm in one short sentence.`,
  )
}

function regenerateChapter(title: string, chapterHint: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found

  const chapter = findChapter(guide, chapterHint)
  if (!chapter) {
    return noDisplay(
      `"${chapterHint}" isn't a chapter in the guide for ${guide.title}. Its chapters are: ` +
      `${guide.sections.map((s, i) => chapterLine(s, i)).join('; ')}. Ask which one they meant.`,
    )
  }

  const result = regenerateSection(item.id, chapter.id)
  if (result === 'busy') {
    return noDisplay(
      `Something is already being researched for "${guide.title}" (${guide.phase ?? 'in progress'}). ` +
      `Tell the user to give it a moment, and do not start another.`,
    )
  }
  if (result === 'missing') return noDisplay(`Couldn't find that chapter to rewrite.`)

  const ticked = chapter.steps.filter(s => s.done).length
  console.log(`[chat:tool] regenerate_guide_chapter → "${guide.title}" § ${chapter.title}`)
  return {
    text:
      `Started re-researching the "${chapter.title}" chapter of ${guide.title}. It takes a minute or two ` +
      `and fills in on screen; the rest of the guide is untouched` +
      (ticked > 0 ? `, and steps they had already ticked off stay ticked if they survive the rewrite` : '') +
      `. Confirm in one short sentence.`,
    // Put the guide up so they can watch it fill in, straight to that chapter.
    display: {
      kind: 'guide',
      itemId: item.id,
      title: guide.title || item.title,
      chapter: chapter.id,
    } satisfies DisplayPayload,
  }
}

function listChapters(title: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { guide } = found
  const p = guideProgress(guide)
  const nextUp = guide.sections.find(s => s.steps.some(x => !x.done))
  return noDisplay(
    `"${guide.title}" — ${p.percent}% complete, organized ${guide.organization}\n` +
    guide.sections.map((s, i) => `${chapterLine(s, i)}${s.counts ? '' : ' [reference, not counted]'}`).join('\n') +
    (nextUp ? `\nFirst chapter with anything left: ${nextUp.title}.` : '\nEverything is ticked off.') +
    `\nSummarize in one or two short sentences — do not read every chapter aloud unless asked.`,
  )
}

function deleteGuideTool(title: string): BrowseToolResult {
  const found = resolveGuide(title)
  if (typeof found === 'string') return noDisplay(found)
  const { item, guide } = found
  const p = guideProgress(guide)
  const removed = deleteGuide(item.id)
  if (!removed) return noDisplay(`There is no guide for "${item.title}" to delete.`)
  note({
    itemId: item.id, title: guide.title, stage: 'deleted', level: 'warn',
    message: `Deleted by voice, along with ${p.all.done} ticked step(s)`,
  })
  return {
    text:
      `Deleted the guide for ${guide.title}, along with the ${p.all.done} step(s) that were ticked off. ` +
      `Confirm in one short sentence.`,
    // Whatever was on screen is now gone; clearing it avoids a dead guide sitting there.
    display: { kind: 'close' },
  }
}

/** Dispatch for the guide-view tools. Returns null for names it doesn't own. */
export async function runGuideViewTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BrowseToolResult | null> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'show_game_guide':        return showGuide(str('title'), str('chapter'))
    case 'read_guide_step':        return readStep(str('title'), str('chapter'))
    case 'next_guide_step':        return nextStep(str('title'), str('chapter'))
    case 'close_screen':           return closeScreen()
    case 'play_guide_video':       return playGuideVideo(str('title'), str('chapter'))
    case 'check_off_guide_chapter': {
      const done = typeof args['done'] === 'boolean' ? (args['done'] as boolean) : true
      return checkOffChapter(str('title'), str('chapter'), done)
    }
    case 'regenerate_guide_chapter': return regenerateChapter(str('title'), str('chapter'))
    case 'list_guide_chapters':    return listChapters(str('title'))
    case 'delete_game_guide':      return deleteGuideTool(str('title'))
    default: return null
  }
}

/** Guide-view tools that change stored state, for the chat route's refetch hints. */
export const GUIDE_VIEW_MUTATING = new Set([
  'next_guide_step',
  'check_off_guide_chapter',
  'regenerate_guide_chapter',
  'delete_game_guide',
])
