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
}
