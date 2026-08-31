import { useMuted, toggleMuted } from '../hooks/useMuted'
import { useRipple } from '../hooks/useRipple'

/**
 * Virtual mic mute — sits beside the settings gear at bottom center.
 *
 * Muting releases the mic device entirely: the wake-word listener tears down
 * and orb taps stop opening the mic. Turns red with a slashed-mic icon so the
 * muted state is unmistakable from arm's length.
 */
export function MicMuteButton() {
  const muted = useMuted()
  const { onPointerDown, rippleLayer } = useRipple()

  return (
    <button
      type="button"
      onClick={toggleMuted}
      onPointerDown={onPointerDown}
      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={muted}
      className={`absolute bottom-3 sm:bottom-5 left-[calc(50%+30px)] sm:left-[calc(50%+38px)] -translate-x-1/2 z-20 w-12 h-12 sm:w-16 sm:h-16 rounded-full border-2 flex items-center justify-center active:scale-90 transition-all backdrop-blur-md shadow-lg overflow-hidden ${
        muted
          ? 'bg-red-500/25 border-red-400/60 text-red-200'
          : 'bg-white/10 border-white/40 text-white/70'
      }`}
    >
      {rippleLayer}
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        {muted && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
    </button>
  )
}
