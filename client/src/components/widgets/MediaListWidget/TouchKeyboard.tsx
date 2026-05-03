import { useState } from 'react'

type Mode = 'alpha' | 'num'

const ALPHA_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
]

const NUM_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['-', '/', '.', ',', ':', ';', '@', '!', '?', '&'],
  ['(', ')', '"', "'", '_', '+', '=', '#'],
]

interface Props {
  value: string
  onChange: (v: string) => void
  onDone: () => void
}

export function TouchKeyboard({ value, onChange, onDone }: Props) {
  const [mode, setMode] = useState<Mode>('alpha')
  const [upper, setUpper] = useState(false)

  // onPointerDown + preventDefault keeps focus on the text input while keys are pressed
  function tap(e: React.PointerEvent, action: () => void) {
    e.preventDefault()
    action()
  }

  function pressKey(key: string) {
    const char = mode === 'alpha' && upper ? key.toUpperCase() : key
    onChange(value + char)
    if (upper) setUpper(false) // one-shot caps
  }

  const rows = mode === 'alpha' ? ALPHA_ROWS : NUM_ROWS

  const keyBase =
    'h-12 min-w-[2.5rem] flex-1 rounded-lg text-white text-sm font-medium flex items-center justify-center transition-colors active:brightness-150 select-none'

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[10000] bg-[#1a1a1a] border-t border-white/15 px-2 pt-2 pb-3 select-none">
      {rows.map((row, ri) => (
        <div key={ri} className="flex justify-center gap-1 mb-1.5">
          {/* Shift — only on alpha row 3 */}
          {ri === 2 && mode === 'alpha' && (
            <button
              onPointerDown={e => tap(e, () => setUpper(u => !u))}
              className={`${keyBase} flex-none w-12 ${upper ? 'bg-cyan-500 text-black' : 'bg-white/20'}`}
            >
              ⇧
            </button>
          )}

          {row.map(key => (
            <button
              key={key}
              onPointerDown={e => tap(e, () => pressKey(key))}
              className={`${keyBase} bg-white/12`}
            >
              {mode === 'alpha' && upper ? key.toUpperCase() : key}
            </button>
          ))}

          {/* Backspace — on every last row */}
          {ri === rows.length - 1 && (
            <button
              onPointerDown={e => tap(e, () => onChange(value.slice(0, -1)))}
              className={`${keyBase} flex-none w-14 bg-white/20`}
            >
              ⌫
            </button>
          )}
        </div>
      ))}

      {/* Bottom action row */}
      <div className="flex gap-1 mt-0.5">
        <button
          onPointerDown={e => tap(e, () => setMode(m => (m === 'alpha' ? 'num' : 'alpha')))}
          className={`${keyBase} flex-none w-16 bg-white/20 text-xs font-bold`}
        >
          {mode === 'alpha' ? '123' : 'ABC'}
        </button>

        <button
          onPointerDown={e => tap(e, () => onChange(value + ' '))}
          className={`${keyBase} flex-1 bg-white/12 text-white/60 text-xs`}
        >
          space
        </button>

        <button
          onPointerDown={e => tap(e, onDone)}
          className="h-12 w-20 flex-none rounded-lg bg-cyan-500 text-black text-sm font-bold flex items-center justify-center active:bg-cyan-400 select-none"
        >
          Done
        </button>
      </div>
    </div>
  )
}
