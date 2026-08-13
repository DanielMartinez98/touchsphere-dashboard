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
} from './guides'
import {
  communityQuery,
  communityTableOfContents,
  researchGame,
  researchPages,
  type Page,
} from './research'
import { pushGuide } from './guide-events'
import { note } from './guide-activity'
import { searchYouTube } from './routes/browse'

const OLLAMA_URL     = process.env['OLLAMA_URL']     ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']   ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''

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
        model: OLLAMA_MODEL,
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

const STEP_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['steps'],
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
  steps?: unknown[]
}
interface DetailsReply {
  details?: Array<{ n?: unknown; note?: unknown }>
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

function outlinePrompt(title: string, order: string | undefined, pages: Page[], toc: string[]): string {
  return (
    `Game: ${title}\n\n` +
    `Below are notes from community guides and wikis for this game.\n\n` +
    `${researchBlock(pages)}\n\n` +
    (toc.length > 0
      ? `The community wiki's own article about this game is divided into these sections — this is ` +
        `literally how that community organizes the game, so lean on it:\n${toc.map(t => `- ${t}`).join('\n')}\n\n`
      : '') +
    `TASK: design the table of contents for a completion guide to this game, ` +
    `structured THE WAY THIS GAME'S OWN COMMUNITY STRUCTURES IT. Look at how the sources above ` +
    `divide the game up and mirror that — if they are organized by dungeon, use one section per ` +
    `dungeon; if by chapter, region, act, or boss, use that instead. Then add the collectible and ` +
    `side-content lists that community tracks for 100% completion (for example masks, heart pieces, ` +
    `key items, side quests) as their own sections.\n` +
    (order
      ? `THE USER HAS OVERRIDDEN THE ORDER. Organize it like this instead, and follow it literally: "${order}"\n`
      : '') +
    `\nRules:\n` +
    `- Between 4 and ${TARGET_SECTIONS} sections, in the order the player meets them.\n` +
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
function stepListPrompt(title: string, section: GuideSection, pages: Page[]): string {
  // What a step has to TEACH differs per kind, and that matters more than wording.
  // "Clear Woodfall Temple" and "Bunny Hood" are both useless steps — they restate
  // what the player already knew they had to do.
  const shape = section.kind === 'collectible'
    ? `This is a COLLECTIBLE LIST — one step per collectible, named exactly as the sources name it, in ` +
      `the sources' order. Be complete: if the sources say there are 24 masks, list 24, not a sample.`
    : section.kind === 'sidequest'
      ? `This is a SIDE-QUEST LIST — one step per quest, named as the sources name it.`
      : section.kind === 'reference'
        ? `This is REFERENCE material — one step per entry, kept short.`
        : `This is a WALKTHROUGH section, and it must be a real route — someone who has never played ` +
          `should be able to get through this part with nothing but these steps. Cover the whole span in ` +
          `order: how you REACH this place and what opens the way in; then every room, puzzle, key and ` +
          `item through it; then the mini-boss and the boss; then the item or ability you leave with. ` +
          `Be specific enough to act on ("Shoot an ice arrow at the water to freeze a stepping stone"), ` +
          `never vague ("solve the water puzzle").`

  const count = section.kind === 'progression'
    ? `- Between 12 and 30 steps. A dungeon described in five steps has been summarized, not written.\n`
    : `- One step per real entry, up to ${GUIDE_CAPS.MAX_STEPS_PER_SECTION}.\n`

  return (
    chapterPreamble(title, section, pages) +
    `TASK: list the steps of the checklist for THIS SECTION ONLY — just the steps themselves. ` +
    `Do NOT explain them; the explanations are asked for separately afterwards.\n${shape}\n\n` +
    `Rules:\n` +
    `- Each step is one short imperative line, under 160 characters. No step numbers — the app ` +
    `numbers them. No sub-bullets, no explanation, no commentary.\n` +
    count +
    `- Use the game's real names for places, items, characters and moves, spelled as the sources spell ` +
    `them. "Use the Hookshot on the target above the door", not "use your grappling tool".\n` +
    `- Only steps the research notes support. Do not invent content.\n` +
    `- Reply as {"steps": ["first step", "second step", ...]} and nothing else.`
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
  batch: Array<{ n: number; text: string }>,
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
    `These are steps ${batch[0]!.n}–${batch[batch.length - 1]!.n} of this section's checklist:\n` +
    batch.map(s => `${s.n}. ${s.text}`).join('\n') + `\n\n` +
    `TASK: for EACH numbered step above, write one short note giving ${want}\n\n` +
    `Rules:\n` +
    `- One or two sentences per note. No preamble, no repeating the step text back.\n` +
    `- Only what the research notes support. If the notes genuinely say nothing about a step, give it ` +
    `an empty note rather than inventing a location or a tactic.\n` +
    `- Use the game's real names, spelled as the sources spell them.\n` +
    `- Cover every number listed above, and use those same numbers in "n".\n` +
    `- Reply as {"details": [{"n": ${batch[0]!.n}, "note": "…"}, …]} and nothing else.`
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

async function buildOutline(itemId: string, title: string, order?: string): Promise<{ guide: Guide; pages: Page[] } | null> {
  update(itemId, g => { g.phase = 'Reading community guides…' })

  // The game's own wiki article plus its walkthrough page: what the game is, and
  // how the community breaks it down. Their article headings come along too —
  // that's the community's literal table of contents.
  const toc = await communityTableOfContents(title)
  note({
    itemId, title, stage: 'research', level: toc.length > 0 ? 'info' : 'warn',
    message: toc.length > 0
      ? `Found the community's table of contents — ${toc.length} headings to organize around`
      : `No community table of contents found; the outline will be built from the pages alone`,
  })

  // Deduped by URL: both searches run against the same wiki, and when a game has
  // no separate walkthrough article they resolve to the same page — which would
  // otherwise be handed to the model twice, spending half the outline's context
  // on a copy of what it already read.
  const pages: Page[] = []
  for (const topic of ['', 'walkthrough 100% completion']) {
    for (const page of await researchGame(title, topic, 1, OUTLINE_CHARS)) {
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
  const outline = await callOllamaJson<OutlineReply>('outline', SYSTEM, outlinePrompt(title, order, pages, toc), OUTLINE_SCHEMA)
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
  queries.push(`${gameTitle} ${t}`)
  // The repair pass casts wider, including terms that reach past the game's own
  // wiki into Wikipedia and the open web.
  if (wider) queries.push(`${gameTitle} ${t} guide`, `${gameTitle} ${t} how to`)
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
): Promise<{ pages: Page[]; own: Page[] }> {
  const own: Page[] = []
  const add = (got: Page[]) => {
    for (const page of got) {
      if (!own.some(p => p.url === page.url)) own.push(page)
    }
  }

  for (const query of sectionQueries(gameTitle, section, wider)) {
    if (totalChars(own) >= SECTION_MIN_CHARS) break
    add(await researchGame(gameTitle, query, 1, SECTION_CHARS))
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
    add(await researchPages(communityQuery(gameTitle, `${section.title} walkthrough`), 1))
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
): Promise<GuideStep[]> {
  const parse = (reply: StepListReply | null): GuideStep[] =>
    (Array.isArray(reply?.steps) ? reply.steps : [])
      // Tolerate {"steps": [{"text": "..."}]} — models reach for the object form
      // even when asked for plain strings, and it would be perverse to drop a
      // perfectly good chapter over the shape of its wrapper.
      .map(s => (typeof s === 'string' ? s : str((s as { text?: unknown } | null)?.text)))
      .map((text, i): GuideStep | null => {
        const clean = str(text).replace(/^\s*\d+[.)]\s*/, '')   // strip a number the model added anyway
        return clean ? { id: `${section.id}-${i + 1}`, text: clean, done: false } : null
      })
      .filter((s): s is GuideStep => s !== null)
      .slice(0, GUIDE_CAPS.MAX_STEPS_PER_SECTION)

  if (pages.length === 0) return []

  const first = parse(await callOllamaJson<StepListReply>(
    `chapter "${section.title}"`, SYSTEM, stepListPrompt(gameTitle, section, pages), STEP_LIST_SCHEMA))
  if (first.length > 0) return first

  note({
    itemId, title: gameTitle, section: section.title, stage: 'steps', level: 'warn',
    message: 'The model listed no steps on the first pass — asking again, more firmly',
  })
  return parse(await callOllamaJson<StepListReply>(
    `chapter "${section.title}" (retry)`,
    SYSTEM,
    `${stepListPrompt(gameTitle, section, pages)}\n\n` +
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

  const numbered = section.steps.map((s, i) => ({ n: i + 1, text: s.text, id: s.id }))
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
    const byId = new Map<string, string>()
    for (const d of Array.isArray(reply?.details) ? reply.details : []) {
      const n = typeof d?.n === 'number' ? d.n : Number(d?.n)
      const note = str(d?.note)
      if (!note || !Number.isInteger(n)) continue
      const target = batch.find(b => b.n === n)
      if (target) byId.set(target.id, note)
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
        const note = byId.get(step.id)
        if (note) step.note = note
      }
    })
    written += byId.size
  }

  return written
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

async function fillSection(
  itemId: string,
  title: string,
  sectionId: string,
  index: number,
  total: number,
  fallbackPages: Page[],
  opts: { wider?: boolean; phase?: string } = {},
): Promise<number> {
  const current = loadGuide(itemId)
  const section = current?.sections.find(s => s.id === sectionId)
  if (!current || !section) return 0

  update(itemId, g => {
    g.phase = opts.phase ?? `${section.title} (${index + 1} of ${total})`
  })
  note({
    itemId, title, section: section.title, stage: 'chapter', level: 'info',
    message: `Started chapter ${index + 1} of ${total} (${section.kind})`,
  })

  const { pages, own } = await researchSection(itemId, title, section, fallbackPages, opts.wider === true)

  // ── Pass one: the skeleton, saved and broadcast on its own ──────────────────
  // The chapter becomes usable here — every step tickable, nothing explained yet.
  // Saving between the passes is what makes a failure in the second one cost only
  // the explanations.
  update(itemId, g => { g.phase = `${section.title} — outlining the steps` })
  const steps = await writeStepList(itemId, title, section, pages)

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
    if (steps.length > 0) target.steps = carryTicks(target.steps, steps)
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
      : `Listed ${steps.length} steps from ${totalChars(pages).toLocaleString()} chars ` +
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

  update(itemId, g => {
    if (!opts.phase) g.phase = `${index + 1} of ${total} sections`
  })
  return steps.length
}

async function run(itemId: string, title: string, order?: string): Promise<void> {
  const started = Date.now()
  try {
    const outlined = await buildOutline(itemId, title, order)
    if (!outlined) return

    const ids = outlined.guide.sections.map(s => s.id)
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
      await fillSection(itemId, title, ids[i]!, i, ids.length, outlined.pages)
    }

    // Second pass over anything still empty. A chapter with no steps is the one
    // outcome that makes the whole guide feel unfinished, and the usual cause is
    // a single unlucky search — so each gets one more attempt with wider terms
    // (which also reach past the game's wiki to Wikipedia and the open web).
    const stillEmpty = (loadGuide(itemId)?.sections ?? []).filter(s => s.steps.length === 0)
    if (stillEmpty.length > 0) {
      note({
        itemId, title, stage: 'repair', level: 'warn',
        message: `${stillEmpty.length} chapter(s) came back empty — researching them again with wider terms: ` +
                 stillEmpty.map(s => s.title).join(', '),
      })
      for (let i = 0; i < stillEmpty.length; i++) {
        if (!loadGuide(itemId)) return
        const section = stillEmpty[i]!
        await fillSection(itemId, title, section.id, i, stillEmpty.length, outlined.pages, {
          wider: true,
          phase: `Filling gaps — ${section.title} (${i + 1} of ${stillEmpty.length})`,
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
    const fallback = await researchGame(title, 'walkthrough 100% completion', 1, OUTLINE_CHARS)
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
export function startGuide(opts: { itemId: string; title: string; order?: string }): StartResult {
  const { itemId, title, order } = opts
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
             `${order ? `, ordered "${order}"` : ''} — model ${OLLAMA_MODEL}, ${NUM_CTX} token context`,
  })
  enqueue(() => run(itemId, title, order))
  return 'started'
}
