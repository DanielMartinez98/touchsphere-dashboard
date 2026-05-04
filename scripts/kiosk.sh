#!/usr/bin/env bash
# kiosk.sh — not used. TouchKio is configured separately on the Pi.
# The server stack (Caddy + app) is managed via docker-compose.yml.


COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
URL="https://localhost"   # Caddy HTTPS proxy on :443 — port 3001 is internal-only

echo "[kiosk] =========================================="
echo "[kiosk] TouchSphere + TouchKio launcher starting"
echo "[kiosk] compose file : $COMPOSE_FILE"
echo "[kiosk] target URL   : $URL"
echo "[kiosk] =========================================="

# ── 1. Start the container ────────────────────────────────────────────────────
echo "[kiosk] starting touchsphere Docker container…"
docker compose -f "$COMPOSE_FILE" up -d touchsphere
echo "[kiosk] container start requested"

# ── 2. Wait for the server to respond (up to 60 s) ───────────────────────────
echo "[kiosk] waiting for server at $URL …"
READY=0
for i in $(seq 1 60); do
  if curl -sfk "$URL/api/health" -o /dev/null 2>/dev/null; then
    echo "[kiosk] server ready after ${i}s"
    READY=1
    break
  fi
  echo "[kiosk] attempt $i/60 — not ready yet"
  sleep 1
done

if [ "$READY" -eq 0 ]; then
  echo "[kiosk] ERROR: server did not respond within 60 s — check docker logs"
  docker logs touchsphere --tail 50 2>&1 | sed 's/^/[kiosk][docker] /'
  exit 1
fi

# ── 3. Launch TouchKio ───────────────────────────────────────────────────────
# TouchKio is an Electron app installed via .deb (arm64).
# It provides its own fullscreen Chromium webview — no separate chromium-browser call.
# Electron grants microphone permissions automatically for http://localhost origins.
#
# Optional MQTT flags (uncomment and fill in to integrate with Home Assistant):
#   --mqtt-url=mqtt://192.168.1.X:1883 \
#   --mqtt-user=kiosk \
#   --mqtt-password=<password>

# Kill any leftover TouchKio process first
pkill -f "touchkio.*localhost" 2>/dev/null || true
sleep 0.5

echo "[kiosk] launching TouchKio → $URL"
touchkio \
  --web-url="$URL" \
  --web-theme=dark \
  --web-zoom=1.0 &
TOUCHKIO_PID=$!
echo "[kiosk] TouchKio PID: $TOUCHKIO_PID"

# ── 4. Block until the container exits ───────────────────────────────────────
echo "[kiosk] blocking on container exit (PID $TOUCHKIO_PID for TouchKio)…"
docker wait touchsphere
CONTAINER_EXIT=$?
echo "[kiosk] container exited with code $CONTAINER_EXIT"

# ── 5. Kill TouchKio ─────────────────────────────────────────────────────────
echo "[kiosk] killing TouchKio (PID $TOUCHKIO_PID)…"
kill "$TOUCHKIO_PID" 2>/dev/null || true
pkill -f "touchkio.*localhost" 2>/dev/null || true

echo "[kiosk] done — exit 0"
exit 0

