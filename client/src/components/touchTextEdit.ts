// The text rules behind TouchKeyboard, kept apart from it.
//
// Everything the keyboard does to a string — insert, backspace, move the caret
// — is a pure function of (value, selection). Splitting them out of the
// component means they can be reasoned about and exercised without a DOM, which
// matters more here than usual: these run on a kiosk with no physical keyboard,
// so a caret arithmetic bug is not something the user can type their way out of.
//
// A selection is always [start, end] with start <= end. start === end is a bare
// caret, which is why insert and delete need no separate cases for it.

export type Selection = [number, number]

/** The result of an edit: the new string and where the caret should land. */
export interface Edit {
  value: string
  caret: number
}

/** Order a raw pair off the DOM, which reports a backwards drag as end < start. */
export function ordered(a: number, b: number, len: number): Selection {
  const s = Math.max(0, Math.min(a, len))
  const e = Math.max(0, Math.min(b, len))
  return s <= e ? [s, e] : [e, s]
}

/**
 * Replace the selection with `text` — which is also plain insertion when the
 * selection is empty, and is what makes typing over a highlighted run replace
 * it rather than appending after it.
 */
export function insertAt(value: string, [s, e]: Selection, text: string): Edit {
  return { value: value.slice(0, s) + text + value.slice(e), caret: s + text.length }
}

/**
 * Delete the selection, or one character back from the caret.
 *
 * Null means "nothing to do" — a caret at position 0 with no selection. Kept
 * distinct from an edit that changes nothing so held-⌫ at the start of the
 * field doesn't push identical entries onto the undo stack.
 */
export function deleteBack(value: string, [s, e]: Selection): Edit | null {
  if (s !== e) return { value: value.slice(0, s) + value.slice(e), caret: s }
  if (s === 0) return null
  // Surrogate pairs (emoji) are two code units; stepping back one would split
  // one in half and leave a lone surrogate in the string.
  const back = /[\uDC00-\uDFFF]/.test(value[s - 1] ?? '') && s >= 2 ? 2 : 1
  return { value: value.slice(0, s - back) + value.slice(s), caret: s - back }
}

/**
 * Where the caret goes for one of the four movement keys.
 *
 * From a SELECTION, left and right collapse to its near and far edge rather
 * than stepping one past — that is what every desktop editor does, and it's how
 * you get back to the start of the run you just highlighted.
 */
export function caretTarget(
  len: number, [s, e]: Selection, to: 'start' | 'left' | 'right' | 'end',
): number {
  switch (to) {
    case 'start': return 0
    case 'end':   return len
    case 'left':  return s !== e ? s : Math.max(0, s - 1)
    case 'right': return s !== e ? e : Math.min(len, e + 1)
  }
}
