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

const router = Router()

const OLLAMA_URL     = process.env['OLLAMA_URL']    ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']  ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''
const TIMEOUT_MS     = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 30_000)
const WEB_SEARCH_URL = process.env['OLLAMA_WEB_SEARCH_URL'] ?? 'https://ollama.com/api/web_search'
const WEB_FETCH_URL  = process.env['OLLAMA_WEB_FETCH_URL']  ?? 'https://ollama.com/api/web_fetch'

const WEB_SEARCH_ENABLED = (() => {
  const flag = process.env['OLLAMA_ENABLE_WEB_SEARCH']
  if (flag === '1' || flag?.toLowerCase() === 'true')  return true
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  // Auto: on for Ollama cloud + API key.
  return /ollama\.com/i.test(OLLAMA_URL) && OLLAMA_API_KEY.length > 0
})()

const SYSTEM_PROMPT =
  "You are TouchSphere, a friendly desktop voice assistant. " +
  "Reply in 1-2 short, natural-sounding sentences. " +
  "Avoid lists, markdown, code blocks, and emoji — your reply will be spoken aloud." +
  (WEB_SEARCH_ENABLED
    ? " You have web_search and web_fetch tools. Use web_search for current events, " +
      "recent news, live data (weather, sports scores, prices, times), or anything " +
      "you don't reliably know. If a search snippet looks promising but lacks the exact " +
      "answer, call web_fetch on that URL to read the full page. " +
      "CRITICAL: When you use a tool, base your answer strictly on what the tool actually " +
      "returned. Do not invent facts, numbers, dates, names, or quotes. If the tool results " +
      "do not contain a clear answer, say so honestly in one sentence rather than guessing."
    : "")

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

const TOOLS = WEB_SEARCH_ENABLED ? [
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
] : undefined

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

// ── Single Ollama /api/chat round ─────────────────────────────────────────
interface OllamaResponse {
  message?: { content?: string; tool_calls?: ToolCall[] }
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
    if (TOOLS) body['tools'] = TOOLS

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
      message?: { content?: string; tool_calls?: ToolCall[] }
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

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ]

  const preview = last.content.slice(0, 80)
  console.log(
    `[chat] → ${OLLAMA_URL} model=${OLLAMA_MODEL} turns=${history.length} ` +
    `tools=${WEB_SEARCH_ENABLED ? 'web_search' : 'off'} prompt="${preview}${last.content.length > 80 ? '…' : ''}"`,
  )

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
        const reply = text || "I'm here, but I didn't catch a reply that time."
        console.log(`[chat] ← reply="${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}" rounds=${round + 1}`)
        return res.json({ reply, model: OLLAMA_MODEL })
      }

      // Cap reached — bail with whatever text we have so the user hears something.
      if (round === MAX_TOOL_ROUNDS) {
        console.warn(`[chat] tool-call cap reached (${MAX_TOOL_ROUNDS}) — returning fallback`)
        const reply = text || "I tried to look that up but couldn't finish in time."
        return res.json({ reply, model: OLLAMA_MODEL })
      }

      // Execute each tool call and append the results back into the conversation.
      messages.push({ role: 'assistant', content: text, tool_calls: calls })
      for (const c of calls) {
        const name = c.function?.name ?? ''
        const args = (c.function?.arguments ?? {}) as Record<string, unknown>
        const result = await runTool(name, args)
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
