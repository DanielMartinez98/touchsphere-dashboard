# TouchSphere Dashboard — Project Plan

## Concept
A fullscreen touch-first dashboard for a Raspberry Pi 5 with a 7" touchscreen running
**TouchKio** (leukipp/touchkio — an Electron-based kiosk launcher).
The screen shows a dark background with a large animated 3D particle sphere in the center.
Four corners each contain a widget with a compact always-visible summary.
Tapping a widget expands it to a full-screen panel.
A voice interface lets the user speak to the orb; the orb reacts and replies.

---

## Hardware Platform — Raspberry Pi 5

| Property            | Value                                                |
|---------------------|------------------------------------------------------|
| SoC                 | Broadcom BCM2712 (4× Cortex-A76 @ 2.4 GHz, 64-bit) |
| RAM                 | 4 GB or 8 GB LPDDR4X                                 |
| Display             | Official 7" Touch Display 2 (720×1280 portrait) **or** any DSI/HDMI touch panel |
| OS                  | Raspberry Pi OS (64-bit), Wayland (labwc preferred)  |
| Kiosk runtime       | TouchKio v1.4+ (.deb, arm64)                         |
| Docker              | Docker Engine + Compose (server runs in a container) |
| Audio               | Built-in 3.5 mm jack or USB/BT speaker; speech-dispatcher + espeak-ng |

### CPU temperature path
`/sys/class/thermal/thermal_zone0/temp` (value in milli-°C, divide by 1000)

### Hardware metrics endpoints (served by our Node server)
`GET /api/device` — returns `{ cpuTemp, memTotalMB, memAvailableMB, memUsedPct, uptimeSeconds }`

---

## TouchKio Runtime

TouchKio is an **Electron-based** kiosk (NOT bare Chromium). It wraps a web URL in a fullscreen Electron window with:

| Feature                               | Notes                                                      |
|---------------------------------------|------------------------------------------------------------|
| Multi-page URL navigation             | Comma-separated URLs in `--web-url`                        |
| Touch-optimised webview               | Extended wake-up, prevents system sleep                    |
| Side panel widget                     | Right-edge slide-out with kiosk controls                   |
| Navigation bar                        | Swipe/tap to switch pages                                  |
| Adjustable zoom & dark/light theme    | `--web-zoom=1.0 --web-theme=dark`                          |
| MQTT remote control (optional)        | Requires mosquitto broker + HA MQTT integration            |
| On-screen keyboard toggle (MQTT)      | squeekboard on Wayland                                     |
| Display power / brightness (MQTT)     | wlopm / kscreen-doctor / ddcutil                           |
| Volume control (MQTT)                 | pactl, non-dummy audio sink required                       |
| CPU / memory / temperature sensors    | Exposed as HA MQTT sensors automatically                   |
| Screenshot via MQTT                   | Captures the Electron webview                              |
| System reboot / shutdown (MQTT)       | Requires password-less sudo for `reboot`/`shutdown`        |
| App update via MQTT                   | Requires .deb install + touchkio.service running           |
| Battery sensor (MQTT)                 | `/sys/class/power_supply/*/capacity`                       |
| Logs                                  | `~/.config/touchkio/logs/main.log`                         |
| Debug DevTools                        | `touchkio --app-debug`                                     |
| Extended Electron logging             | `touchkio --enable-logging --log-level=2`                  |

### TouchKio launch command (in `scripts/kiosk.sh`)
```bash
touchkio \
  --web-url=http://localhost:3001 \
  --web-theme=dark \
  --web-zoom=1.0
```

### TouchKio config file
`~/.config/touchkio/Arguments.json` — written by `touchkio --setup` or manually:
```json
{
  "web_url": ["http://localhost:3001"],
  "web_theme": "dark",
  "web_zoom": 1.0
}
```

### MQTT integration (optional — for HA users)
```bash
touchkio \
  --web-url=http://localhost:3001 \
  --mqtt-url=mqtt://192.168.1.X:1883 \
  --mqtt-user=kiosk \
  --mqtt-password=<password>
```
Adds the following to Home Assistant automatically:
- **Controls:** keyboard toggle, display on/off, brightness, zoom, volume, reboot, shutdown, page switch, screenshot
- **Sensors:** CPU temp, memory usage, battery, uptime, network IP, package upgrades pending

### Voice / Audio in TouchKio (Electron)
Electron runs Chromium internally. Since the URL is `http://localhost` (a secure context),
`SpeechRecognition` and `getUserMedia` work without extra flags.
TTS (`speechSynthesis`) requires `speech-dispatcher` and `espeak-ng` on the Pi:
```bash
sudo apt install speech-dispatcher espeak-ng
sudo systemctl enable --now speech-dispatcher
```

---

## Layout

```
┌─────────────────────────────────────────────┐
│  [WEATHER]                  [CALENDAR]       │
│   Top-Left                   Top-Right       │
│                                              │
│                                              │
│              ( PARTICLE SPHERE )             │
│         [ transcript ] [ reply ]             │
│                                              │
│  [MEDIA LIST]               [CLOCK]          │
│   Bottom-Left               Bottom-Right     │
│        [🎤 MIC]  [⚙ SETTINGS]  [🔊 SPK]      │
└─────────────────────────────────────────────┘
```

---

## Widgets

### Top-Right — Google Calendar
**Collapsed:** Shows next upcoming event today (time + title). If none: "No more events today"  
**Expanded:** Monthly calendar grid, events for selected day, Google OAuth2 login if not authenticated

### Bottom-Right — Clock
**Collapsed:** Large current local time (HH:MM), day + date  
**Expanded:** World clock showing multiple timezones

### Top-Left — Weather
**Collapsed:** Current temperature + condition icon, location name (auto-detected via IP)  
**Expanded:** Interactive world weather map (Leaflet.js + OpenWeatherMap tile layer)

### Bottom-Left — Media List
**Collapsed:** "Up Next:" + title of next item (game or show), type icon (🎮 or 📺)  
**Expanded:** Scrollable list, add/remove items, mark done  
**Persistence:** Server-side JSON file via `/api/state/media` (survives Docker rebuilds)

---

## Center — Particle Sphere
- Rendered with Three.js
- ~3000 particles on a sphere surface (Fibonacci distribution)
- Reacts to touch/mouse proximity
- Color lerps between modes: cyan (work), violet (rest/locked), **green (listening), amber (speaking)**
- Scale pulses with microphone volume when voice is active
- Rotation speed 2.5× faster during voice activity

---

## Voice Interface
- **Mic button** — bottom-center-left; tap to start/stop listening
- **SpeechRecognition** — browser-native Web Speech API (Chromium/Electron)
- **Transcript** — cyan text shown below the orb in real time
- **Default reply** — random response shown in amber text, read aloud via `speechSynthesis`
- **Speaker button** — amber, visible while reply plays; tap to stop early
- Orb turns green + pulses with mic amplitude when listening
- Orb turns amber + gentle wave when speaking

---

## Tech Stack

| Layer           | Technology                                       |
|-----------------|--------------------------------------------------|
| Frontend        | React 19 + TypeScript + Vite 8                   |
| Particle FX     | Three.js 0.184                                   |
| Styling         | Tailwind CSS v4 (dark theme, JIT)                |
| Animation       | Framer Motion                                    |
| Backend         | Node.js 22 + Express 5 + TypeScript              |
| Calendar        | Google Calendar (iCal / ICAL URL, node-ical)     |
| Weather         | OpenWeatherMap API v2.5 (proxied + cached)        |
| Geolocation     | ip-api.com (free, no key, auto server IP)         |
| World Map       | Leaflet.js + OWM tile layer                      |
| State storage   | Server-side JSON files in `CACHE_DIR`             |
| Container       | Docker + multi-stage Dockerfile                  |
| Kiosk launcher  | TouchKio (Electron .deb, arm64)                  |

---

## API Keys Needed (server/.env)
```
OPENWEATHER_API_KEY=...
CALENDAR_ICAL_URL=...        # Google Calendar iCal link (optional)
DEFAULT_LAT=...              # Fixed location lat (optional, overrides ip-api)
DEFAULT_LON=...              # Fixed location lon (optional)
PORT=3001                    # Server port (default 3001)
CACHE_DIR=/tmp/touchsphere   # Where JSON state files are stored
LOG_LEVEL=info               # error | warn | info | debug
```

---

## API Reference

### Data / Proxy endpoints
| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/weather`              | Current weather conditions         |
| GET    | `/api/weather/forecast`     | 5-day 3-hourly forecast            |
| GET    | `/api/weather/cloud-layers` | Low/mid/high cloud cover           |
| GET    | `/api/airquality`           | AQI + pollutant breakdown          |
| GET    | `/api/geoip`                | lat/lon from server's public IP    |
| GET    | `/api/calendar`             | Today's calendar events (iCal)     |
| GET    | `/api/tiles/:z/:x/:y`       | Proxied OWM cloud tile             |

### State persistence (JSON file on server)
| Method  | Path                          | Description                              |
|---------|-------------------------------|------------------------------------------|
| GET     | `/api/state/mode`             | Read current app mode                    |
| POST    | `/api/state/mode`             | Persist app mode `{ mode }`              |
| GET     | `/api/state/cred`             | Check if lock credential exists          |
| POST    | `/api/state/cred`             | Save lock credential hash+salt           |
| POST    | `/api/state/cred/verify`      | Verify lock credential `{ hash }`        |
| GET     | `/api/state/media`            | Read full media list                     |
| POST    | `/api/state/media`            | Add item `{ title, type }` → MediaItem  |
| PATCH   | `/api/state/media/:id`        | Toggle done                              |
| DELETE  | `/api/state/media/:id`        | Remove item                              |

### Device metrics (Raspberry Pi 5)
| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/device`                 | CPU temp, memory, uptime                 |

### System
| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/health`                 | `{ ok: true }` — liveness probe         |
| GET    | `/api/system/events`          | SSE stream (reload events)               |
| POST   | `/api/system/restart`         | Broadcast reload to all SSE clients      |

---

## Logging Strategy

### Server (structured tagged logs)
Every log line starts with `[tag]` and includes a timestamp via the request middleware.
Log levels: `[startup]`, `[request]`, `[cache:hit]`, `[cache:miss]`, `[error]`, `[warn]`, `[state]`, `[device]`.

- **Startup:** env vars present/missing, port, NODE_ENV
- **Every request:** method, path, IP, response time (ms), status code
- **Cache hits/misses:** which key, TTL remaining or how stale
- **External API calls:** URL (no key), response status, latency, bytes
- **Errors:** full error message + upstream body + stack if unexpected
- **State mutations:** what changed, from what to what, who requested it
- **Device reads:** raw values from `/proc`, `/sys`, parse errors

### Client (structured console tags)
Every hook and API call logs with a `[tag]` prefix:
- `[api]` — every fetch call: URL, method, response status, latency
- `[MediaList]` — CRUD operations with item details
- `[AppMode]` — mode transitions, lock credential ops
- `[Voice]` — start/stop, transcript text, reply text, TTS events
- `[Device]` — metrics fetched, values, errors

### Viewing logs on the Pi
```bash
# Docker server logs (live)
docker logs -f touchsphere

# TouchKio Electron logs
cat ~/.config/touchkio/logs/main.log

# Extended Electron + Chromium logs
touchkio --enable-logging --log-level=2
touchkio --app-debug          # opens Chrome DevTools on the webview
```

---

## File Structure

```
touchsphere-dashboard/
├── PLAN.md
├── Dockerfile
├── docker-compose.yml
├── scripts/
│   ├── kiosk.sh                    ← launches touchkio (not chromium directly)
│   └── touchsphere-kiosk.service   ← systemd unit
├── client/
│   └── src/
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── ParticleSphere/
│       │   │   └── ParticleSphere.tsx   ← voice-reactive (scale, color, speed)
│       │   ├── VoiceInterface.tsx       ← mic button, transcript, reply text
│       │   ├── StatusBar.tsx
│       │   ├── LockScreen.tsx
│       │   ├── SettingsPanel.tsx
│       │   └── widgets/
│       │       ├── Widget.tsx
│       │       ├── CalendarWidget/
│       │       ├── ClockWidget/
│       │       ├── WeatherWidget/
│       │       └── MediaListWidget/
│       ├── hooks/
│       │   ├── useAppMode.ts        ← persists mode to /api/state/mode
│       │   ├── useMediaList.ts      ← CRUD via /api/state/media
│       │   ├── useVoice.ts          ← SpeechRecognition + TTS
│       │   ├── useDevice.ts         ← polls /api/device (CPU temp, memory)
│       │   ├── useCalendar.ts
│       │   ├── useClock.ts
│       │   ├── useWeather.ts
│       │   ├── useForecast.ts
│       │   ├── useCloudLayers.ts
│       │   ├── useRainviewer.ts
│       │   └── useAirQuality.ts
│       └── types/
│           └── index.ts
└── server/
    └── src/
        ├── index.ts                 ← Express app, logging middleware, route registration
        └── routes/
            ├── weather.ts
            ├── calendar.ts
            ├── airquality.ts
            ├── tiles.ts
            ├── geoip.ts
            ├── state.ts             ← NEW: media list + app mode + lock cred
            ├── device.ts            ← NEW: Pi hardware metrics
            └── system.ts
```

---

## Kiosk Setup on the Pi

### 1. Install dependencies
```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# TouchKio
bash <(wget -qO- https://raw.githubusercontent.com/leukipp/touchkio/main/install.sh)
# Follow prompts — set --web-url=http://localhost:3001 --web-theme=dark

# TTS engine (for voice replies)
sudo apt install speech-dispatcher espeak-ng
sudo systemctl enable --now speech-dispatcher
```

### 2. Configure server/.env
Copy `server/.env.example` to `server/.env` and fill in:
- `OPENWEATHER_API_KEY`
- `CALENDAR_ICAL_URL` (optional)
- `DEFAULT_LAT` / `DEFAULT_LON` (optional, recommended)

### 3. Start via systemd
The `touchsphere-kiosk.service` starts Docker then launches TouchKio.
```bash
sudo cp scripts/touchsphere-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now touchsphere-kiosk.service
```

### 4. Debugging voice on the Pi
- Run `touchkio --app-debug` to open Chrome DevTools → Console
- Check that `window.SpeechRecognition` or `window.webkitSpeechRecognition` exists
- Verify speech-dispatcher: `spd-say "hello"`
- Electron grants media permissions automatically for localhost origins

---

## Development Phases

### Phase 1 — Shell & Sphere ✅
### Phase 2 — Clock & Weather ✅
### Phase 3 — Google Calendar ✅
### Phase 4 — Media List ✅
### Phase 5 — Polish / Lock Screen ✅
### Phase 6 — Voice Interface ✅
### Phase 7 — Server-side State & Device Metrics ← current
- Move media list from localStorage → `/api/state/media`
- Move app mode from localStorage → `/api/state/mode`
- Persist lock credential hash on server
- `/api/device` endpoint for Pi CPU temp + memory
- `useDevice` hook for status bar or settings panel

### Phase 8 — TouchKio MQTT Integration (optional)
- Connect to mosquitto broker
- Expose brightness / volume / display power as HA controls
- Read CPU temp / memory from HA rather than our own endpoint
- `scripts/kiosk.sh` passes `--mqtt-*` flags

---

## Notes
- Target resolution: 720×1280 (portrait, Official 7" Touch Display 2) or 1280×800 landscape
- All UI must be accessible by tap only — no hover-only states
- Text readable at arm's length — minimum 14px, prefer 16–18px
- touchkio runs Electron (Chromium) — all standard Web APIs work
- Server runs in Docker, client connects via `http://localhost:3001`
- SSE (`/api/system/events`) keeps the browser synced with server restarts
- Never commit `server/.env` — API keys must stay server-side
- `CACHE_DIR` should be a Docker volume for persistence across container rebuilds

