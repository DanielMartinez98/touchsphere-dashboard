// ── Avatar cues — the LLM's hidden body language ─────────────────────────────
//
// The chat model is told (server-side, in the system prompt) that it may embed
// stage cues in square brackets — "[wave] Hi there! [happy]" — at the exact
// point in the sentence where the action should happen. The user never sees or
// hears them: useVoice strips them from the displayed reply and from the text
// sent to TTS, and instead fires them as window events timed to the sentence
// chunk they sat in, so the avatar waves WHILE saying "hi", not three sentences
// later.
//
// Both avatar backends listen for the same event: the VRM one performs the
// gesture procedurally and drives the face morphs; the Live2D one maps gestures
// to the model's own Tap/Flick motion groups. No avatar on screen? The events
// fire into the void — the protocol costs nothing when nobody's watching.

/** One parsed cue: its canonical name and where it sat in the CLEANED text. */
export interface AvatarCue {
  kind: 'gesture' | 'face'
  name: string
  /** Character offset into the cleaned (tags removed, whitespace collapsed) reply. */
  at: number
}

// Canonical vocabulary. Keep it small: a local model uses a dozen cues
// reliably, but hallucinates freely inside a huge one.
export const GESTURE_CUES = ['wave', 'nod', 'shake', 'bow', 'cheer', 'think', 'jump', 'peace', 'pose', 'show', 'shoot'] as const
export const FACE_CUES    = ['happy', 'excited', 'shy', 'wink', 'sad', 'angry', 'surprised', 'calm', 'shocked'] as const

export type GestureName = (typeof GESTURE_CUES)[number]
export type FaceName    = (typeof FACE_CUES)[number]

// Models improvise near-misses ("[smile]", "[laughs]", "[yes]") — fold the
// predictable ones back into the canon rather than dropping them.
const ALIASES: Record<string, { kind: 'gesture' | 'face'; name: string }> = {
  smile:   { kind: 'face', name: 'happy' },
  laugh:   { kind: 'face', name: 'happy' },
  laughs:  { kind: 'face', name: 'happy' },
  giggle:  { kind: 'face', name: 'happy' },
  blush:   { kind: 'face', name: 'shy' },
  cry:     { kind: 'face', name: 'sad' },
  mad:     { kind: 'face', name: 'angry' },
  shock:   { kind: 'face', name: 'shocked' },
  gasp:    { kind: 'face', name: 'surprised' },
  wow:     { kind: 'face', name: 'surprised' },
  yes:     { kind: 'gesture', name: 'nod' },
  no:      { kind: 'gesture', name: 'shake' },
  waves:   { kind: 'gesture', name: 'wave' },
  nods:    { kind: 'gesture', name: 'nod' },
  bows:    { kind: 'gesture', name: 'bow' },
  dance:   { kind: 'gesture', name: 'cheer' },
  dances:  { kind: 'gesture', name: 'cheer' },
  jumps:   { kind: 'gesture', name: 'jump' },
  thinks:  { kind: 'gesture', name: 'think' },
  hmm:     { kind: 'gesture', name: 'think' },
  ponder:  { kind: 'gesture', name: 'think' },
  hooray:  { kind: 'gesture', name: 'cheer' },
  yay:     { kind: 'gesture', name: 'cheer' },
  peacesign: { kind: 'gesture', name: 'peace' },
  'peace sign': { kind: 'gesture', name: 'peace' },
  vsign:   { kind: 'gesture', name: 'peace' },
  'v sign': { kind: 'gesture', name: 'peace' },
  posing:  { kind: 'gesture', name: 'pose' },
  'model pose': { kind: 'gesture', name: 'pose' },
  spin:    { kind: 'gesture', name: 'cheer' },   // the spin motion reads as celebratory
  twirl:   { kind: 'gesture', name: 'cheer' },
  // "show" — a full-body reveal / turn-around ("ta-da, here I am")
  shows:   { kind: 'gesture', name: 'show' },
  showoff: { kind: 'gesture', name: 'show' },
  'show off': { kind: 'gesture', name: 'show' },
  showcase: { kind: 'gesture', name: 'show' },
  turn:    { kind: 'gesture', name: 'show' },
  'full body': { kind: 'gesture', name: 'show' },
  fullbody: { kind: 'gesture', name: 'show' },
  tada:    { kind: 'gesture', name: 'show' },
  // "shoot" — a finger-gun / pew-pew pose
  shoots:  { kind: 'gesture', name: 'shoot' },
  bang:    { kind: 'gesture', name: 'shoot' },
  pew:     { kind: 'gesture', name: 'shoot' },
  pow:     { kind: 'gesture', name: 'shoot' },
  gun:     { kind: 'gesture', name: 'shoot' },
  fingergun: { kind: 'gesture', name: 'shoot' },
  'finger gun': { kind: 'gesture', name: 'shoot' },
}

function resolveCue(word: string): { kind: 'gesture' | 'face'; name: string } | null {
  const w = word.toLowerCase()
  if ((GESTURE_CUES as readonly string[]).includes(w)) return { kind: 'gesture', name: w }
  if ((FACE_CUES as readonly string[]).includes(w))    return { kind: 'face', name: w }
  return ALIASES[w] ?? null
}

// A tag is a short bracketed word: [wave], [Star Eyes] won't match (two words
// are allowed but nothing longer), [see docs 4.2] won't either. Unknown tags
// that LOOK like cues ("[shrugs]") are still stripped — speaking or printing
// "[shrugs]" is always wrong — they just don't fire an event.
const TAG_RE = /\[\s*([a-zA-Z]+(?:[ _-][a-zA-Z]+)?)\s*\]/g

/**
 * Pull the cues out of a reply.
 *
 * Returns the text with every tag removed and whitespace collapsed (this is
 * what gets displayed AND spoken — the collapse keeps cue offsets aligned with
 * the chunk offsets useVoice computes on the same collapsed form), plus the
 * recognised cues with their positions in that cleaned text.
 */
export function extractCues(text: string): { clean: string; cues: AvatarCue[] } {
  const cues: AvatarCue[] = []
  const parts: string[] = []
  let lastIndex = 0
  let cleanLen = 0

  const pushText = (raw: string) => {
    // Collapse whitespace as we go so cue offsets are exact in the final string.
    let s = raw.replace(/\s+/g, ' ')
    if (cleanLen === 0) s = s.replace(/^ /, '')
    if (parts.length > 0 && parts[parts.length - 1]!.endsWith(' ')) s = s.replace(/^ /, '')
    parts.push(s)
    cleanLen += s.length
  }

  TAG_RE.lastIndex = 0
  for (let m = TAG_RE.exec(text); m !== null; m = TAG_RE.exec(text)) {
    pushText(text.slice(lastIndex, m.index))
    lastIndex = m.index + m[0].length
    const resolved = resolveCue(m[1]!.replace(/[ _-]+/g, ' ').trim())
    if (resolved) cues.push({ ...resolved, at: cleanLen })
  }
  pushText(text.slice(lastIndex))

  const clean = parts.join('').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim()
  // The punctuation tidy above can shift offsets by a character or two; clamp
  // rather than re-track — cue timing is per-sentence-chunk, not per-letter.
  for (const c of cues) c.at = Math.min(c.at, clean.length)
  return { clean, cues }
}

// ── Event plumbing ───────────────────────────────────────────────────────────

export const AVATAR_CUE_EVENT = 'ts:avatar-cue'

export interface AvatarCueDetail { kind: 'gesture' | 'face'; name: string }

/** Fire a cue at whichever avatar is on screen. Safe to call with none. */
export function dispatchCue(cue: AvatarCueDetail): void {
  window.dispatchEvent(new CustomEvent<AvatarCueDetail>(AVATAR_CUE_EVENT, { detail: cue }))
}

/** Subscribe an avatar backend to cues. Returns the unsubscribe. */
export function onCue(handler: (cue: AvatarCueDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<AvatarCueDetail>).detail
    if (detail?.name) handler(detail)
  }
  window.addEventListener(AVATAR_CUE_EVENT, listener)
  return () => window.removeEventListener(AVATAR_CUE_EVENT, listener)
}
