#!/usr/bin/env bash
#
# Set THIS machine up to do the dashboard's AI work: the language model
# (Ollama), the pictures (ComfyUI), the voices (Kokoro out, Whisper in, RVC
# for Miku) — and their models — with everything stored on the biggest disk
# that is NOT the system one.
#
#   bash scripts/local-ai/install.sh                      # pick the disk, start it all, anime models
#   bash scripts/local-ai/install.sh --data /mnt/big      # this disk instead
#   bash scripts/local-ai/install.sh --models all --yes   # every picture model, no questions
#   bash scripts/local-ai/install.sh --dashboard https://touchsphere.local --name "Office PC"
#       # …and register this machine under Settings → Devices, already chosen
#       # for everything it started
#
# What it does, in order, each step skipped when already done so it can be
# re-run after anything (a new disk, a new GPU, one more model):
#
#   1. Picks the data root: the mounted filesystem with the most free space
#      that isn't / (or --data). Multi-gigabyte weights have no business on a
#      system disk, and "the big drive" is the one everybody means.
#   2. Writes .env.ai next to the compose files — the data root and the
#      profile (gpu when nvidia-smi AND the NVIDIA container runtime are
#      there, cpu otherwise) — which is all docker-compose.voice.yml needs.
#   3. Starts the stack: Ollama, Kokoro, Whisper, RVC and (GPU only — see the
#      compose file for why there is no CPU ComfyUI) ComfyUI, all bound to
#      that disk, under their own compose project so the dashboard's own
#      containers on this box are untouched.
#   4. Pulls the language models into Ollama, downloads the picture models
#      into ComfyUI's folders, installs the two ComfyUI node packs the
#      dashboard uses (segment-anything for "just a part", controlnet_aux for
#      the body/pose hold), and warms Whisper so its weights are on disk before
#      anyone speaks.
#   5. Tells the dashboard (--dashboard) that this machine exists, so it shows
#      up under Settings → Devices with every service it runs already chosen.
#
# Needs: Linux, Docker with the compose plugin, curl, python3. For the GPU:
# an NVIDIA card with its driver, plus the NVIDIA container toolkit (offered
# with --install-nvidia-toolkit on Debian/Ubuntu when it is missing).
# Downloads are resumable: a file already on disk is kept, a partial one is
# continued.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
COMPOSE_FILE="$REPO/docker-compose.voice.yml"
ENV_AI="$REPO/.env.ai"
PROJECT="touchsphere-ai"

# ── Arguments ─────────────────────────────────────────────────────────────────
DATA=""
MODELS="anime"
YES=0
DASHBOARD=""
DEVICE_NAME=""
ADDRESS=""
LLM_MODEL=""
VISION_MODEL=""
WHISPER_MODEL=""
MIKU_URL=""
MIKU_INDEX_URL=""
INSTALL_TOOLKIT=0
FORCE_PROFILE=""
SKIP_MODELS=0

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --data DIR             where the models and caches go (default: the largest non-system disk)
  --models SET[,SET…]    picture models to download: anime (default), edit, flux, all, none
  --llm MODEL            Ollama chat model (default: OLLAMA_MODEL from .env, else qwen3:8b)
  --vision MODEL         Ollama vision model for the picture tools (default: OLLAMA_VISION_MODEL, else gemma4)
  --whisper-model ID     Whisper model to warm (default: WHISPER_MODEL from .env, else Systran/faster-whisper-small)
  --miku-url URL         an RVC .pth for Miku's voice, downloaded into rvc-models/miku/ (--miku-index-url for its .index)
  --profile gpu|cpu      force the compose profile instead of detecting the GPU
  --install-nvidia-toolkit   on Debian/Ubuntu, install the NVIDIA container toolkit if it is missing (needs sudo)
  --skip-models          start the services and register the device, download nothing
  --dashboard URL        register this machine with a running dashboard (Settings → Devices)
  --name NAME            the device's name there (default: this hostname)
  --address HOST         how the dashboard reaches this machine (default: detected — see the end of the run)
  --yes                  no confirmation before the big downloads
  -h, --help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --data)            DATA="$2"; shift 2 ;;
    --models)          MODELS="$2"; shift 2 ;;
    --llm)             LLM_MODEL="$2"; shift 2 ;;
    --vision)          VISION_MODEL="$2"; shift 2 ;;
    --whisper-model)   WHISPER_MODEL="$2"; shift 2 ;;
    --miku-url)        MIKU_URL="$2"; shift 2 ;;
    --miku-index-url)  MIKU_INDEX_URL="$2"; shift 2 ;;
    --profile)         FORCE_PROFILE="$2"; shift 2 ;;
    --install-nvidia-toolkit) INSTALL_TOOLKIT=1; shift ;;
    --skip-models)     SKIP_MODELS=1; shift ;;
    --dashboard)       DASHBOARD="${2%/}"; shift 2 ;;
    --name)            DEVICE_NAME="$2"; shift 2 ;;
    --address)         ADDRESS="$2"; shift 2 ;;
    --yes|-y)          YES=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

# ── Output helpers (the check-local-ai.sh palette) ────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
say()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()   { red "$*" >&2; exit 1; }

envval() { # envval NAME — from the dashboard's .env if there is one here
  [ -f "$REPO/.env" ] || return 0
  grep -E "^$1=" "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'\r "
}

# ── 0. Prerequisites ─────────────────────────────────────────────────────────
say "Checking this machine"
[ "$(uname -s)" = Linux ] || die "This installer is for Linux (Docker with NVIDIA passthrough); on other systems run docker-compose.voice.yml by hand."
for tool in docker curl python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed."
done
docker info >/dev/null 2>&1 || die "Docker is installed but this user cannot talk to it — start the daemon, or add yourself to the docker group (sudo usermod -aG docker \$USER, then log in again)."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing (apt install docker-compose-plugin)."
green "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') with compose $(docker compose version --short 2>/dev/null || echo '?')"

# ── 1. The disk ──────────────────────────────────────────────────────────────
# The largest free space among mounted filesystems that are not the system
# disk and not the pseudo-filesystems. `df --output` is GNU coreutils, which
# every Linux this can run on has.
pick_data_root() {
  df -P -B1 --output=target,avail,fstype 2>/dev/null | awk 'NR > 1' | while read -r target avail fstype; do
    case "$fstype" in
      # Under WSL the Windows drives are 9p (WSL2) / drvfs (WSL1) mounts at
      # /mnt/<letter> — those are kept: "the D: drive" is exactly what is meant.
      tmpfs|devtmpfs|overlay|squashfs|efivarfs|proc|sysfs|cgroup*|autofs|fuse.*|nsfs|ramfs|iso9660|vfat|debugfs|tracefs|mqueue|hugetlbfs|configfs|securityfs|pstore|bpf|binfmt_misc|rpc_pipefs) continue ;;
    esac
    case "$target" in
      /|/boot|/boot/*|/efi|/snap/*|/var/lib/docker|/var/lib/docker/*|/var/snap/*|/run|/run/*|/dev|/dev/*|/sys|/sys/*|/proc|/proc/*|/tmp|/var/tmp|/mnt/c|/mnt/wsl|/mnt/wsl/*|/mnt/wslg|/mnt/wslg/*|/usr/lib/wsl/*|/init) continue ;;
    esac
    echo "$avail $target"
  done | sort -rn | head -1
}

say "Where the models go"
if [ -z "$DATA" ] && [ -f "$ENV_AI" ]; then
  # A re-run keeps the disk it chose last time; a new disk is an explicit --data.
  DATA=$(grep -E '^TS_AI_DATA=' "$ENV_AI" | cut -d= -f2- || true)
  [ -n "$DATA" ] && dim "keeping the data root from .env.ai"
fi
if [ -z "$DATA" ]; then
  pick=$(pick_data_root || true)
  if [ -z "$pick" ]; then
    red "No mounted disk other than the system one was found."
    echo "Block devices on this machine:"
    lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT 2>/dev/null | sed 's/^/   /'
    die "Mount the big drive (it must be formatted and mounted — e.g. at /mnt/ai) and re-run, or pass --data DIR to use a directory anyway."
  fi
  avail=${pick%% *}; mount=${pick#* }
  DATA="$mount/touchsphere-ai"
  green "picked $mount — $(numfmt --to=iec-i --suffix=B "$avail" 2>/dev/null || echo "$avail bytes") free, the largest disk that isn't the system one"
else
  DATA="${DATA%/}"
  case "$DATA" in /*) ;; *) DATA="$PWD/$DATA" ;; esac
  # A bare mount point gets its own folder; a named directory is used as-is.
  if mountpoint -q "$DATA" 2>/dev/null; then DATA="$DATA/touchsphere-ai"; fi
  green "using $DATA"
fi
mkdir -p "$DATA" || die "cannot create $DATA — is the drive mounted read-only, or owned by root? (sudo mkdir -p $DATA && sudo chown $USER $DATA)"
[ -w "$DATA" ] || die "$DATA is not writable by $USER (sudo chown $USER $DATA)."
for d in ollama comfy/models/checkpoints comfy/models/diffusion_models comfy/models/text_encoders comfy/models/vae \
         comfy/models/loras comfy/models/controlnet comfy/models/model_patches comfy/models/upscale_models \
         comfy/models/grounding-dino comfy/models/sams comfy/output comfy/input whisper-models rvc-models/miku; do
  mkdir -p "$DATA/$d"
done
dim "layout: $DATA/{ollama, comfy/models, comfy/output, comfy/input, whisper-models, rvc-models}"

# ── 2. GPU or not ────────────────────────────────────────────────────────────
say "GPU"
PROFILE=cpu
GPU_NAME=""
if [ -n "$FORCE_PROFILE" ]; then
  PROFILE="$FORCE_PROFILE"
  warn "profile forced to $PROFILE"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)
  green "NVIDIA: $GPU_NAME"
  # The real test — a container asked for the GPU — rather than grepping
  # `docker info`, which Docker Desktop on WSL2 never annotates with nvidia.
  if docker run --rm --gpus all alpine:3 true >/dev/null 2>&1; then
    PROFILE=gpu
    green "Docker can hand containers the GPU"
  else
    warn "Docker cannot see the GPU: the NVIDIA container toolkit is not installed (or not registered)."
    if [ "$INSTALL_TOOLKIT" = 1 ] && command -v apt-get >/dev/null 2>&1; then
      say "Installing the NVIDIA container toolkit (sudo)"
      # The steps from NVIDIA's own install page, verbatim in spirit.
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
      curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
      sudo apt-get update -qq
      sudo apt-get install -y -qq nvidia-container-toolkit
      sudo nvidia-ctk runtime configure --runtime=docker
      sudo systemctl restart docker
      if docker run --rm --gpus all alpine:3 true >/dev/null 2>&1; then PROFILE=gpu; green "toolkit installed — Docker sees the GPU now"; else warn "toolkit installed but a container still cannot get the GPU; continuing on CPU"; fi
    else
      echo "   Install it and re-run to use the card (this run continues on CPU, without ComfyUI):"
      echo "     bash $0 --install-nvidia-toolkit ${DATA:+--data \"$DATA\"}"
      echo "   or by hand: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
    fi
  fi
else
  warn "No NVIDIA GPU found. The voices and the language model run on the CPU; ComfyUI is not started"
  warn "(SDXL on a CPU is minutes per picture — a hang, not a slow fallback — so the dashboard"
  warn "keeps drawing on whichever other device has a card, or not at all)."
fi
if [ "$PROFILE" = cpu ] && [ "$MODELS" != none ] && [ "$SKIP_MODELS" = 0 ]; then
  dim "picture models are skipped on the CPU profile — there is no ComfyUI to load them (pass --profile gpu to insist)"
  MODELS=none
fi

# ── 3. .env.ai and the stack ─────────────────────────────────────────────────
say "Writing $ENV_AI"
{
  echo "# Written by scripts/local-ai/install.sh — the AI stack on this machine."
  echo "# docker-compose.voice.yml reads these; scripts/local-ai/ai-stack.sh is the"
  echo "# day-to-day wrapper (up / down / status / logs / pull)."
  echo "TS_AI_DATA=$DATA"
  echo "COMFY_MODELS_DIR=$DATA/comfy/models"
  echo "TS_AI_PROFILE=$PROFILE"
} > "$ENV_AI"
cat "$ENV_AI" | sed 's/^/   /'

compose() { docker compose -p "$PROJECT" --env-file "$ENV_AI" -f "$COMPOSE_FILE" --profile "$PROFILE" "$@"; }

say "Starting the stack ($PROFILE profile) — first time builds the RVC image, which takes a while"
compose up -d --build --remove-orphans
compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | sed 's/^/   /' || compose ps | sed 's/^/   /'

wait_for() { # wait_for <label> <url> <seconds>
  local label="$1" url="$2" budget="$3" t=0
  printf '   %-10s ' "$label"
  while [ "$t" -lt "$budget" ]; do
    if curl -sf --max-time 4 -o /dev/null "$url"; then green "up"; return 0; fi
    sleep 3; t=$((t + 3))
  done
  warn "not answering after ${budget}s ($url) — check: $HERE/ai-stack.sh logs"
  return 1
}

say "Waiting for the services"
STARTED=()
wait_for ollama  http://localhost:11434/api/tags 120 && STARTED+=(chat)
wait_for kokoro  http://localhost:8880/v1/audio/voices 180 && STARTED+=(tts)
wait_for whisper http://localhost:8000/health 180 && STARTED+=(stt)
if curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://localhost:5050/ 2>/dev/null | grep -qE '^[1-4]'; then
  green "   rvc        up"; STARTED+=(rvc)
else
  printf '   %-10s ' rvc; warn "not answering yet (the image is large; it comes up on its own)"
  STARTED+=(rvc)
fi
if [ "$PROFILE" = gpu ]; then
  wait_for comfyui http://localhost:8188/system_stats 300 && STARTED+=(image)
fi

# ── 4. Models ────────────────────────────────────────────────────────────────
LLM_MODEL="${LLM_MODEL:-$(envval OLLAMA_MODEL)}";            LLM_MODEL="${LLM_MODEL:-qwen3:8b}"
VISION_MODEL="${VISION_MODEL:-$(envval OLLAMA_VISION_MODEL)}"; VISION_MODEL="${VISION_MODEL:-gemma4}"
WHISPER_MODEL="${WHISPER_MODEL:-$(envval WHISPER_MODEL)}";    WHISPER_MODEL="${WHISPER_MODEL:-Systran/faster-whisper-small}"

if [ "$SKIP_MODELS" = 0 ]; then
  say "Language models → Ollama ($DATA/ollama)"
  for m in "$LLM_MODEL" "$VISION_MODEL"; do
    if docker exec touchsphere-ollama ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$m"; then
      echo "   have $m"
    else
      echo "   pulling $m…"
      docker exec touchsphere-ollama ollama pull "$m" || warn "   could not pull $m — pull it later: docker exec touchsphere-ollama ollama pull $m"
    fi
  done

  # ── Picture models ──
  # Each line: <path under comfy/models>|<url>|<approx GB>. The sources are the
  # ones the dashboard documents for each style (.env.example, server/src/image.ts):
  # ungated Hugging Face repos, since a kiosk cannot log in to accept a licence.
  ANIME_FILES=(
    "diffusion_models/anima-base-v1.0.safetensors|https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-base-v1.0.safetensors|3.9"
    "diffusion_models/anima-aesthetic-v1.1.safetensors|https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors|3.9"
    "diffusion_models/anima-turbo-v1.1.safetensors|https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-turbo-v1.1.safetensors|3.9"
    "text_encoders/qwen_3_06b_base.safetensors|https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors|1.2"
    "vae/qwen_image_vae.safetensors|https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors|0.3"
    "model_patches/anima-lllite-inpainting-v2.safetensors|https://huggingface.co/Comfy-Org/Anima-LLLite/resolve/main/model_patches/anima-lllite-inpainting-v2.safetensors|0.1"
    "checkpoints/animagine-xl-4.0.safetensors|https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/main/animagine-xl-4.0.safetensors|6.9"
    "checkpoints/NoobAI-XL-v1.1.safetensors|https://huggingface.co/Laxhar/noobai-XL-1.1/resolve/main/NoobAI-XL-v1.1.safetensors|6.9"
    "controlnet/controlnet-union-sdxl-1.0-promax.safetensors|https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors|2.5"
    "upscale_models/4x-UltraSharpV2.safetensors|https://huggingface.co/Kim2091/UltraSharpV2/resolve/main/4x-UltraSharpV2.safetensors|0.1"
  )
  EDIT_FILES=(
    "diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors|https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors|11.9"
    "text_encoders/clip_l.safetensors|https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors|0.25"
    "text_encoders/t5xxl_fp8_e4m3fn.safetensors|https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors|4.9"
    "vae/ae.safetensors|https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors|0.35"
    "diffusion_models/qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors|https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors|20.4"
    "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors|https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors|9.4"
    "vae/qwen_image_vae.safetensors|https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors|0.3"
  )
  FLUX_FILES=(
    "diffusion_models/flux1-dev.safetensors|https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev.safetensors|23.8"
    "text_encoders/clip_l.safetensors|https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors|0.25"
    "text_encoders/t5xxl_fp8_e4m3fn.safetensors|https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors|4.9"
    "vae/ae.safetensors|https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors|0.35"
  )

  WANT=()
  for set in ${MODELS//,/ }; do
    case "$set" in
      anime) WANT+=("${ANIME_FILES[@]}") ;;
      edit)  WANT+=("${EDIT_FILES[@]}") ;;
      flux)  WANT+=("${FLUX_FILES[@]}") ;;
      all)   WANT+=("${ANIME_FILES[@]}" "${EDIT_FILES[@]}" "${FLUX_FILES[@]}") ;;
      none)  ;;
      *) die "unknown model set '$set' (anime, edit, flux, all, none)" ;;
    esac
  done

  if [ ${#WANT[@]} -gt 0 ]; then
    say "Picture models → $DATA/comfy/models"
    total=0; todo=()
    seen=""
    for entry in "${WANT[@]}"; do
      rel=${entry%%|*}; rest=${entry#*|}; url=${rest%%|*}; gb=${rest#*|}
      case " $seen " in *" $rel "*) continue ;; esac
      seen="$seen $rel"
      if [ -s "$DATA/comfy/models/$rel" ]; then
        echo "   have $rel"
      else
        todo+=("$rel|$url"); total=$(python3 -c "print(round($total + $gb, 1))")
        echo "   need $rel (~${gb} GB)"
      fi
    done
    if [ ${#todo[@]} -gt 0 ]; then
      free_gb=$(df -P -BG "$DATA" | awk 'NR==2 {gsub("G","",$4); print $4}')
      echo "   about ${total} GB to download; ${free_gb} GB free on the disk"
      if python3 -c "import sys; sys.exit(0 if $total > $free_gb - 5 else 1)"; then
        die "not enough room — pick a smaller --models set, or another --data disk"
      fi
      if [ "$YES" != 1 ]; then
        if [ -t 0 ]; then
          read -r -p "   Download now? [Y/n] " ans
          case "$ans" in n|N|no|NO) warn "skipped — re-run with --models when ready"; todo=() ;; esac
        else
          dim "no terminal to ask on; downloading (pass --yes to say so)"
        fi
      fi
      for item in "${todo[@]}"; do
        rel=${item%%|*}; url=${item#*|}
        dest="$DATA/comfy/models/$rel"
        echo "   downloading $rel…"
        # Resumable, with retries; the .part is renamed only when complete, so a
        # cut download can never be mistaken for a model by ComfyUI.
        if curl -fL --retry 5 --retry-delay 5 -C - -o "$dest.part" "$url"; then
          mv "$dest.part" "$dest"
        else
          warn "   failed: $url — re-run to resume; the rest continue"
        fi
      done
    fi
  fi

  # ── ComfyUI node packs ──
  if [ "$PROFILE" = gpu ] && docker ps --format '{{.Names}}' | grep -qx touchsphere-comfyui; then
    say "ComfyUI node packs"
    # "Just a part" — GroundingDINO + Segment Anything, with the transformers-5
    # patch. The existing script does the whole thing and is idempotent.
    MODELS_DIR="$DATA/comfy/models" COMFY_CONTAINER=touchsphere-comfyui bash "$REPO/scripts/comfy/install-segment-anything.sh" \
      || warn "segment-anything install failed — 'Just a part' will use the plain mask until scripts/comfy/install-segment-anything.sh succeeds"
    # The body/pose hold ("Keep the pose" → body or pose) needs the
    # controlnet_aux preprocessors; their own weights download on first use.
    echo "   comfyui_controlnet_aux (body / pose hold)…"
    docker exec touchsphere-comfyui sh -c '
      set -e
      d=/root/ComfyUI/custom_nodes/comfyui_controlnet_aux
      if [ ! -d "$d/.git" ]; then git clone --depth 1 https://github.com/Fannovel16/comfyui_controlnet_aux "$d"; else echo "   already cloned"; fi
      cd "$d" && python3 -m pip install -q --root-user-action=ignore -r requirements.txt
    ' || warn "   controlnet_aux install failed — the hold falls back to lines (Canny) until it is installed"
    echo "   restarting ComfyUI so the packs load"
    docker restart touchsphere-comfyui >/dev/null
    wait_for comfyui http://localhost:8188/system_stats 300 || true
  fi

  # ── Whisper ──
  say "Whisper — downloading and loading $WHISPER_MODEL (once; kept in $DATA/whisper-models)"
  SILENT="$(mktemp -t ts-silence-XXXXXX.wav)"
  python3 - "$SILENT" <<'EOF'
import struct, sys
rate, seconds = 16000, 1
data = b"\0\0" * rate * seconds
hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
open(sys.argv[1], "wb").write(hdr + data)
EOF
  if curl -sf --max-time 900 -o /dev/null -F "file=@$SILENT;type=audio/wav" -F "model=$WHISPER_MODEL" -F "response_format=json" \
       http://localhost:8000/v1/audio/transcriptions; then
    green "   $WHISPER_MODEL is on disk and answering"
  else
    warn "   Whisper did not answer the warm-up — the dashboard's own boot warm-up will retry it"
  fi
  rm -f "$SILENT"

  # ── Miku ──
  if [ -n "$MIKU_URL" ]; then
    say "Miku's voice model → $DATA/rvc-models/miku"
    curl -fL --retry 3 -C - -o "$DATA/rvc-models/miku/miku.pth.part" "$MIKU_URL" && mv "$DATA/rvc-models/miku/miku.pth.part" "$DATA/rvc-models/miku/miku.pth"
    [ -n "$MIKU_INDEX_URL" ] && curl -fL --retry 3 -C - -o "$DATA/rvc-models/miku/miku.index.part" "$MIKU_INDEX_URL" && mv "$DATA/rvc-models/miku/miku.index.part" "$DATA/rvc-models/miku/miku.index"
  elif ! ls "$DATA/rvc-models/miku"/*.pth >/dev/null 2>&1; then
    say "Miku's voice"
    warn "   no RVC model in $DATA/rvc-models/miku/ — put a Miku .pth (and its .index) there, or re-run with"
    warn "   --miku-url <url>. Until then Miku speaks with a plain Kokoro voice; everyone else is unaffected."
  fi
fi

# ── 5. Tell the dashboard ────────────────────────────────────────────────────
# How the dashboard's container reaches this box. On the same machine that is
# host.docker.internal (docker-compose.yml maps it to the host gateway); across
# the LAN it is this box's address; on a tailnet the tailscale IP is the one
# that survives a change of Wi-Fi.
detect_address() {
  if [ -n "$ADDRESS" ]; then echo "$ADDRESS"; return; fi
  local dhost=""
  if [ -n "$DASHBOARD" ]; then dhost=$(printf '%s' "$DASHBOARD" | sed -E 's#^[a-z]+://##; s#[:/].*$##'); fi
  case "$dhost" in
    localhost|127.0.0.1|::1|"$(hostname)"|"$(hostname -s 2>/dev/null)") echo host.docker.internal; return ;;
  esac
  if command -v tailscale >/dev/null 2>&1; then
    local ts; ts=$(tailscale ip -4 2>/dev/null | head -1 || true)
    if [ -n "$ts" ]; then
      case "$dhost" in *.ts.net|100.*) echo "$ts"; return ;; esac
    fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}
ADDR=$(detect_address)
DEVICE_NAME="${DEVICE_NAME:-$(hostname)}"
if grep -qi microsoft /proc/version 2>/dev/null && [ -z "$ADDRESS" ] && [ "$ADDR" != host.docker.internal ]; then
  warn "This is WSL: $ADDR is the WSL VM's address, not Windows'. Docker Desktop publishes the ports on the"
  warn "Windows side, so from another machine use the PC's own LAN or Tailscale address (re-run with --address)."
fi

say "Done — this machine runs: ${STARTED[*]:-nothing yet}"
if [ "$PROFILE" = gpu ]; then dim "with $GPU_NAME"; fi
echo
echo "   Ollama    http://$ADDR:11434   ($LLM_MODEL, $VISION_MODEL)"
echo "   Kokoro    http://$ADDR:8880"
echo "   Whisper   http://$ADDR:8000    ($WHISPER_MODEL)"
echo "   RVC       http://$ADDR:5050"
[ "$PROFILE" = gpu ] && echo "   ComfyUI   http://$ADDR:8188"
echo
echo "   Day to day:  $HERE/ai-stack.sh up | down | status | logs [service] | pull <ollama model>"

if [ -n "$DASHBOARD" ]; then
  say "Registering with the dashboard at $DASHBOARD as \"$DEVICE_NAME\" ($ADDR)"
  assign=$(printf '"%s",' "${STARTED[@]}"); assign="[${assign%,}]"
  body=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "host": sys.argv[2], "assign": json.loads(sys.argv[3])}))' "$DEVICE_NAME" "$ADDR" "$assign")
  # -k: the dashboard's Caddy uses its own CA. The payload has nothing secret.
  if out=$(curl -sk --max-time 20 -H 'content-type: application/json' -d "$body" "$DASHBOARD/api/ai-devices" 2>&1) \
     && printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if "device" in d else 1)' 2>/dev/null; then
    green "registered — Settings → Devices now lists \"$DEVICE_NAME\", chosen for: ${STARTED[*]}"
    printf '%s' "$out" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for s in d.get("services", []):
    print("   %-28s %s  (%s%s)" % (s["label"], s["url"] or "off", s["source"], (" " + s["device"]["name"]) if s.get("device") else ""))'
  else
    warn "could not register: ${out:-no answer} — add it by hand under Settings → Devices (name \"$DEVICE_NAME\", address $ADDR)"
  fi
else
  echo
  echo "   To use it from the dashboard: Settings → Devices → Add a device, name \"$DEVICE_NAME\", address $ADDR"
  echo "   (or re-run with --dashboard https://<dashboard> to have it added and chosen automatically)."
  echo "   The .env route still works too: OLLAMA_URL=http://$ADDR:11434 KOKORO_URL=http://$ADDR:8880"
  echo "   WHISPER_URL=http://$ADDR:8000 RVC_URL=http://$ADDR:5050${GPU_NAME:+ COMFYUI_URL=http://$ADDR:8188}"
fi
