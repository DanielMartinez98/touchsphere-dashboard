// Which keyboard this device types with.
//
// The on-screen TouchKeyboard exists because the kiosk — TouchKio on the Pi —
// has no keyboard of its own. Everything else that opens this app does have
// one, and a better one than anything drawn in a web page: a phone's carries
// autocorrect, dictation, emoji and its owner's languages, a tablet's the
// same, a desktop has the physical one. Until 2026-09-17 the native keyboard
// was suppressed EVERYWHERE, so a phone got a ten-key imitation of its own
// keyboard with none of that — reported, fairly, as "the keyboard on the phone
// sucks". So: `touch` on the kiosk, `native` on everything else, decided per
// device and remembered per device.
//
// Detection, in order: `?keyboard=touch|native` (for testing), the choice
// saved from Settings → Hardware, then a guess from the device itself — an
// iPhone, iPad or Android in the user agent (an iPad asking for the desktop
// site says "Macintosh" and betrays itself by reporting touch points) has its
// own; TouchKio or Electron in the user agent is the kiosk; `?mode=kiosk` and
// `?mode=companion` say which layout was asked for; a fine pointer is a mouse,
// so a computer; and a touch-only screen that is none of those is the Pi's
// Chromium. The guess is shown on the Hardware card beside the override, so a
// wrong one is one tap to fix rather than a mystery.

import { useEffect, useState } from 'react'

export type KeyboardMode = 'touch' | 'native'
export type KeyboardChoice = KeyboardMode | 'auto'

const LS_KEY = 'touchsphere.keyboard'

/** What the detection looks at, pulled out of the browser so it can be tested without one. */
export interface DeviceHints {
  ua:             string
  maxTouchPoints: number
  finePointer:    boolean
  search:         string
}

/** The device in words, for the Hardware card: what the automatic guess is based on. */
export function describeDevice(h: DeviceHints): string {
  if (/iPhone|iPod/i.test(h.ua)) return 'an iPhone'
  if (/iPad/i.test(h.ua) || (/Macintosh/.test(h.ua) && h.maxTouchPoints > 1)) return 'an iPad'
  if (/Android/i.test(h.ua)) return 'an Android device'
  if (/TouchKio/i.test(h.ua)) return 'the kiosk (TouchKio)'
  if (/Electron/i.test(h.ua)) return 'the kiosk (an Electron browser)'
  if (h.finePointer) return 'a computer with a mouse'
  if (h.maxTouchPoints > 0) return 'a touch screen with no keyboard of its own'
  return 'a computer'
}

/** The automatic answer for a device, before any saved choice. */
export function detectKeyboardMode(h: DeviceHints): KeyboardMode {
  const params = new URLSearchParams(h.search)
  const forced = params.get('keyboard')
  if (forced === 'touch' || forced === 'native') return forced
  // A phone or tablet always has its own, whatever layout it was asked to show.
  if (/iPhone|iPad|iPod|Android/i.test(h.ua)) return 'native'
  if (/Macintosh/.test(h.ua) && h.maxTouchPoints > 1) return 'native'
  if (/TouchKio|Electron/i.test(h.ua)) return 'touch'
  const mode = params.get('mode')
  if (mode === 'kiosk') return 'touch'
  if (mode === 'companion') return 'native'
  if (h.finePointer) return 'native'
  if (h.maxTouchPoints > 0) return 'touch'
  return 'native'
}

export function deviceHints(): DeviceHints {
  try {
    return {
      ua:             navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      finePointer:    !!window.matchMedia?.('(pointer: fine)').matches,
      search:         window.location.search,
    }
  } catch {
    return { ua: '', maxTouchPoints: 0, finePointer: false, search: '' }
  }
}

function readChoice(): KeyboardChoice {
  try {
    const v = localStorage.getItem(LS_KEY)
    return v === 'touch' || v === 'native' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

let choice: KeyboardChoice = readChoice()
const listeners = new Set<() => void>()

export function keyboardChoice(): KeyboardChoice { return choice }

/** What the automatic guess would pick on this device right now. */
export function detectedKeyboardMode(): KeyboardMode { return detectKeyboardMode(deviceHints()) }

/** The keyboard in effect: the saved choice, else the guess. */
export function keyboardMode(): KeyboardMode {
  return choice === 'auto' ? detectedKeyboardMode() : choice
}

/** Settings → Hardware. Per device: it lives in this browser's storage, like the theme and the gallery columns. */
export function setKeyboardChoice(next: KeyboardChoice): void {
  choice = next
  try {
    if (next === 'auto') localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, next)
  } catch { /* private mode: the choice lasts until the page is closed */ }
  for (const fn of listeners) fn()
}

function useKeyboardStore<T>(read: () => T): T {
  const [v, setV] = useState<T>(read)
  useEffect(() => {
    const sync = () => setV(read())
    listeners.add(sync)
    return () => { listeners.delete(sync) }
  }, [read])
  return v
}

export function useKeyboardMode(): KeyboardMode { return useKeyboardStore(keyboardMode) }
export function useKeyboardChoice(): KeyboardChoice { return useKeyboardStore(keyboardChoice) }
