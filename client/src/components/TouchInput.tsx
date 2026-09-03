import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TouchKeyboard, type KeyboardTarget } from './TouchKeyboard'

// Drop-in replacement for <input> / <textarea> that opens the on-screen
// TouchKeyboard when tapped (kiosk has no physical keyboard). `inputMode='none'`
// is what keeps the native IME away. Edits go through TouchKeyboard's onChange
// and commit to the parent live (commitOn='change', the default) or only when
// Done is tapped (commitOn='done'). Live is the default because a field whose
// parent only learns the text on Done reads as broken: a search that doesn't
// search, a Save button that stays grey, a prompt the Draw button ignores —
// every one of those was reported as "the text does not update". 'done' is
// for the few fields whose parent does something expensive or lossy per
// value (a POST, a clamp), and those name it explicitly.
//
// The element is handed to TouchKeyboard by ref, which is what makes the caret
// real — tap to put it anywhere, drag or double-tap to select, and the keyboard
// edits at that selection instead of appending at the end.

interface Props {
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
  multiline?:   boolean
  className?:   string
  ariaLabel?:   string
  // 'change' (default) hands every keystroke to the parent; 'done' only the
  // final value, for parents that POST or clamp on each one.
  commitOn?:    'done' | 'change'
  rows?:        number
  /** Draw the dialler pad instead of the letter board (steps, cfg, seed…). */
  numeric?:     boolean
}

export function TouchInput({
  value, onChange, placeholder, multiline = false,
  className = '', ariaLabel, commitOn = 'change', rows, numeric = false,
}: Props) {
  const [open,  setOpen]  = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<KeyboardTarget | null>(null)

  // Sync external value updates when keyboard isn't open. While open the
  // local draft is the source of truth so external rerenders don't clobber
  // in-progress typing.
  useEffect(() => { if (!open) setDraft(value) }, [value, open])

  // Opening the keyboard covers the bottom third of the screen, and half the
  // fields in this app live down there — a sheet's input lands underneath it
  // and you type blind. Scroll it into the middle of what's left.
  useLayoutEffect(() => {
    if (!open) return
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [open])

  // Grow a multiline field to fit what's in it.
  //
  // `rows` is a FLOOR now, not a window. A three-row box holding a forty-word
  // image prompt scrolls internally, and an internal scroller is a dead strip
  // for the page behind it: a finger dragging to scroll the Draw panel that
  // happens to start on the prompt — which is wide, near the top, and the
  // biggest single target up there — moves the prompt's own two lines of
  // overflow and then stops, because `overscroll-behavior: contain` (index.css)
  // won't chain it out. Growing the box removes the scroller instead of fighting
  // it, and has the side benefit that you can see the whole thing you typed.
  const shown = open ? draft : value
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !multiline) return
    // Collapse first: without it the box can only ever get taller, because
    // scrollHeight of an already-tall element is its own height.
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [multiline, shown])

  function handleKeyboardChange(next: string) {
    setDraft(next)
    if (commitOn === 'change') onChange(next)
  }
  function handleDone() {
    setOpen(false)
    if (commitOn === 'done' && draft !== value) onChange(draft)
  }

  function handleOpen() {
    // Never preventDefault and never force focus: the browser is already
    // placing the caret where the finger landed, and stealing focus mid-tap is
    // exactly what would move it back to the end.
    if (!open) setOpen(true)
  }

  const shared = {
    value:       shown,
    placeholder,
    // NOT readOnly.
    //
    // It used to be, to keep the native IME away — but Chromium paints no caret
    // at all in a readonly field, so tapping into the middle of a prompt put an
    // invisible caret somewhere and looked like the tap had done nothing. That
    // is the whole interaction this component exists for, so `inputMode='none'`
    // carries the job on its own: it is the attribute that means "this app
    // supplies its own keyboard", the field stays a real editable field, and the
    // caret and selection are the browser's, visible and draggable.
    //
    // The trade: a physical keyboard can now type straight into the field. On
    // the kiosk there isn't one; on a desktop browser it is the behaviour you'd
    // want anyway, which is why onChange below keeps the draft in step instead
    // of blocking it.
    inputMode:   'none' as const,
    onChange:    (e: React.ChangeEvent<KeyboardTarget>) => handleKeyboardChange(e.target.value),
    onClick:        handleOpen,
    onPointerDown:  handleOpen,
    'aria-label':   ariaLabel,
    className:   `${className} cursor-text`,
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
      {open && (
        <TouchKeyboard
          value={draft}
          onChange={handleKeyboardChange}
          onDone={handleDone}
          multiline={multiline}
          numeric={numeric}
          targetRef={ref}
        />
      )}
    </>
  )
}
