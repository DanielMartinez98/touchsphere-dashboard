import { useState, useEffect } from 'react'
import { TouchKeyboard } from './TouchKeyboard'

// Drop-in replacement for <input> / <textarea> that opens the on-screen
// TouchKeyboard when tapped (kiosk has no physical keyboard). The DOM input is
// readonly + inputMode='none' so iOS/Android/Electron's native IME never
// appears. Edits go through TouchKeyboard's onChange and commit to the parent
// either live (commitOn='change') or only when Done is tapped (commitOn='done').

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
}

export function TouchInput({
  value, onChange, placeholder, multiline = false,
  className = '', ariaLabel, commitOn = 'done', rows,
}: Props) {
  const [open,  setOpen]  = useState(false)
  const [draft, setDraft] = useState(value)

  // Sync external value updates when keyboard isn't open. While open the
  // local draft is the source of truth so external rerenders don't clobber
  // in-progress typing.
  useEffect(() => { if (!open) setDraft(value) }, [value, open])

  function handleKeyboardChange(next: string) {
    setDraft(next)
    if (commitOn === 'change') onChange(next)
  }
  function handleDone() {
    setOpen(false)
    if (commitOn === 'done' && draft !== value) onChange(draft)
  }

  const shared = {
    value:       open ? draft : value,
    placeholder,
    readOnly:    true,
    inputMode:   'none' as const,
    onClick:        () => setOpen(true),
    onPointerDown:  () => setOpen(true),
    'aria-label':   ariaLabel,
    className: `${className} cursor-pointer`,
  }

  return (
    <>
      {multiline
        ? <textarea {...shared} rows={rows ?? 1} />
        : <input    {...shared} type="text" />}
      {open && (
        <TouchKeyboard
          value={draft}
          onChange={handleKeyboardChange}
          onDone={handleDone}
          multiline={multiline}
        />
      )}
    </>
  )
}
