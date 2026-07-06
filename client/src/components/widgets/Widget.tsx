import { useEffect } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { WidgetPosition } from '../../types'

interface WidgetProps {
  position: WidgetPosition
  collapsed: React.ReactNode
  expanded: React.ReactNode
  isOpen: boolean
  onToggle: () => void
  /** Accent colour used for the glowing outer halo of the collapsed pill. */
  accent?: string
}

const positionClasses: Record<WidgetPosition, string> = {
  'top-left':     'top-0 left-0',
  'top-right':    'top-0 right-0',
  'bottom-left':  'bottom-0 left-0',
  'bottom-right': 'bottom-0 right-0',
}

const expandOrigin: Record<WidgetPosition, string> = {
  'top-left':     'origin-top-left',
  'top-right':    'origin-top-right',
  'bottom-left':  'origin-bottom-left',
  'bottom-right': 'origin-bottom-right',
}

export default function Widget({ position, collapsed, expanded, isOpen, onToggle, accent }: WidgetProps) {
  // Swipe-down-to-close: the drag is initiated only from the grab handle at the
  // top of the overlay so it never fights with scrolling content below.
  const dragControls = useDragControls()

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
      {/* Collapsed pill — always visible */}
      <motion.button
        onClick={onToggle}
        className={`
          relative flex flex-col gap-1.5 p-5
          bg-black/60 backdrop-blur-md border border-hairline
          rounded-3xl cursor-pointer active:scale-95
          transition-colors hover:bg-white/10
          ${position === 'top-right' || position === 'bottom-right' ? 'items-end' : 'items-start'}
          ${position.startsWith('top') ? 'rounded-t-none' : 'rounded-b-none'}
          ${position.endsWith('right') ? 'rounded-r-none' : 'rounded-l-none'}
        `}
        style={{
          minWidth: 230,
          maxWidth: 290,
          // Hairline accent edge + one soft halo — calmer than a full neon bloom
          // but keeps each corner's colour identity.
          borderColor: accent ? `${accent}59` : undefined,
          boxShadow: accent
            ? `0 0 24px 0 ${accent}40, inset 0 0 16px ${accent}14`
            : undefined,
        }}
        whileTap={{ scale: 0.95 }}
      >
        {collapsed}
      </motion.button>

      {/* Expanded full-screen overlay — portalled to body so it escapes stacking context */}
      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              role="dialog"
              aria-modal="true"
              className={`fixed inset-0 z-[9000] bg-black/95 backdrop-blur-xl flex flex-col ${expandOrigin[position]}`}
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
                className="absolute top-0 left-1/2 -translate-x-1/2 w-44 h-9 z-[9500] flex items-start justify-center pt-2.5 touch-none cursor-grab active:cursor-grabbing"
                aria-hidden
              >
                <div className="w-12 h-1.5 rounded-full bg-white/20" />
              </div>

              {/* Close button — above Leaflet panes (z ~600) */}
              <button
                type="button"
                onClick={onToggle}
                aria-label="Close"
                className="absolute top-3 right-3 z-[9999] w-14 h-14 rounded-full bg-glass-2 border border-hairline flex items-center justify-center text-white/80 active:scale-90 active:bg-white/25 transition-colors"
              >
                <X size={26} strokeWidth={2.25} />
              </button>
              <div className="flex-1 overflow-auto">
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
