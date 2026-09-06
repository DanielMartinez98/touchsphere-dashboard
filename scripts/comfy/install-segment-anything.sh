#!/usr/bin/env bash
#
# Give the ComfyUI box "find it by name": the comfyui_segment_anything node
# pack (GroundingDINO + Segment Anything), its weights, and the two-line patch
# it needs to run on the transformers 5 that the ComfyUI image ships.
#
# Run on the machine that runs ComfyUI (the GPU box), from the repo checkout:
#
#   scripts/comfy/install-segment-anything.sh                # defaults below
#   COMFY_CONTAINER=my-comfy MODELS_DIR=/srv/models scripts/comfy/install-segment-anything.sh
#
# Why a script: docker-compose.voice.yml bind-mounts ./comfy/models but NOT
# custom_nodes — those live in the container's own volume, deliberately, so
# a pack installed by hand survives `docker restart` but not a recreate or a
# volume wipe. Re-running this puts it all back. It is idempotent: weights
# already on disk are kept, the clone is skipped when present, and the patch
# is applied only if it hasn't been.
#
# The patch: the pack's local GroundingDINO wraps a HuggingFace BertModel and
# reaches for two things transformers 5 changed — `get_head_mask` no longer
# exists, and `get_extended_attention_mask` lost its `device` argument (so
# the old call lands `device` in `dtype` and torch refuses). Neither affects
# the result: a None head mask means "every head", and two arguments work on
# every transformers version. Downgrading transformers instead would touch a
# library ComfyUI itself uses, which is the worse trade.

set -euo pipefail

COMFY_CONTAINER="${COMFY_CONTAINER:-touchsphere-comfyui}"
MODELS_DIR="${MODELS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/comfy/models}"
COMFY_URL="${COMFY_URL:-http://localhost:8188}"
PACK_DIR=/root/ComfyUI/custom_nodes/comfyui_segment_anything

say() { printf '\n== %s\n' "$*"; }

fetch() { # fetch <url> <dest>
  if [ -s "$2" ]; then echo "   have $(basename "$2")"; return; fi
  echo "   downloading $(basename "$2")…"
  curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}

say "Weights → $MODELS_DIR"
mkdir -p "$MODELS_DIR/grounding-dino" "$MODELS_DIR/sams"
fetch https://huggingface.co/ShilongLiu/GroundingDINO/resolve/main/GroundingDINO_SwinT_OGC.cfg.py \
      "$MODELS_DIR/grounding-dino/GroundingDINO_SwinT_OGC.cfg.py"
fetch https://huggingface.co/ShilongLiu/GroundingDINO/resolve/main/groundingdino_swint_ogc.pth \
      "$MODELS_DIR/grounding-dino/groundingdino_swint_ogc.pth"
fetch https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth \
      "$MODELS_DIR/sams/sam_vit_b_01ec64.pth"
# bert-base-uncased is fetched by the pack itself on first use, into
# $MODELS_DIR/bert-base-uncased, so it needs the box to reach huggingface.co once.

say "Node pack in container $COMFY_CONTAINER"
docker exec "$COMFY_CONTAINER" sh -c "
  set -e
  if [ ! -d $PACK_DIR/.git ]; then
    git clone --depth 1 https://github.com/storyicon/comfyui_segment_anything $PACK_DIR
  else
    echo '   already cloned'
  fi
  cd $PACK_DIR
  python3 -m pip install -q -r requirements.txt
"

say "Patching for transformers 5"
docker exec "$COMFY_CONTAINER" python3 - <<'EOF'
import io, sys
p = "/root/ComfyUI/custom_nodes/comfyui_segment_anything/local_groundingdino/models/GroundingDINO/bertwarper.py"
s = open(p, encoding="utf-8").read()
before = s
s = s.replace(
    "        self.get_head_mask = bert_model.get_head_mask\n",
    "        # transformers 5 removed get_head_mask; a None head mask means \"keep every head\".\n"
    "        self.get_head_mask = getattr(bert_model, \"get_head_mask\", lambda head_mask, n: None)\n")
s = s.replace(
    "        extended_attention_mask: torch.Tensor = self.get_extended_attention_mask(\n"
    "            attention_mask, input_shape, device\n"
    "        )",
    "        # transformers 5 dropped the device argument (it became dtype); two\n"
    "        # arguments work on every version.\n"
    "        extended_attention_mask: torch.Tensor = self.get_extended_attention_mask(\n"
    "            attention_mask, input_shape\n"
    "        )")
s = s.replace(
    "            attention_mask=extended_attention_mask,\n"
    "            head_mask=head_mask,\n",
    "            attention_mask=extended_attention_mask,\n"
    "            **({\"head_mask\": head_mask} if head_mask is not None else {}),\n")
if s != before:
    open(p, "w", encoding="utf-8").write(s)
    print("   patched bertwarper.py")
else:
    print("   already patched")
EOF

say "Restarting $COMFY_CONTAINER"
docker restart "$COMFY_CONTAINER" >/dev/null
for i in $(seq 1 60); do
  if curl -fs -m 3 "$COMFY_URL/system_stats" >/dev/null 2>&1; then echo "   up"; break; fi
  sleep 3
done

say "Checking the node is registered"
if curl -fs -m 10 "$COMFY_URL/object_info/GroundingDinoSAMSegment%20(segment%20anything)" | grep -q GroundingDino; then
  echo "   GroundingDinoSAMSegment (segment anything) is available"
  echo "   The dashboard's Draw panel will now offer 'Find it by name' (it re-checks /api/image/models every load)."
else
  echo "   NOT registered — check: docker logs $COMFY_CONTAINER | grep -i segment" >&2
  exit 1
fi
