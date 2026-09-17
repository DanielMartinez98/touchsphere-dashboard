import { TouchInput, type TouchInputProps } from './TouchInput'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'

/**
 * A TouchInput for the handful of fields that write straight to the server
 * with no Save button — a style's prefix, the prompt improver's model. What is
 * typed is saved a moment after the typing pauses, and at once when editing
 * ends, so the value registers as it is typed without a POST per keystroke.
 * The field keeps showing the draft while a save is in flight, so a partial
 * value coming back from the server never overwrites the rest of a word.
 */
export function AutosaveInput({
  onSave, delayMs = 600, ...rest
}: Omit<TouchInputProps, 'onChange' | 'onCommit'> & { onSave: (v: string) => void; delayMs?: number }) {
  const save = useDebouncedCallback(onSave, delayMs)
  return (
    <TouchInput
      {...rest}
      onChange={save.call}
      onCommit={v => { save.cancel(); onSave(v) }}
    />
  )
}
