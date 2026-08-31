import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TouchKeyboard, type KeyboardTarget } from './TouchKeyboard'

// Drop-in replacement for <input> / <textarea> that opens the on-screen
// TouchKeyboard when tapped (kiosk has no physical keyboard). The DOM input is
// readonly + inputMode='none' so iOS/Android/Electron's native IME never
// appears. Edits go through TouchKeyboard's onChange and commit to the parent
// either live (commitOn='change') or only when Done is tapped (commitOn='done').
//
// The element is handed to TouchKeyboard by ref, which is what makes the caret
// real: readOnly does not stop a browser from placing a caret or letting you
// drag a selection — it only stops the native IME — so tap-to-position,
// drag-to-select and double-tap-a-word all work, and the keyboard edits at that
// selection instead of appending at the end.

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
    if (open) return          // already typing — let the tap place the caret
    setOpen(true)
    // A tap that opens the keyboard should also put the caret where the finger
    // landed, which needs focus. The browser gives a readOnly field focus on
    // its own here; this only makes sure of it when the tap was on the padding.
    ref.current?.focus()
  }

  const shared = {
    value:       open ? draft : value,
    placeholder,
    readOnly:    true,
    inputMode:   'none' as const,
    onClick:        handleOpen,
    onPointerDown:  handleOpen,
    'aria-label':   ariaLabel,
    className: `${className} cursor-pointer`,
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
