import { useEffect } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useRipple } from '../../hooks/useRipple'
import type { WidgetPosition } from '../../types'

interface WidgetProps {
  position: WidgetPosition
  collapsed: React.ReactNode
  expanded: React.ReactNode
  isOpen: boolean
  onToggle: () => void
  /** Accent colour used for the glowing outer halo of the collapsed pill. */
  accent?: string
  /**
   * Draw the collapsed corner pill. False on a phone, where the companion
   * layout's tab bar opens the same expanded panel and the corners would
   * only overlap it.
   */
  pill?: boolean
}

// Corners are offset by the safe-area insets so a notched phone doesn't put the
// top pills under the notch or the bottom pills under the home indicator.
// env() resolves to 0 everywhere else, so the 720x1280 kiosk is untouched.
const positionClasses: Record<WidgetPosition, string> = {
  'top-left':     'top-[env(safe-area-inset-top)] left-[env(safe-area-inset-left)]',
  'top-right':    'top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)]',
  'bottom-left':  'bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)]',
  'bottom-right': 'bottom-[env(safe-area-inset-bottom)] right-[env(safe-area-inset-right)]',
}

const expandOrigin: Record<WidgetPosition, string> = {
  'top-left':     'origin-top-left',
  'top-right':    'origin-top-right',
  'bottom-left':  'origin-bottom-left',
  'bottom-right': 'origin-bottom-right',
}

export default function Widget({ position, collapsed, expanded, isOpen, onToggle, accent, pill = true }: WidgetProps) {
  // Swipe-down-to-close: the drag is initiated only from the grab handle at the
  // top of the overlay so it never fights with scrolling content below.
  const dragControls = useDragControls()

  // Press ripple tinted to this corner's accent colour, so the tap flare
  // reinforces each widget's identity instead of a generic white flash.
  const { onPointerDown, rippleLayer } = useRipple(accent ? `${accent}4d` : undefined)

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onToggle])

  return (
    <div className={`absolute ${positionClasses[position]} z-10`}>
      {/*
        Collapsed pill — always visible.

        The width rule is the whole phone story. Two pills sit side by side with
        the mode pill (top) or the gear + mic pair (bottom) between them, and on
        a 390px iPhone the old 44vw/46vw left ~38px of centre channel for a
        control that needs 150 — so the corners ran underneath it and the clock
        read "1:58 PM" with its leading digit behind the Work badge.

        `sm:` is the switch rather than a hand-rolled media query because the
        720px kiosk and any iPad sit ABOVE the 640px breakpoint and keep the
        exact 230/290px they have today, while only genuinely narrow screens get
        the vw sizing. 34vw caps a phone pill at ~133px, which leaves a real
        gutter down the middle for the centre controls to live in.
      */}
      {pill && <motion.button
        onClick={onToggle}
        onPointerDown={onPointerDown}
        className={`
          relative flex flex-col gap-1.5 p-3.5 sm:p-5
          min-w-[30vw] max-w-[34vw] sm:min-w-[230px] sm:max-w-[290px]
          bg-black/60 backdrop-blur-md border border-hairline
          rounded-3xl cursor-pointer active:scale-95
          transition-colors hover:bg-white/10
          ${position === 'top-right' || position === 'bottom-right' ? 'items-end' : 'items-start'}
          ${position.startsWith('top') ? 'rounded-t-none' : 'rounded-b-none'}
          ${position.endsWith('right') ? 'rounded-r-none' : 'rounded-l-none'}
        `}
        style={{
          // Hairline accent edge + one soft halo — calmer than a full neon bloom
          // but keeps each corner's colour identity.
          borderColor: accent ? `${accent}59` : undefined,
          boxShadow: accent
            ? `0 0 24px 0 ${accent}40, inset 0 0 16px ${accent}14`
            : undefined,
        }}
        whileTap={{ scale: 0.95 }}
      >
        {rippleLayer}
        {collapsed}
      </motion.button>}

      {/* Expanded full-screen overlay — portalled to body so it escapes stacking context */}
      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              role="dialog"
              aria-modal="true"
              // No backdrop-blur. It sat behind `bg-black/95`, which is 95%
              // opaque — so it bought a barely-visible 5% of blurred sphere and
              // charged a full-viewport backdrop filter that Chromium repaints
              // on every scroll frame. On the 720px kiosk that was tolerable;
              // on a tablet it is four times the pixels behind the two longest
              // panels in the app (Draw and Calendar), and it reads as the
              // scroll being heavy rather than as a graphics setting.
              className={`fixed inset-0 z-[9000] bg-black/95 flex flex-col ${expandOrigin[position]}`}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              drag="y"
              dragListener={false}
              dragControls={dragControls}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.55 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 140 || info.velocity.y > 900) onToggle()
              }}
            >
              {/* Grab handle — swipe down anywhere on it to dismiss */}
              <div
                onPointerDown={e => dragControls.start(e)}
                className="absolute left-1/2 -translate-x-1/2 w-44 h-9 z-[9500] flex items-start justify-center pt-2.5 touch-none cursor-grab active:cursor-grabbing"
                style={{ top: 'env(safe-area-inset-top)' }}
                aria-hidden
              >
                <div className="w-12 h-1.5 rounded-full bg-white/20" />
              </div>

              {/* Close button — above Leaflet panes (z ~600) */}
              <button
                type="button"
                onClick={onToggle}
                aria-label="Close"
                className="absolute z-[9999] w-14 h-14 rounded-full bg-glass-2 border border-hairline flex items-center justify-center text-white/80 active:scale-90 active:bg-white/25 transition-colors"
                style={{
                  top:   'calc(0.75rem + env(safe-area-inset-top))',
                  right: 'calc(0.75rem + env(safe-area-inset-right))',
                }}
              >
                <X size={26} strokeWidth={2.25} />
              </button>
              {/* min-h-0 so a tall panel actually scrolls here instead of
                  overflowing the dialog and getting clipped.

                  The bottom padding is the on-screen keyboard's height, which
                  TouchKeyboard publishes as `--ts-keyboard-h` while it is up
                  (0px otherwise). Without it the board — `fixed`, and up to a
                  third of an iPad screen — covers the tail of the panel with no
                  scroll left to bring it back: you can see the field you are
                  typing into and nothing under it. This is the single scroll
                  container for every expanded widget, so one line covers all of
                  them. */}
              <div
                className="flex-1 min-h-0 overflow-auto scroll-fade-y"
                style={{ paddingBottom: 'var(--ts-keyboard-h, 0px)' }}
              >
                {expanded}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
