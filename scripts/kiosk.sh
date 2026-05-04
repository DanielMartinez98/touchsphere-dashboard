#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# kiosk.sh  —  TouchSphere host-side kiosk launcher
#
# What it does:
#   1. Brings the touchsphere Docker container up (idempotent).
#   2. Waits until the server is accepting connections.
#   3. Launches Chromium in kiosk mode.
#   4. Blocks on "docker wait touchsphere" — the moment the container exits
#      (because the user pressed Close App → server does process.exit(0)),
#      this script kills Chromium and exits with 0.
#
# The matching systemd unit (touchsphere-kiosk.service) sets Restart=on-failure
# so a clean exit (code 0) keeps everything stopped, while a crash restarts it.
#
# Usage: install the systemd unit or run manually as the desktop user.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
URL="http://localhost:3001"

# ── 0. Pre-create a Chromium profile that grants mic + speech permissions ─────
# Without this (and the flags below) the kiosk has no way to click "Allow" on
# the browser permission dialog, so SpeechRecognition and getUserMedia silently
# fail in kiosk mode.
CHROME_PROFILE="/tmp/touchsphere-kiosk-profile"
mkdir -p "$CHROME_PROFILE/Default"
cat > "$CHROME_PROFILE/Default/Preferences" << 'PREFS'
{
  "profile": {
    "content_settings": {
      "exceptions": {
        "media_stream_mic": {
          "http://localhost:3001,*": { "last_modified": "0", "setting": 1 }
        }
      }
    }
  }
}
PREFS

# ── 1. Start the container ────────────────────────────────────────────────────
echo "[kiosk] starting touchsphere container…"
docker compose -f "$COMPOSE_FILE" up -d touchsphere

# ── 2. Wait for the server to respond (up to 60 s) ───────────────────────────
echo "[kiosk] waiting for server at $URL …"
for i in $(seq 1 60); do
  if curl -sf "$URL" -o /dev/null 2>/dev/null; then
    echo "[kiosk] server ready after ${i}s"
    break
  fi
  sleep 1
done

# ── 3. Launch Chromium in kiosk mode ─────────────────────────────────────────
# Kill any leftover Chromium session first
pkill -f "chromium.*$URL" 2>/dev/null || true

echo "[kiosk] launching Chromium…"
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --user-data-dir="$CHROME_PROFILE" \
  --use-fake-ui-for-media-stream \
  --enable-speech-dispatcher \
  --enable-features=WebSpeechAPI,SpeechSynthesis \
  "$URL" &
CHROMIUM_PID=$!

# ── 4. Block until the container exits ───────────────────────────────────────
echo "[kiosk] watching container (pid $CHROMIUM_PID for Chromium)…"
docker wait touchsphere

# ── 5. Kill Chromium ─────────────────────────────────────────────────────────
echo "[kiosk] container exited — killing Chromium"
kill "$CHROMIUM_PID" 2>/dev/null || true
pkill -f "chromium.*$URL" 2>/dev/null || true

echo "[kiosk] done"
exit 0
