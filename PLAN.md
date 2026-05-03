# TouchSphere Dashboard — Project Plan

## Concept
A fullscreen touch-first dashboard for a Raspberry Pi 5 with a 7" touchscreen running touchkio.
The screen shows a dark background with a large animated 3D particle sphere in the center.
Four corners each contain a widget with a compact always-visible summary.
Tapping a widget expands it to a full-screen panel.

---

## Layout

```
┌─────────────────────────────────────────────┐
│  [WEATHER]                  [CALENDAR]       │
│   Top-Left                   Top-Right       │
│                                              │
│                                              │
│              ( PARTICLE SPHERE )             │
│                                              │
│                                              │
│  [MEDIA LIST]               [CLOCK]          │
│   Bottom-Left               Bottom-Right     │
└─────────────────────────────────────────────┘
```

---

## Widgets

### Top-Right — Google Calendar
**Collapsed:**
- Shows next upcoming event today (time + title)
- If none: "No more events today"

**Expanded (full screen):**
- Monthly calendar grid
- List of events for selected day
- Google OAuth2 login if not authenticated

### Bottom-Right — Clock
**Collapsed:**
- Large current local time (HH:MM)
- Day + date beneath it

**Expanded (full screen):**
- World clock showing multiple timezones
- Clean analog or digital display per zone

### Top-Left — Weather
**Collapsed:**
- Current temperature + condition icon
- Location name (auto-detected via IP)

**Expanded (full screen):**
- Interactive world weather map (Leaflet.js + OpenWeatherMap tile layer)
- Current location highlighted

### Bottom-Left — Media List
**Collapsed:**
- "Up Next:" + title of next item (game or show)
- Type icon (🎮 or 📺)

**Expanded (full screen):**
- Scrollable list of all items
- Add item form (title + type)
- Remove / reorder items
- Persisted in localStorage

---

## Center — Particle Sphere
- Rendered with Three.js
- Thousands of small particles orbiting a center point
- Subtle interaction: particles react to touch/mouse proximity
- Color: electric blue/cyan with faint glow
- Continuously rotating, never static

---

## Tech Stack

| Layer       | Technology                            |
|-------------|---------------------------------------|
| Frontend    | React + TypeScript + Vite             |
| Particle FX | Three.js                              |
| Styling     | Tailwind CSS (dark theme)             |
| Backend     | Node.js + Express + TypeScript        |
| Calendar    | Google Calendar API v3 + OAuth2       |
| Weather     | OpenWeatherMap API (proxied)          |
| Geolocation | ip-api.com (free, no key required)    |
| World Map   | Leaflet.js                            |
| Storage     | localStorage (media list)             |

---

## API Keys Needed (user must provide)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENWEATHERMAP_API_KEY`

These go in `server/.env` (never committed to git).

---

## File Structure

```
touchsphere-dashboard/
├── client/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── ParticleSphere/
│       │   │   └── ParticleSphere.tsx
│       │   └── widgets/
│       │       ├── Widget.tsx               ← reusable corner widget shell
│       │       ├── CalendarWidget/
│       │       │   ├── CalendarWidget.tsx   ← collapsed view
│       │       │   └── CalendarExpanded.tsx ← full screen view
│       │       ├── ClockWidget/
│       │       │   ├── ClockWidget.tsx
│       │       │   └── WorldClock.tsx
│       │       ├── WeatherWidget/
│       │       │   ├── WeatherWidget.tsx
│       │       │   └── WeatherMap.tsx
│       │       └── MediaListWidget/
│       │           ├── MediaListWidget.tsx
│       │           └── MediaListExpanded.tsx
│       ├── hooks/
│       │   ├── useCalendar.ts
│       │   ├── useWeather.ts
│       │   ├── useClock.ts
│       │   └── useMediaList.ts
│       └── types/
│           └── index.ts
├── server/
│   ├── .env.example
│   ├── tsconfig.json
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── routes/
│       │   ├── calendar.ts
│       │   └── weather.ts
│       └── services/
│           ├── googleAuth.ts
│           └── weatherService.ts
└── PLAN.md
```

---

## Development Phases

### Phase 1 — Shell & Sphere ✅ (start here)
- Wipe default Vite template
- Set up Tailwind dark theme, fullscreen layout
- Four corner widget placeholders
- Three.js particle sphere in center

### Phase 2 — Clock & Weather
- `useClock` hook with live ticker
- World clock expanded panel
- IP geolocation → weather API call
- Leaflet weather map

### Phase 3 — Google Calendar
- Backend OAuth2 flow
- `/api/calendar/today` endpoint
- Collapsed event display
- Expanded monthly calendar UI

### Phase 4 — Media List
- CRUD list stored in localStorage
- Compact "Up Next" display
- Full list manager with add/remove

### Phase 5 — Polish
- Touch gesture refinements
- Smooth expand/collapse animations (Framer Motion)
- Performance tuning for Pi 5 (particle count, render loop)
- Auto-hide expanded panels after inactivity

---

## Notes
- Target resolution: 800×480 (Raspberry Pi TouchScreen 2) or 1280×800 — confirm before final CSS
- All panels should be accessible by tap only (no hover states needed)
- Text must be large enough to read at arm's length
- touchkio runs a Chromium-based kiosk — standard web APIs work fine
