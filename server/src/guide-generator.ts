// Builds a game guide from online research, in the background.
//
// OVERVIEW FIRST, THEN DETAIL — at both levels, and for the same reason: every
// model call has to be short enough to finish. A local model asked for a long
// answer doesn't answer badly, it stops partway, and half a JSON object parses
// as nothing at all. So nothing here is ever asked for a lot at once:
//
//   1. OUTLINE — research how this game's community lays a guide out, then one
//      model call for the section list ("Woodfall Temple", "Masks", "Heart
//      Pieces"...) plus which of those sections count toward 100%.
//   2a. STEP LIST — per section, a targeted search + page read, then one call
//      for the steps as bare one-line strings. Saved and broadcast immediately:
//      the chapter is a working, tickable checklist from this moment.
//   2b. DETAIL — the same steps in batches of a few, one call per batch, asking
//      only for the note on each. Written straight into the stored guide as
//      each batch lands.
//
// The guide is saved and broadcast throughout, so the view fills in as it goes
// instead of showing a spinner for five minutes — and a failure late in a
// chapter costs the explanations, not the chapter.
//
// Why not run this through the chat tool loop: tool results are truncated to
// 8000 chars and the loop is capped at 5 rounds (see chat.ts), neither of which
// fits reading several pages and emitting a few hundred steps. The assistant
// starts this job and answers immediately; the job outlives the conversation.
//
// Nothing here throws. A failed section is marked failed and the rest continue;
// a fatal error lands in guide.error with status 'failed' so the UI can offer
// Retry. Generation is in-memory only — a restart mid-job is swept to 'failed'
// by guides.ts sweepInterrupted() rather than resumed.

import crypto from 'crypto'
import {
  GUIDE_CAPS,
  guideProgress,
  loadGuide,
  patchGuide,
  saveGuide,
  SECTION_KINDS,
  type Guide,
  type GuideSection,
  type GuideStep,
  type SectionKind,
  type GuideImage,
} from './guides'
import {
  communityChapters,
  communityQuery,
  communityTableOfContents,
  gameQualifier,
  mentionsGame,
  researchGame,
  researchPages,
  SEARCH_PROVIDER,
  type ChapterCategory,
  type Page,
  findGameWiki,
  wikiGameMap,
  wikiImageFor,
  wikiMapFor,
} from './research'
import { pushGuide } from './guide-events'
import { note } from './guide-activity'
import { cacheGuideImage } from './guide-media'
import { searchYouTube } from './routes/browse'

const OLLAMA_URL     = process.env['OLLAMA_URL']     ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']   ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''

/**
 * The model that writes guides, which need not be the one that holds the
 * conversation. The chat model is chosen for latency — someone is standing at
 * the kiosk waiting for a sentence. Nobody is waiting on this: a guide is a
 * dozen calls over several minutes of background work, and it is the one place
 * in the app where a slower, stronger model costs nothing anyone can perceive.
 * Synthesizing 26k characters of research into a route is also simply a harder
 * job than answering "what's the weather", so the small model that is right for
 * the voice loop is the wrong place to economize here.
 */
const GUIDE_MODEL = process.env['OLLAMA_GUIDE_MODEL'] ?? OLLAMA_MODEL

// Generous compared to the 30 s the conversation gets: nobody is waiting on a
// spoken reply here, and a section of forty steps is a lot of tokens for a
// model running on a box that is also driving the voice pipeline.
const TIMEOUT_MS = Number(process.env['OLLAMA_GUIDE_TIMEOUT_MS'] ?? 180_000)

// THE most important number in this file. Ollama defaults num_ctx to 4096 tokens
// and silently discards whatever doesn't fit — from the FRONT of the prompt,
// which is exactly where the research notes are. Left at the default, a section
// prompt carrying two pages of wiki text reaches the model as instructions with
// the evidence sheared off, and the model then writes four vague steps because
// four vague steps is all it can see. Every "the guide isn't detailed" symptom
// traces back here. Lower it only on a box that can't hold the KV cache.
const NUM_CTX = Number(process.env['OLLAMA_GUIDE_NUM_CTX'] ?? 16384)

const TARGET_SECTIONS = 12                       // asked for; capped by GUIDE_CAPS.MAX_SECTIONS
const YOUTUBE_GAP_MS  = 400                      // politeness gap between video lookups

/**
 * Whether to ask the open web before the wiki.
 *
 * Only on the hosted provider, and the difference is not subtle: it returns the
 * page's full text inline — tens of thousands of characters of an actual
 * walkthrough — where the scraped path returns a URL this server then has to
 * fetch, and the walkthrough sites worth reading answer that fetch with a
 * Cloudflare interstitial. So with a key the open web is the best source
 * available; without one it is a CAPTCHA generator, and the wiki-first order is
 * correct. Same config, opposite right answer.
 */
const WEB_FIRST = SEARCH_PROVIDER === 'ollama'

// Per-page budgets. Outline pages only have to convey how the game is divided
// up; a section's pages have to contain the actual walkthrough, so they get
// room. A wiki dungeon article runs 20–40k chars and the walkthrough is usually
// in the middle of it, well past where the old 6000-char cut landed.
const OUTLINE_CHARS = 8000
const SECTION_CHARS = 14000

/** A section researched from less than this has nothing to write steps from. */
const SECTION_MIN_CHARS = 4000
/** …and past this there's more than the context window should carry. */
const SECTION_MAX_CHARS = 26000

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── Single-flight ────────────────────────────────────────────────────────────
// One guide at a time, whatever the dashboard asks for. Two concurrent jobs
// would have the Pi's Ollama box swapping models under the voice loop, which is
// how a "make me a guide" turns into an assistant that stops answering.
// Same promise-chain trick as withRVCLock in routes/tts.ts.

let queue: Promise<void> = Promise.resolve()
const inFlight = new Set<string>()

function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn, fn)
}

export function isGenerating(itemId: string): boolean {
  return inFlight.has(itemId)
}

// ── Ollama, structured ───────────────────────────────────────────────────────

interface JsonSchema { [k: string]: unknown }

function stripFence(raw: string): string {
  // Small models like to wrap JSON in ```json fences even when asked not to.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? raw).trim()
  // And to prepend a sentence. Take the outermost object if one is in there.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

async function postChat(
  messages: Array<{ role: string; content: string }>,
  format: JsonSchema | 'json',
): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      // No `tools` here on purpose: this call has one job, which is to emit JSON.
      // think:false for the same reason as the chat route — a reasoning model
      // puts its answer in `thinking` and leaves `content` empty.
      body: JSON.stringify({
        model: GUIDE_MODEL,
        stream: false,
        think: false,
        format,
        messages,
        // num_ctx: see the constant. num_predict is generous rather than large:
        // no single call here is asked for more than a list of short strings or
        // a handful of notes, precisely so none of them can run long enough to
        // be cut off mid-JSON — a truncated object parses as nothing at all.
        options: { num_ctx: NUM_CTX, num_predict: 3072, temperature: 0.3 },
      }),
    })
    if (!res.ok) {
      console.warn(`[guides] ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      return null
    }
    const json = (await res.json()) as { message?: { content?: string }; response?: string }
    return (json.message?.content ?? json.response ?? '').trim() || null
  } catch (err) {
    console.warn('[guides] ollama error:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One JSON call, with a fallback for older Ollama builds. `format: <schema>`
 * (0.5+) constrains generation so the reply can't be prose; where that isn't
 * supported the schema is only advisory, so the retry asks for `format: 'json'`
 * and puts the shape in the prompt instead.
 */
async function callOllamaJson<T>(
  label: string,
  system: string,
  user: string,
  schema: JsonSchema,
): Promise<T | null> {
  const attempts: Array<JsonSchema | 'json'> = [schema, 'json']
  for (let i = 0; i < attempts.length; i++) {
    const format = attempts[i]!
    const content = i === 0
      ? user
      : `${user}\n\nReply with JSON matching exactly this schema, and nothing else:\n${JSON.stringify(schema)}`
    const raw = await postChat([{ role: 'system', content: system }, { role: 'user', content }], format)
    if (!raw) continue
    try {
      return JSON.parse(stripFence(raw)) as T
    } catch {
      console.warn(`[guides] ${label}: unparseable JSON on attempt ${i + 1} — ${raw.slice(0, 160).replace(/\s+/g, ' ')}`)
    }
  }
  return null
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const OUTLINE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    organization: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:   { type: 'string' },
          kind:    { type: 'string', enum: [...SECTION_KINDS] },
          counts:  { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['title', 'kind', 'counts'],
      },
    },
  },
  required: ['organization', 'sections'],
}

// A chapter is written in two passes, and each has its own small schema.
//
// It used to be one call: "here are 26,000 characters of research, now give me
// thirty steps each with a note." That is several thousand tokens of JSON from
// one generation, and on a local model it either runs past the timeout or stops
// mid-object — and a truncated object doesn't parse, so the whole chapter lands
// empty. The length of the answer was the failure.
//
// Now: pass one asks only for the step TEXTS (short, and the model can hold the
// whole shape in view), which is saved and broadcast immediately so the chapter
// is usable. Pass two walks those steps in small batches asking only for the
// note on each. Every call is small enough to finish, and a failure costs one
// batch of detail rather than the chapter.

// Pass one returns the chapter already divided into its own sub-chapters —
// "Getting there", "The central chamber", "Boss: Odolwa" — each with its steps.
// It's flattened into the one ordered step list the rest of the system works on,
// with the part name kept on each step as `group` (see GuideStep in guides.ts).
// Asking for the division and the steps together costs nothing: naming the parts
// is what makes the model lay a long chapter out in order instead of drifting.
const STEP_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          part:  { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: ['part', 'steps'],
      },
    },
  },
  required: ['parts'],
}

const DETAILS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n:    { type: 'integer' },
          note: { type: 'string' },
          // The actions a step breaks into, each of which becomes its own
          // checkbox. Optional: a step that is genuinely one action must be
          // allowed to stay one action rather than be padded into three.
          subs: { type: 'array', items: { type: 'string' } },
          // Where on the map this happens, in words — see mapPosition(). The
          // model cannot see the map, so a compass phrase is the most it can
          // honestly offer and the UI presents the resulting pin as approximate.
          where: { type: 'string' },
        },
        required: ['n', 'note'],
      },
    },
  },
  required: ['details'],
}

interface OutlineReply {
  organization?: unknown
  sections?: Array<{ title?: unknown; kind?: unknown; counts?: unknown; summary?: unknown }>
}
interface StepListReply {
  parts?: Array<{ part?: unknown; steps?: unknown }>
  /** Tolerated: a model that ignores the parts and just lists steps. */
  steps?: unknown[]
}
interface DetailsReply {
  details?: Array<{ n?: unknown; note?: unknown; subs?: unknown; where?: unknown }>
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM = 'You are a meticulous game-guide editor. You answer only with JSON. ' +
  'You never invent game content: everything you write comes from the research notes you are given.'

function researchBlock(pages: Page[]): string {
  if (pages.length === 0) return '(no research available)'
  return pages
    .map((p, i) => `--- SOURCE ${i + 1}: ${p.title} (${p.site}) ---\n${p.text}`)
    .join('\n\n')
}

function outlinePrompt(
  title: string,
  order: string | undefined,
  pages: Page[],
  toc: string[],
  chapters: ChapterCategory[],
): string {
  return (
    `Game: ${title}\n\n` +
    `Below are notes from community guides and wikis for this game.\n\n` +
    `${researchBlock(pages)}\n\n` +
    // The strongest signal in the prompt, and the only one that is a fact rather
    // than an inference: these lists come straight off the wiki's own per-game
    // categories, so they name the real places, in the real game, exhaustively.
    (chapters.length > 0
      ? `THE GAME'S OWN CONTENTS, as this game's wiki files them. These are real and complete — ` +
        `use them as the backbone of the guide:\n` +
        chapters.map(c => `- ${c.label}: ${c.members.join(', ')}`).join('\n') + `\n\n`
      : '') +
    (toc.length > 0
      ? `The community wiki's article about this game also has these sections, which may hint at what ` +
        `else is tracked:\n${toc.map(t => `- ${t}`).join('\n')}\n\n`
      : '') +
    `TASK: design the table of contents for a completion guide to this game, ` +
    `structured THE WAY THIS GAME'S OWN COMMUNITY STRUCTURES IT. Look at how the sources above ` +
    `divide the game up and mirror that — if they are organized by dungeon, use one section per ` +
    `dungeon; if by chapter, region, act, or boss, use that instead. Then add the collectible and ` +
    `side-content lists that community tracks for 100% completion (for example masks, heart pieces, ` +
    `key items, side quests) as their own sections.\n\n` +
    // Without this the model reliably produced a plot summary. The research it is
    // handed is largely encyclopedic, and an encyclopedia's own shape is the path
    // of least resistance — so the wrong answer has to be named explicitly.
    `A CHAPTER IS A PLACE OR A TASK, NEVER A PLOT BEAT. Chapters are the things a player DOES and ` +
    `can tick off — "Woodfall Temple", "Snowhead Temple", "Pirates' Fortress". They are NOT the ` +
    `acts of the story: "Arrival to a Doomed Land", "The Boy Without a Fairy" and "The Final Battle" ` +
    `are chapter names taken from a plot summary, and they are WRONG — a player cannot tick off a ` +
    `plot summary. If this game has dungeons, temples, levels or missions, THOSE are the ` +
    `progression chapters, one each, and there are usually eight or more of them. Never collapse ` +
    `several dungeons into one chapter called "The Four Giants" or "The Dungeons".\n` +
    (order
      ? `THE USER HAS OVERRIDDEN THE ORDER. Organize it like this instead, and follow it literally: "${order}"\n`
      : '') +
    `\nRules:\n` +
    `- Between 4 and ${TARGET_SECTIONS} sections, in the order the player meets them.\n` +
    `- Every section title must name something from THIS game, "${title}". Never a place, item or ` +
    `boss from another game in the same series.\n` +
    `- "kind": "progression" for story/dungeon/chapter sections, "collectible" for lists of things to ` +
    `collect, "sidequest" for optional quests, "reference" for pure reference tables (controls, enemy ` +
    `stats, item prices) that a player does not "complete".\n` +
    `- "counts": true if finishing that section is part of 100% completion, false for reference sections.\n` +
    `- "summary": at most one short sentence.\n` +
    `- "organization": one short sentence naming the structure you used, e.g. ` +
    `"by dungeon, then masks and heart pieces, the way the Zelda community tracks it".\n` +
    `- Use the game's real names for places and items, spelled as the sources spell them.`
  )
}

/**
 * The research block goes FIRST and byte-identical in both passes on purpose:
 * Ollama caches the KV for a shared prompt prefix, so the ~7k tokens of wiki
 * text are processed once for a chapter and reused by every detail batch after
 * it. Put anything section-specific ahead of it and each batch pays full price.
 */
function chapterPreamble(title: string, section: GuideSection, pages: Page[]): string {
  return (
    `Research notes:\n\n${researchBlock(pages)}\n\n` +
    `Game: ${title}\nSection: ${section.title}\n\n`
  )
}

/** Pass one: the chapter's skeleton — step texts only, no notes. */
function stepListPrompt(
  title: string,
  section: GuideSection,
  pages: Page[],
  expected: number | null,
): string {
  // What a step has to TEACH differs per kind, and that matters more than wording.
  // "Clear Woodfall Temple" and "Bunny Hood" are both useless steps — they restate
  // what the player already knew they had to do.
  const shape = section.kind === 'collectible'
    ? `This is a COLLECTIBLE LIST — one step per collectible, named exactly as the sources name it, in ` +
      `the sources' order. Be complete: if the sources say there are 24 masks, list 24, not a sample.\n` +
      `Group them the way the sources group them — by how they're obtained, by region, or by which are ` +
      `needed for completion ("Transformation masks", "Sold in Clock Town", "Sidequest rewards").`
    : section.kind === 'sidequest'
      ? `This is a SIDE-QUEST LIST — one step per quest, named as the sources name it. Group the quests ` +
        `by where or when they're taken on.`
      : section.kind === 'reference'
        ? `This is REFERENCE material — one step per entry, kept short. Group entries by category.`
        : `This is a WALKTHROUGH section, and it must be a real route — someone who has never played ` +
          `should be able to get through this part with nothing but these steps. Be specific enough to ` +
          `act on ("Shoot an ice arrow at the water to freeze a stepping stone"), never vague ("solve ` +
          `the water puzzle").\n` +
          `Divide it into the parts the player experiences in order — typically: getting there and ` +
          `opening the way in; then the areas or floors of the place itself, one part each; then the ` +
          `mini-boss; then the boss. Name the parts after the real places and bosses, not "Part 1".`

  const count = section.kind === 'progression'
    ? `- 3 to 6 parts, 3 to 8 steps in each. A dungeon described in five steps total has been ` +
      `summarized, not written.\n`
    : `- 2 to 6 parts. One step per real entry, ${GUIDE_CAPS.MAX_STEPS_PER_SECTION} steps across the ` +
      `whole section at most.\n`

  return (
    chapterPreamble(title, section, pages) +
    `TASK: lay out the checklist for THIS SECTION ONLY, divided into its own parts — just the parts and ` +
    `the steps in them. Do NOT explain the steps; the explanations are asked for separately ` +
    `afterwards.\n${shape}\n\n` +
    `Rules:\n` +
    `- "part": a short heading naming that stretch of the section, a few words, no numbering.\n` +
    `- Each step is one short imperative line, under 160 characters. No step numbers — the app ` +
    `numbers them. No sub-bullets, no explanation, no commentary.\n` +
    // The model's escape hatch when the notes don't actually list the things is
    // to enumerate the count instead of the contents — thirteen rows of "Collect
    // 4 Pieces of Heart for Heart Container N". Name that failure and give it a
    // legitimate way out (write fewer, real ones).
    `- NEVER write a numbered placeholder. "Obtain Heart Container 1 from boss", "Collect 4 Pieces ` +
    `of Heart for Heart Container 2", "Defeat Boss 3" are all FORBIDDEN: a step that differs from ` +
    `its neighbour only by a digit tells the player nothing. Every step must name the actual thing ` +
    `and where it is. If the notes only say how MANY there are and not which, write only the ones ` +
    `the notes actually name, however few that is.\n` +
    (expected !== null
      ? `- The sources say there are ${expected} of these in total. List all ${expected} if the notes ` +
        `name them; a partial list is misleading because the player will read it as complete.\n`
      : '') +
    count +
    `- The parts run in the order the player meets them, and the steps within a part likewise.\n` +
    `- Use the game's real names for places, items, characters and moves, spelled as the sources spell ` +
    `them. "Use the Hookshot on the target above the door", not "use your grappling tool".\n` +
    `- Only parts and steps the research notes support. Do not invent content.\n` +
    // The notes can still contain a stray paragraph about a sibling game, and
    // "write only from the notes" then reads as permission to use it.
    `- EVERYTHING you write must be about ${title} specifically. If any of the notes above turn out ` +
    `to describe a different game in the same series, ignore those notes completely — do not write ` +
    `steps from them.\n` +
    `- Reply as {"parts": [{"part": "Getting there", "steps": ["first step", "second step"]}, …]} ` +
    `and nothing else.`
  )
}

/**
 * Pass two: the detail on one batch of steps. Steps arrive pre-numbered and the
 * reply is keyed by that number, so a batch that comes back short or out of
 * order still lands on the right steps instead of shifting every note by one.
 */
function detailsPrompt(
  title: string,
  section: GuideSection,
  pages: Page[],
  batch: Array<{ n: number; text: string; group?: string | undefined }>,
): string {
  const want = section.kind === 'collectible'
    ? `HOW TO GET IT: where it is, what you need to have first, and what you actually do to obtain it ` +
      `("Beneath the Deku Palace in the Bean Seller's cave. Play the Song of Storms to water the magic ` +
      `bean, then ride it up to the ledge"). A list that only names the collectibles is worthless — the ` +
      `method is the whole reason the player opened it.`
    : section.kind === 'sidequest'
      ? `who gives the quest, where and when to find them, what it requires, and what it rewards.`
      : section.kind === 'reference'
        ? `the concrete figures or facts for that entry, kept to one line.`
        : `what makes the step doable: the exact location, the method, the tactic for a fight (what hurts ` +
          `it, what to dodge, the order of the phases), or the thing you need to have first.`

  return (
    chapterPreamble(title, section, pages) +
    `These are steps ${batch[0]!.n}–${batch[batch.length - 1]!.n} of this section's checklist. ` +
    `The headings tell you which part of the section each step belongs to:\n` +
    batch
      .map((s, i) => {
        // Re-announce the part whenever it changes, so a batch that straddles a
        // boundary doesn't leave the model guessing where it is.
        const head = s.group && s.group !== batch[i - 1]?.group ? `[${s.group}]\n` : ''
        return `${head}${s.n}. ${s.text}`
      })
      .join('\n') + `\n\n` +
    `TASK: for EACH numbered step above, write one short note giving ${want}\n\n` +
    // The single biggest complaint about the guides this replaced was that the
    // steps were not detailed enough to act on. A note is prose you read; subs
    // are the thing you actually do, in order, with a box beside each — which is
    // what turns "solve the water puzzle" into something a player can follow.
    `ALSO, for any step that is really several actions in sequence, break it into ` +
    `"subs": 2 to 5 short imperative lines, in order, each one thing the player does. ` +
    `Only when the notes actually describe those actions — never invent the middle of a ` +
    `sequence to reach a count. A step that is genuinely one action gets no "subs" at all.\n` +
    `AND, when the notes say where in the game world the step happens, give "where": a short ` +
    `position on the map in plain words — "north-west", "centre", "south-east corner", or a ` +
    `named region if the notes give one. Omit it when the notes do not say.\n\n` +
    `Rules:\n` +
    `- One or two sentences per note. No preamble, no repeating the step text back.\n` +
    `- Each sub is under 120 characters, imperative, and never repeats the step text.\n` +
    `- Only what the research notes support. If the notes genuinely say nothing about a step, give it ` +
    `an empty note rather than inventing a location or a tactic.\n` +
    `- Use the game's real names, spelled as the sources spell them.\n` +
    `- Cover every number listed above, and use those same numbers in "n".\n` +
    `- Reply as {"details": [{"n": ${batch[0]!.n}, "note": "…", "subs": ["…", "…"], "where": "north-west"}, …]} ` +
    `and nothing else. "subs" and "where" may be omitted.`
  )
}

// ── Generation ───────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Save a mutation and tell every connected dashboard about it. */
function update(itemId: string, mutate: (g: Guide) => void): Guide | null {
  const next = patchGuide(itemId, mutate)
  if (next) pushGuide(next)
  return next
}

async function buildOutline(itemId: string, title: string, order?: string, sourceSite?: string): Promise<{ guide: Guide; pages: Page[] } | null> {
  update(itemId, g => { g.phase = 'Reading community guides…' })

  // The game's own wiki article plus its walkthrough page: what the game is, and
  // how the community breaks it down. Their article headings come along too —
  // that's the community's literal table of contents.
  const [toc, chapters] = await Promise.all([
    communityTableOfContents(title),
    communityChapters(title),
  ])
  if (chapters.length > 0) {
    note({
      itemId, title, stage: 'research', level: 'good',
      message: `The wiki files this game's contents in ${chapters.length} list(s) — ` +
               chapters.map(c => `${c.label} (${c.members.length})`).join(', ') +
               `. These name the real chapters, so the outline is built on them`,
    })
  } else {
    note({
      itemId, title, stage: 'research', level: 'warn',
      message: 'The wiki has no per-game contents list for this game — the outline falls back to the ' +
               'article headings, which are a weaker signal',
    })
  }
  note({
    itemId, title, stage: 'research', level: toc.length > 0 ? 'info' : 'warn',
    message: toc.length > 0
      ? `Found the community's table of contents — ${toc.length} headings to organize around`
      : `No community table of contents found; the outline will be built from the pages alone`,
  })
  if (sourceSite) {
    note({
      itemId, title, stage: 'research', level: 'info',
      message: `Building from the requested source site first: ${sourceSite} (the wiki is the fallback)`,
    })
  }

  // Deduped by URL: both searches run against the same wiki, and when a game has
  // no separate walkthrough article they resolve to the same page — which would
  // otherwise be handed to the model twice, spending half the outline's context
  // on a copy of what it already read.
  const pages: Page[] = []
  for (const topic of ['', 'walkthrough 100% completion']) {
    const got = await researchGame(title, topic, {
      limit: 1,
      maxChars: OUTLINE_CHARS,
      ...(sourceSite ? { preferredSite: sourceSite } : {}),
      // The bare-topic pass is what identifies the game, so it stays on the wiki
      // (whose article for the game is unambiguous); the walkthrough pass is the
      // one that benefits from a real walkthrough site.
      webFirst: WEB_FIRST && topic !== '',
      requireGameMention: true,
    })
    for (const page of got) {
      if (!pages.some(p => p.url === page.url)) pages.push(page)
    }
  }

  if (pages.length === 0) {
    note({
      itemId, title, stage: 'research', level: 'error',
      message: 'No readable guide pages could be reached — nothing to build from',
    })
    update(itemId, g => {
      g.status = 'failed'
      g.error = "Couldn't reach any guide pages for this game — check the dashboard's internet connection and try again."
      delete g.phase
    })
    return null
  }

  note({
    itemId, title, stage: 'research', level: 'good',
    message: `Read ${pages.length} page(s) — ` +
             pages.map(p => `"${p.title}" on ${p.site} (${p.text.length.toLocaleString()} chars)`).join(', '),
  })

  update(itemId, g => { g.phase = 'Planning the sections…' })
  // The article headings are a fallback, not a supplement. When the categories
  // came through they name the game's real contents, and the headings alongside
  // them are mostly noise — on a page the search picked slightly wrong they are
  // a character's dialogue subheadings, which is worse than nothing in a prompt
  // whose whole job is deciding what the chapters are.
  const tocHint = chapters.length > 0 ? [] : toc
  const outline = await callOllamaJson<OutlineReply>(
    'outline', SYSTEM, outlinePrompt(title, order, pages, tocHint, chapters), OUTLINE_SCHEMA)
  const raw = Array.isArray(outline?.sections) ? outline!.sections : []
  const sections: GuideSection[] = raw
    .map((s, i): GuideSection | null => {
      const secTitle = str(s?.title)
      if (!secTitle) return null
      const kindRaw = str(s?.kind) as SectionKind
      const kind: SectionKind = SECTION_KINDS.includes(kindRaw) ? kindRaw : 'progression'
      const summary = str(s?.summary)
      return {
        id: `sec${i + 1}-${crypto.randomBytes(2).toString('hex')}`,
        title: secTitle,
        kind,
        counts: typeof s?.counts === 'boolean' ? s.counts : kind !== 'reference',
        ...(summary ? { summary } : {}),
        state: 'pending',
        steps: [],
      }
    })
    .filter((s): s is GuideSection => s !== null)
    .slice(0, GUIDE_CAPS.MAX_SECTIONS)

  if (sections.length === 0) {
    note({
      itemId, title, stage: 'outline', level: 'error',
      message: 'The model returned no usable chapter list from the research',
    })
    update(itemId, g => {
      g.status = 'failed'
      g.error = `The model couldn't lay out a guide for "${title}" from what was found online. Try retrying, or a more specific title.`
      delete g.phase
    })
    return null
  }

  // The overall walkthrough video, alongside the outline so there's something
  // watchable on screen before any section has finished.
  const overall = await searchYouTube(`${title} 100% walkthrough guide`)

  const saved = update(itemId, g => {
    g.organization = str(outline?.organization) || 'Ordered the way this game is usually played through.'
    g.sections = sections
    g.sources = pages.map(p => ({ url: p.url, site: p.site, title: p.title }))
    if (overall) g.video = overall
    g.phase = `0 of ${sections.length} sections`
  })
  note({
    itemId, title, stage: 'outline', level: 'good',
    message: `Planned ${sections.length} chapters — ${saved?.organization?.slice(0, 90) ?? ''}`,
  })
  return saved ? { guide: saved, pages } : null
}

const totalChars = (pages: Page[]) => pages.reduce((n, p) => n + p.text.length, 0)

/**
 * Search terms to try for one section, most specific first. A section is usually
 * an article of its own on the game's wiki ("Woodfall Temple"), but community
 * wikis name things inconsistently — "Masks" may live at "Mask", "List of Masks",
 * or only inside the game's own article — so several phrasings get a turn before
 * anything is declared unresearchable.
 */
function sectionQueries(gameTitle: string, section: GuideSection, wider: boolean): string[] {
  const t = section.title
  const queries = [t]
  if (section.kind === 'collectible') {
    // "Locations" and "how to get" pages are the ones carrying the method; the
    // bare "Masks" article is often just a gallery with no way to obtain any.
    queries.push(`List of ${t}`, `${t} locations`, `How to get ${t}`)
  } else if (section.kind === 'sidequest') {
    queries.push(`${t} list`, 'Side quests')
  } else if (section.kind === 'reference') {
    queries.push(`${t} list`)
  } else {
    // Many wikis keep the prose walkthrough on a subpage, with the parent article
    // holding only an overview box — which is what the guide was being written
    // from, and why chapters read like a summary of a dungeon rather than a route
    // through it. Ask for the walkthrough explicitly, and first.
    queries.push(`${t}/Walkthrough`, `${t} walkthrough`, `${t} guide`)
  }
  // Scoped by the game's distinctive name rather than its full title: on a
  // franchise wiki "The Legend of Zelda Sidequests" matches every game in the
  // series, where "Majora's Mask Sidequests" matches one.
  const qualifier = gameQualifier(gameTitle)
  queries.push(`${qualifier} ${t}`)
  // The repair pass casts wider, including terms that reach past the game's own
  // wiki into Wikipedia and the open web.
  if (wider) queries.push(`${qualifier} ${t} guide`, `${qualifier} ${t} how to`)
  return [...new Set(queries.map(q => q.trim()).filter(Boolean))]
}

/**
 * Gather research for one section, accumulating pages until there's enough text
 * to write from. Falls back to the broad walkthrough pages the outline was built
 * from — a table-of-contents page usually covers each dungeon too, and a section
 * written from that beats an empty one.
 */
async function researchSection(
  itemId: string,
  gameTitle: string,
  section: GuideSection,
  fallbackPages: Page[],
  wider: boolean,
  preferredSite?: string,
): Promise<{ pages: Page[]; own: Page[] }> {
  const own: Page[] = []
  const add = (got: Page[]) => {
    for (const page of got) {
      if (!own.some(p => p.url === page.url)) own.push(page)
    }
  }

  for (const query of sectionQueries(gameTitle, section, wider)) {
    if (totalChars(own) >= SECTION_MIN_CHARS) break
    add(await researchGame(gameTitle, query, {
      limit: 1,
      maxChars: SECTION_CHARS,
      ...(preferredSite ? { preferredSite } : {}),
      // A walkthrough section wants a walkthrough site; a collectible list is
      // usually best served by the wiki's own table, which is exhaustive.
      webFirst: WEB_FIRST && section.kind === 'progression',
      // The guard that matters: this is where another game's article used to be
      // picked up and written into the guide as a chapter.
      requireGameMention: true,
    }))
  }

  // A wiki describes a dungeon; a walkthrough site routes you through one. The
  // Woodfall Temple article is 14k chars of theme, layout and lore that never
  // says which room the boss key is in — good background, not a guide. And
  // because researchGame only falls through to the open web when the wiki
  // returns NOTHING, a section like this would never reach the sites that do
  // walk you through it. So progression sections ask the open web directly, on
  // top of whatever the wiki gave. Best-effort: this is the scraped search path,
  // and when it's throttled the wiki page still carries the section.
  if (section.kind === 'progression' && own.length < 2) {
    const before = own.length
    const webQuery = preferredSite
      ? `${section.title} walkthrough site:${preferredSite}`
      : communityQuery(gameQualifier(gameTitle), `${section.title} walkthrough`)
    add((await researchPages(webQuery, 1, SECTION_CHARS))
      .filter(p => mentionsGame(`${p.title}\n${p.text}`, gameTitle)))
    if (own.length === before) {
      note({
        itemId, title: gameTitle, section: section.title, stage: 'research', level: 'warn',
        message: 'No walkthrough page came back from the open web (usually a throttled search) — ' +
                 'working from the wiki article alone',
      })
    }
  }

  if (totalChars(own) >= SECTION_MIN_CHARS) {
    note({
      itemId, title: gameTitle, section: section.title, stage: 'research', level: 'good',
      message: `Read ${own.length} page(s), ${totalChars(own).toLocaleString()} chars — ` +
               `${[...new Set(own.map(p => p.site))].join(', ')}`,
    })
    return { pages: capped(own), own }
  }

  // Thin or nothing: pad with the shared pages rather than write from scratch.
  const merged = [...own]
  for (const page of fallbackPages) {
    if (!merged.some(p => p.url === page.url)) merged.push(page)
  }
  note({
    itemId, title: gameTitle, section: section.title, stage: 'research', level: 'warn',
    message: own.length === 0
      ? 'No page of its own could be found — falling back to the guide-wide sources'
      : `Only ${totalChars(own).toLocaleString()} chars found (want ${SECTION_MIN_CHARS.toLocaleString()}) — ` +
        `topping up from the guide-wide sources`,
  })
  return { pages: capped(merged), own }
}

/**
 * Trim the tail of the page list to the context budget. Pages are in
 * most-specific-first order, so dropping from the end sheds the padding rather
 * than the article this section is actually about.
 */
function capped(pages: Page[]): Page[] {
  const out: Page[] = []
  let used = 0
  for (const page of pages) {
    if (used >= SECTION_MAX_CHARS) break
    const room = SECTION_MAX_CHARS - used
    out.push(page.text.length <= room ? page : { ...page, text: page.text.slice(0, room) })
    used += Math.min(page.text.length, room)
  }
  return out
}

// ── Quality gates ────────────────────────────────────────────────────────────
// Everything below is a pure function over what the model returned, and every
// one of them exists because of something that actually shipped into a guide.
// They run before the content is stored, because a checklist of filler is worse
// than a short checklist: it reads as the guide having been written, and it
// moves the completion bar.

const NOTE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'by',
  'is', 'are', 'be', 'it', 'its', 'this', 'that', 'you', 'your', 'will', 'can', 'as', 'into',
  'then', 'after', 'before', 'when', 'where', 'which', 'must', 'need', 'get', 'go',
])

const contentWords = (s: string): string[] =>
  s.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !NOTE_STOPWORDS.has(w))

/**
 * The shape of a step with its numbers blanked: "Obtain Heart Container 1 from
 * boss" and "…2 from boss" collapse to the same skeleton.
 */
const numberSkeleton = (s: string): string =>
  s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim()

/**
 * Drop enumerated filler.
 *
 * A model asked for "one step per collectible" from notes that never list them
 * will happily emit the COUNT instead of the CONTENT: thirteen consecutive
 * "Collect 4 Pieces of Heart for Heart Container N", eight "Obtain Heart
 * Container N from boss". These parse fine, store fine and render as a tidy
 * checklist that tells the player nothing and inflates the 100% bar with boxes
 * that mean nothing.
 *
 * A real collectible entry distinguishes itself by more than a number — it names
 * a place or a method — so a run of three or more steps that differ ONLY in a
 * digit is the signature, and it doesn't fire on genuine lists. The whole run
 * goes, not all-but-one: "Obtain Heart Container 1 from boss" on its own is just
 * as useless, and an emptied section gets re-researched by the repair pass,
 * which is the outcome that can actually fix it.
 */
export function dropPlaceholderRuns(steps: Array<{ text: string; group: string }>): {
  kept: Array<{ text: string; group: string }>
  dropped: number
} {
  const counts = new Map<string, number>()
  for (const s of steps) {
    const k = numberSkeleton(s.text)
    if (k.includes('#')) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const filler = new Set([...counts].filter(([, n]) => n >= 3).map(([k]) => k))

  const seen = new Set<string>()
  const kept: Array<{ text: string; group: string }> = []
  for (const s of steps) {
    if (filler.has(numberSkeleton(s.text))) continue
    // Exact repeats are never intentional in an ordered checklist.
    const dedupe = s.text.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    kept.push(s)
  }
  return { kept, dropped: steps.length - kept.length }
}

/**
 * Is this note just the step said again?
 *
 * "Travel to Woodfall" → "Travel to the cardinal direction of Woodfall."
 * "Play the Song of Time" → "Use the Ocarina of Time."
 * "Collect 4 Pieces of Heart for Heart Container 1" → "Collect four Pieces of Heart."
 *
 * All three shipped. A note is the answer to "how do I actually do this", and
 * one that restates the step reads as the guide mocking the reader — strictly
 * worse than no note, which renders as an honest plain checkbox. The test is
 * whether the note contributes words the step didn't already have: three new
 * content words, or enough length that it is plainly carrying detail.
 */
export function isVacuousNote(stepText: string, note: string): boolean {
  if (note.length >= 80) return false
  const known = new Set(contentWords(stepText))
  const fresh = new Set(contentWords(note).filter(w => !known.has(w)))
  return fresh.size < 3
}

/**
 * How many of a thing the sources say there are — "there are 24 masks", "all 52
 * Pieces of Heart". Used to tell the model the target up front and to notice
 * afterwards when a list came back a fraction of the real size: the masks
 * chapter shipped with 5 of 24, and a collectible list that stops short is worse
 * than none, because the bar then reads 100% on an unfinished game.
 *
 * Deliberately conservative — it only counts a number that sits next to a word
 * from the section's own title, and returns null rather than a guess.
 */
export function statedTotal(text: string, sectionTitle: string): number | null {
  const nouns = contentWords(sectionTitle).filter(w => w.endsWith('s') && w.length >= 5)
  let best: number | null = null
  for (const noun of nouns) {
    const re = new RegExp(`\\b(\\d{1,3})\\s+(?:\\w+\\s+){0,2}?${noun}\\b`, 'gi')
    for (const m of text.matchAll(re)) {
      const n = Number(m[1])
      // 3 is noise ("the 3 masks you start with"); 200 is a parse accident.
      if (n >= 5 && n <= 200 && (best === null || n > best)) best = n
    }
  }
  return best
}

/**
 * PASS ONE — the chapter's skeleton: step texts, no notes.
 *
 * Small output by construction (an array of short strings), which is the point:
 * this is the call that must not fail, because everything downstream hangs off
 * it. A stricter second attempt covers a model that came back shy about a thin
 * page — which is what an empty first pass usually means, not a genuine absence.
 */
async function writeStepList(
  itemId: string,
  gameTitle: string,
  section: GuideSection,
  pages: Page[],
  expected: number | null,
): Promise<GuideStep[]> {
  // Tolerate the step being {"text": "..."} instead of a plain string, and a
  // number the model prepended despite being told not to. Dropping a good
  // chapter over the shape of its wrapper would be perverse.
  const asText = (s: unknown): string =>
    str(typeof s === 'string' ? s : (s as { text?: unknown } | null)?.text)
      .replace(/^\s*\d+[.)]\s*/, '')

  /** Flatten {parts:[{part, steps}]} into the one ordered list, part name kept per step. */
  const parse = (reply: StepListReply | null): GuideStep[] => {
    const flat: Array<{ text: string; group: string }> = []

    for (const p of Array.isArray(reply?.parts) ? reply.parts : []) {
      const group = str(p?.part)
      for (const s of Array.isArray(p?.steps) ? p.steps : []) {
        const text = asText(s)
        if (text) flat.push({ text, group })
      }
    }
    // A model that ignored the parts and returned a bare step list still gives a
    // perfectly good chapter — it just has no sub-chapters.
    if (flat.length === 0) {
      for (const s of Array.isArray(reply?.steps) ? reply.steps : []) {
        const text = asText(s)
        if (text) flat.push({ text, group: '' })
      }
    }

    const { kept, dropped } = dropPlaceholderRuns(flat)
    if (dropped > 0) {
      note({
        itemId, title: gameTitle, section: section.title, stage: 'steps', level: 'warn',
        message: `Discarded ${dropped} placeholder step(s) — numbered filler like ` +
                 `"Obtain Heart Container 1 from boss" that names nothing and would still tick off`,
      })
    }

    return kept.slice(0, GUIDE_CAPS.MAX_STEPS_PER_SECTION).map((s, i) => ({
      id: `${section.id}-${i + 1}`,
      text: s.text,
      ...(s.group ? { group: s.group } : {}),
      done: false,
    }))
  }

  if (pages.length === 0) return []

  const first = parse(await callOllamaJson<StepListReply>(
    `chapter "${section.title}"`, SYSTEM, stepListPrompt(gameTitle, section, pages, expected), STEP_LIST_SCHEMA))
  if (first.length > 0) return first

  note({
    itemId, title: gameTitle, section: section.title, stage: 'steps', level: 'warn',
    message: 'The model listed no steps on the first pass — asking again, more firmly',
  })
  return parse(await callOllamaJson<StepListReply>(
    `chapter "${section.title}" (retry)`,
    SYSTEM,
    `${stepListPrompt(gameTitle, section, pages, expected)}\n\n` +
    `IMPORTANT: your previous attempt returned no steps. The notes above DO describe this part of ` +
    `the game — read them again and pull out every concrete thing the player does, gets, or fights. ` +
    `If the notes are a list of things, write one step per thing. Return at least 3 steps.`,
    STEP_LIST_SCHEMA,
  ))
}

/** How many steps get explained per model call. Small enough that a batch always finishes. */
const DETAIL_BATCH = 8

/**
 * PASS TWO — the notes, a batch at a time, written straight into the stored
 * guide as each batch lands.
 *
 * Patched in by step id rather than by rewriting the array, because the chapter
 * has been on screen and tickable since pass one: the player may well be ticking
 * boxes in it while this runs, and writing back a whole array built a minute ago
 * would silently un-tick them.
 *
 * Returns how many notes were written. A batch that fails is skipped — a chapter
 * with steps and no notes is still a usable checklist, which is exactly the
 * property the old one-shot call didn't have.
 */
async function detailSteps(
  itemId: string,
  gameTitle: string,
  sectionId: string,
  pages: Page[],
): Promise<number> {
  const section = loadGuide(itemId)?.sections.find(s => s.id === sectionId)
  if (!section || section.steps.length === 0 || pages.length === 0) return 0

  const numbered = section.steps.map((s, i) => ({ n: i + 1, text: s.text, id: s.id, group: s.group }))
  let written = 0

  for (let start = 0; start < numbered.length; start += DETAIL_BATCH) {
    if (!loadGuide(itemId)) return written          // guide deleted under us
    const batch = numbered.slice(start, start + DETAIL_BATCH)

    update(itemId, g => {
      g.phase = `${section.title} — detail ${batch[0]!.n}–${batch[batch.length - 1]!.n} of ${numbered.length}`
    })

    const reply = await callOllamaJson<DetailsReply>(
      `chapter "${section.title}" detail ${batch[0]!.n}-${batch[batch.length - 1]!.n}`,
      SYSTEM,
      detailsPrompt(gameTitle, section, pages, batch),
      DETAILS_SCHEMA,
    )

    // Key the reply by the step id it belongs to, ignoring numbers outside this
    // batch — a model that renumbers from 1 must not overwrite the first steps
    // of the chapter with notes meant for the last.
    const byId = new Map<string, StepDetail>()
    let vacuous = 0
    let subbed = 0
    for (const d of Array.isArray(reply?.details) ? reply.details : []) {
      const n = typeof d?.n === 'number' ? d.n : Number(d?.n)
      const noteText = str(d?.note)
      if (!Number.isInteger(n)) continue
      const target = batch.find(b => b.n === n)
      if (!target) continue
      // A note that only restates its step is worse than no note: the step keeps
      // its honest plain checkbox instead of an explanation that explains nothing.
      const keptNote = noteText && !isVacuousNote(target.text, noteText) ? noteText : ''
      if (noteText && !keptNote) vacuous++
      const subs = cleanSubs(target.text, d?.subs)
      const pin = mapPosition(str(d?.where))
      // Nothing usable came back for this step at all — leave it exactly as it
      // was rather than writing an empty note over a plain checkbox.
      if (!keptNote && subs.length === 0 && !pin) continue
      if (subs.length > 0) subbed++
      byId.set(target.id, {
        ...(keptNote ? { note: keptNote } : {}),
        ...(subs.length > 0 ? { subs } : {}),
        ...(pin ? { pin } : {}),
      })
    }
    if (vacuous > 0) {
      note({
        itemId, title: gameTitle, section: section.title, stage: 'detail', level: 'info',
        message: `Dropped ${vacuous} note(s) that only repeated the step back ` +
                 `(e.g. "Travel to Woodfall" explained as "Travel to the cardinal direction of Woodfall")`,
      })
    }

    if (byId.size === 0) {
      note({
        itemId, title: gameTitle, section: section.title, stage: 'detail', level: 'warn',
        message: `No detail came back for steps ${batch[0]!.n}–${batch[batch.length - 1]!.n} — ` +
                 `those steps stay as plain checkboxes`,
      })
      continue
    }

    update(itemId, g => {
      const target = g.sections.find(s => s.id === sectionId)
      if (!target) return
      for (const step of target.steps) {
        const detail = byId.get(step.id)
        if (!detail) continue
        if (detail.note) step.note = detail.note
        if (detail.subs) {
          // Written fresh rather than merged: this is the first and only pass
          // that produces them, and a re-run is a rewrite of the explanation.
          // Ticks are not at risk — a sub-step has never been on screen at this
          // point, and the STEP's own tick lives on the step, untouched here.
          step.subs = detail.subs.map((text, i) => ({ id: `${step.id}u${i}`, text, done: step.done }))
        }
        if (detail.pin) step.pin = { ...detail.pin, approx: true }
      }
    })
    if (subbed > 0) {
      note({
        itemId, title: gameTitle, section: section.title, stage: 'detail', level: 'good',
        message: `Broke ${subbed} step(s) in this batch into tickable sub-steps`,
      })
    }
    written += byId.size
  }

  return written
}

/** What one step gained from the detail pass. */
interface StepDetail {
  note?: string
  subs?: string[]
  pin?:  { x: number; y: number }
}

/**
 * Clean the model's sub-steps, or return none.
 *
 * Fewer than two is dropped on purpose: one sub-step is the step said twice,
 * which gives the player two boxes for one action and makes the step look
 * broken down when it isn't. The store enforces the same rule (normalizeStep),
 * so this is about not sending it rather than about safety.
 */
function cleanSubs(stepText: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const same = (a: string, b: string) =>
    a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '')
  const out: string[] = []
  for (const item of raw) {
    const text = str(item).slice(0, 200)
    // A sub that restates the step is the same failure isVacuousNote() catches
    // in prose, and a duplicate of a sibling is the placeholder failure
    // dropPlaceholderRuns() catches in step lists. Both show up here too.
    if (!text || same(text, stepText) || out.some(o => same(o, text))) continue
    out.push(text)
    if (out.length >= 5) break
  }
  return out.length >= 2 ? out : []
}

/**
 * A compass phrase turned into a point on the map, 0..1.
 *
 * This is the honest limit of automatic pinning: the model never sees the map
 * image, so it cannot place a pin — the most it can do is repeat where the
 * research notes say a thing is, in words. Those words land the pin in roughly
 * the right ninth of the picture, which is enough to be worth showing next to a
 * draggable handle and a label, and not enough to present as fact. Everything
 * placed this way is stored with `approx: true` and says so on screen.
 *
 * Anything that isn't a recognised direction returns null rather than a guess —
 * a pin in the middle of the map "because it had to go somewhere" is exactly the
 * kind of confident wrongness this whole file is written against.
 */
export function mapPosition(where: string): { x: number; y: number } | null {
  const w = where.toLowerCase()
  const has = (...words: string[]) => words.some(x => w.includes(x))
  // Thirds, so a bare "north" lands mid-top rather than in a corner.
  let x: number | null = null
  let y: number | null = null
  if (has('west', 'left'))  x = 0.2
  if (has('east', 'right')) x = 0.8
  if (has('north', 'top', 'upper'))    y = 0.2
  if (has('south', 'bottom', 'lower')) y = 0.8
  if (has('centre', 'center', 'middle')) {
    if (x === null) x = 0.5
    if (y === null) y = 0.5
  }
  if (x === null && y === null) return null
  return { x: x ?? 0.5, y: y ?? 0.5 }
}

/**
 * Carry ticked-off steps across a rewrite. Rewriting one chapter is something a
 * player does mid-playthrough — usually because that chapter came out thin — and
 * losing the boxes they already ticked would make the fix cost more than the
 * problem. Matched on normalized text: the ids are regenerated, but a step that
 * still says the same thing is still the same step.
 */
function carryTicks(previous: GuideStep[], next: GuideStep[]): GuideStep[] {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wasDone = new Map(previous.filter(s => s.done).map(s => [key(s.text), s.doneAt]))
  if (wasDone.size === 0) return next
  let carried = 0
  const out = next.map(step => {
    if (!wasDone.has(key(step.text))) return step
    carried++
    const doneAt = wasDone.get(key(step.text))
    return { ...step, done: true, ...(doneAt ? { doneAt } : {}) }
  })
  if (carried > 0) console.log(`[guides] carried ${carried} ticked step(s) across the rewrite`)
  return out
}

/** What one chapter came out as, for the repair pass to judge. */
interface FilledSection {
  steps: number
  /** Set when the sources say there are more of these than were listed. */
  shortfall?: { want: number; got: number }
}

// ── Pictures ─────────────────────────────────────────────────────────────────
//
// Runs after the two writing passes, never before, and never blocks them: a
// chapter is a working checklist the moment its steps are saved, and a wiki that
// is slow or down must cost the guide its pictures rather than its content.
// Every failure here is swallowed for that reason.
//
// What gets a picture is deliberately uneven, because the useful picture differs
// by chapter kind. A dungeon wants ONE establishing shot at the top and a map;
// its thirty route steps do not each want a screenshot, and fetching thirty
// would be thirty wiki round trips for a chapter nobody has scrolled yet. A
// collectible list is the opposite: every row names a real thing, "what does it
// look like and where is it" is the entire question, and the picture is the
// answer — so those get one per step, capped.

/** Steps that get their own picture, in a chapter kind where that is the point. */
const MAX_STEP_IMAGES = 20
/** Politeness gap between wiki image lookups, matching YOUTUBE_GAP_MS in spirit. */
const IMAGE_GAP_MS = 250

/** Fetch one wiki image and cache it, or null. Never throws. */
async function grab(
  found: { url: string; title: string; width: number; height: number } | null,
): Promise<GuideImage | null> {
  if (!found) return null
  const file = await cacheGuideImage(found.url)
  if (!file) return null
  return {
    file,
    source: found.url,
    // "File:MM3D Woodfall Temple Entrance Screenshot.png" -> a usable caption.
    title: found.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '),
    ...(found.width  > 0 ? { width:  found.width }  : {}),
    ...(found.height > 0 ? { height: found.height } : {}),
  }
}

/**
 * Find the whole-game map once, for every chapter that has no map of its own.
 *
 * Most chapters are places ON the world map rather than places WITH a map — a
 * collectible list spans the entire game — so without this the map tool would
 * only ever appear for dungeons, which is most of the feature missing.
 */
async function illustrateGuide(itemId: string, title: string): Promise<void> {
  try {
    const wiki = await findGameWiki(title)
    if (!wiki) return
    const map = await grab(await wikiGameMap(wiki.host, title))
    if (!map) {
      note({
        itemId, title, stage: 'chapter', level: 'info',
        message: `No world map found on ${wiki.host} — chapters will show their own map if they have one`,
      })
      return
    }
    update(itemId, g => { g.map = { image: map, pins: [] } })
    note({
      itemId, title, stage: 'chapter', level: 'good',
      message: `Found a world map (${map.title}) — chapters without their own will use it`,
    })
  } catch (err) {
    console.warn(`[guides] world map lookup failed for "${title}":`, err)
  }
}

/** Attach a header picture, a map, and — for a list chapter — a picture per row. */
async function illustrateSection(itemId: string, title: string, sectionId: string): Promise<void> {
  try {
    const guide = loadGuide(itemId)
    const section = guide?.sections.find(s => s.id === sectionId)
    if (!guide || !section || section.steps.length === 0) return
    const wiki = await findGameWiki(title)
    if (!wiki) return

    update(itemId, g => { g.phase = `${section.title} — finding pictures` })

    const header = await grab(await wikiImageFor(wiki.host, section.title, title))
    await sleep(IMAGE_GAP_MS)
    const map = await grab(await wikiMapFor(wiki.host, section.title, title))

    if (header || map) {
      update(itemId, g => {
        const target = g.sections.find(s => s.id === sectionId)
        if (!target) return
        if (header) target.image = header
        // Pins are the user's, so a re-run replaces the picture and keeps them.
        if (map) target.map = { image: map, pins: target.map?.pins ?? [] }
      })
    }

    // One picture per row, for the chapters where a row IS a thing.
    let stepImages = 0
    if (section.kind === 'collectible' || section.kind === 'sidequest') {
      for (const step of section.steps.slice(0, MAX_STEP_IMAGES)) {
        if (!loadGuide(itemId)) return                 // deleted under us
        await sleep(IMAGE_GAP_MS)
        // The step's own text is the subject — "Bunny Hood", "Piece of Heart in
        // the Deku Playground". wikiImageFor strips the game's words out of it
        // and refuses anything that doesn't match what's left, so a step whose
        // text names nothing specific correctly comes back with nothing.
        const img = await grab(await wikiImageFor(wiki.host, step.text, title))
        if (!img) continue
        stepImages++
        update(itemId, g => {
          const t = g.sections.find(x => x.id === sectionId)?.steps.find(x => x.id === step.id)
          if (t) t.image = img
        })
      }
    }

    if (header || map || stepImages > 0) {
      note({
        itemId, title, section: section.title, stage: 'detail', level: 'good',
        message: [
          header ? 'a header picture' : '',
          map ? `a map (${map.title})` : '',
          stepImages > 0 ? `${stepImages} step picture(s)` : '',
        ].filter(Boolean).join(', ') + ` from ${wiki.host}`,
      })
    } else {
      note({
        itemId, title, section: section.title, stage: 'detail', level: 'info',
        message: `No pictures on ${wiki.host} matched this chapter closely enough to use — ` +
                 `a wrong-game screenshot looks more authoritative than a wrong sentence, so ` +
                 `nothing is better than nearly right`,
      })
    }
  } catch (err) {
    console.warn(`[guides] illustration failed for section ${sectionId}:`, err)
  }
}

async function fillSection(
  itemId: string,
  title: string,
  sectionId: string,
  index: number,
  total: number,
  fallbackPages: Page[],
  opts: { wider?: boolean; phase?: string; keepBest?: boolean } = {},
): Promise<FilledSection> {
  const current = loadGuide(itemId)
  const section = current?.sections.find(s => s.id === sectionId)
  if (!current || !section) return { steps: 0 }

  update(itemId, g => {
    g.phase = opts.phase ?? `${section.title} (${index + 1} of ${total})`
  })
  note({
    itemId, title, section: section.title, stage: 'chapter', level: 'info',
    message: `Started chapter ${index + 1} of ${total} (${section.kind})`,
  })

  const { pages, own } = await researchSection(itemId, title, section, fallbackPages, opts.wider === true, current.sourceSite)

  // ── Pass one: the skeleton, saved and broadcast on its own ──────────────────
  // The chapter becomes usable here — every step tickable, nothing explained yet.
  // Saving between the passes is what makes a failure in the second one cost only
  // the explanations.
  update(itemId, g => { g.phase = `${section.title} — outlining the steps` })
  // "There are 24 masks" — told to the model up front, and checked against below.
  const expected = section.kind === 'collectible'
    ? statedTotal(pages.map(p => p.text).join('\n'), section.title)
    : null
  const steps = await writeStepList(itemId, title, section, pages, expected)

  // A video is worth having even when the steps didn't come through — often it's
  // the better answer for a fiddly dungeon anyway.
  let video = section.video
  if (!video) {
    await sleep(YOUTUBE_GAP_MS)
    video = (await searchYouTube(`${title} ${section.title} walkthrough`)) ?? undefined
  }

  update(itemId, g => {
    const target = g.sections.find(s => s.id === sectionId)
    if (!target) return
    // The automatic repair pass runs against a chapter that already has content,
    // and a wider search can just as easily come back with less — so it keeps
    // the longer list; the retry is there to improve the chapter, not gamble it.
    // A rewrite the USER asked for is the opposite case: they want this chapter
    // replaced, however it comes out, so keepBest is deliberately not set there.
    const better = steps.length > 0 && (!opts.keepBest || steps.length >= target.steps.length)
    if (better) target.steps = carryTicks(target.steps, steps)
    target.state = (steps.length > 0 || target.steps.length > 0) ? 'ready' : 'failed'
    if (video) target.video = video
    // Credit the page this section was actually written from, preferring one of
    // its own over the shared outline sources.
    const src = own[0] ?? pages[0]
    if (src) target.source = { url: src.url, site: src.site }
  })
  note({
    itemId, title, section: section.title, stage: 'steps',
    level: steps.length === 0 ? 'error' : steps.length < 5 ? 'warn' : 'good',
    message: steps.length === 0
      ? `No steps listed — this chapter is empty and can be redone on its own`
      : `Listed ${steps.length} steps in ${new Set(steps.map(s => s.group ?? '')).size} part(s) ` +
        `from ${totalChars(pages).toLocaleString()} chars ` +
        `(${own.length > 0 ? [...new Set(own.map(p => p.site))].join(', ') : 'guide-wide sources'})` +
        `${video ? ' + a walkthrough video' : ''}`,
  })

  // ── Pass two: fill in the detail, a few steps per call ──────────────────────
  if (steps.length > 0) {
    const written = await detailSteps(itemId, title, sectionId, pages)
    note({
      itemId, title, section: section.title, stage: 'detail',
      level: written === 0 ? 'warn' : written < steps.length ? 'info' : 'good',
      message: written === 0
        ? 'No detail could be written — the steps stand as a plain checklist'
        : `Explained ${written} of ${steps.length} steps`,
    })
  }

  // Pictures last: everything above is what makes the chapter usable, and this
  // is what makes it easier to follow. A chapter that reaches here has already
  // been saved and broadcast, so a slow wiki delays nothing the player is
  // waiting on.
  if (steps.length > 0) await illustrateSection(itemId, title, sectionId)

  update(itemId, g => {
    if (!opts.phase) g.phase = `${index + 1} of ${total} sections`
  })

  // A collectible list that stops short is the one failure that actively lies:
  // the player ticks every box and the bar reads 100% on an unfinished game.
  const shortfall = expected !== null && steps.length > 0 && steps.length < Math.ceil(expected * 2 / 3)
    ? { want: expected, got: steps.length }
    : undefined
  if (shortfall) {
    note({
      itemId, title, section: section.title, stage: 'steps', level: 'warn',
      message: `The sources say there are ${expected} — only ${steps.length} were listed. ` +
               `This chapter will be researched again with wider terms, because a list that looks ` +
               `complete and isn't reads as 100% on an unfinished game`,
    })
  }
  return { steps: steps.length, ...(shortfall ? { shortfall } : {}) }
}

async function run(itemId: string, title: string, order?: string, sourceSite?: string): Promise<void> {
  const started = Date.now()
  try {
    const outlined = await buildOutline(itemId, title, order, sourceSite)
    if (!outlined) return

    // The world map, once, before the chapters — so the first chapter to finish
    // already has something to fall back on when it has no map of its own.
    await illustrateGuide(itemId, title)

    const ids = outlined.guide.sections.map(s => s.id)
    const shortfalls = new Set<string>()
    for (let i = 0; i < ids.length; i++) {
      // The item can be deleted from the playlist mid-generation — its guide goes
      // with it, and there's nothing left to write to.
      if (!loadGuide(itemId)) {
        note({
          itemId, title, stage: 'stopped', level: 'warn',
          message: 'The game was removed from the list mid-generation — stopping',
        })
        return
      }
      const filled = await fillSection(itemId, title, ids[i]!, i, ids.length, outlined.pages)
      if (filled.shortfall) shortfalls.add(ids[i]!)
    }

    // Second pass over anything empty or visibly incomplete. A chapter with no
    // steps is the one outcome that makes the whole guide feel unfinished, and a
    // collectible list at a third of its real length is the one that misleads —
    // both usually come of a single unlucky search, so each gets one more attempt
    // with wider terms (which also reach past the game's wiki to Wikipedia and
    // the open web).
    const needsWork = (loadGuide(itemId)?.sections ?? [])
      .filter(s => s.steps.length === 0 || shortfalls.has(s.id))
    if (needsWork.length > 0) {
      note({
        itemId, title, stage: 'repair', level: 'warn',
        message: `${needsWork.length} chapter(s) came back empty or short — researching them again ` +
                 `with wider terms: ` + needsWork.map(s => s.title).join(', '),
      })
      for (let i = 0; i < needsWork.length; i++) {
        if (!loadGuide(itemId)) return
        const section = needsWork[i]!
        await fillSection(itemId, title, section.id, i, needsWork.length, outlined.pages, {
          wider: true,
          keepBest: true,
          phase: `Filling gaps — ${section.title} (${i + 1} of ${needsWork.length})`,
        })
      }
    }

    const done = update(itemId, g => {
      const anyReady = g.sections.some(s => s.steps.length > 0)
      g.status = anyReady ? 'ready' : 'failed'
      if (!anyReady) g.error = 'None of the sections could be researched. Try retrying in a moment.'
      delete g.phase
    })
    const p = done ? guideProgress(done) : null
    const empty = (done?.sections ?? []).filter(s => s.steps.length === 0)
    note({
      itemId, title, stage: 'done', level: done?.status === 'ready' ? 'good' : 'error',
      message:
        `Finished in ${Math.round((Date.now() - started) / 1000)}s — ${done?.sections.length ?? 0} chapters, ` +
        `${p?.all.total ?? 0} steps (${p?.counted.total ?? 0} count toward 100%)` +
        `${empty.length > 0 ? `. Still empty: ${empty.map(s => s.title).join(', ')}` : ''}`,
    })
  } catch (err) {
    // Belt and braces: every helper above already swallows its own failures, so
    // reaching here means something genuinely unexpected. Never let it escape
    // into an unhandled rejection that takes the server down.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[guides] "${title}" generation crashed:`, err)
    note({ itemId, title, stage: 'crashed', level: 'error', message: `Generation crashed: ${msg.slice(0, 200)}` })
    update(itemId, g => {
      g.status = 'failed'
      g.error = `Generation failed: ${msg.slice(0, 200)}`
      delete g.phase
    })
  } finally {
    inFlight.delete(itemId)
  }
}

/**
 * Re-research and rewrite ONE section, leaving the rest of the guide alone.
 *
 * A guide is a dozen model calls over several minutes, and it is normal for one
 * chapter to come back thin while the others are fine — one unlucky search, or a
 * wiki that keeps that dungeon's walkthrough somewhere the others aren't. Making
 * the user rebuild the whole guide to fix one chapter throws away every other
 * chapter and every ticked box to repair a twentieth of the document.
 *
 * Runs with the wider search terms the repair pass uses, since a section worth
 * rewriting is usually one the narrow terms already failed at.
 */
async function runSection(itemId: string, title: string, sectionId: string): Promise<void> {
  const started = Date.now()
  try {
    const guide = loadGuide(itemId)
    const section = guide?.sections.find(s => s.id === sectionId)
    if (!guide || !section) return

    // The outline's research isn't kept on disk, so re-fetch the broad pages to
    // fall back on. One search, and only used if the section's own come up short.
    const fallback = await researchGame(title, 'walkthrough 100% completion', {
      limit: 1,
      maxChars: OUTLINE_CHARS,
      ...(guide.sourceSite ? { preferredSite: guide.sourceSite } : {}),
      webFirst: WEB_FIRST,
      requireGameMention: true,
    })
    await fillSection(itemId, title, sectionId, 0, 1, fallback, {
      wider: true,
      phase: `Rewriting ${section.title}…`,
    })

    const done = update(itemId, g => {
      const target = g.sections.find(s => s.id === sectionId)
      g.status = g.sections.some(s => s.steps.length > 0) ? 'ready' : 'failed'
      // A rewrite that fixed the chapter also clears a guide-level error left over
      // from the run that produced it.
      if (g.status === 'ready') delete g.error
      delete g.phase
      if (target && target.steps.length === 0) target.state = 'failed'
    })
    const steps = done?.sections.find(s => s.id === sectionId)?.steps.length ?? 0
    note({
      itemId, title, section: section.title, stage: 'rewrite',
      level: steps > 0 ? 'good' : 'error',
      message: `Rewritten in ${Math.round((Date.now() - started) / 1000)}s — ${steps} steps`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[guides] "${title}" section rewrite crashed:`, err)
    note({ itemId, title, stage: 'crashed', level: 'error', message: `Chapter rewrite crashed: ${msg.slice(0, 200)}` })
    update(itemId, g => {
      g.status = 'ready'   // the rest of the guide is still good
      g.error = `Rewriting that chapter failed: ${msg.slice(0, 200)}`
      delete g.phase
    })
  } finally {
    inFlight.delete(itemId)
  }
}

/**
 * Add detail, pictures and map pins to a chapter that already exists —
 * WITHOUT rewriting a single step.
 *
 * The difference from runSection() is the whole point. A rewrite re-researches
 * the chapter and replaces its step list, and although carryTicks() rescues the
 * boxes whose text survives, a chapter that comes back worded differently loses
 * them. That is an acceptable trade when the chapter is empty or wrong, and a
 * bad one when it is fine and merely thin — which is the case here.
 *
 * So this runs only the two ADDITIVE passes:
 *   • detailSteps(), which patches notes, sub-steps and pins onto existing steps
 *     BY STEP ID and never touches the array;
 *   • illustrateSection(), which only ever sets an image or a map.
 *
 * Nothing here can move a tick. A step keeps its id, its text and its `done`;
 * the sub-steps it gains inherit that `done` so a step already ticked doesn't
 * reopen itself by growing children (see the write in detailSteps).
 */
async function runEnrich(itemId: string, title: string, sectionId: string): Promise<void> {
  const started = Date.now()
  try {
    const guide = loadGuide(itemId)
    const section = guide?.sections.find(s => s.id === sectionId)
    if (!guide || !section || section.steps.length === 0) return

    note({
      itemId, title, section: section.title, stage: 'detail', level: 'info',
      message: `Adding detail and pictures to "${section.title}" — its ${section.steps.length} steps ` +
               `and everything ticked on them stay exactly as they are`,
    })

    update(itemId, g => {
      g.status = 'generating'
      g.phase = `${section.title} — adding detail`
    })

    const fallback = await researchGame(title, 'walkthrough 100% completion', {
      limit: 1,
      maxChars: OUTLINE_CHARS,
      ...(guide.sourceSite ? { preferredSite: guide.sourceSite } : {}),
      webFirst: WEB_FIRST,
      requireGameMention: true,
    })
    const { pages } = await researchSection(itemId, title, section, fallback, true, guide.sourceSite)

    const written = pages.length > 0 ? await detailSteps(itemId, title, sectionId, pages) : 0
    await illustrateSection(itemId, title, sectionId)

    const after = loadGuide(itemId)?.sections.find(s => s.id === sectionId)
    const withSubs = after?.steps.filter(x => (x.subs?.length ?? 0) > 0).length ?? 0
    const withPins = after?.steps.filter(x => x.pin).length ?? 0

    update(itemId, g => {
      g.status = 'ready'
      delete g.phase
    })
    note({
      itemId, title, section: section.title, stage: 'detail',
      level: written > 0 || withSubs > 0 ? 'good' : 'warn',
      message: written === 0 && withSubs === 0
        ? `Nothing new could be found for this chapter in ${Math.round((Date.now() - started) / 1000)}s — ` +
          `it is unchanged, including every box you had ticked`
        : `Enriched in ${Math.round((Date.now() - started) / 1000)}s — ${written} step(s) explained, ` +
          `${withSubs} broken into sub-steps, ${withPins} placed on the map`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[guides] "${title}" enrich crashed:`, err)
    note({ itemId, title, stage: 'crashed', level: 'error', message: `Adding detail crashed: ${msg.slice(0, 200)}` })
    update(itemId, g => {
      // The chapter is untouched by definition, so the guide is still ready.
      g.status = 'ready'
      g.error = `Adding detail to that chapter failed: ${msg.slice(0, 200)}`
      delete g.phase
    })
  } finally {
    inFlight.delete(itemId)
  }
}

export type StartResult = 'started' | 'busy'
export type SectionResult = StartResult | 'missing'

/** Kick off a one-section rewrite and return immediately, like startGuide. */
export function regenerateSection(itemId: string, sectionId: string): SectionResult {
  if (inFlight.has(itemId)) return 'busy'
  const guide = loadGuide(itemId)
  const section = guide?.sections.find(s => s.id === sectionId)
  if (!guide || !section) return 'missing'

  inFlight.add(itemId)
  // 'generating' at the guide level is what drives the spinner and disables the
  // rebuild buttons; the section going back to 'pending' is what tells the
  // chapter list this one specifically is being worked on.
  update(itemId, g => {
    g.status = 'generating'
    g.phase = `Rewriting ${section.title}…`
    const target = g.sections.find(s => s.id === sectionId)
    if (target) target.state = 'pending'
  })

  note({
    itemId, title: guide.title, section: section.title, stage: 'queued', level: 'info',
    message: 'Queued a rewrite of this chapter on its own — the rest of the guide is untouched',
  })
  enqueue(() => runSection(itemId, guide.title, sectionId))
  return 'started'
}

/**
 * Kick off (or restart) generation for one media item and return immediately.
 * The assistant calls this and speaks its confirmation while the job runs, the
 * same fire-and-forget shape as the end-of-conversation summarizer in chat.ts.
 */
/**
 * Ask for one chapter to be enriched. Same guard as regenerateSection: one job
 * per guide at a time, because both write the same document.
 */
export function enrichSection(itemId: string, sectionId: string): SectionResult {
  const guide = loadGuide(itemId)
  const section = guide?.sections.find(s => s.id === sectionId)
  if (!guide || !section || section.steps.length === 0) return 'missing'
  if (inFlight.has(itemId)) return 'busy'
  inFlight.add(itemId)
  enqueue(() => runEnrich(itemId, guide.title, sectionId))
  return 'started'
}

export function startGuide(opts: { itemId: string; title: string; order?: string; sourceSite?: string }): StartResult {
  const { itemId, title, order, sourceSite } = opts
  if (inFlight.has(itemId)) return 'busy'
  inFlight.add(itemId)

  const now = new Date().toISOString()
  const existing = loadGuide(itemId)
  // Regenerating replaces the outline and every step, so ticked boxes are gone —
  // that's the point of a regenerate, and the UI says so before asking.
  saveGuide({
    itemId,
    title,
    organization: '',
    ...(order ? { orderOverride: order } : {}),
    ...(sourceSite ? { sourceSite } : {}),
    status: 'generating',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    phase: 'Starting…',
    sections: [],
    sources: [],
  })
  const fresh = loadGuide(itemId)
  if (fresh) pushGuide(fresh)

  note({
    itemId, title, stage: 'queued', level: 'info',
    message: `${existing ? 'Rebuilding from scratch' : 'Queued a new guide'}` +
             `${order ? `, ordered "${order}"` : ''}${sourceSite ? `, sourced from ${sourceSite}` : ''} — ` +
             `model ${GUIDE_MODEL}, ${NUM_CTX} token context, ` +
             `${WEB_FIRST ? 'hosted search (walkthrough sites first)' : 'wiki-first (no search key)'}`,
  })
  enqueue(() => run(itemId, title, order, sourceSite))
  return 'started'
}
