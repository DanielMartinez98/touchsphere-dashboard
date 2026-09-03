// Which kind of screen this is: the KIOSK (the 7" panel on the wall, or any
// tablet/desktop showing the full dashboard) or a COMPANION (a phone).
//
// The same build serves both, and the difference matters in three places:
// the phone gets its own layout (a remote for the kiosk rather than a cramped
// copy of it), the server sends kiosk-only events (play this, pause) to the
// kiosk and not to every phone that happens to be open, and the offline
// cache is installed on the phone only — the kiosk must never be handed a
// stale build by its own service worker.
//
// Decided by width, like the keyboard layout: it is the thing that actually
// determines whether the four-corner layout fits, it follows a rotation with
// nothing to listen for, and it puts the 720px kiosk on the kiosk side with
// no special case. `?mode=` overrides it either way, which is what the home
// screen shortcut uses so an iPad added to the home screen can still be a
// remote if that's what was asked for.

import { useEffect, useState } from 'react'

export type ClientRole = 'kiosk' | 'companion'

const COMPANION_MAX_WIDTH = 640   // Tailwind's `sm`, the breakpoint the corners already use

function forced(): ClientRole | null {
  try {
    const m = new URLSearchParams(window.location.search).get('mode')
    if (m === 'companion' || m === 'kiosk') return m
  } catch { /* no window */ }
  return null
}

export function clientRole(): ClientRole {
  return forced() ?? (window.innerWidth < COMPANION_MAX_WIDTH ? 'companion' : 'kiosk')
}

/** Reactive: re-evaluated on resize, so a rotated tablet can cross the line. */
export function useClientRole(): ClientRole {
  const [role, setRole] = useState<ClientRole>(() => clientRole())
  useEffect(() => {
    if (forced()) return
    const on = () => setRole(clientRole())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return role
}

/** True when opened from a home-screen icon (iOS/Android "Add to Home Screen"). */
export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch { return false }
}
