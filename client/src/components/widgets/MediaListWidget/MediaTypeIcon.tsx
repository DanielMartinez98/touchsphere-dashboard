import type { MediaType } from '../../../types'

// Inline SVG icons for each media type — avoids dependency on colour-emoji fonts
// which are often absent on Raspberry Pi OS / Chromium.
const PATHS: Record<MediaType, JSX.Element> = {
  game: (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* controller body */}
      <rect x="2" y="7" width="20" height="12" rx="4" />
      {/* d-pad cross */}
      <path d="M7 13h2m-1-1v2" />
      {/* face buttons */}
      <circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="13" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  show: (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* screen */}
      <rect x="2" y="3" width="20" height="14" rx="2" />
      {/* stand */}
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  movie: (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* film frame outer */}
      <rect x="2" y="2" width="20" height="20" rx="2" />
      {/* vertical strips */}
      <path d="M7 2v20M17 2v20" />
      {/* horizontal strip */}
      <path d="M2 12h20" />
      {/* sprocket holes */}
      <path d="M2 7h5M17 7h5M2 17h5M17 17h5" />
    </svg>
  ),
}

interface Props {
  type: MediaType
  className?: string
}

export function MediaTypeIcon({ type, className = '' }: Props) {
  return <span className={`inline-flex items-center justify-center ${className}`}>{PATHS[type]}</span>
}
