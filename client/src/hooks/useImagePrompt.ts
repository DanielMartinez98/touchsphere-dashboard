// The Draw panel's compose field, lifted out of the Draw panel.
//
// It lives here for one reason: "use this prompt again" is asked for from the
// full-screen ImageOverlay, which is a portal at the top of the tree and cannot
// reach into ImageExpanded's useState — the same problem, and the same module
// store answer, as useImageOverlay and useBrowse.
//
// Two things ride on it:
//
//   • the draft itself, so the picture you are looking at can hand its prompt to
//     the field. Keeping it here also means the text survives closing the Draw
//     panel, which is the behaviour you want anyway on a device where typing a
//     prompt is the most expensive thing in the app.
//   • a "bring the Draw panel up" signal App.tsx listens for. Filling a field
//     nobody can see is not "reuse" — the panel has to come up with it.

import { useSyncExternalStore } from 'react'

let draft = ''

const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function emit() { listeners.forEach(cb => cb()) }

function getDraft() { return draft }

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

/** Called whenever something asks for the Draw panel. Returns an unsubscribe. */
export function onDrawPanelRequest(cb: () => void) {
  openListeners.add(cb)
  return () => { openListeners.delete(cb) }
}

/** Put this prompt in the compose field and bring the Draw panel up on it. */
export function reuseImagePrompt(prompt: string) {
  draft = prompt
  emit()
  openListeners.forEach(cb => cb())
}
