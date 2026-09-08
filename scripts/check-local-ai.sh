#!/usr/bin/env bash
# Is every AI tool running locally — and is each one actually working?
#
# Two passes, the same shape as check-elevenlabs.sh: straight at each service
# (is it up, does it answer the request the app will send it?), then through
# the app (is the app USING it, and which link of each chain answered?). The
# second pass is the one that matters, because every chain here is designed to
# survive a dead link — /api/stt falls from Whisper to ElevenLabs, /api/tts
# from Kokoro to ElevenLabs to espeak, search from SearXNG to the hosted one —
# and that resilience hides a local service that has quietly stopped. The
# X-STT-Provider / X-TTS-Provider headers and the `by` field on a chat reply
# exist so this script can tell.
#
#   ./scripts/check-local-ai.sh                 # reads ./.env, app on :3001
#   APP=http://localhost:3001 ENV_FILE=server/.env ./scripts/check-local-ai.sh
#
# Exit status is 0 when the app is up and every AI tool it is configured for
# answered locally; 1 when one is down or a cloud link answered for a local
# one. Services the app is not configured for are reported, not failed.

set -uo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
APP="${APP:-http://localhost:3001}"
CLIP="$(mktemp -t ts-local-XXXXXX.audio)"
trap 'rm -f "$CLIP"' EXIT

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

fail=0
cloud=0

envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'\r "; }
# JSON field, via python — jq is not on every box this runs on.
jfield() { python3 -c 'import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d.get(k) if isinstance(d,dict) else None
    if d is None: break
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1" 2>/dev/null; }

if [ -f "$ENV_FILE" ]; then
  OLLAMA_URL=$(envval OLLAMA_URL);    OLLAMA_MODEL=$(envval OLLAMA_MODEL)
  WHISPER_URL=$(envval WHISPER_URL);  KOKORO_URL=$(envval KOKORO_URL)
  RVC_URL=$(envval RVC_URL);          COMFYUI_URL=$(envval COMFYUI_URL)
  SEARXNG_URL=$(envval SEARXNG_URL);  OLLAMA_API_KEY=$(envval OLLAMA_API_KEY)
  ELEVEN_KEY=$(envval ELEVENLABS_API_KEY)
  TTS_PROVIDER=$(envval TTS_PROVIDER); SEARCH_PREFER_LOCAL=$(envval SEARCH_PREFER_LOCAL)
else
  warn "No .env at $ENV_FILE — skipping the direct pass; the app pass still runs."
fi
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

echo "═══ Way 1: straight at each service (is it up?) ═══"
dim "URLs come from $ENV_FILE and are as the CONTAINER sees them — a compose"
dim "name like http://whisper:8000 does not resolve from the host, and that is"
dim "reported as 'not reachable from here', not as down. Way 2 settles it."

# probe <label> <url> [curl args…] — prints OK/no and the code; never fails the run.
probe() {
  local label="$1" url="$2"; shift 2
  printf '%-10s … ' "$label"
  if [ -z "$url" ]; then warn "not configured"; return 1; fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$@" "$url" 2>/dev/null)
  case "$code" in
    2*|3*) green "OK ($code) $url" ; return 0 ;;
    000)   warn "not reachable from here ($url)"; return 1 ;;
    *)     red "answered $code ($url)"; return 1 ;;
  esac
}

if probe "ollama" "${OLLAMA_URL%/}/api/tags"; then
  models=$(curl -s --max-time 8 "${OLLAMA_URL%/}/api/tags" | python3 -c 'import sys,json;print(", ".join(m["name"] for m in json.load(sys.stdin).get("models",[])))' 2>/dev/null)
  dim "           models: ${models:-none}"
  if [ -n "${OLLAMA_MODEL:-}" ] && ! printf '%s' "$models" | grep -q "${OLLAMA_MODEL}"; then
    warn "           OLLAMA_MODEL=$OLLAMA_MODEL is not in that list — ollama pull it"
  fi
fi
# A second of 16 kHz silence: what the app itself sends to warm and probe Whisper.
python3 - "$CLIP" <<'PY'
import struct,sys
rate=16000; n=rate; data=b"\0\0"*n
hdr=b"RIFF"+struct.pack("<I",36+len(data))+b"WAVEfmt "+struct.pack("<IHHIIHH",16,1,1,rate,rate*2,2,16)+b"data"+struct.pack("<I",len(data))
open(sys.argv[1],"wb").write(hdr+data)
PY
WHISPER_PATH=$(envval WHISPER_PATH); WHISPER_MODEL=$(envval WHISPER_MODEL)
probe "whisper" "${WHISPER_URL:+${WHISPER_URL%/}${WHISPER_PATH:-/v1/audio/transcriptions}}" \
  -X POST -F "file=@$CLIP;type=audio/wav" -F "model=${WHISPER_MODEL:-Systran/faster-whisper-small}" -F "response_format=json"
probe "kokoro"  "${KOKORO_URL:+${KOKORO_URL%/}/v1/audio/voices}"
probe "rvc"     "${RVC_URL:+${RVC_URL%/}/}"
probe "comfyui" "${COMFYUI_URL:+${COMFYUI_URL%/}/system_stats}"
probe "searxng" "${SEARXNG_URL:+${SEARXNG_URL%/}/search?q=test&format=json}"

echo
echo "═══ Way 2: through the app (is the app using it?) ═══"

printf 'app up     … '
if curl -sf --max-time 8 -o /dev/null "$APP/api/health"; then green "OK ($APP)"; else
  red "no response at $APP — is the container running?"; exit 1
fi

# The chains, as the server itself reports them. A "(cloud)" in the FIRST
# position of any chain is the thing this script exists to catch.
debug=$(curl -s --max-time 8 "$APP/api/system/debug")
for key in stt tts search chat; do
  line=$(printf '%s' "$debug" | jfield "chains.$key")
  printf '%-10s … ' "$key"
  if [ -z "$line" ]; then warn "not reported (server predates chains — rebuild the container)"; continue; fi
  first=${line%%→*}
  case "$first" in
    *"(cloud)"*) warn "$line"; warn "           ↑ the cloud link answers FIRST here"; cloud=1 ;;
    *)           echo "$line" ;;
  esac
done
warnings=$(printf '%s' "$debug" | jfield warnings)
[ -n "$warnings" ] && [ "$warnings" != "[]" ] && warn "server warnings: $warnings"

# TALKING through the app — the header names the engine that actually spoke.
printf 'talking    … '
hdrs=$(curl -s --max-time 30 -D - -o "$CLIP" "$APP/api/tts?as=jarvis&text=The%20quick%20brown%20fox%20jumps%20over%20the%20lazy%20dog." | tr -d '\r')
prov=$(printf '%s' "$hdrs" | awk -F': ' 'tolower($1)=="x-tts-provider"{print $2}')
ctype=$(printf '%s' "$hdrs" | awk -F': ' 'tolower($1)=="content-type"{print $2}')
case "$prov" in
  kokoro|rvc)  green "OK — $prov (local) synthesised it" ;;
  espeak)      warn "espeak (local floor) — Kokoro/ElevenLabs both failed or are unset"; ;;
  elevenlabs)  if [ "${TTS_PROVIDER:-}" = "local" ]; then red "ElevenLabs answered although TTS_PROVIDER=local — Kokoro failed; check the kokoro container"; fail=1
               else warn "ElevenLabs (cloud) — set TTS_PROVIDER=local to prefer Kokoro"; cloud=1; fi ;;
  "")          red "no audio / no X-TTS-Provider header"; fail=1 ;;
  *)           warn "unexpected provider: $prov" ;;
esac

# HEARING through the app — the clip we just made, back through /api/stt.
# Round-tripping our own audio means a failure here is the transcriber or its
# config, never a bad recording. Only when the clip is real audio.
printf 'hearing    … '
if [ -s "$CLIP" ] && [ -n "$prov" ]; then
  case "$ctype" in audio/wav*) mime=audio/wav ;; *) mime=audio/mpeg ;; esac
  out=$(curl -s --max-time 90 -D "$CLIP.h" -X POST -F "audio=@$CLIP;type=$mime" "$APP/api/stt")
  sprov=$(tr -d '\r' < "$CLIP.h" | awk -F': ' 'tolower($1)=="x-stt-provider"{print $2}'); rm -f "$CLIP.h"
  text=$(printf '%s' "$out" | jfield text)
  if printf '%s' "$text" | grep -qi 'quick brown fox'; then
    case "$sprov" in
      whisper)    green "OK — Whisper (local) heard \"$text\"" ;;
      elevenlabs) if [ -n "${WHISPER_URL:-}" ]; then red "ElevenLabs answered although WHISPER_URL is set — the whisper container failed; see /api/stt/check below"; fail=1
                  else warn "ElevenLabs (cloud) heard it — set WHISPER_URL for local hearing"; cloud=1; fi ;;
      *)          warn "heard it, provider unknown ($sprov)" ;;
    esac
  else
    red "FAILED — $(printf '%s' "$out" | head -c 300)"; fail=1
  fi
else
  warn "SKIPPED (no clip — talking has to succeed first)"
fi

printf 'whisper    … '
out=$(curl -s --max-time 60 "$APP/api/stt/check")
if [ "$(printf '%s' "$out" | jfield ok)" = "True" ]; then green "OK — $(printf '%s' "$out" | jfield detail)"; else
  msg=$(printf '%s' "$out" | jfield error)
  case "$msg" in
    *"not set"*) warn "${msg:-not configured}" ;;
    *)           red "FAILED — ${msg:-$(printf '%s' "$out" | head -c 200)}"; [ -n "${WHISPER_URL:-}" ] && fail=1 ;;
  esac
fi

# THINKING through the app: one reply, and which model produced it. `by` is
# only present when the fallback model answered instead of the primary.
printf 'chat       … '
out=$(curl -s --max-time 120 -X POST -H 'content-type: application/json' \
      -d '{"messages":[{"role":"user","content":"Reply with exactly one word: pong"}]}' "$APP/api/chat")
reply=$(printf '%s' "$out" | jfield reply); model=$(printf '%s' "$out" | jfield model); by=$(printf '%s' "$out" | jfield by)
if [ -n "$reply" ]; then
  green "OK — $model${by:+ (answered by $by)} said \"$(printf '%s' "$reply" | head -c 80)\""
else
  red "FAILED — $(printf '%s' "$out" | head -c 300)"; fail=1
fi

# LOOKING THINGS UP through the app: a request that should make the model
# call web_search, and the reply's `tools` says whether it did. Informational
# — a small model sometimes answers from memory instead, which is the model's
# choice rather than a broken tool.
printf 'web search … '
out=$(curl -s --max-time 180 -X POST -H 'content-type: application/json' \
      -d '{"messages":[{"role":"user","content":"Search the web for the release date of the Raspberry Pi 5 and tell me what the search found."}]}' "$APP/api/chat")
tools=$(printf '%s' "$out" | jfield tools)
case "$tools" in
  *web_search*) green "OK — the model called web_search (tools: $tools)" ;;
  "")           red "no reply — $(printf '%s' "$out" | head -c 200)"; fail=1 ;;
  *)            warn "the model answered without searching (tools: $tools) — try again, or a bigger OLLAMA_MODEL" ;;
esac

printf 'images     … '
out=$(curl -s --max-time 20 "$APP/api/image/check")
if [ "$(printf '%s' "$out" | jfield ok)" = "True" ]; then green "OK — $(printf '%s' "$out" | jfield detail)"; else
  msg=$(printf '%s' "$out" | jfield error)
  if [ -z "${COMFYUI_URL:-}" ]; then warn "not configured (COMFYUI_URL unset — drawing is not offered)"; else red "FAILED — ${msg:-$(printf '%s' "$out" | head -c 200)}"; fail=1; fi
fi

echo
if [ "$fail" -ne 0 ]; then
  red "Something failed above."; exit 1
elif [ "$cloud" -ne 0 ]; then
  warn "Everything works, but a cloud link answers first somewhere above. See .env.example → 'Running the AI locally'."; exit 1
else
  green "Every configured AI tool answered, and every chain is local-first."
fi
