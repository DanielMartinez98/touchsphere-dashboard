// The on-screen keyboard. The kiosk has no physical one, and the native IME is
// suppressed everywhere (readOnly + inputMode='none'), so this is the ONLY way
// text gets typed on this device.
//
// It used to be append-only: every key did `value + char` and ⌫ did
// `slice(0, -1)`. That made the caret a fiction — you could not fix a typo in
// the middle of a sentence, and deleting a long prompt meant tapping ⌫ forty
// times. Every edit now happens at the target element's REAL selection, which
// is what turns three things on at once:
//
//   • tap to put the caret anywhere, and type there;
//   • drag / double-tap / long-press to select a run of text — that is native
//     behaviour on a readOnly input, it was simply never being read;
//   • type or ⌫ over a selection to replace or bulk-delete it.
//
// So the interesting code here is small: read [start, end] off the element,
// splice, and put the caret back after React re-renders the controlled value
// (which otherwise snaps it to the end).
//
// `targetRef` is optional. Without it there is no element to have a selection,
// and the keyboard degrades to the append-only behaviour it had before — which
// is honest rather than tidy: a caret nobody can see or move is worse than no
// caret at all.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  ClipboardPaste, Copy, TextSelect, Undo2,
} from 'lucide-react'
import { caretTarget, deleteBack, insertAt, ordered, type Selection } from './touchTextEdit'
import {
  bottomRow, LAYOUTS, useKeyboardShape,
  type KeyDef, type KeyPage,
} from './keyboardLayouts'

export type KeyboardTarget = HTMLInputElement | HTMLTextAreaElement

// The number pad. A field that can only hold a number gets phone-dialler keys
// rather than the full board: three fat columns instead of ten thin ones, and
// no letters to mis-tap into a value that then parses as NaN. Digits are laid
// out 7-8-9 over 1-2-3 — calculator order, which is what every numeric pad on a
// touchscreen uses, and it puts the small numbers nearest the thumb.
const NUMPAD_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
]

// Held-⌫ repeat. 400ms before the first repeat so a normal tap is never read as
// a hold, then 55ms — fast enough to clear a long prompt in a couple of seconds,
// slow enough that letting go lands where you meant.
const REPEAT_DELAY_MS = 400
const REPEAT_EVERY_MS = 55

// Undo depth. Deep enough to walk back out of a mis-tapped "select all" that
// ate a paragraph, shallow enough to stay a fixed cost.
const UNDO_MAX = 40

// Clipboard fallback for when navigator.clipboard is unavailable or refused —
// a kiosk browser may have no permission prompt to grant it. Module-level so
// copy in one field and paste in another still works within the app.
let localClipboard = ''

interface Props {
  value:    string
  onChange: (v: string) => void
  onDone:   () => void
  // Multiline mode keeps the keyboard open after Enter and inserts a newline
  // instead of closing. Single-line inputs (titles, search) close on Enter.
  multiline?: boolean
  /**
   * Number-only field: draw a dialler pad instead of the full board. Purely a
   * layout switch — the editing model underneath (caret, selection, undo) is
   * the same one, so tapping into the middle of a seed still works.
   */
  numeric?: boolean
  /**
   * The field being typed into. Supplying it is what makes the caret and
   * selection real; without it the keyboard appends at the end as it always did.
   */
  targetRef?: React.RefObject<KeyboardTarget | null>
}

export function TouchKeyboard({
  value, onChange, onDone, multiline = false, numeric = false, targetRef,
}: Props) {
  // Which page of keys — letters / 123 / #+=, the same three iOS has.
  const [page, setPage] = useState<KeyPage>('letters')
  // iPhone board or iPad board, by viewport width. Live, so an iPad rotating
  // into landscape gets the wider one without anything being reopened.
  const shape = useKeyboardShape()
  // 'off' → 'once' (one-shot, the common case) → 'lock' (double-tap ⇧).
  const [shift, setShift] = useState<'off' | 'once' | 'lock'>('off')
  const [sel, setSel] = useState<[number, number]>([value.length, value.length])

  // Where to put the caret once React has re-rendered the new value. Null means
  // "leave whatever the user has", so this never fights a tap or a drag.
  const pendingCaret = useRef<number | null>(null)
  const undoStack = useRef<{ value: string; caret: number }[]>([])
  const repeat = useRef<{ delay?: number; tick?: number }>({})
  // ⌫ repeat fires from a timer, which closes over a stale `value`; the ref is
  // the live one. Same for the selection.
  const latest = useRef({ value, sel })
  useLayoutEffect(() => { latest.current = { value, sel } }, [value, sel])

  // The toolbar is only truthful once the target element exists, and on the
  // first render it doesn't yet — refs are attached during commit. Rendering
  // the row anyway would give the user five buttons that silently do nothing
  // for one frame, on the one screen where a dead button is most confusing.
  const [caretAware, setCaretAware] = useState(false)
  useLayoutEffect(() => { setCaretAware(!!targetRef?.current) }, [targetRef])

  /** The current selection as an ordered pair, defaulting to the end. */
  const range = useCallback((): Selection => {
    const el = targetRef?.current
    const len = latest.current.value.length
    if (!el) return [len, len]
    // A backwards drag reports end < start, and every splice below assumes the
    // pair is ordered.
    return ordered(el.selectionStart ?? len, el.selectionEnd ?? len, len)
  }, [targetRef])

  // Follow the caret so the toolbar can grey out what wouldn't do anything.
  // document-level `selectionchange` is the only event that covers caret moves
  // inside a form control from every cause — tap, drag, and our own edits alike.
  useEffect(() => {
    const el = targetRef?.current
    if (!el) return
    const sync = () => setSel([el.selectionStart ?? 0, el.selectionEnd ?? 0])
    sync()
    document.addEventListener('selectionchange', sync)
    return () => document.removeEventListener('selectionchange', sync)
  }, [targetRef, value])

  // Put the caret back after a controlled re-render.
  //
  // React rewrites the whole value of a controlled input, and the browser's
  // answer to that is to drop the caret at the end — which would undo the point
  // of this file on every single keystroke. Layout effect, not effect: the caret
  // has to be right before the frame paints or it visibly jumps.
  useLayoutEffect(() => {
    const el = targetRef?.current
    const caret = pendingCaret.current
    if (!el || caret === null) return
    pendingCaret.current = null
    const at = Math.max(0, Math.min(caret, el.value.length))
    el.setSelectionRange(at, at)
    setSel([at, at])
  }, [value, targetRef])

  useEffect(() => () => {
    // A ⌫ held while the sheet closes would otherwise keep firing into a dead
    // component.
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.tick)
  }, [])

  /** Apply an edit, remembering the previous state for undo. */
  const commit = useCallback((next: string, caret: number) => {
    const [s] = latest.current.sel
    undoStack.current.push({ value: latest.current.value, caret: s })
    if (undoStack.current.length > UNDO_MAX) undoStack.current.shift()
    pendingCaret.current = caret
    onChange(next)
  }, [onChange])

  /** Replace the selection (or insert at the caret) with `text`. */
  const insert = useCallback((text: string) => {
    const next = insertAt(latest.current.value, range(), text)
    commit(next.value, next.caret)
  }, [range, commit])

  /** Delete the selection, or the character before the caret. */
  const backspace = useCallback(() => {
    // Null means there was nothing to delete — a caret at 0. Bailing here is
    // what stops held-⌫ at the start of the field filling the undo stack with
    // identical entries.
    const next = deleteBack(latest.current.value, range())
    if (next) commit(next.value, next.caret)
  }, [range, commit])

  const moveCaret = useCallback((to: 'start' | 'left' | 'right' | 'end') => {
    const el = targetRef?.current
    if (!el) return
    const at = caretTarget(latest.current.value.length, range(), to)
    el.focus()
    el.setSelectionRange(at, at)
    setSel([at, at])
  }, [range, targetRef])

  const selectAll = useCallback(() => {
    const el = targetRef?.current
    if (!el) return
    const len = latest.current.value.length
    el.focus()
    el.setSelectionRange(0, len)
    setSel([0, len])
  }, [targetRef])

  const copy = useCallback(() => {
    const [s, e] = range()
    if (s === e) return
    const text = latest.current.value.slice(s, e)
    localClipboard = text
    // Best effort: the system clipboard is nicer when it works (it reaches the
    // browser's own fields), but a kiosk has nobody to answer a permission
    // prompt, so the in-app copy above is what's actually relied on.
    void navigator.clipboard?.writeText(text).catch(() => { /* local copy stands */ })
  }, [range])

  const paste = useCallback(async () => {
    let text = localClipboard
    try {
      const sys = await navigator.clipboard?.readText()
      if (sys) text = sys
    } catch { /* denied or unavailable — the in-app clipboard is the fallback */ }
    if (text) insert(text)
  }, [insert])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    pendingCaret.current = prev.caret
    onChange(prev.value)
  }, [onChange])

  // onPointerDown + preventDefault keeps focus (and therefore the selection) on
  // whatever input is active — a key that stole focus would clear the very
  // selection it is about to act on.
  function tap(e: React.PointerEvent, action: () => void) {
    e.preventDefault()
    action()
  }

  function pressKey(key: string) {
    // Only letters shift. iOS's ⇧ does nothing on the number page either — it
    // is the page toggle that gets you to the other symbols, not the shift.
    insert(page === 'letters' && shift !== 'off' ? key.toUpperCase() : key)
    if (shift === 'once') setShift('off')
  }

  function pressEnter() {
    if (multiline) insert('\n')
    else onDone()
  }

  function startRepeat() {
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.tick)
    repeat.current.delay = window.setTimeout(() => {
      repeat.current.tick = window.setInterval(backspace, REPEAT_EVERY_MS)
    }, REPEAT_DELAY_MS)
  }
  function stopRepeat() {
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.tick)
    repeat.current = {}
  }

  const rows = LAYOUTS[shape][page]
  const hasSelection = sel[0] !== sel[1]

  // No `flex-1` and no `min-w-*`: width is per-key data now (see renderKey),
  // and a minimum width would stop ten keys being ten EVEN columns the moment
  // one of them is labelled `#+=`.
  //
  // Taller keys on the tablet board. iPad keys are physically bigger than
  // iPhone ones, and at 768px+ the extra height is free — on the phone board
  // it would push the top of a bottom-anchored sheet off screen.
  const keyBase =
    `${shape === 'tablet' ? 'h-14 text-base' : 'h-12 text-sm'} ` +
    'rounded-lg text-white font-medium flex items-center justify-center ' +
    'transition-colors active:brightness-150 select-none'
  // Shorter than a letter key: this row is reached deliberately, not touch-typed,
  // and the letters are what needs to stay thumb-sized.
  const toolBase =
    'h-10 flex-1 rounded-lg flex items-center justify-center gap-1 select-none transition-colors ' +
    'active:brightness-150 disabled:opacity-25 text-white/70 bg-white/[0.09]'

  /**
   * One key, from its definition.
   *
   * Width comes through as `flexGrow` rather than a Tailwind class because the
   * weights are data (1 letter column, 1.5 for ⇧, 5 for the space bar) and a
   * class per weight would mean a class per layout change. `flexBasis: 0`
   * matters: without it a wide label like `#+=` would set the key's floor and
   * the row would stop being ten even columns.
   */
  function renderKey(key: KeyDef, id: string) {
    const grow = { flexGrow: key.w ?? 1, flexBasis: 0, minWidth: 0 }

    switch (key.k) {
      // Half-key inset at the ends of the iPhone's `asdfghjkl` row. Not a
      // button — it must not be tappable, or the row grows two dead targets.
      case 'gap':
        return <span key={id} style={grow} aria-hidden />

      case 'char': {
        const label = page === 'letters' && shift !== 'off' ? key.v.toUpperCase() : key.v
        return (
          <button type="button" key={id} style={grow}
            onPointerDown={e => tap(e, () => pressKey(key.v))}
            className={`${keyBase} bg-white/12`}>
            {label}
          </button>
        )
      }

      case 'shift':
        return (
          <button type="button" key={id} style={grow} aria-label="Shift"
            // Tapping ⇧ while it is already armed locks it — the only way to
            // type an acronym without re-arming between every letter.
            onPointerDown={e => tap(e, () => setShift(v =>
              v === 'off' ? 'once' : v === 'once' ? 'lock' : 'off'))}
            className={`${keyBase} ${
              shift === 'lock' ? 'bg-[var(--accent,#06b6d4)] text-black ring-2 ring-white/40'
              : shift === 'once' ? 'bg-[var(--accent,#06b6d4)] text-black'
              : 'bg-white/20'}`}>
            {shift === 'lock' ? '⇪' : '⇧'}
          </button>
        )

      case 'back':
        return (
          <button type="button" key={id} style={grow} aria-label="Backspace"
            // Hold to repeat. Clearing a long prompt one tap at a time is the
            // single most tedious thing on this keyboard.
            onPointerDown={e => tap(e, () => { backspace(); startRepeat() })}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
            className={`${keyBase} bg-white/20`}>
            ⌫
          </button>
        )

      case 'page':
        return (
          <button type="button" key={id} style={grow}
            onPointerDown={e => tap(e, () => {
              setPage(key.to)
              // Leaving the letters drops a one-shot ⇧ — it would otherwise be
              // spent on a digit, which shift does nothing to, and be gone.
              if (key.to !== 'letters' && shift === 'once') setShift('off')
            })}
            className={`${keyBase} bg-white/20 text-xs font-bold`}>
            {key.label}
          </button>
        )

      case 'space':
        return (
          <button type="button" key={id} style={grow} aria-label="Space"
            onPointerDown={e => tap(e, () => insert(' '))}
            className={`${keyBase} bg-white/12 text-white/60 text-xs`}>
            space
          </button>
        )

      case 'enter':
        return (
          <button type="button" key={id} style={grow} aria-label="Return"
            onPointerDown={e => tap(e, pressEnter)}
            className={`${keyBase} bg-white/20 text-xs font-bold`}>
            ↵
          </button>
        )

      case 'done':
        return (
          <button type="button" key={id} style={grow}
            onPointerDown={e => tap(e, onDone)}
            className={`${keyBase} bg-[var(--accent,#06b6d4)] text-black font-bold
                        active:opacity-80 active:brightness-100`}>
            Done
          </button>
        )
    }
  }

  // ── Number pad ──
  //
  // Its own return rather than another `rows` variant, because almost nothing
  // about the letter board applies: no ⇧, no 123/ABC swap, no space bar, and
  // three columns of tall keys instead of ten narrow ones. Everything that
  // matters — caret, selection, undo, held-⌫ repeat — is the shared code above.
  if (numeric) {
    const numKey = 'h-14 rounded-xl bg-white/12 text-white text-xl font-semibold ' +
      'flex items-center justify-center transition-colors active:brightness-150 select-none'
    const sideKey = 'h-14 rounded-xl bg-white/20 text-white text-sm font-semibold ' +
      'flex items-center justify-center transition-colors active:brightness-150 select-none'
    return (
      <div className="fixed bottom-0 left-0 right-0 z-[10000] bg-[#1a1a1a] border-t border-white/15
                      px-2 pt-2 pb-3 select-none">
        <div className="mx-auto w-full max-w-[21rem] flex flex-col gap-1.5">
          {/* Caret controls only — a number is short enough that copy/paste and
              jump-to-end are noise, but placing the caret to fix one digit is
              exactly why this keyboard learned about selections. */}
          {caretAware && (
            <div className="flex gap-1.5">
              <button type="button" aria-label="Undo"
                onPointerDown={e => tap(e, undo)}
                className={toolBase}>
                <Undo2 size={16} />
              </button>
              <button type="button" aria-label="Left"
                onPointerDown={e => tap(e, () => moveCaret('left'))}
                className={toolBase}>
                <ChevronLeft size={17} />
              </button>
              <button type="button" aria-label="Right"
                onPointerDown={e => tap(e, () => moveCaret('right'))}
                className={toolBase}>
                <ChevronRight size={17} />
              </button>
              <button type="button" aria-label="Select all"
                onPointerDown={e => tap(e, selectAll)}
                className={`${toolBase} ${hasSelection ? 'bg-[var(--accent,#06b6d4)]/25 text-white' : ''}`}>
                <TextSelect size={16} />
              </button>
            </div>
          )}

          <div className="flex gap-1.5">
            <div className="flex-1 flex flex-col gap-1.5">
              {NUMPAD_ROWS.map((row, ri) => (
                <div key={ri} className="flex gap-1.5">
                  {row.map(key => (
                    <button type="button" key={key}
                      onPointerDown={e => tap(e, () => insert(key))}
                      className={`${numKey} flex-1`}>
                      {key}
                    </button>
                  ))}
                </div>
              ))}
              <div className="flex gap-1.5">
                <button type="button"
                  onPointerDown={e => tap(e, () => insert('.'))}
                  className={`${numKey} flex-1`}>
                  .
                </button>
                {/* 0 spans two columns, as it does on a dialler — it is the most
                    tapped key here (every 1024, every 512). */}
                <button type="button"
                  onPointerDown={e => tap(e, () => insert('0'))}
                  className={`${numKey} flex-[2]`}>
                  0
                </button>
              </div>
            </div>

            <div className="w-[5.5rem] flex flex-col gap-1.5">
              <button type="button" aria-label="Backspace"
                onPointerDown={e => tap(e, () => { backspace(); startRepeat() })}
                onPointerUp={stopRepeat}
                onPointerLeave={stopRepeat}
                onPointerCancel={stopRepeat}
                className={sideKey}>
                ⌫
              </button>
              {/* Retyping a value is the common edit here, not amending one, so
                  emptying the field is a key rather than eight taps of ⌫. */}
              <button type="button"
                onPointerDown={e => tap(e, () => commit('', 0))}
                className={`${sideKey} text-xs text-white/70`}>
                Clear
              </button>
              <button type="button"
                onPointerDown={e => tap(e, onDone)}
                className="flex-1 min-h-[3.5rem] rounded-xl bg-[var(--accent,#06b6d4)] text-black
                           text-sm font-bold flex items-center justify-center active:opacity-80 select-none">
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[10000] bg-[#1a1a1a] border-t border-white/15 px-2 pt-2 pb-3 select-none">
      {/* ── Caret / selection toolbar ──
          Only drawn when there is an element whose selection we can act on;
          without one every button here would be a lie. */}
      {caretAware && (
        <div className="flex gap-1 mb-2">
          <button type="button" aria-label="Undo"
            onPointerDown={e => tap(e, undo)}
            className={toolBase}>
            <Undo2 size={16} />
          </button>
          <button type="button" aria-label="To start"
            onPointerDown={e => tap(e, () => moveCaret('start'))}
            className={toolBase}>
            <ChevronsLeft size={17} />
          </button>
          <button type="button" aria-label="Left"
            onPointerDown={e => tap(e, () => moveCaret('left'))}
            className={toolBase}>
            <ChevronLeft size={17} />
          </button>
          <button type="button" aria-label="Right"
            onPointerDown={e => tap(e, () => moveCaret('right'))}
            className={toolBase}>
            <ChevronRight size={17} />
          </button>
          <button type="button" aria-label="To end"
            onPointerDown={e => tap(e, () => moveCaret('end'))}
            className={toolBase}>
            <ChevronsRight size={17} />
          </button>
          <button type="button" aria-label="Select all"
            onPointerDown={e => tap(e, selectAll)}
            className={`${toolBase} ${hasSelection ? 'bg-[var(--accent,#06b6d4)]/25 text-white' : ''}`}>
            <TextSelect size={16} />
          </button>
          <button type="button" aria-label="Copy" disabled={!hasSelection}
            onPointerDown={e => tap(e, copy)}
            className={toolBase}>
            <Copy size={15} />
          </button>
          <button type="button" aria-label="Paste"
            onPointerDown={e => tap(e, () => { void paste() })}
            className={toolBase}>
            <ClipboardPaste size={16} />
          </button>
        </div>
      )}

      {[...rows, bottomRow(page, multiline)].map((row, ri) => (
        <div key={ri} className="flex gap-1 mb-1.5 last:mb-0">
          {row.map((key, ki) => renderKey(key, `${ri}-${ki}`))}
        </div>
      ))}

    </div>
  )
}
