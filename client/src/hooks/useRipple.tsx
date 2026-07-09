import { useCallback, useRef, useState } from 'react'

// A Material-style tap ripple, standardized for the kiosk's touch controls.
// On press it spawns an expanding circle from the exact finger position, which
// gives every primary control the same immediate, tactile "the tap landed"
// feedback — important on a touchscreen with no hover/cursor to lean on.
//
// Usage: spread `onPointerDown` on any `position: relative` element and render
// `rippleLayer` as a child. The layer clips itself to the parent's border
// radius, so it works on pills, circles, and rounded rows alike.
//
//   const { onPointerDown, rippleLayer } = useRipple('#22c55e66')
//   <button className="relative …" onPointerDown={onPointerDown}>{rippleLayer}…</button>

interface Ripple { id: number; x: number; y: number; size: number }

export function useRipple(color = 'rgba(255,255,255,0.28)') {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const nextId = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    // Diameter large enough to always cover the element from the touch point.
    const size = Math.max(rect.width, rect.height) * 2
    const x = e.clientX - rect.left - size / 2
    const y = e.clientY - rect.top - size / 2
    const id = nextId.current++
    setRipples(r => [...r, { id, x, y, size }])
    // Drop the ripple once its animation (see .tap-ripple in index.css) is done.
    window.setTimeout(() => setRipples(r => r.filter(rp => rp.id !== id)), 600)
  }, [])

  const rippleLayer = (
    <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
      {ripples.map(r => (
        <span
          key={r.id}
          className="tap-ripple absolute rounded-full"
          style={{ left: r.x, top: r.y, width: r.size, height: r.size, background: color }}
        />
      ))}
    </span>
  )

  return { onPointerDown, rippleLayer }
}
