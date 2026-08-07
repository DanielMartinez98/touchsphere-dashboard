// POST /api/chat
//
// Forwards a conversation to a local (or cloud) Ollama instance and returns
// the assistant's reply. Designed to be a thin pass-through — we keep it
// server-side so the API key (if any) and the upstream URL never reach the
// browser, and so we can swap providers later without touching the client.
//
// Multi-turn:  the client sends the full `messages` array (system message is
// prepended here, the client only sends user/assistant turns). We forward the
// whole thing to Ollama so the model has context across turns.
//
// Web search:  if OLLAMA_ENABLE_WEB_SEARCH=1 (or auto-detected from a cloud
// OLLAMA_URL) we expose a `web_search` tool to the model. When the model
// emits a tool call we execute it against Ollama's hosted search endpoint
// (https://ollama.com/api/web_search) and feed the result back in, looping
// up to MAX_TOOL_ROUNDS times before giving up. The model itself decides
// when browsing is needed.
//
// Env vars:
//   OLLAMA_URL              base URL of the Ollama HTTP API
//                           (default: http://host.docker.internal:11434)
//   OLLAMA_MODEL            model tag to use   (default: gemma3)
//   OLLAMA_API_KEY          Bearer token (required for cloud + web search)
//   OLLAMA_TIMEOUT_MS       upstream timeout per round (default: 30_000)
//   OLLAMA_ENABLE_WEB_SEARCH  '1' to force-enable, '0' to force-disable.
//                             If unset: enabled iff OLLAMA_URL points at
//                             ollama.com AND OLLAMA_API_KEY is set.
//   OLLAMA_WEB_SEARCH_URL   override the web-search endpoint
//                           (default: https://ollama.com/api/web_search)

import { Router, type Request, type Response } from 'express'
import { DASHBOARD_TOOLS, MUTATING_TOOLS, TOOL_SLICE, runDashboardTool } from './dashboard-tools'
import { BROWSE_TOOLS, runBrowseTool, type DisplayPayload } from './browse'
import { addMemory, formatForPrompt as formatMemoryForPrompt } from '../memory'
import { getSelectedProfile, type AssistantProfile } from '../config/assistant'

const router = Router()

const OLLAMA_URL     = process.env['OLLAMA_URL']    ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']  ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''
const TIMEOUT_MS     = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 30_000)
const WEB_SEARCH_URL = process.env['OLLAMA_WEB_SEARCH_URL'] ?? 'https://ollama.com/api/web_search'
const WEB_FETCH_URL  = process.env['OLLAMA_WEB_FETCH_URL']  ?? 'https://ollama.com/api/web_fetch'

// ── Thinking mode ─────────────────────────────────────────────────────────
// Reasoning models (Gemma 4 among them) default to thinking, and Ollama then
// returns the reasoning in `message.thinking` while leaving `message.content`
// EMPTY. Nothing errors: the request is a 200, the tool loop sees no text and
// no tool calls, and the user hears the "didn't catch a reply" fallback — a
// total failure that looks like success from every angle.
//   https://github.com/ollama/ollama/issues/15288
//
// Off by default, for two reasons: this assistant's whole job is one or two
// spoken sentences, and thinking tokens are latency the user waits through
// before hearing anything. Set OLLAMA_THINK=true (or low|medium|high|max) if
// you ever want it back; empty string omits the field for upstreams that
// reject unknown keys.
const OLLAMA_THINK: boolean | string | null = (() => {
  const raw = (process.env['OLLAMA_THINK'] ?? 'false').trim().toLowerCase()
  if (raw === '')      return null
  if (raw === 'true')  return true
  if (raw === 'false') return false
  if (['low', 'medium', 'high', 'max'].includes(raw)) return raw
  console.warn(`[chat] unrecognised OLLAMA_THINK="${raw}" — disabling thinking`)
  return false
})()

const WEB_SEARCH_ENABLED = (() => {
  const flag = process.env['OLLAMA_ENABLE_WEB_SEARCH']
  if (flag === '1' || flag?.toLowerCase() === 'true')  return true
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  // Auto: on for Ollama cloud + API key.
  return /ollama\.com/i.test(OLLAMA_URL) && OLLAMA_API_KEY.length > 0
})()

// Everything after the persona is identical across assistants. The persona
// (name + personality) is prepended per-request from the user's selected
// profile \u2014 see buildSystemPrompt below.
const SYSTEM_PROMPT_BODY =
  "You are a voice assistant living on the user's dashboard. " +
  "Reply in 1-2 short, natural-sounding sentences. " +
  "Avoid lists, markdown, code blocks, and emoji \u2014 your reply will be spoken aloud. " +
  "SOUNDS: perform your noises, never narrate them. Your text goes straight to a speech engine, so writing " +
  "*hiccup* or (clears throat) just makes the voice say the WORD \"hiccup\" \u2014 that is not a hiccup. " +
  "Instead, SPELL THE NOISE PHONETICALLY, the way it actually sounds when pronounced, as ordinary words in the sentence: " +
  "hiccup \u2192 \"Eehuuup!\"  sigh \u2192 \"Haaahhh...\"  groan \u2192 \"Uuurgh.\"  burp \u2192 \"Buuuurp.\"  laugh \u2192 \"Heh heh heh.\"  " +
  "throat-clear \u2192 \"Ahem.\"  disgust \u2192 \"Blegh.\"  dismissal \u2192 \"Pffff.\"  Stretch the vowels so the engine drawls them " +
  "(\"Uuuugh\", not \"Ugh\"). Never write the name of the sound; write the sound. No asterisks, no parenthetical actions. " +
  "BODY LANGUAGE: you have an animated on-screen body and face. You may embed hidden stage cues in square brackets, " +
  "placed at the exact point in the sentence where the action should happen \u2014 they are invisible and silent, the system " +
  "strips them before display and speech and performs them instead. " +
  "Gestures: [wave] [nod] [shake] [bow] [cheer] [think] [jump] [peace] [pose] [show] [shoot]. " +
  "Faces: [happy] [excited] [shy] [wink] [sad] [angry] [surprised] [calm] [shocked]. " +
  "Use 0-2 cues per reply, only where they feel natural \u2014 a [wave] on a greeting, a [think] before a tricky answer, " +
  "a [cheer] for good news. Only these exact words in brackets; never invent new ones, never mention the cues aloud. " +
  "TURN CONTROL \u2014 you decide explicitly when the conversation ends. " +
  "The microphone is CLOSED while you think and speak. To control whether it reopens after your reply, " +
  "you MUST call exactly one of these tools BEFORE producing your final spoken text: " +
  "  - end_conversation()  -- conversation is complete; mic stays closed (this is the default expectation). " +
  "  - keep_listening()    -- you need another user turn; mic reopens after TTS finishes. " +
  "Call end_conversation in every case below: " +
  "(a) you answered the question, " +
  "(b) you completed an action (added/removed/marked an item, fetched info, etc.), " +
  "(c) you reported a result from a tool, " +
  "(d) you acknowledged something (\"got it\", \"sure\", \"done\"), " +
  "(e) you don't know and have nothing more to try. " +
  "Call keep_listening ONLY when you literally cannot proceed without more input from the user " +
  "(ambiguous title, missing date, unclear target, multiple matching items to disambiguate). " +
  "Never call keep_listening for filler like \"anything else?\", \"sound good?\", or \"let me know if you need more\" \u2014 those are end_conversation. " +
  "If you forget to call either tool, the system defaults to end_conversation. " +
  "Only call ONE turn-control tool per reply; if you change your mind mid-turn, the LATER call wins. " +
  "Don't quote the user's question back at them; if you must reference what they asked, paraphrase as a statement. " +
  "You have tools to read and update the dashboard's own widgets: " +
  "get_time (current time at any city or IANA timezone \u2014 always use this for time questions, never guess), " +
  "list_media_items / add_media_item / remove_media_item / mark_media_done / set_media_status / star_media_item / recommend_media_item " +
  "(the user's playlist of games, shows, and movies \u2014 use add_media_item to save anything they want to remember to play or watch, " +
  "set_media_status when they report progress on games/shows (\"started\", \"finished\", \"gave up\") with status in_progress | done | dropped, " +
  "star_media_item to pin priorities to the top, recommend_media_item when they ask what to play/watch next. " +
  "Note: movies only support \"not_started\" or \"done\" \u2014 never use in_progress or dropped on a movie), " +
  "set_app_mode (switch between work and rest modes \u2014 use when the user says \"switch to rest\", \"back to work\", etc.), " +
  "add_notion_task (add an actionable to-do to the user's Notion task list \u2014 errands, work items, reminders, chores, follow-ups; " +
  "pass an optional natural-language due date like \"today\", \"tomorrow\", or \"next friday\". " +
  "IMPORTANT: use add_notion_task for things the user needs to DO, and add_media_item only for games, shows, or movies to play or watch \u2014 never mix them up), " +
  "set_timer / set_alarm / list_timers / cancel_timer " +
  "(set_timer for relative countdowns \u2014 \"timer for 10 minutes\", pass the duration in the hours/minutes/seconds fields; " +
  "set_alarm for an absolute clock time \u2014 \"wake me at 7:30 am\"; the dashboard rings and shows the countdown automatically, " +
  "so just confirm what you set in one short sentence), " +
  "get_weather (now), get_weather_forecast (future \u2014 use for any \"will it rain\", \"high tomorrow\", multi-hour question), " +
  "get_air_quality, get_calendar_today, get_calendar_day, get_calendar_week, get_calendar_range, get_device_status, " +
  "remember (save a fact to long-term or short-term memory), forget (remove memories matching a query), and list_memories. " +
  "PERSISTENT MEMORY: anything you saved with remember in a past conversation is auto-injected into your prompt below — " +
  "treat those as facts you already know and answer directly without re-asking. Use remember whenever the user shares " +
  "something they would not want to repeat (their name, preferences, recurring routines, what they're working on today). " +
  "Choose scope=long for stable facts, scope=short for context that's only relevant for the rest of the day. " +
  "Use forget when the user contradicts a saved fact or asks you to forget something. " +
  "For any calendar question other than 'today', use get_calendar_day, get_calendar_week, or get_calendar_range — never guess what is on a date you haven't fetched. " +
  "CRITICAL: When you use a tool, base your answer strictly on what the tool actually returned. " +
  "Do not invent facts, numbers, dates, names, titles, or quotes. After mutating tools (add/remove/mark) confirm what you did in one short sentence." +
  (WEB_SEARCH_ENABLED
    ? " You also have web_search and web_fetch tools for current events, recent news, live data, " +
      "or anything you don't reliably know. If a search snippet looks promising but lacks the exact " +
      "answer, call web_fetch on that URL to read the full page."
    : "") +
  " SHOWING THINGS ON SCREEN: you can put a page or a video on the dashboard with open_website and play_video. " +
  "Answering out loud and showing something are not exclusive — showing is an extra, and you still speak one short sentence either way. " +
  "Use play_video for anything the user would rather WATCH: tutorials, how-tos, recipes, repairs, walkthroughs, " +
  "workouts, music, trailers, \"show me how to...\". " +
  "Use open_website when they ask you to open, pull up, show, or browse a site, article, or page, " +
  "and for answers that are much better read than heard (long articles, documentation, recipes with amounts, tables, listings). " +
  (WEB_SEARCH_ENABLED
    ? "For open_website, call web_search FIRST and pass the winning result's exact url — only pass a bare query if the search gave you nothing. "
    : "For open_website, pass a url you are confident is real (e.g. a wikipedia.org article); pass a query only if you have none. ") +
  "Do NOT speak URLs out loud — say what you put on screen (\"Put a ten-minute knife-sharpening tutorial up for you\"), never the address. " +
  "If the user only wants a quick fact, just answer — don't open a window for it. " +
  "One window at a time: a new open_website or play_video replaces whatever is on screen."

// Compose the full system prompt for a given assistant: its personality up
// front, then the shared behaviour/tool instructions.
function buildSystemPrompt(profile: AssistantProfile): string {
  return `${profile.persona} ${SYSTEM_PROMPT_BODY}`
}

const MAX_PROMPT_LEN     = 1000
const MAX_HISTORY_MSGS   = 20      // user+assistant turns kept per request
const MAX_TOOL_ROUNDS    = 5       // safety cap on tool-call loop
const MAX_SEARCH_RESULTS = 5
const MAX_SNIPPET_CHARS  = 2000    // per-result content from web_search
const MAX_TOOL_MSG_CHARS = 8000    // total chars we feed back per tool message

type Role = 'system' | 'user' | 'assistant' | 'tool'
interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}
interface ChatMessage {
  role: Role
  content: string
  tool_calls?: ToolCall[]
  tool_name?: string
}

const WEB_TOOLS = WEB_SEARCH_ENABLED ? [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web for up-to-date information. Returns a list of result snippets with titles and URLs. Use for current events, recent news, live data, or anything that may have changed recently.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A concise search query (a few keywords, like a Google search).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the full text content of a specific URL. Use this after web_search when a snippet looks relevant but you need the full page to answer accurately (e.g. exact numbers, dates, quotes).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (must start with http:// or https://).',
          },
        },
        required: ['url'],
      },
    },
  },
] : []

// ── Turn-control tools ────────────────────────────────────────────────────
// The model decides explicitly whether the mic reopens for another turn by
// calling one of these (instead of the previous '?' heuristic). Default is
// to end the conversation if neither is called by the time the model emits a
// final text reply — i.e. silence ends the session, the model has to opt in
// to keep listening.
const TURN_CONTROL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'end_conversation',
      description:
        'Signal that the conversation is COMPLETE and the microphone should NOT reopen. ' +
        'Call this whenever you have answered the question, completed the requested action, ' +
        'reported a tool result, acknowledged something, or have nothing more to do. ' +
        'This is the default — when in doubt, call this. ' +
        'Call it BEFORE producing your final spoken reply, in the same turn.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keep_listening',
      description:
        'Signal that you NEED another user turn and the microphone should reopen after you finish speaking. ' +
        'Call this ONLY when you literally cannot proceed without more input from the user ' +
        '(ambiguous title, missing date, multiple matching items to disambiguate, unclear target). ' +
        'Do NOT call this for filler like "anything else?" — those should use end_conversation instead. ' +
        'Call it BEFORE producing your final spoken reply, in the same turn.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const

// Dashboard + browsing tools are always exposed; web search/fetch layer on if
// configured. (open_website / play_video do their own resolving, so they work
// even without an Ollama web-search key.)
const TOOLS = [...DASHBOARD_TOOLS, ...BROWSE_TOOLS, ...TURN_CONTROL_TOOLS, ...WEB_TOOLS]

// ── Tool implementations ──────────────────────────────────────────────────
async function runWebSearch(query: string): Promise<string> {
  if (!OLLAMA_API_KEY) return 'web_search unavailable: no API key configured.'
  console.log(`[chat:tool] web_search query="${query.slice(0, 80)}"`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(WEB_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${OLLAMA_API_KEY}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({ query, max_results: MAX_SEARCH_RESULTS }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn(`[chat:tool] web_search ${res.status}: ${detail.slice(0, 200)}`)
      return `web_search failed: ${res.status} ${detail.slice(0, 200)}`
    }
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    const results = (json.results ?? []).slice(0, MAX_SEARCH_RESULTS)
    if (results.length === 0) return 'No results.'
    return results
      .map((r, i) =>
        `[${i + 1}] ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${(r.content ?? '').slice(0, MAX_SNIPPET_CHARS)}`,
      )
      .join('\n\n')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[chat:tool] web_search error:', msg)
    return `web_search error: ${msg}`
  } finally {
    clearTimeout(timer)
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'end_conversation' || name === 'keep_listening') {
    // Handled at the call-site for control-flow purposes; this branch only
    // runs if the loop somehow forwards it here. Return a brief ACK either way.
    return 'Acknowledged.'
  }
  if (name === 'web_search') {
    const q = typeof args['query'] === 'string' ? args['query'] : ''
    if (!q.trim()) return 'web_search error: missing "query" argument.'
    return runWebSearch(q.trim().slice(0, 200))
  }
  if (name === 'web_fetch') {
    const u = typeof args['url'] === 'string' ? args['url'] : ''
    if (!u.trim()) return 'web_fetch error: missing "url" argument.'
    return runWebFetch(u.trim())
  }
  const dashboard = await runDashboardTool(name, args)
  if (dashboard !== null) return dashboard
  return `Unknown tool: ${name}`
}

async function runWebFetch(url: string): Promise<string> {
  if (!OLLAMA_API_KEY) return 'web_fetch unavailable: no API key configured.'
  if (!/^https?:\/\//i.test(url)) return `web_fetch error: url must start with http(s)://`
  console.log(`[chat:tool] web_fetch url="${url.slice(0, 120)}"`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(WEB_FETCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${OLLAMA_API_KEY}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({ url }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn(`[chat:tool] web_fetch ${res.status}: ${detail.slice(0, 200)}`)
      return `web_fetch failed: ${res.status} ${detail.slice(0, 200)}`
    }
    const json = (await res.json()) as { title?: string; content?: string }
    const title = json.title ?? '(no title)'
    const content = (json.content ?? '').trim()
    if (!content) return `Fetched ${url} but the page had no extractable content.`
    return `Title: ${title}\nURL: ${url}\n\n${content}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[chat:tool] web_fetch error:', msg)
    return `web_fetch error: ${msg}`
  } finally {
    clearTimeout(timer)
  }
}

// ── Background session summarizer ─────────────────────────────────────────
// When the assistant calls end_conversation we kick this off (fire-and-forget)
// to distill the just-finished session into one short note that lives in
// short-term memory for the next 24h. Skipped for trivial sessions to avoid
// burning tokens on "what time is it"-style one-shots.
async function summarizeAndStore(history: ChatMessage[], finalReply: string): Promise<void> {
  // Filter to user/assistant text turns; tool messages and the system prompt
  // aren't useful here. Append the just-spoken final reply so the summarizer
  // sees how the assistant closed the conversation.
  const turns = history.filter(m =>
    (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim(),
  )
  if (finalReply.trim()) turns.push({ role: 'assistant', content: finalReply.trim() })
  const transcript = turns
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n')
  if (!transcript) return
  const userTurns = history.filter(m => m.role === 'user').length
  // Single-turn Q&A rarely contains anything worth remembering for tomorrow.
  if (userTurns < 2 && transcript.length < 200) return

  try {
    const summarizerMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          "You are a memory summarizer. Given a transcript of a voice conversation between a user and " +
          "an assistant, write ONE short factual sentence (under 25 words) that captures only the parts " +
          "worth remembering for tomorrow — what the user is doing, planning, feeling, or interested in. " +
          "Skip pleasantries, weather lookups, time checks, and anything trivial. " +
          "If the conversation contains nothing memorable, reply with the single word: SKIP.",
      },
      { role: 'user', content: transcript.slice(0, 4000) },
    ]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      // Same thinking caveat as callOllama — a reasoning model would return an
      // empty summary here too, silently costing every session its memory note.
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: summarizerMessages,
        ...(OLLAMA_THINK !== null ? { think: OLLAMA_THINK } : {}),
      }),
    }).finally(() => clearTimeout(timer))
    if (!res.ok) {
      console.warn('[memory:auto] summarizer upstream', res.status)
      return
    }
    const json = await res.json() as { message?: { content?: string }; response?: string }
    const summary = (json.message?.content ?? json.response ?? '').trim()
    if (!summary || /^skip\.?$/i.test(summary) || summary.length > 250) {
      console.log(`[memory:auto] no summary stored (raw="${summary.slice(0, 60)}")`)
      return
    }
    addMemory(summary, 'short', 'auto')
  } catch (err) {
    console.warn('[memory:auto] summarize failed:', err)
  }
}

// ── Single Ollama /api/chat round ─────────────────────────────────────────
interface OllamaResponse {
  // `thinking` is only read for diagnostics — it's a reasoning trace, not a
  // reply, and speaking it aloud would be worse than the fallback line. Its
  // presence alongside empty content is the signature of the bug above.
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }
  response?: string
  status: number
  detail?: string
}

async function callOllama(messages: ChatMessage[]): Promise<OllamaResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    const body: Record<string, unknown> = {
      model: OLLAMA_MODEL,
      stream: false,
      messages,
    }
    if (TOOLS.length > 0) body['tools'] = TOOLS
    if (OLLAMA_THINK !== null) body['think'] = OLLAMA_THINK

    const upstream = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify(body),
    })
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      return { status: upstream.status, detail }
    }
    const json = await upstream.json() as {
      message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }
      response?: string
    }
    return { ...json, status: 200 }
  } finally {
    clearTimeout(timer)
  }
}

// ── Route ─────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const body = req.body as { prompt?: unknown; messages?: unknown }

  // Normalize input. Accept either:
  //   { prompt: string }                       (legacy single-turn)
  //   { messages: [{role, content}, ...] }     (multi-turn)
  let history: ChatMessage[] = []
  if (Array.isArray(body.messages)) {
    history = body.messages
      .filter((m): m is { role: string; content: string } =>
        !!m && typeof m === 'object'
        && (m as { role?: unknown }).role !== undefined
        && typeof (m as { content?: unknown }).content === 'string',
      )
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as Role, content: m.content.slice(0, MAX_PROMPT_LEN) }))
      .slice(-MAX_HISTORY_MSGS)
  } else if (typeof body.prompt === 'string' && body.prompt.trim().length > 0) {
    history = [{ role: 'user', content: body.prompt.trim().slice(0, MAX_PROMPT_LEN) }]
  }

  // Last message must be a user turn.
  const last = history[history.length - 1]
  if (!last || last.role !== 'user' || !last.content.trim()) {
    return res.status(400).json({ error: 'a final user message (or `prompt`) is required' })
  }

  // Inject persistent memory into the system message so the assistant treats
  // remembered facts as background knowledge without having to call list_memories.
  const profile = getSelectedProfile()
  const memoryBlock = formatMemoryForPrompt()
  const basePrompt = buildSystemPrompt(profile)
  const systemContent = memoryBlock ? `${basePrompt}\n${memoryBlock}` : basePrompt
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...history,
  ]

  const preview = last.content.slice(0, 80)
  console.log(
    `[chat] → ${OLLAMA_URL} model=${OLLAMA_MODEL} as=${profile.id} turns=${history.length} ` +
    `tools=dashboard${WEB_SEARCH_ENABLED ? '+web' : ''} think=${JSON.stringify(OLLAMA_THINK)} ` +
    `prompt=\"${preview}${last.content.length > 80 ? '\u2026' : ''}\"`,
  )

  // Track which client-side state slices the model touched so the client can
  // refetch just those (rather than reloading every widget on every reply).
  const changed = new Set<string>()

  // Turn control. Default = end conversation (mic stays closed). Flipped to
  // true when the model calls keep_listening; flipped back to false if it
  // later calls end_conversation in the same turn.
  let keepListening = false

  // Set when the model asks for something to be put on screen (open_website /
  // play_video). Only the last one survives — the dashboard shows one window.
  let display: DisplayPayload | null = null

  try {
    // Tool-call loop. Bounded by MAX_TOOL_ROUNDS to prevent runaway upstreams.
    for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round++) {
      const resp = await callOllama(messages)
      if (resp.status !== 200) {
        console.warn(`[chat] upstream ${resp.status}: ${(resp.detail ?? '').slice(0, 200)}`)
        return res.status(502).json({ error: `ollama ${resp.status}`, detail: (resp.detail ?? '').slice(0, 500) })
      }

      const msg = resp.message
      const calls = msg?.tool_calls ?? []
      const text  = (msg?.content ?? resp.response ?? '').trim()

      // No tool calls → we're done.
      if (calls.length === 0) {
        // An empty final message is a real upstream failure wearing a 200: the
        // user hears the fallback line and the log says "reply=..." as if all
        // was well. Dump the message shape so the cause is visible — commonly a
        // model that put its answer somewhere other than `content` (e.g. the
        // `thinking` field of a reasoning model), or one that stopped early.
        if (!text) {
          const thinking = (msg?.thinking ?? '').trim()
          if (thinking) {
            // The model answered, into the wrong field. Name the fix outright
            // rather than making the next person rediscover the GitHub issue.
            console.warn(
              `[chat] EMPTY content but ${thinking.length} chars of THINKING — the model is in ` +
              `reasoning mode and put its answer in message.thinking. think=${JSON.stringify(OLLAMA_THINK)} ` +
              `was sent; if that is not false, set OLLAMA_THINK=false. See ollama/ollama#15288. ` +
              `thinking="${thinking.slice(0, 200).replace(/\s+/g, ' ')}…"`,
            )
          } else {
            console.warn(
              `[chat] upstream returned an EMPTY final message on round ${round + 1} — ` +
              `no content, no thinking, no tool calls. Model=${OLLAMA_MODEL}, ` +
              `system prompt ${messages[0]?.content.length ?? 0} chars. ` +
              `raw=${JSON.stringify(msg ?? resp.response ?? null).slice(0, 400)}`,
            )
          }
        }
        const reply = text || "I'm here, but I didn't catch a reply that time."
        console.log(`[chat] ← reply="${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}" rounds=${round + 1} changed=[${[...changed].join(',')}] keepListening=${keepListening}${display ? ` display=${display.kind}` : ''}`)
        // Conversation is ending — kick off a background summary for short-term
        // memory. Fire-and-forget so the user gets their reply without waiting.
        if (!keepListening) void summarizeAndStore(messages, reply)
        return res.json({ reply, model: OLLAMA_MODEL, changed: [...changed], keepListening, display })
      }

      // Cap reached — bail with whatever text we have so the user hears something.
      if (round === MAX_TOOL_ROUNDS) {
        console.warn(`[chat] tool-call cap reached (${MAX_TOOL_ROUNDS}) — returning fallback`)
        const reply = text || "I tried to look that up but couldn't finish in time."
        return res.json({ reply, model: OLLAMA_MODEL, changed: [...changed], keepListening, display })
      }

      // Execute each tool call and append the results back into the conversation.
      messages.push({ role: 'assistant', content: text, tool_calls: calls })
      for (const c of calls) {
        const name = c.function?.name ?? ''
        const args = (c.function?.arguments ?? {}) as Record<string, unknown>

        // Turn-control tools flip the mic flag for the response and feed back a
        // short ACK so the model continues to its final spoken reply.
        if (name === 'end_conversation') {
          keepListening = false
          console.log('[chat:tool] end_conversation \u2014 mic will stay closed')
          messages.push({ role: 'tool', content: 'Acknowledged. The microphone will stay closed after your reply.', tool_name: name })
          continue
        }
        if (name === 'keep_listening') {
          keepListening = true
          console.log('[chat:tool] keep_listening \u2014 mic will reopen after reply')
          messages.push({ role: 'tool', content: 'Acknowledged. The microphone will reopen after your reply so the user can respond.', tool_name: name })
          continue
        }

        // Browsing tools return a payload for the client alongside the text
        // the model reads, so they're dispatched here rather than in runTool.
        const browsed = await runBrowseTool(name, args)
        if (browsed) {
          if (browsed.display) display = browsed.display
          console.log(`[chat:tool] ${name} → ${browsed.display ? `${browsed.display.kind} "${browsed.display.title.slice(0, 60)}"` : 'no display'}`)
          messages.push({ role: 'tool', content: browsed.text, tool_name: name })
          continue
        }

        const result = await runTool(name, args)
        if (MUTATING_TOOLS.has(name) && !/^(Error|No playlist|No timer|There are no|Already on the list|Nothing)/.test(result)) {
          // Bucket each mutating tool under the client-side slice key its
          // matching hook listens for. The voice hook fans these out as
          // ts:state-changed events so only the affected widgets refetch.
          changed.add(TOOL_SLICE[name] ?? 'media')
        }
        const truncated = result.slice(0, MAX_TOOL_MSG_CHARS)
        console.log(`[chat:tool] ${name} returned ${result.length} chars (sent ${truncated.length}): ${truncated.slice(0, 200).replace(/\s+/g, ' ')}\u2026`)
        messages.push({ role: 'tool', content: truncated, tool_name: name })
      }
    }

    // Unreachable, but keeps TypeScript happy.
    return res.status(500).json({ error: 'tool loop exited unexpectedly' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chat] failed:', msg)
    return res.status(502).json({ error: 'chat upstream failed', detail: msg })
  }
})

export default router
