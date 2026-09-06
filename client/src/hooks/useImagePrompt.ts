// The Draw panel's compose field, lifted out of the Draw panel.
//
// It lives here for one reason: "use this prompt again" and "redraw this" are
// asked for from the full-screen ImageOverlay, which is a portal at the top of
// the tree and cannot reach into ImageExpanded's useState — the same problem,
// and the same module store answer, as useImageOverlay and useBrowse.
//
// Three things ride on it:
//
//   • the draft prompt, so the picture you are looking at can hand its words to
//     the field. Keeping it here also means the text survives closing the Draw
//     panel, which is the behaviour you want anyway on a device where typing a
//     prompt is the most expensive thing in the app.
//   • the SOURCE picture, when the next render is a redraw rather than a fresh
//     one. It is a piece of the composed request exactly like the prompt is —
//     the panel shows it, the Draw button changes its label for it, and it goes
//     up with the POST — so it belongs in the same store rather than in a
//     second one that would have to be kept in step with this.
//   • an `onDrawPanelRequest` event App.tsx listens for. Filling a field nobody
//     can see is not "reuse" — the panel has to come up with it.

import { useSyncExternalStore } from 'react'

/** The picture a redraw starts from. */
export interface PromptSource {
  id:     string
  url:    string
  /** What the original was of — shown on the card so the thumbnail has a caption. */
  prompt: string
}

/** The part of the source that may change, when only part of it should. */
export interface PromptMask {
  id:       string
  url:      string
  coverage: number | null
  /** The words it was found from, when it was; absent for a painted one. */
  what?:    string
}

let draft  = ''
let source: PromptSource | null = null
let mask:   PromptMask | null = null
// "Change part of this" from the viewer: the panel should open the mask editor
// the moment it comes up, rather than making the user find the button that
// says the same thing again. Consumed once by the panel.
let partRequested = false

const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function emit() { listeners.forEach(cb => cb()) }

function getDraft()  { return draft }
function getSource() { return source }
function getMask()   { return mask }
function getPart()   { return partRequested }

// A separate list from the draft's subscribers: this one fires on an EVENT, not
// on a value, and App.tsx must open the corner when the picture viewer asks and
// at no other time — not on every keystroke in the compose field.
const openListeners = new Set<() => void>()

/** What the compose field currently holds. */
export function useImagePrompt() {
  return useSyncExternalStore(subscribe, getDraft, getDraft)
}

/** Every keystroke in the compose field. */
export function setImagePrompt(next: string) {
  if (next === draft) return
  draft = next
  emit()
}

/** The picture the next render starts from, or null for a fresh one. */
export function useImageSource() {
  return useSyncExternalStore(subscribe, getSource, getSource)
}

/** Stop redrawing and go back to drawing from scratch. */
export function clearImageSource() {
  if (!source) return
  source = null
  mask = null
  partRequested = false
  emit()
}

/** The mask over the source, or null for the whole picture. */
export function useImageMask() {
  return useSyncExternalStore(subscribe, getMask, getMask)
}

/** Mark which part of the source may change; null goes back to the whole picture. */
export function setImageMask(next: PromptMask | null) {
  mask = next
  emit()
}

/** Whether the viewer asked for a PART to be changed; the panel clears it once acted on. */
export function useMaskRequest() {
  return useSyncExternalStore(subscribe, getPart, getPart)
}
export function clearMaskRequest() {
  if (!partRequested) return
  partRequested = false
  emit()
}

/** Called whenever something asks for the Draw panel. Returns an unsubscribe. */
export function onDrawPanelRequest(cb: () => void) {
  openListeners.add(cb)
  return () => { openListeners.delete(cb) }
}

/** Put this prompt in the compose field and bring the Draw panel up on it. */
export function reuseImagePrompt(prompt: string) {
  draft = prompt
  // Explicitly cleared, not left alone: "use this prompt" and "redraw this" are
  // two different buttons on the same picture, and inheriting a source from a
  // previous tap on the other one would silently turn one into the other.
  source = null
  mask = null
  partRequested = false
  emit()
  openListeners.forEach(cb => cb())
}

/**
 * Redraw this picture: same prompt to start from, and the picture itself as the
 * base the sampler works over.
 *
 * The prompt is seeded rather than blanked because a redraw's prompt describes
 * the picture you want OUT, not the change — so the original's own words are
 * always the right first draft, and the edit is usually two of them.
 */
export function redrawImage(src: PromptSource, opts: { part?: boolean } = {}) {
  draft = src.prompt
  source = src
  // A mask belongs to ONE source; a new source starts with none.
  mask = null
  partRequested = opts.part === true
  emit()
  openListeners.forEach(cb => cb())
}
