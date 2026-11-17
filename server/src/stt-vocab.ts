import fs from 'fs'
import path from 'path'
import { ASSISTANT_PROFILES } from './config/assistant'

// The words speech-to-text should expect: sent to Whisper as its `prompt`.
//
// A small Whisper model hears "Frieren" as "free ran" and "Sonarr" as "sonar",
// because nothing in a five-second clip says those are the words in play. The
// OpenAI transcription API's `prompt` field is exactly that hint — Whisper reads
// it as the text that came before the clip, and spells names the way they were
// spelled there. Measured on lokloComputer (2026-11-17, 14 dashboard-style
// clips): word errors fell from ~9% to ~4% with a names list, for Whisper small
// and Qwen3-ASR alike. TouchSphere sent no prompt at all until then.
//
// The list is built from what this dashboard is actually about, so it follows
// the user without anyone maintaining it:
//   - the assistants' names (the wake word and "hey Martin…" are in every turn)
//   - the app and the services the voice tools talk about
//   - the titles on the Watch/Play list (show names are the worst-heard words)
//   - STT_VOCAB, a comma list of anything else (STT_VOCAB=off sends no prompt)
//
// Whisper keeps only the LAST ~224 tokens of a prompt, so the list is capped and
// ordered least-important first: what survives truncation is the user's own
// list and the titles they are in the middle of.

const MAX_CHARS = 600
const CACHE_MS = 60_000

const BASE_TERMS = [
  'TouchSphere', 'Plex', 'Sonarr', 'Radarr', 'Prowlarr', 'Bazarr', 'Seerr', 'qBittorrent',
  'Notion', 'ComfyUI', 'Ollama',
]

interface MediaRow { title?: string; status?: string; done?: boolean; starred?: boolean }

function mediaTitles(): string[] {
  try {
    const dir = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
    const p = path.join(dir, 'media.json')
    if (!fs.existsSync(p)) return []
    const rows = JSON.parse(fs.readFileSync(p, 'utf8')) as MediaRow[]
    if (!Array.isArray(rows)) return []
    // Finished first, then not started, then starred / in progress last — the
    // end of the prompt is the part Whisper is sure to keep.
    const rank = (r: MediaRow) => (r.starred ? 3 : 0) + (r.status === 'in_progress' ? 2 : r.done || r.status === 'done' ? 0 : 1)
    return rows
      .filter(r => typeof r.title === 'string' && r.title.trim())
      .sort((a, b) => rank(a) - rank(b))
      .map(r => r.title!.trim())
  } catch {
    return []
  }
}

function envTerms(): string[] {
  return (process.env['STT_VOCAB'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** Whether a prompt is sent at all. */
export function sttVocabEnabled(): boolean {
  return !/^(off|0|false|no|none)$/i.test((process.env['STT_VOCAB'] ?? '').trim())
}

let cached: { at: number; text: string } | null = null

/** The `prompt` for the next transcription, or '' when switched off. */
export function sttPrompt(): string {
  if (!sttVocabEnabled()) return ''
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.text
  const names = Object.values(ASSISTANT_PROFILES).map(p => p.name)
  const ordered = [...BASE_TERMS, ...names, ...mediaTitles(), ...envTerms()]
  // De-duplicate keeping the LAST occurrence, so a term's most important
  // position wins.
  const seen = new Set<string>()
  const terms: string[] = []
  for (let i = ordered.length - 1; i >= 0; i--) {
    const k = ordered[i]!.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    terms.unshift(ordered[i]!)
  }
  // Drop from the front until it fits.
  while (terms.length > 1 && terms.join(', ').length + 1 > MAX_CHARS) terms.shift()
  const text = terms.length ? `${terms.join(', ')}.` : ''
  cached = { at: Date.now(), text }
  return text
}

/** Whisper's best-known failure with a prompt: on near-silence it answers with
 *  (part of) the prompt itself. A transcript made only of words from the list
 *  is that echo, not speech. */
export function isPromptEcho(transcript: string, prompt: string): boolean {
  if (!prompt) return false
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean)
  const said = words(transcript)
  if (said.length < 3) return false
  const vocab = new Set(words(prompt))
  return said.every(w => vocab.has(w))
}
