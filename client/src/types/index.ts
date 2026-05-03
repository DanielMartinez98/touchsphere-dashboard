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

export interface MediaItem {
  id: string
  title: string
  type: MediaType
  done: boolean
}
