#!/usr/bin/env bash
# Check ElevenLabs in both directions — talking (TTS) and hearing (STT) — twice
# over: once straight at ElevenLabs, once through this app.
#
# Why both: the app is designed to survive an ElevenLabs outage, and that
# resilience hides the outage. /api/tts falls through a provider chain
# (elevenlabs -> kokoro -> espeak) and still answers 200, so "the voice works"
# proves nothing about the key. /api/stt has no fallback and just fails. The
# direct pass tells you whether the CREDENTIAL is good; the app pass tells you
# whether the app is USING it. You need both to know where a fault lives.
#
#   ./scripts/check-elevenlabs.sh              # reads ./.env, app on :3001
#   APP=http://localhost:3001 ./scripts/check-elevenlabs.sh
#
# Exit status is 0 only when all four checks pass.

set -uo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
APP="${APP:-http://localhost:3001}"
# Rachel — a stock voice present on every ElevenLabs account, so a 404 here
# means the key/account is wrong rather than the voice being missing.
VOICE="${VOICE:-21m00Tcm4TlvDq8ikWAM}"
CLIP="$(mktemp -t el-check-XXXXXX.mp3)"
trap 'rm -f "$CLIP"' EXIT

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }

fail=0

if [ ! -f "$ENV_FILE" ]; then
  red "No .env at $ENV_FILE — run this from the repo root, or set ENV_FILE."
  exit 1
fi

KEY=$(grep -E '^ELEVENLABS_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'\r ")

echo "═══ Key ═══"
if [ -z "$KEY" ]; then
  red "ELEVENLABS_API_KEY is not set in $ENV_FILE"
  exit 1
fi
echo "prefix ${KEY:0:3}…  length ${#KEY}"
case "$KEY" in
  sk_*) green "shape OK (starts with sk_)" ;;
  *)    red "WRONG SHAPE — ElevenLabs keys start with \"sk_\". This is not an ElevenLabs API key."
        red "Get one at elevenlabs.io -> Profile -> API Keys. Everything below will fail."
        fail=1 ;;
esac

echo
echo "═══ Way 1: straight at ElevenLabs (is the credential good?) ═══"

printf 'auth     … '
code=$(curl -s -o /dev/null -w '%{http_code}' -H "xi-api-key: $KEY" \
       https://api.elevenlabs.io/v1/user)
if [ "$code" = "200" ]; then green "OK ($code)"; else red "FAILED ($code)"; fail=1; fi

# TALKING. A real synthesis request; the resulting clip is reused as the input
# to the hearing check below, so the two halves test each other end to end.
printf 'talking  … '
out=$(curl -s -o "$CLIP" -w '%{http_code} %{size_download}' \
      -X POST -H "xi-api-key: $KEY" -H 'content-type: application/json' \
      -d '{"text":"The quick brown fox jumps over the lazy dog.","model_id":"eleven_turbo_v2_5"}' \
      "https://api.elevenlabs.io/v1/text-to-speech/$VOICE")
code=${out%% *}; size=${out##* }
if [ "$code" = "200" ] && [ "$size" -gt 1000 ]; then
  green "OK — synthesised $size bytes"
else
  red "FAILED ($code)"; head -c 300 "$CLIP" 2>/dev/null; echo; fail=1
fi

# HEARING. Transcribe the clip we just made. Round-tripping our own audio means
# a failure here is the STT service or the key, never a bad recording.
printf 'hearing  … '
if [ "$code" = "200" ] && [ "$size" -gt 1000 ]; then
  body=$(curl -s -X POST -H "xi-api-key: $KEY" \
         -F "file=@$CLIP" -F 'model_id=scribe_v1' \
         https://api.elevenlabs.io/v1/speech-to-text)
  if printf '%s' "$body" | grep -qi 'quick brown fox'; then
    green "OK — transcribed back correctly"
  else
    red "FAILED"; echo "  $(printf '%s' "$body" | head -c 300)"; fail=1
  fi
else
  warn "SKIPPED (no clip to transcribe)"
fi

echo
echo "═══ Way 2: through the app (is the app using it?) ═══"

printf 'app up   … '
if curl -sf -o /dev/null "$APP/api/health"; then green "OK"; else
  red "no response at $APP — is the container running?"; exit 1
fi

# TALKING through the app. The X-TTS-Provider header names the engine that
# actually produced the audio; without it, fall back to reading the log, since
# an image built before that header still logs which provider ran.
printf 'talking  … '
prov=$(curl -s -o /dev/null -D - "$APP/api/tts?as=martin&text=hello%20there" \
       | tr -d '\r' | awk -F': ' 'tolower($1)=="x-tts-provider"{print $2}')
case "$prov" in
  elevenlabs) green "OK — ElevenLabs synthesised it" ;;
  espeak)     red "FELL BACK TO espeak — ElevenLabs failed, the app is using the robot voice"; fail=1 ;;
  kokoro|rvc) warn "used $prov (local pipeline) — expected for Miku, not for Martin" ;;
  "")         warn "no X-TTS-Provider header — image predates it; check the log:"
              echo "         sudo docker compose logs --tail=30 app | grep '\\[tts\\]'" ;;
  *)          warn "unexpected provider: $prov" ;;
esac

# HEARING through the app. Same clip again — this is the exact path the voice
# loop uses, so a pass here means the microphone round-trip will work.
printf 'hearing  … '
if [ -s "$CLIP" ]; then
  body=$(curl -s -X POST -F "audio=@$CLIP;type=audio/mpeg" "$APP/api/stt")
  if printf '%s' "$body" | grep -qi 'quick brown fox'; then
    green "OK — the app transcribed it"
  else
    red "FAILED"; echo "  $(printf '%s' "$body" | head -c 300)"; fail=1
  fi
else
  warn "SKIPPED (no clip — the talking check above had to succeed first)"
fi

echo
if [ "$fail" -eq 0 ]; then
  green "All four checks passed — talking and hearing both work, directly and through the app."
else
  red "Something failed above. Direct failures = bad key/account. App-only failures = app config."
fi
exit "$fail"
