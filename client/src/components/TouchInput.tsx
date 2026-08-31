import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TouchKeyboard, type KeyboardTarget } from './TouchKeyboard'

// Drop-in replacement for <input> / <textarea> that opens the on-screen
// TouchKeyboard when tapped (kiosk has no physical keyboard). `inputMode='none'`
// is what keeps the native IME away. Edits go through TouchKeyboard's onChange
// and commit to the parent either live (commitOn='change') or only when Done is
// tapped (commitOn='done').
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
  // 'done' is safer for parents that should only see the final value, but
  // 'change' is needed when the parent autosaves (BlockEditor).
  commitOn?:    'done' | 'change'
  rows?:        number
  /** Draw the dialler pad instead of the letter board (steps, cfg, seed…). */
  numeric?:     boolean
}

export function TouchInput({
  value, onChange, placeholder, multiline = false,
  className = '', ariaLabel, commitOn = 'done', rows, numeric = false,
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
    value:       open ? draft : value,
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
        ? <textarea {...shared} ref={ref as React.RefObject<HTMLTextAreaElement>} rows={rows ?? 1} />
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
