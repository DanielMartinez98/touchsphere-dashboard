import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TouchKeyboard, type KeyboardTarget } from './TouchKeyboard'
import { useKeyboardMode } from '../hooks/useKeyboardMode'

// Drop-in replacement for <input> / <textarea>: the one way text is typed in
// this app, whichever device it is on.
//
// ON THE KIOSK it opens the on-screen TouchKeyboard when tapped, since the Pi
// has no keyboard of its own; `inputMode='none'` is what keeps the (absent)
// native IME away. ON A PHONE, A TABLET OR A DESKTOP it is a plain field and
// the device's own keyboard comes up — autocorrect, dictation, emoji and all,
// which no board drawn in a web page can offer. `useKeyboardMode` decides per
// device (Settings → Hardware overrides it).
//
// ONE RULE FOR WHAT THE PARENT SEES, on both: every keystroke reaches
// `onChange` as it happens, and `onCommit` fires once when editing ends — Done
// on the board, or the field losing focus / Enter with a native keyboard.
// There used to be a `commitOn='done'` switch that handed the parent nothing
// until Done was tapped, for fields whose parent POSTed or clamped per value;
// it read as "typing does nothing until I find the Done key", and with a
// native keyboard there is no Done key to find. Those parents now debounce
// (AutosaveInput) or act on `onCommit` instead, and the field always shows
// what is being typed, because while editing the local draft is the value.
//
// The element is handed to TouchKeyboard by ref, which is what makes the caret
// real on the kiosk — tap to put it anywhere, drag or double-tap to select, and
// the keyboard edits at that selection instead of appending at the end.

export interface TouchInputProps {
  value:        string
  /** Every keystroke, as it happens. Optional only for a field that acts on `onCommit` alone (a rename). */
  onChange?:    (v: string) => void
  /** Editing ended, with the final text: Done on the board, or blur / Enter with a native keyboard. */
  onCommit?:    (v: string) => void
  placeholder?: string
  multiline?:   boolean
  className?:   string
  ariaLabel?:   string
  rows?:        number
  /** A number-only field: the dialler pad on the kiosk, the numeric keyboard on a phone. */
  numeric?:     boolean
  /** Ids, keys, tokens, tags: no autocorrect or auto-capitalisation from a phone's keyboard. */
  plain?:       boolean
}

export function TouchInput({
  value, onChange, onCommit, placeholder, multiline = false,
  className = '', ariaLabel, rows, numeric = false, plain = false,
}: TouchInputProps) {
  const native = useKeyboardMode() === 'native'
  // Editing = the board is open (kiosk) or the field has focus (native).
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<KeyboardTarget | null>(null)

  // While editing, the local draft is the source of truth, so external
  // rerenders (a debounced save coming back from the server) don't clobber
  // in-progress typing; the rest of the time the field shows the parent's
  // value. The draft is taken from the value at the moment editing starts —
  // no effect keeping the two in step, which would be a render per keystroke.
  const shown = editing ? draft : value

  // Opening the board covers the bottom third of the kiosk's screen, and half
  // the fields in this app live down there — a sheet's input lands underneath
  // it and you type blind. So the field is brought clear of the board once it
  // is up, and again if a multiline box grows past it. A native keyboard does
  // this itself, so it is the kiosk's board only.
  //
  // By hand rather than scrollIntoView, after that call scrolled the wrong
  // thing: it walks EVERY ancestor, and the app's root is `overflow-hidden` —
  // not scrollable by a finger, but scrollable by script — so for a field in
  // a sheet pinned above the board (the main screen's typing sheet, which is
  // `fixed`) it slid the whole dashboard up behind the sheet, with no way to
  // drag it back. revealAboveBoard() moves the nearest ancestor a finger could
  // scroll, stops at a fixed ancestor (nothing above a pinned sheet should
  // move), and leaves a field that is already in view alone.
  const boardH = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ts-keyboard-h')
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  useEffect(() => {
    if (!editing || native) return
    const el = ref.current
    if (!el) return
    // After the board is up AND `.kb-room` has finished growing (its padding
    // transitions over 120ms): scrolled before that, a panel whose field sits
    // at the bottom has no room yet to scroll into and stops short. Instant
    // rather than smooth so the second pass — a safety net for a container
    // that grew late — measures a settled position and is a no-op normally.
    const reveal = () => revealAboveBoard(el, boardH())
    const t1 = setTimeout(reveal, 180)
    const t2 = setTimeout(reveal, 500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
    // `shown` is a dep on purpose: a growing box has to be re-checked, and a
    // box still in view is left alone, so this is quiet while you type inside
    // the visible area.
  }, [editing, native, shown])

  // Grow a multiline field to fit what's in it.
  //
  // `rows` is a FLOOR, not a window. A three-row box holding a forty-word image
  // prompt scrolls internally, and an internal scroller is a dead strip for the
  // page behind it: a finger dragging to scroll the Draw panel that happens to
  // start on the prompt moves the prompt's own two lines of overflow and then
  // stops, because `overscroll-behavior: contain` (index.css) won't chain it
  // out. Growing the box removes the scroller instead of fighting it, and has
  // the side benefit that you can see the whole thing you typed.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !multiline) return
    // Collapse first: without it the box can only ever get taller, because
    // scrollHeight of an already-tall element is its own height.
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [multiline, shown])

  function change(next: string) {
    setDraft(next)
    onChange?.(next)
  }
  function finish(next: string) {
    setEditing(false)
    onCommit?.(next)
  }

  // Kiosk: a tap opens the board. Never preventDefault and never force focus:
  // the browser is already placing the caret where the finger landed, and
  // stealing focus mid-tap is exactly what would move it back to the end.
  function handleOpen() {
    if (native || editing) return
    setDraft(value)
    setEditing(true)
  }
  function handleDone() { finish(draft) }

  // Native: focus and blur are the edges of editing, and Enter in a one-line
  // field is Done — it blurs, which commits.
  function handleFocus() {
    if (!native) return
    setDraft(value)
    setEditing(true)
  }
  function handleBlur() {
    if (native && editing) finish(draft)
  }
  function handleKeyDown(e: React.KeyboardEvent<KeyboardTarget>) {
    if (native && !multiline && e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  const shared = {
    value:       shown,
    placeholder,
    // On the kiosk `inputMode='none'` is the attribute that means "this app
    // supplies its own keyboard"; the field stays a real editable field (NOT
    // readOnly — Chromium paints no caret in a readonly field, so tapping into
    // the middle of a prompt looked like the tap had done nothing), so the
    // caret and selection are the browser's, visible and draggable. A
    // physical keyboard can type straight in, which is why onChange keeps the
    // draft in step instead of blocking it. On a device with its own keyboard
    // the hint is the kind of keyboard wanted: the number pad for a number.
    ...(native
      ? {
          inputMode:      numeric ? 'decimal' as const : undefined,
          enterKeyHint:   multiline ? undefined : 'done' as const,
          autoCorrect:    plain ? 'off' : undefined,
          autoCapitalize: plain ? 'none' : undefined,
          spellCheck:     plain ? false : undefined,
          onFocus:        handleFocus,
          onBlur:         handleBlur,
          onKeyDown:      handleKeyDown,
        }
      : {
          inputMode:      'none' as const,
          onClick:        handleOpen,
          onPointerDown:  handleOpen,
        }),
    onChange:     (e: React.ChangeEvent<KeyboardTarget>) => change(e.target.value),
    'aria-label': ariaLabel,
    className:    `${className} cursor-text`,
  }

  return (
    <>
      {multiline
        ? <textarea {...shared} ref={ref as React.RefObject<HTMLTextAreaElement>} rows={rows ?? 1}
            // Hidden rather than auto: the effect above keeps the box the size
            // of its content, so a scrollbar here would only ever be a one-frame
            // flicker between a keystroke and the resize.
            style={{ overflow: 'hidden', resize: 'none' }} />
        : <input    {...shared} ref={ref as React.RefObject<HTMLInputElement>} type="text" />}
      {/* Portaled to the document body, not rendered beside the field. The
          board is `position: fixed` and means "the bottom of the SCREEN" —
          but fixed positioning is relative to the nearest ancestor with a
          transform, filter or backdrop-filter, and half the surfaces here have
          one: the typing sheet's card is backdrop-blurred, so its keyboard came
          up fixed to the bottom of a 640×170 card, floating mid-screen over
          the very field being typed into; the Settings panel is blurred too.
          At the body there is no such ancestor, so bottom-0 is the screen and
          --ts-keyboard-h means what every consumer assumes it means. Nothing
          about the board depends on DOM adjacency: it edits through
          `targetRef`, and closes from its Done key or a tap outside it. */}
      {!native && editing && createPortal(
        <TouchKeyboard
          value={draft}
          onChange={change}
          onDone={handleDone}
          onDismiss={handleDone}
          multiline={multiline}
          numeric={numeric}
          targetRef={ref}
        />,
        document.body,
      )}
    </>
  )
}

/**
 * Scroll `el` clear of the on-screen board (`kb` px tall at the bottom of the
 * screen), moving only the nearest scroll container a finger could move. A box
 * that fits is nudged just above the board; one taller than the space left is
 * pinned near the top, which keeps the first line in view and leaves the most
 * room for what follows (centring it would hide the end, where the caret is).
 * Nothing moves when the field is already in view, when the only scroll
 * containers are overflow-hidden, or above a fixed ancestor.
 */
function revealAboveBoard(el: HTMLElement, kb: number): void {
  const margin = 16
  const rect = el.getBoundingClientRect()
  const limit = window.innerHeight - kb - margin
  const tall = rect.height > limit - margin
  let delta = 0
  if (tall || rect.top < margin) delta = rect.top - margin
  else if (rect.bottom > limit) delta = rect.bottom - limit
  if (Math.abs(delta) < 1) return
  for (let node = el.parentElement; node; node = node.parentElement) {
    const cs = getComputedStyle(node)
    const oy = cs.overflowY
    const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1
    if (scrollable) { node.scrollBy({ top: delta }); return }
    if (cs.position === 'fixed') return
  }
  if (document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight + 1) {
    window.scrollBy({ top: delta })
  }
}
