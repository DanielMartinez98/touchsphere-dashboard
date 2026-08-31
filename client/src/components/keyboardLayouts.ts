// The key layouts, kept apart from the keyboard that renders them.
//
// These follow iOS, because that is the layout the people using this dashboard
// already have in their hands — the point of matching it is muscle memory, so
// what matters is not that it looks Apple-ish but that the keys are in the
// positions a thumb already expects: ⇧ and ⌫ flanking `zxcvbnm`, `123` at the
// bottom-left, punctuation on the same page it lives on in iOS.
//
// Two shapes, chosen by viewport width rather than user-agent:
//
//   PHONE  — the iPhone board. Ten narrow columns; ⇧ and ⌫ take the ends of the
//            letter row; ⌫ and return are NOT on the letter rows because there
//            isn't width for them.
//   TABLET — the iPad board. Wide enough that ⌫ rides the end of row 1 and
//            return the end of row 2, `zxcvbnm` gains `,` and `.`, and ⇧
//            appears at BOTH ends — which is the actual difference between the
//            two boards, not just bigger keys.
//
// Width, not sniffing, because it is the thing that actually decides whether a
// row of eleven keys fits, it follows an iPad rotating without anything to
// listen for, and it does the right thing for the kiosk (a 720px-wide Pi is
// phone-shaped and gets the phone board) without a special case for it.

import { useEffect, useState } from 'react'

/** Which page of keys is showing. Named after the keys that switch to them. */
export type KeyPage = 'letters' | 'numbers' | 'symbols'

/** Which board — the iPhone one or the iPad one. */
export type Shape = 'phone' | 'tablet'

export type KeyDef =
  /** A literal character. `w` is a flex-grow weight; 1 is one letter column. */
  | { k: 'char'; v: string; w?: number }
  | { k: 'shift'; w?: number }
  | { k: 'back'; w?: number }
  /** Switches pages. `label` is what iOS writes on it (`123`, `#+=`, `ABC`). */
  | { k: 'page'; to: KeyPage; label: string; w?: number }
  | { k: 'space'; w?: number }
  /** Newline in a multiline field; in a single-line one iOS's return commits. */
  | { k: 'enter'; w?: number }
  /** Our own commit-and-close. iOS's return does both jobs; ours are separate. */
  | { k: 'done'; w?: number }
  /** Blank filler. Row 2 of the iPhone board is inset by half a key each side. */
  | { k: 'gap'; w?: number }

export type Layout = Record<KeyPage, KeyDef[][]>

const chars = (s: string, w?: number): KeyDef[] =>
  [...s].map(v => ({ k: 'char', v, ...(w ? { w } : {}) } as KeyDef))

// ── iPhone ───────────────────────────────────────────────────────────────────

export const PHONE: Layout = {
  letters: [
    chars('qwertyuiop'),
    // Inset by half a key at each end, exactly as iOS does — it is what makes
    // the nine-key row read as centred under the ten-key one above it.
    [{ k: 'gap', w: 0.5 }, ...chars('asdfghjkl'), { k: 'gap', w: 0.5 }],
    [{ k: 'shift', w: 1.5 }, ...chars('zxcvbnm'), { k: 'back', w: 1.5 }],
  ],
  numbers: [
    chars('1234567890'),
    chars('-/:;()$&@"'),
    // iOS widens this row: five punctuation keys, not ten, so each is 1.25
    // letter-widths and the two modifiers take 1.875. Still ten units total,
    // which is what keeps it flush with the rows above.
    [
      { k: 'page', to: 'symbols', label: '#+=', w: 1.875 },
      ...chars(".,?!'", 1.25),
      { k: 'back', w: 1.875 },
    ],
  ],
  symbols: [
    chars('[]{}#%^*+='),
    chars('_\\|~<>€£¥•'),
    // iOS widens this row: five punctuation keys, not ten, so each is 1.25
    // letter-widths and the two modifiers take 1.875. Still ten units total,
    // which is what keeps it flush with the rows above.
    [
      { k: 'page', to: 'numbers', label: '123', w: 1.875 },
      ...chars(".,?!'", 1.25),
      { k: 'back', w: 1.875 },
    ],
  ],
}

// ── iPad ─────────────────────────────────────────────────────────────────────
//
// The character SETS are the same as the phone's on purpose. iPad's own number
// and symbol pages differ slightly from the iPhone's, but the iPhone sets are
// the ones anybody has memorised, and a punctuation mark that moves between two
// devices the same person uses is worse than one that is a row off Apple's.
// What does change is the row SHAPE, which is the part that actually matters at
// this width.

// Every row sums to ROW_UNITS so a letter key is exactly 1/12 of the row on
// ALL THREE rows and the modifiers absorb the difference — which is what an
// iPad actually looks like. Left to their natural totals the rows come out
// 11.6 / 10.8 / 12.6 and `z` ends up visibly narrower than the `a` above it.
const ROW_UNITS_PHONE = 10
const ROW_UNITS = 12

export const TABLET: Layout = {
  letters: [
    [...chars('qwertyuiop'), { k: 'back', w: 2 }],
    // The leading gap is what lets `return` stay the same width here as on
    // the number page — nine letters plus a 2-wide return is only 11 units.
    [{ k: 'gap', w: 1 }, ...chars('asdfghjkl'), { k: 'enter', w: 2 }],
    // Comma and full stop join the bottom row — on iPad they are on the letter
    // page, which is most of the reason you stop switching to `123` mid-sentence.
    [{ k: 'shift', w: 1.5 }, ...chars('zxcvbnm,.'), { k: 'shift', w: 1.5 }],
  ],
  numbers: [
    [...chars('1234567890'), { k: 'back', w: 2 }],
    [...chars('-/:;()$&@"'), { k: 'enter', w: 2 }],
    [
      { k: 'page', to: 'symbols', label: '#+=', w: 1.5 }, ...chars('.,?!\'%_+='),
      { k: 'page', to: 'symbols', label: '#+=', w: 1.5 },
    ],
  ],
  symbols: [
    [...chars('[]{}#%^*+='), { k: 'back', w: 2 }],
    [...chars('_\\|~<>€£¥•'), { k: 'enter', w: 2 }],
    [
      { k: 'page', to: 'numbers', label: '123', w: 1.5 }, ...chars('.,?!\'§¶°·'),
      { k: 'page', to: 'numbers', label: '123', w: 1.5 },
    ],
  ],
}

/**
 * The bottom row.
 *
 * Two deliberate departures from iOS, both of them fixes for this app rather
 * than decoration:
 *
 * `,` and `.` FLANK THE SPACE BAR. On an iPhone the comma lives on the `123`
 * page, which costs two taps and a hunt every time — fine when you are writing
 * a text message and know the board by heart, bad here, where the longest thing
 * anyone types is a comma-separated image prompt. Android has put them here for
 * years and it is the right call at this width. (The tablet board doesn't need
 * this: `,` and `.` are already on its letter row, as they are on a real iPad.)
 *
 * NOTHING THAT COMMITS SITS NEXT TO SPACE. iOS's single `return` has to be two
 * keys here — one types a newline, one closes the field — and the first version
 * of this row put `↵` immediately right of the space bar, where it got hit by
 * accident constantly. Both now sit at the far end, past `.`, so the keys either
 * side of space are punctuation and a mis-tap costs a character, not the field.
 */
export function bottomRow(page: KeyPage, multiline: boolean, shape: Shape): KeyDef[] {
  const toggle: KeyDef = page === 'letters'
    ? { k: 'page', to: 'numbers', label: '123', w: 2 }
    : { k: 'page', to: 'letters', label: 'ABC', w: 2 }

  // The tablet already has punctuation and `return` on its letter rows, so its
  // bottom row stays the plain iPad one.
  if (shape === 'tablet') {
    return [toggle, { k: 'space', w: 8 }, { k: 'done', w: 2 }]
  }

  const comma: KeyDef = { k: 'char', v: ',', w: 1.15 }
  const stop:  KeyDef = { k: 'char', v: '.', w: 1.15 }
  // Both sum to ROW_UNITS_PHONE so the space bar lines up under the letters
  // above it instead of the row quietly having a scale of its own.
  return multiline
    ? [toggle, comma, { k: 'space', w: 3.7 }, stop, { k: 'enter', w: 1 }, { k: 'done', w: 1 }]
    : [toggle, comma, { k: 'space', w: 3.7 }, stop, { k: 'done', w: 2 }]
}

/**
 * Where the phone board stops and the tablet one starts.
 *
 * 768 is iPad portrait. Deliberately above the kiosk's 720: the Pi's screen is
 * phone-shaped, and eleven keys across 720px would be narrower than the ten it
 * has now for no gain. An iPad mini in portrait (744pt) lands on the phone
 * board, which is the right call at that width anyway.
 */
export const TABLET_MIN_WIDTH = 768

/**
 * Which board fits, kept live so an iPad rotating swaps layouts under the hand.
 *
 * `visualViewport` when it exists, because that is the width AFTER the browser
 * chrome and any zoom, which is what the keys actually have to fit inside.
 */
export function useKeyboardShape(): Shape {
  const [shape, setShape] = useState<Shape>(() => measure())
  useEffect(() => {
    const sync = () => setShape(measure())
    window.addEventListener('resize', sync)
    window.visualViewport?.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.visualViewport?.removeEventListener('resize', sync)
    }
  }, [])
  return shape
}

function measure(): Shape {
  const w = window.visualViewport?.width ?? window.innerWidth
  return w >= TABLET_MIN_WIDTH ? 'tablet' : 'phone'
}

export const LAYOUTS = { phone: PHONE, tablet: TABLET } as const

/** Total flex weight of a row — what decides how wide one key in it comes out. */
export function rowWeight(row: KeyDef[]): number {
  return row.reduce((n, key) => n + (key.w ?? 1), 0)
}

/**
 * Rows in a layout whose weight doesn't match the rest of that layout.
 *
 * Every row of a board has to sum to the same number or a letter key is a
 * different width on each row — the bug this exists to catch, since it is
 * invisible in the layout tables and obvious the moment you look at the
 * keyboard. Phone rows sum to 10 (ten columns), tablet rows to ROW_UNITS.
 * Exported so it can be asserted rather than eyeballed.
 */
export function unevenRows(layout: Layout, units: number): string[] {
  const bad: string[] = []
  for (const [pageName, rows] of Object.entries(layout)) {
    rows.forEach((row, i) => {
      const w = rowWeight(row)
      if (Math.abs(w - units) > 0.001) bad.push(`${pageName}[${i}] = ${w}, expected ${units}`)
    })
  }
  return bad
}

/** Column counts each board is built to. Phone is ten keys across; iPad, twelve. */
export const PHONE_UNITS = ROW_UNITS_PHONE
export const TABLET_UNITS = ROW_UNITS
