// Global tap-vs-scroll guard for the touchscreen kiosk.
//
// On a touch device a scroll gesture that ends over a tappable element still
// synthesizes a `click` — so lifting your finger after a flick fires a tap on
// whatever row was under it, navigating or toggling something you only meant to
// scroll past. This installs a single capture-phase listener that swallows any
// click concluding a gesture that actually moved (or that the browser turned
// into a scroll). A movement is therefore EITHER a scroll OR a tap, never both.
//
// Genuine taps (travel under the threshold) pass through untouched, and mouse
// input is left alone — the guard only arms for touch/pen or a pointer that
// clearly dragged.

const MOVE_THRESHOLD = 10 // px of travel that reclassifies a press as a scroll

export function installTapGuard(): void {
  let startX = 0
  let startY = 0
  let moved  = false

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') { moved = false; return }
    startX = e.clientX
    startY = e.clientY
    moved  = false
  }

  const onMove = (e: PointerEvent) => {
    if (moved || e.pointerType === 'mouse') return
    if (Math.abs(e.clientX - startX) > MOVE_THRESHOLD ||
        Math.abs(e.clientY - startY) > MOVE_THRESHOLD) {
      moved = true
    }
  }

  // When the browser takes the gesture over for scrolling it cancels the
  // pointer — a definitive "this was a scroll, not a tap" signal.
  const onCancel = () => { moved = true }

  // Capture phase on document runs before React's delegated handlers on the
  // root container, so stopping propagation here means the click never reaches
  // any onClick.
  const onClickCapture = (e: MouseEvent) => {
    if (!moved) return
    moved = false
    e.stopPropagation()
    e.stopImmediatePropagation()
    e.preventDefault()
  }

  document.addEventListener('pointerdown',   onDown,         { capture: true, passive: true })
  document.addEventListener('pointermove',   onMove,         { capture: true, passive: true })
  document.addEventListener('pointercancel', onCancel,       { capture: true, passive: true })
  document.addEventListener('click',         onClickCapture, { capture: true })
}
