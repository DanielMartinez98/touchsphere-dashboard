// The last conversation — kept for 12 hours so a topic can be picked back up.
//
// The client throws its history away the moment the assistant ends a
// conversation, which is right for a wake-word device: you don't want yesterday
// bleeding into "what's the weather". But it also means that walking away and
// coming back thirty seconds later loses everything, and the user has to
// re-explain what they were doing.
//
// So the transcript is parked here on the way out, and on the FIRST utterance
// of the next conversation we make one explicit decision:
//
//   continue → the user is still on that topic. The old turns are prepended to
//              the new conversation as real history; the model sees them as
//              things that were actually said.
//   maybe    → can't tell. Only a one-line recap is injected, flagged as
//              possibly unrelated, and the model decides in context.
//   new      → unrelated. Nothing is injected; the conversation starts clean,
//              exactly as it does today.
//
// The decision is lexical, not a model call. An LLM classifier would be more
// accurate, but it would sit in front of every single reply on a local Ollama
// box — the same latency this codebase already turned thinking mode off to
// avoid. The 'maybe' band exists precisely so the cheap scorer doesn't have to
// be right at the edges: it hands the ambiguous cases to the model that was
// going to run anyway.
//
// Stored as JSON under CACHE_DIR, alongside memory.json.

import fs from 'fs'
import path from 'path'

const FILE = 'session.json'
const SESSION_TTL_MS   = 12 * 60 * 60 * 1000   // 12 hours
const MAX_TURNS        = 20
const MAX_TURN_CHARS   = 500
const MAX_KEYWORDS     = 40

export interface SessionTurn { role: 'user' | 'assistant'; content: string }

export interface SavedSession {
  endedAt:  string          // ISO
  turns:    SessionTurn[]
  summary?: string          // one-line gist, when the summarizer produced one
  keywords: string[]        // content words, for the continuation score
}

function dir(): string {
  const d = process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}
function pathFor(): string { return path.join(dir(), FILE) }

// ── Keywording ────────────────────────────────────────────────────────────
// Deliberately dumb: lowercase, split on non-letters, drop stopwords and very
// short tokens, crudely singularize. Good enough to tell "the elden ring boss"
// from "what's the weather", which is the entire job.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','than','that','this','these','those',
  'is','are','was','were','be','been','being','am','do','does','did','doing','done',
  'have','has','had','having','can','could','will','would','should','shall','may',
  'might','must','i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their','mine','yours','what','which','who','whom',
  'whose','when','where','why','how','all','any','both','each','few','more','most',
  'other','some','such','no','nor','not','only','own','same','so','too','very','s',
  'to','of','in','on','at','by','for','with','about','from','up','down','out','off',
  'over','under','again','further','once','here','there','now','just','also','get',
  'got','go','going','want','wanted','like','need','please','okay','ok','yeah','yes',
  'hey','hi','hello','thanks','thank','tell','show','give','make','let','know','see',
  'think','say','said','one','two','thing','things','stuff','really','actually',
])

// Crude singularize, so "bosses"/"boss" and "videos"/"video" land on the same
// token. The order matters: a blanket /(es|s)$/ would take "fires" down to
// "fir" while leaving "fire" alone, and the two would then never match.
function singular(w: string): string {
  if (/(?:ss|us|is)$/.test(w)) return w                    // boss, status, analysis
  if (/(?:ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)  // bosses → boss
  if (/[^s]s$/.test(w)) return w.slice(0, -1)               // fires → fire, giants → giant
  return w
}

export function keywordsOf(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const w = raw.replace(/'s$/, '')
    if (w.length < 3) continue
    if (STOPWORDS.has(w)) continue
    const stem = singular(w)
    out.add(stem.length >= 3 ? stem : w)
  }
  return [...out]
}

// ── Store ─────────────────────────────────────────────────────────────────
/** Returns the `endedAt` stamp it wrote — the handle for updateSessionSummary. */
export function saveSession(turns: SessionTurn[], summary?: string): string | null {
  const trimmed = turns
    .filter(t => t.content && t.content.trim())
    .map(t => ({ role: t.role, content: t.content.trim().slice(0, MAX_TURN_CHARS) }))
    .slice(-MAX_TURNS)
  if (trimmed.length === 0) return null

  // Topic keywords come from what the USER said. The assistant's replies drag
  // in vocabulary from tool output ("degrees", "forecast") that would make
  // every session look like it was about the weather.
  const userText = trimmed.filter(t => t.role === 'user').map(t => t.content).join(' ')
  const keywords = keywordsOf(`${userText} ${summary ?? ''}`).slice(0, MAX_KEYWORDS)

  const session: SavedSession = {
    endedAt: new Date().toISOString(),
    turns: trimmed,
    keywords,
    ...(summary?.trim() ? { summary: summary.trim().slice(0, 300) } : {}),
  }
  if (!writeSession(session)) return null
  console.log(`[session] saved ${trimmed.length} turns, keywords=[${keywords.slice(0, 8).join(',')}]`)
  return session.endedAt
}

function writeSession(session: SavedSession): boolean {
  const p = pathFor()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    console.warn('[session] save failed:', err)
    return false
  }
}

// Attach the gist once the background summarizer produces one, which sharpens
// the topic keywords the next utterance is scored against.
//
// Guarded by the stamp from saveSession: the summarizer takes up to 15s, and a
// blind re-write landing after the user has already had another conversation
// would replace the newer session with a stale one.
export function updateSessionSummary(stamp: string, summary: string): void {
  const current = loadSession()
  if (!current || current.endedAt !== stamp) {
    console.log('[session] summary arrived for a superseded session — discarded')
    return
  }
  const userText = current.turns.filter(t => t.role === 'user').map(t => t.content).join(' ')
  const next: SavedSession = {
    ...current,
    summary: summary.trim().slice(0, 300),
    keywords: keywordsOf(`${userText} ${summary}`).slice(0, MAX_KEYWORDS),
  }
  if (writeSession(next)) console.log('[session] summary attached')
}

/** The last conversation, or null if there isn't one or it's older than 12h. */
export function loadSession(): SavedSession | null {
  const p = pathFor()
  try {
    if (!fs.existsSync(p)) return null
    const s = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SavedSession>
    if (!s.endedAt || !Array.isArray(s.turns) || s.turns.length === 0) return null
    const age = Date.now() - new Date(s.endedAt).getTime()
    if (!Number.isFinite(age) || age > SESSION_TTL_MS) {
      clearSession()
      console.log('[session] expired (older than 12h) — forgotten')
      return null
    }
    return {
      endedAt:  s.endedAt,
      turns:    s.turns,
      keywords: Array.isArray(s.keywords) ? s.keywords : [],
      ...(s.summary ? { summary: s.summary } : {}),
    }
  } catch (err) {
    console.warn('[session] unreadable, discarding:', err)
    clearSession()
    return null
  }
}

export function clearSession(): void {
  try { fs.rmSync(pathFor(), { force: true }) } catch { /* already gone */ }
}

/** Minutes since the session ended — for prompt phrasing and logging. */
export function sessionAgeMinutes(s: SavedSession): number {
  return Math.max(0, Math.round((Date.now() - new Date(s.endedAt).getTime()) / 60_000))
}

// ── Continuation scoring ──────────────────────────────────────────────────
export type Verdict = 'continue' | 'maybe' | 'new'
export interface Decision { verdict: Verdict; score: number; reason: string }

// "and what about the second one" — an utterance that grammatically depends on
// something already said.
const FOLLOW_UP_OPENER = /^(and\b|also\b|what about\b|how about\b|but\b|so\b|then\b|what else\b|anything else\b|another\b|more\b|again\b|continue\b|keep going\b|go on\b|next\b|ok(ay)?[, ]+(but|and|so)\b)/i
// Words that point AT something rather than naming it.
const ANAPHORA = /\b(it|its|that|those|these|them|they|he|she|him|her|the same|that one|this one|the (first|second|third|other|last|next) one)\b/i
// The user telling you outright that they've moved on.
const NEW_TOPIC = /^(new question|different question|never ?mind|forget (that|it)|change of subject|unrelated|something else)\b/i

const CONTINUE_AT = 0.55
const MAYBE_AT    = 0.25

export function scoreContinuation(utterance: string, session: SavedSession): Decision {
  const text = utterance.trim()
  if (NEW_TOPIC.test(text)) {
    return { verdict: 'new', score: 0, reason: 'user signalled a new topic outright' }
  }

  const words = keywordsOf(text)
  const prior = new Set(session.keywords)
  const hits = words.filter(w => prior.has(w))
  // Share of what they just said that we were already talking about.
  const overlap = words.length > 0 ? hits.length / words.length : 0

  let score = overlap
  const why: string[] = [`overlap ${hits.length}/${words.length}${hits.length ? ` [${hits.join(',')}]` : ''}`]

  if (FOLLOW_UP_OPENER.test(text)) { score += 0.35; why.push('follow-up opener') }
  if (ANAPHORA.test(text)) {
    // A short utterance built mostly of pronouns can only mean the last topic —
    // there's nothing else in it for them to refer to.
    const bump = words.length <= 3 ? 0.4 : 0.15
    score += bump
    why.push(`anaphora (+${bump})`)
  }

  // Recency adjusts evidence; it is never evidence on its own. Without this
  // guard, "what's the weather" asked a minute after a conversation about a
  // game boss scores 0.25 on the recency bump alone and drags an irrelevant
  // recap into the prompt — sharing a clock with the last topic says nothing
  // about sharing a subject with it.
  if (score === 0) {
    return { verdict: 'new', score: 0, reason: `${why[0]}; nothing in common with the last topic` }
  }

  // Straight back-to-back speech is usually one thought, split by a wake word.
  const mins = sessionAgeMinutes(session)
  if (mins <= 3) { score += 0.25; why.push('ended <3m ago') }
  else if (mins >= 240) { score -= 0.15; why.push('ended >4h ago') }

  score = Math.max(0, Math.min(1, score))
  const verdict: Verdict = score >= CONTINUE_AT ? 'continue' : score >= MAYBE_AT ? 'maybe' : 'new'
  return { verdict, score: Math.round(score * 100) / 100, reason: why.join('; ') }
}
