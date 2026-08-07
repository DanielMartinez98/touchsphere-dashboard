# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Client (React/Vite) — run from `client/`
```bash
npm run dev       # Dev server with HMR at http://localhost:5173 (proxies /api/* → localhost:3001)
npm run build     # TypeScript check + Vite production build → client/dist
npm run lint      # ESLint
npm run preview   # Preview production build
```

### Server (Express/Node) — run from `server/`
```bash
npm run dev       # nodemon + ts-node, watches src/index.ts
npm run build     # tsc → server/dist
npm run start     # Run compiled dist/index.js
```

### Docker (from repo root)
```bash
docker-compose up                          # Start app + Caddy + Watchtower
docker-compose --profile local-voice up    # …plus Kokoro + RVC on this box
docker-compose build                       # Multi-platform build (amd64 + arm64)
```

The Kokoro/RVC voice pipeline is location-independent (the app reaches it via
`KOKORO_URL`/`RVC_URL`). To offload it to a faster machine (typically the Ollama
box), run `docker-compose.voice.yml` there (`--profile gpu` for CUDA via
`docker/rvc/Dockerfile.gpu`, `--profile cpu` otherwise) and point the URLs at it
in `.env`; then start the dashboard box *without* `--profile local-voice`.

## Environment Setup

Copy `.env.example` to `server/.env` and fill in:
- `OPENWEATHER_API_KEY` — required for all weather/AQI/tile routes
- `CALENDAR_ICAL_URL` — optional Google Calendar iCal feed
- `DEFAULT_LAT` / `DEFAULT_LON` — recommended (falls back to GeoIP)
- `ELEVENLABS_API_KEY` — optional; falls back to `espeak-ng` on Pi
- `OLLAMA_URL` / `OLLAMA_MODEL` — LLM backend for `/api/chat`
- `YOUTUBE_API_KEY` — optional; makes `play_video` search reliable (falls back to scraping)
- `PORT` — defaults to 3001

## Architecture

### Layout
A full-screen kiosk SPA (720×1280 portrait on Raspberry Pi 5 / 7" touchscreen) with a center 3D particle sphere and four corner widgets. Designed for touch-only interaction at arm's length (minimum 14px, prefer 16–18px fonts).

```
┌──────────────────────────┐
│  [Weather]   [Calendar]  │   ← top-left blue / top-right yellow
│         [Sphere]         │   ← center: Three.js particle sphere
│  [Media]     [Clock]     │   ← bottom-left red / bottom-right purple
│         [StatusBar]      │   ← mode selector (work/rest/locked)
└──────────────────────────┘
```

### Frontend (`client/src/`)

- **[App.tsx](client/src/App.tsx)** — root layout, widget positioning, sphere tap handler, mode-based styling
- **[main.tsx](client/src/main.tsx)** — React 19 mount, ErrorBoundary, eager data hook imports for pre-loading
- **[components/ParticleSphere/ParticleSphere.tsx](client/src/components/ParticleSphere/ParticleSphere.tsx)** — Three.js sphere; color/scale/spin react to voice state (green = listening, amber = speaking)
- **[components/widgets/](client/src/components/widgets/)** — each widget has collapsed (icon only) and expanded states; `Widget.tsx` is the generic wrapper
- **[hooks/useVoice.ts](client/src/hooks/useVoice.ts)** — core voice loop: SpeechRecognition → `/api/stt` → `/api/chat` → `/api/tts` playback
- **[hooks/useWakeWord.ts](client/src/hooks/useWakeWord.ts)** — offline wake-word via Vosk running in a Web Worker; the wake phrases come from the selected assistant profile
- **[config/assistant.ts](client/src/config/assistant.ts)** — client half of the **selectable assistant** system: the profile table (name, `wakePatterns`, `wakePhrase`, tagline) + a reactive store (`useAssistant`, `setAssistantId`). Four profiles: **Martin** (default), **Jarvis**, **TouchSphere**, **Merlin**. The user picks one in Settings; the id is persisted via `POST /api/state/assistant` so the server's persona + voice follow. The server half (personality + TTS voice) is [server/src/config/assistant.ts](server/src/config/assistant.ts) — keep ids/names in sync. **This is the AI's identity** — the product/app is still "TouchSphere".
- **[components/BrowserOverlay.tsx](client/src/components/BrowserOverlay.tsx)** — full-screen browser window the assistant opens via `open_website` / `play_video` (see [server/src/routes/browse.ts](server/src/routes/browse.ts)). Three bodies: the YouTube embed, a live iframe, or reader mode for the majority of sites that refuse to be framed — with a manual reader ⇄ site toggle, since an iframe can still come back blank. Target lives in [hooks/useBrowse.ts](client/src/hooks/useBrowse.ts) and is opened by `useVoice` at the moment the spoken reply is revealed, so window and voice land together. A video is held (poster, then iframe-API pause/resume) for as long as the assistant has the floor — playback and the voice loop must never share the room
- **[hooks/useAppMode.ts](client/src/hooks/useAppMode.ts)** — `work` / `rest` / `locked` mode; lock credential hashed client-side

### Backend (`server/src/`)

- **[index.ts](server/src/index.ts)** — Express 5 app; Helmet security headers (CSP disabled for Vite), rate limiting (60/min data, 600/min tiles), CORS, request timing logs
- **[routes/chat.ts](server/src/routes/chat.ts)** — `POST /api/chat` → Ollama LLM with conversation history; the system-prompt personality is built per-request from the selected assistant profile ([config/assistant.ts](server/src/config/assistant.ts) → `getSelectedProfile()`). `ASSISTANT_NAME` env seeds the default profile
- **[config/assistant.ts](server/src/config/assistant.ts)** — server half of the selectable-assistant system: per-profile `persona` (chat personality) + `elevenVoiceId`/`espeakVoice` (TTS). Reads the selected id from `assistant.json` in `$CACHE_DIR`; consumed by chat.ts (persona) and tts.ts (voice)
- **[routes/browse.ts](server/src/routes/browse.ts)** — the assistant's **show-it-on-screen** half. `web_search`/`web_fetch` only let her *talk* about what she found; the `open_website` and `play_video` tools defined here resolve a target and return a `display` payload on the chat reply, which the client renders in [BrowserOverlay](client/src/components/BrowserOverlay.tsx). Resolution is server-side because it needs the network: YouTube search (Data API when `YOUTUBE_API_KEY` is set, otherwise `ytInitialData` off the results page), a DuckDuckGo-HTML fallback for when the model passes a query instead of a URL, and an up-front embeddability probe — most sites send `X-Frame-Options`/`frame-ancestors` and would render as a blank iframe, so those are flagged for reader mode instead. `GET /api/browse/page?url=` serves that reader extraction. Model-supplied URLs are checked against loopback/LAN ranges before any fetch
- **[routes/tts.ts](server/src/routes/tts.ts)** — `GET /api/tts?text=` → ElevenLabs WAV or `espeak-ng` fallback
- **[routes/stt.ts](server/src/routes/stt.ts)** — `POST /api/stt` → Vosk or Whisper transcription
- **[routes/state.ts](server/src/routes/state.ts)** — `POST /api/state/*` persists media list, mode, lock credential as JSON in `$CACHE_DIR` (Docker volume `/data/cache`)
- **[routes/device.ts](server/src/routes/device.ts)** — `GET /api/device` reads `/sys/class/thermal/thermal_zone0/temp` and `/proc/meminfo` (Pi-specific)
- **[routes/weather.ts](server/src/routes/weather.ts)** — current weather + 5-day forecast via OpenWeatherMap; cloud-layers and `GET /api/weather/timeline` via Open-Meteo (keyless). **The timeline is the only source of past weather** — OWM history sits behind a paid One Call 3.0 subscription and 401s on the free key. It returns one contiguous hourly series (2 days back → 5 days ahead) in OWM's units, and drives the map's time scrubber. Note map *imagery* has no such range: RainViewer covers ~2h back plus a 30-min nowcast, OWM cloud tiles are always a live snapshot, so outside that window the overlay is hidden and the badge reads "NO IMAGERY · DATA ONLY" rather than painting current clouds on a past timestamp
- **[routes/tiles.ts](server/src/routes/tiles.ts)** — proxies OWM cloud tile requests (rate-limited separately)
- **[routes/artwork.ts](server/src/routes/artwork.ts)** — cover art for the Watch/Play list. `GET /api/artwork/search?type=&q=` hits TMDB (movies/shows) or IGDB (games); the chosen poster is downloaded once into `$CACHE_DIR/covers` and served by `GET /api/artwork/cover/:file`, so the list renders offline. `state.ts` looks up a cover on add (`autoCover`) and re-caches on `PATCH /api/state/media/:id { coverUrl }` when the user corrects a wrong match. IGDB authenticates via Twitch client-credentials (`IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET`); both providers are optional — without keys, items fall back to a gradient tile

### Data Flow

```
React hooks → fetch /api/* → Express routes → External APIs
                                             → Ollama (local LLM)
                                             → OpenWeatherMap
                                             → Google Calendar iCal
                                             → ElevenLabs TTS
```

### Deployment

- **Dockerfile** — 3-stage build: client (Vite), server (tsc), production Alpine image with `espeak-ng` + `su-exec`
- **Caddy** — reverse proxy on :443 with self-signed TLS (required for browser microphone/camera APIs in kiosk)
- **Watchtower** — polls `ghcr.io` and auto-updates the running container
- **CI/CD** — `.github/workflows/docker-publish.yml` builds `linux/amd64` + `linux/arm64` on every push to `main`
- **Kiosk** — `scripts/kiosk.sh` launches TouchKio (Electron); `scripts/touchsphere-kiosk.service` is the systemd unit

## Key Constraints

- **Touch-only UI** — no hover states, all interactions must work with a finger tap
- **ARM64 target** — Docker images must support `linux/arm64` for Raspberry Pi 5; test multi-arch builds before merging
- **Secure context required** — microphone and camera APIs require HTTPS; Caddy provides self-signed TLS even in local dev on Pi
- **Offline-capable voice** — wake-word detection (Vosk) and TTS fallback (espeak-ng) must work without internet
- **State persistence** — app mode, media list, and lock credential survive restarts via server-side JSON in the Docker volume
