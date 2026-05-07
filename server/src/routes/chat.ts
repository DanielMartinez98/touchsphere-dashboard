// POST /api/chat
//
// Forwards a user message to a local (or remote) Ollama instance and returns
// the assistant's reply. Designed to be a thin pass-through — we keep it
// server-side so the API key (if any) and the upstream URL never reach the
// browser, and so we can swap providers later without touching the client.
//
// Env vars:
//   OLLAMA_URL     base URL of the Ollama HTTP API
//                  (default: http://host.docker.internal:11434)
//   OLLAMA_MODEL   model tag to use   (default: llama3.2)
//   OLLAMA_API_KEY optional Bearer token (only needed if you front Ollama
//                  with a reverse proxy that requires auth, e.g. Open WebUI)
//   OLLAMA_TIMEOUT_MS  upstream timeout (default: 30_000)

import { Router, type Request, type Response } from 'express'

const router = Router()

const OLLAMA_URL     = process.env['OLLAMA_URL']    ?? 'http://host.docker.internal:11434'
const OLLAMA_MODEL   = process.env['OLLAMA_MODEL']  ?? 'gemma3'
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'] ?? ''
const TIMEOUT_MS     = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 30_000)

const SYSTEM_PROMPT =
  "You are TouchSphere, a friendly desktop voice assistant. " +
  "Reply in 1-2 short, natural-sounding sentences. " +
  "Avoid lists, markdown, code blocks, and emoji — your reply will be spoken aloud."

const MAX_PROMPT_LEN = 1000

router.post('/', async (req: Request, res: Response) => {
  const promptRaw = (req.body as { prompt?: unknown }).prompt
  if (typeof promptRaw !== 'string' || promptRaw.trim().length === 0) {
    return res.status(400).json({ error: 'prompt is required' })
  }
  const prompt = promptRaw.trim().slice(0, MAX_PROMPT_LEN)

  console.log(`[chat] → ${OLLAMA_URL} model=${OLLAMA_MODEL} prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`

    const upstream = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
      method:  'POST',
      headers,
      signal:  ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.warn(`[chat] upstream ${upstream.status}: ${detail.slice(0, 200)}`)
      return res.status(502).json({ error: `ollama ${upstream.status}`, detail: detail.slice(0, 500) })
    }

    const json = (await upstream.json()) as {
      message?: { content?: string }
      // /api/generate compatibility, just in case someone points OLLAMA_URL at a wrapper.
      response?: string
    }
    const reply =
      (json.message?.content ?? json.response ?? '').trim() ||
      "I'm here, but I didn't catch a reply that time."

    console.log(`[chat] ← reply="${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`)
    return res.json({ reply, model: OLLAMA_MODEL })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chat] failed:', msg)
    return res.status(502).json({ error: 'chat upstream failed', detail: msg })
  } finally {
    clearTimeout(timer)
  }
})

export default router
