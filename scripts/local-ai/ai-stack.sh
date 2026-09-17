#!/usr/bin/env bash
# The AI stack on this machine, day to day — the compose incantation
# scripts/local-ai/install.sh set up (.env.ai: the data disk and the profile)
# so nobody has to remember `-p touchsphere-ai --env-file .env.ai -f
# docker-compose.voice.yml --profile gpu`.
#
#   scripts/local-ai/ai-stack.sh up            # start (or restart what changed)
#   scripts/local-ai/ai-stack.sh down          # stop; models stay on the disk
#   scripts/local-ai/ai-stack.sh status        # containers, and whether each answers
#   scripts/local-ai/ai-stack.sh logs [name]   # follow the logs (ollama, kokoro, whisper, rvc, comfyui)
#   scripts/local-ai/ai-stack.sh pull qwen3:8b # one more Ollama model
#   scripts/local-ai/ai-stack.sh models        # what Ollama and ComfyUI have
#   scripts/local-ai/ai-stack.sh update        # newer images, then up

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ENV_AI="$REPO/.env.ai"

[ -f "$ENV_AI" ] || { echo "no $ENV_AI — run scripts/local-ai/install.sh first" >&2; exit 1; }
PROFILE=$(grep -E '^TS_AI_PROFILE=' "$ENV_AI" | cut -d= -f2-)
DATA=$(grep -E '^TS_AI_DATA=' "$ENV_AI" | cut -d= -f2-)
PROFILE="${PROFILE:-cpu}"

compose() { docker compose -p touchsphere-ai --env-file "$ENV_AI" -f "$REPO/docker-compose.voice.yml" --profile "$PROFILE" "$@"; }

probe() { # probe <label> <url>
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$2" 2>/dev/null || echo 000)
  case "$code" in
    2*|3*|404) printf '   %-8s \033[32mup\033[0m   %s\n' "$1" "$2" ;;
    000)       printf '   %-8s \033[31mdown\033[0m %s\n' "$1" "$2" ;;
    *)         printf '   %-8s \033[33m%s\033[0m  %s\n' "$1" "$code" "$2" ;;
  esac
}

case "${1:-}" in
  up)      compose up -d --build --remove-orphans ;;
  down)    compose down ;;
  restart) compose restart "${@:2}" ;;
  update)  compose pull --ignore-buildable && compose up -d --build --remove-orphans ;;
  logs)    compose logs -f --tail=200 "${@:2}" ;;
  status)
    echo "profile $PROFILE, data $DATA"
    compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || compose ps
    echo
    probe ollama  http://localhost:11434/api/tags
    probe kokoro  http://localhost:8880/v1/audio/voices
    probe whisper http://localhost:8000/health
    probe rvc     http://localhost:5050/
    [ "$PROFILE" = gpu ] && probe comfyui http://localhost:8188/system_stats
    ;;
  pull)
    [ -n "${2:-}" ] || { echo "usage: $0 pull <ollama model>" >&2; exit 64; }
    docker exec touchsphere-ollama ollama pull "$2"
    ;;
  models)
    echo "Ollama:"; docker exec touchsphere-ollama ollama list 2>/dev/null | sed 's/^/   /' || echo "   (not running)"
    echo "ComfyUI ($DATA/comfy/models):"
    find "$DATA/comfy/models" -type f \( -name '*.safetensors' -o -name '*.pth' -o -name '*.ckpt' \) -printf '   %P  %k KB\n' 2>/dev/null | sort || true
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 64
    ;;
esac
