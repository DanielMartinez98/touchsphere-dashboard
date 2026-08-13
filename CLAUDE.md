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
- **[components/widgets/MediaListWidget/GuideView.tsx](client/src/components/widgets/MediaListWidget/GuideView.tsx)** — the **game guide**, full screen, in two layers: a chapter list (nothing but the chapters, each with its kind chip, `x/y` and bar) and, on tapping one, that chapter's own scrolling page of tickable steps with its walkthrough video and prev/next. Steps deliberately never appear in the list — a 12-chapter game is a few hundred of them. A chapter row is **two tap targets**: the body opens it, the trailing circle ticks the whole chapter off where it stands, because picking up a guide for a game you're part-way through means marking several chapters done before reading anything. Inside a chapter, "Mark all done" and "Redo this chapter" sit at the top, above the steps, since both exist precisely to avoid scrolling the steps. Both layers carry the **same round X at top-right as every expanded widget** — that's the one gesture in this app that already means "done with this screen", and a chapter also keeps a labelled "← Chapters" pill so back-one-level and leave-entirely are never the same guess. The guide previously offered only a small top-*left* arrow, which took two taps to get out of a chapter and sat where nothing else in the app puts its exit Data comes from [hooks/useGuides.ts](client/src/hooks/useGuides.ts): `useGuides()` for the per-game summaries that draw the row/pill bars, `useGuide(itemId)` for the document itself. Both follow the server's `guide` SSE event, which is what makes a generation *fill in while you watch* and a spoken "tick that off" move the bar under your eyes. Note `/api/guides` sends `Cache-Control: no-store`: without it Chrome heuristically reuses the document and those live refetches silently return the old one. Videos are handed to the existing [BrowserOverlay](client/src/components/BrowserOverlay.tsx) via `openBrowse`
- **Overlay stacking** — three portals can be on screen at once, and their z-bands are load-bearing: **9200/9190** BrowserOverlay window + backdrop → **9100** GuideOverlay → **9000** `Widget`'s expanded overlay. A video opened from inside a chapter must cover the guide, and the guide must cover the Watch/Play list it was opened from. The guide sat at 8900 until it was reported invisible — tapping a game in the *expanded* list rendered the guide under the very widget it was tapped from, so it only appeared once the list was closed. A widget's inner controls (close button at 9999, grab handle at 9500) are inside its own stacking context and can't escape above the guide, so they need no separate handling
- **[components/GuideOverlay.tsx](client/src/components/GuideOverlay.tsx)** + **[hooks/useGuideOverlay.ts](client/src/hooks/useGuideOverlay.ts)** — which guide is on screen. The guide is a top-level overlay rather than a layer inside the media widget because two unrelated things open it: a tap on a game, and the assistant being asked out loud (`show_game_guide`) — and a voice command can't reach into a component's `useState`. Same module-store shape as `useBrowse`, and `openBrowseFromPayload` routes the `guide` and `close` display kinds into it
- **[hooks/useServerEvents.ts](client/src/hooks/useServerEvents.ts)** — one shared `EventSource` on `/api/system/events` with `subscribe(event, cb)`. The restart signal, guide progress (`guide`) and the guide activity feed (`guide-activity`) all ride it; a per-hook EventSource would cost the Pi a held-open request and a heartbeat per widget
- **[hooks/useGuideActivity.ts](client/src/hooks/useGuideActivity.ts)** + the **Guides** tab in [SettingsPanel.tsx](client/src/components/SettingsPanel.tsx) — what the guide researcher is doing, in three blocks: what's generating right now (phase + bar), every guide on disk with its status, and the activity feed itself (tap a guide to filter the feed to it). One GET for the backlog plus the SSE event for everything after, merged on the server's monotonic entry id so a frame arriving mid-fetch can't land twice
- **[hooks/useAppMode.ts](client/src/hooks/useAppMode.ts)** — `work` / `rest` / `locked` mode; lock credential hashed client-side

### Backend (`server/src/`)

- **[index.ts](server/src/index.ts)** — Express 5 app; Helmet security headers (CSP disabled for Vite), rate limiting (60/min data, 600/min tiles), CORS, request timing logs
- **[routes/chat.ts](server/src/routes/chat.ts)** — `POST /api/chat` → Ollama LLM with conversation history; the system-prompt personality is built per-request from the selected assistant profile ([config/assistant.ts](server/src/config/assistant.ts) → `getSelectedProfile()`). `ASSISTANT_NAME` env seeds the default profile. The client sends `newConversation: true` on the opening utterance after a wake word — that's the only turn on which the same-topic-or-new decision runs (see [session.ts](server/src/session.ts))
- **[config/assistant.ts](server/src/config/assistant.ts)** — server half of the selectable-assistant system: per-profile `persona` (chat personality) + `elevenVoiceId`/`espeakVoice` (TTS). Reads the selected id from `assistant.json` in `$CACHE_DIR`; consumed by chat.ts (persona) and tts.ts (voice)
- **[routes/browse.ts](server/src/routes/browse.ts)** — the assistant's **show-it-on-screen** half. `web_search`/`web_fetch` only let her *talk* about what she found; the `open_website` and `play_video` tools defined here resolve a target and return a `display` payload on the chat reply, which the client renders in [BrowserOverlay](client/src/components/BrowserOverlay.tsx). Resolution is server-side because it needs the network: YouTube search (Data API when `YOUTUBE_API_KEY` is set, otherwise `ytInitialData` off the results page), a DuckDuckGo-HTML fallback for when the model passes a query instead of a URL, and an up-front embeddability probe — most sites send `X-Frame-Options`/`frame-ancestors` and would render as a blank iframe, so those are flagged for reader mode instead. `GET /api/browse/page?url=` serves that reader extraction. Model-supplied URLs are checked against loopback/LAN ranges before any fetch
- **[guides.ts](server/src/guides.ts)** + **[guide-generator.ts](server/src/guide-generator.ts)** + **[routes/guides.ts](server/src/routes/guides.ts)** — **game guides**: one researched, tickable walkthrough per game, organized the way that game's own community organizes it. The store is `guides.json` in `$CACHE_DIR`, keyed by `MediaItem.id` and deliberately *not* folded into `media.json` — that file has two non-atomic writers and a field-whitelisting normalizer that has already destroyed a column once. Every array in a guide is model-generated, so the store caps and re-validates on both read and write, quarantines a corrupt file instead of overwriting it, and writes atomically (the `memory.ts` pattern). Generation is a background job: `startGuide()` writes a `generating` skeleton and returns, so the assistant can answer in one breath while the work outlives the conversation. Stage 1 is one model call for the section list (dungeons/chapters, then collectibles and side quests) plus which sections count toward 100%; stage 2 is one call per section for its steps, and the guide is **saved and SSE-broadcast after every section**. Research happens here rather than through the chat tool loop because that loop truncates tool results at 8k chars and caps at 5 rounds. A section that fails is marked failed and the rest continue; a restart mid-job is swept by `sweepInterrupted()` at boot rather than leaving a permanent spinner — to `ready` with the unfinished chapters flagged when anything survived, `failed` only when nothing did, because failing a whole document over two bad chapters points the user at a full rebuild that costs them every ticked box. **`OLLAMA_GUIDE_NUM_CTX` (default 16384) is load-bearing**: Ollama defaults `num_ctx` to 4096 and discards the overflow from the *front* of the prompt, which is where the research notes are — left at the default the model writes each section from instructions with the evidence sheared off, which reads as "the guide has no detail". **A single section can be re-researched on its own** (`regenerateSection`, `POST /api/guides/:itemId/sections/:sectionId/regenerate`, tool `regenerate_guide_chapter`), leaving every other chapter and its ticks alone; `carryTicks` matches steps by normalized text so a rewrite keeps the boxes that survive it. Voice side: `create_game_guide` / `get_game_guide_progress` / `check_off_guide_step` in [dashboard-tools.ts](server/src/routes/dashboard-tools.ts), and the screen-driving half in [routes/guide-view-tools.ts](server/src/routes/guide-view-tools.ts) — `show_game_guide` (full screen, optionally straight to a chapter named or numbered), `list_guide_chapters`, `play_guide_video`, `check_off_guide_chapter`, `regenerate_guide_chapter`, `delete_game_guide`, `close_screen`. Those return a `display` payload like the browse tools, so **everything reachable by tapping is reachable by asking**. `pushGuide` in [guide-events.ts](server/src/guide-events.ts) is the one place that broadcasts a change (generator, voice tools and the REST route all call it; it lives on its own to keep those three from importing each other)
- **[research.ts](server/src/research.ts)** — where guide content comes from, **wiki-first**. Scraped search engines answer a burst of queries with a CAPTCHA and one guide fires a dozen, so the primary source is the game's own wiki through the MediaWiki API: no key, no throttling, clean plain text, and — the real point — a wiki's article structure *is* how that community organizes the game (`communityTableOfContents()` feeds those headings into the outline prompt). The wiki host is discovered by probing slug candidates against fandom.com/wiki.gg (`zelda`, `hollowknight`, `celestegame`…). Two per-farm quirks are handled: `prop=extracts` isn't installed on every Fandom wiki, so those fall back to rendered HTML through the same readability pass reader mode uses, and Wikimedia serves `api.php` under `/w/`. Wikipedia is the next fallback, and only then the open web (hosted search when `OLLAMA_API_KEY` is set, DuckDuckGo HTML otherwise)
- **[routes/tts.ts](server/src/routes/tts.ts)** — `GET /api/tts?text=` → ElevenLabs WAV or `espeak-ng` fallback
- **[routes/stt.ts](server/src/routes/stt.ts)** — `POST /api/stt` → Vosk or Whisper transcription
- **[memory.ts](server/src/memory.ts)** — what the assistant knows about the user, in `memory.json`. Long-term (no expiry, 50 max) holds two `kind`s: `fact` ("the user's name is…") and `preference` — a learned *answer shape* ("when they ask how to get past a part of a game, they want a video"), saved via the `remember_preference` tool. Preferences are injected under their own heading with instructions to **offer, never assume**, so the assistant proposes the format and calls `keep_listening` for a yes/no instead of silently opening a window. Short-term (24h TTL, 30 max) holds the end-of-conversation auto-summaries. `formatForPrompt()` injects the lot into every system prompt. `forget` refuses queries under 3 chars or matching more than 3 entries — it's driven by a language model and used to be able to empty the store in one call
- **[session.ts](server/src/session.ts)** — the **last conversation**, kept 12h so a topic can be resumed. The client wipes its history when the assistant hangs up, so the transcript is parked here on the way out. On the first utterance of the *next* conversation, `scoreContinuation()` decides `continue` (replay the old turns as real history) / `maybe` (inject only a one-line recap, flagged as possibly unrelated) / `new` (inject nothing — today's behaviour). The scorer is lexical, not a model call: an LLM classifier would sit in front of every reply on a local Ollama box, the same latency `OLLAMA_THINK=false` exists to avoid. The `maybe` band is what lets a cheap scorer be wrong at the edges. The decision is latched in `chat.ts` for the whole conversation, since the client only ever sends its own turns
- **[guide-activity.ts](server/src/guide-activity.ts)** — the running account of what the guide system is doing, behind Settings → **Guides**. A 300-entry in-memory ring buffer; `note()` is the single place guide progress is written to stdout, and it also broadcasts a `guide-activity` SSE frame and appends to the buffer, so the console line and the on-screen line are the same sentence and can't drift. `GET /api/guides/activity` serves the backlog for a tab opened mid-run (**registered above `GET /:itemId`** — Express matches in order and would otherwise read `activity` as a media-item id). Deliberately not persisted: it's a window onto work in progress, and guides.json already has a writer per section. Why it exists — a run is a dozen model calls and twice as many fetches over minutes, and its only trace was one constantly-overwritten `phase` string; when a chapter came back empty, the answer to *why* (no wiki page, throttled search, model returned nothing twice) was being logged and thrown away
- **[routes/memory.ts](server/src/routes/memory.ts)** — `GET/POST/DELETE /api/memory` (+ `DELETE /api/memory/session`), behind the Settings → **Memory** tab. Memory was previously inspectable only by asking out loud and trusting the answer; this is the window and the off switch
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
