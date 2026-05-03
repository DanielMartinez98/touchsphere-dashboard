import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import type { WidgetPosition } from '../../types'

interface WidgetProps {
  position: WidgetPosition
  collapsed: React.ReactNode
  expanded: React.ReactNode
  isOpen: boolean
  onToggle: () => void
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

export default function Widget({ position, collapsed, expanded, isOpen, onToggle }: WidgetProps) {
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
          relative flex flex-col gap-1 p-3
          bg-black/60 backdrop-blur-md border border-white/10
          rounded-2xl cursor-pointer active:scale-95
          transition-colors hover:bg-white/5
          ${position === 'top-right' || position === 'bottom-right' ? 'items-end' : 'items-start'}
          ${position.startsWith('top') ? 'rounded-t-none' : 'rounded-b-none'}
          ${position.endsWith('right') ? 'rounded-r-none' : 'rounded-l-none'}
        `}
        style={{ minWidth: 160, maxWidth: 200 }}
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
            >
              {/* Close button — above Leaflet panes (z ~600) */}
              <button
                onClick={onToggle}
                className="absolute top-4 right-4 z-[9999] w-12 h-12 rounded-full bg-white/20 border border-white/30 flex items-center justify-center text-white text-2xl font-bold active:scale-90"
              >
                ✕
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
