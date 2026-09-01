export type WidgetPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
}

export interface WeatherData {
  temp: number
  feels_like: number
  description: string
  icon: string
  city: string
  country: string
  lat: number
  lon: number
  humidity: number
  wind_speed: number
  wind_deg: number
  pressure: number
  visibility: number
  clouds: number
  rain_1h: number
  rain_chance: number
}

export interface AirQualityData {
  aqi: number
  aqi_label: string
  co: number
  no2: number
  o3: number
  so2: number
  pm2_5: number
  pm10: number
}

export type MediaType = 'game' | 'show' | 'movie'

// Games and shows can be in one of four states. Movies only support the two
// extremes — most people don't watch a movie "in progress" the same way they
// play a 40-hour RPG. Code that needs to validate per-type uses MOVIE_STATUSES.
export type MediaStatus = 'not_started' | 'in_progress' | 'done' | 'dropped'
export const MOVIE_STATUSES: readonly MediaStatus[] = ['not_started', 'done'] as const

export function statusesFor(type: MediaType): readonly MediaStatus[] {
  return type === 'movie'
    ? MOVIE_STATUSES
    : ['not_started', 'in_progress', 'done', 'dropped']
}

export interface MediaItem {
  id: string
  title: string
  type: MediaType
  // Legacy boolean retained for back-compat with consumers that haven't moved
  // to status. Always equals (status === 'done') after normalization.
  done: boolean
  status: MediaStatus
  starred?: boolean
  // Cached poster filename, served by /api/artwork/cover/<cover>. Looked up on
  // add (TMDB for movies/shows, IGDB for games) and correctable in the item
  // sheet. Absent when nothing matched — the UI falls back to a gradient tile.
  cover?: string
}

/** One candidate poster from /api/artwork/search. */
export interface ArtworkResult {
  id: string
  title: string
  year: number | null
  imageUrl: string
}

// ── Game guides ──────────────────────────────────────────────────────────────
// A researched, tickable walkthrough attached to a game in the list. Mirrors
// server/src/guides.ts — keep the two in sync.

export type GuideStatus  = 'generating' | 'ready' | 'failed'
/** `reference` sections (item tables, controls) never move the 100% bar. */
export type SectionKind  = 'progression' | 'collectible' | 'sidequest' | 'reference'
export type SectionState = 'pending' | 'ready' | 'failed'

/** A wiki picture cached on the volume. Serve via /api/guides/image/:file. */
export interface GuideImage {
  file: string
  source: string
  title?: string
  width?: number
  height?: number
}

/**
 * One concrete action inside a step, with its own checkbox.
 *
 * The step is still the unit of progress — see guideProgress() below, which does
 * not count these. Ticking every sub ticks the step and vice versa, and that
 * cascade is settled on the SERVER (setSubStepDone) rather than here, so the
 * document renders the same whichever screen drew it.
 */
export interface GuideSubStep {
  id: string
  text: string
  done: boolean
  doneAt?: string
}

export interface GuideStep {
  id: string
  text: string
  note?: string
  /**
   * Sub-chapter heading. Consecutive steps sharing a group ARE that sub-chapter;
   * the chapter page derives its headings and per-part counts from those runs.
   * See GuideStep in server/src/guides.ts for why it's a label, not a tree.
   */
  group?: string
  /** The actions this step breaks into. Absent for a step that is one action. */
  subs?: GuideSubStep[]
  /** A picture of the place or thing this step is about. */
  image?: GuideImage
  /** Seconds into the chapter's walkthrough video. Absent when nothing located it. */
  at?: number
  /**
   * Where this happens on the map, as a fraction of its width and height.
   * `approx` means the generator placed it from a compass phrase and has never
   * seen the picture — the UI says so, and dragging it clears the flag.
   */
  pin?: { x: number; y: number; approx?: boolean }
  done: boolean
  doneAt?: string
}

/** A pin the user dropped. Exact, unlike a step's generated one. */
export interface GuideMapPin {
  id: string
  x: number
  y: number
  label: string
  createdAt: string
}

export interface GuideMap {
  image: GuideImage
  pins: GuideMapPin[]
}

export interface GuideVideo {
  videoId: string
  title: string
  channel?: string
}

export interface GuideSection {
  id: string
  title: string
  kind: SectionKind
  /** Whether this section's steps feed the overall 100% bar. */
  counts: boolean
  summary?: string
  video?: GuideVideo
  source?: { url: string; site: string }
  /** A picture of this place, shown at the top of the chapter. */
  image?: GuideImage
  /** This chapter's own map. Falls back to the guide's when absent. */
  map?: GuideMap
  state: SectionState
  steps: GuideStep[]
}

export interface Guide {
  itemId: string
  title: string
  /** One line on how the community orders this game, shown under the title. */
  organization: string
  orderOverride?: string
  status: GuideStatus
  error?: string
  createdAt: string
  updatedAt: string
  /** Generation phase, e.g. "Woodfall Temple (3 of 7)". Absent when finished. */
  phase?: string
  video?: GuideVideo
  /** The whole-game map, used by any chapter without one of its own. */
  map?: GuideMap
  sections: GuideSection[]
  sources: Array<{ url: string; site: string; title: string }>
}

/** The light row GET /api/guides returns — enough for a progress bar. */
export interface GuideSummary {
  itemId: string
  title: string
  status: GuideStatus
  phase?: string
  percent: number
  counted: { done: number; total: number }
  sections: number
}

/**
 * Counts behind the bars. `counted` is the community "100%" definition — only
 * sections the generator marked as counting — while `all` includes reference
 * material, which is why a guide can read 100% with boxes still unticked.
 */
export function guideProgress(g: Guide): {
  counted: { done: number; total: number }
  all: { done: number; total: number }
  percent: number
} {
  let cDone = 0, cTotal = 0, aDone = 0, aTotal = 0
  for (const sec of g.sections) {
    for (const step of sec.steps) {
      aTotal++
      if (step.done) aDone++
      if (sec.counts) {
        cTotal++
        if (step.done) cDone++
      }
    }
  }
  return {
    counted: { done: cDone, total: cTotal },
    all:     { done: aDone, total: aTotal },
    percent: cTotal > 0 ? Math.round((cDone / cTotal) * 100) : 0,
  }
}
