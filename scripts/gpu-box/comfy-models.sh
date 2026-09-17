#!/usr/bin/env bash
# The ComfyUI weights TouchSphere's drawing styles use — the same set loklo-pc
# has — downloaded into the touchsphere-ai distro's ext4 disk. Resumable: run
# it again and finished files are skipped, partial ones continue.
#   wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/comfy-models.sh
# Files land in a staging dir first and are moved in when complete, because
# ComfyUI lists a half-downloaded file as installed.
set -uo pipefail
MODELS=/srv/touchsphere/comfy/models
STAGE=/srv/touchsphere/comfy/incoming
HF=https://huggingface.co
command -v aria2c >/dev/null || apt-get install -y -q aria2 >/dev/null
mkdir -p "$STAGE"

# folder | file name ComfyUI sees | source (repo/path)
LIST=$(cat <<'EOF'
checkpoints|animagine-xl-4.0.safetensors|cagliostrolab/animagine-xl-4.0/animagine-xl-4.0.safetensors
text_encoders|qwen_3_06b_base.safetensors|circlestone-labs/Anima/split_files/text_encoders/qwen_3_06b_base.safetensors
vae|qwen_image_vae.safetensors|circlestone-labs/Anima/split_files/vae/qwen_image_vae.safetensors
diffusion_models|anima-base-v1.0.safetensors|circlestone-labs/Anima/split_files/diffusion_models/anima-base-v1.0.safetensors
diffusion_models|anima-aesthetic-v1.1.safetensors|circlestone-labs/Anima/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors
diffusion_models|anima-turbo-v1.1.safetensors|circlestone-labs/Anima/split_files/diffusion_models/anima-turbo-v1.1.safetensors
model_patches|anima-lllite-inpainting-v2.safetensors|Comfy-Org/Anima-LLLite/model_patches/anima-lllite-inpainting-v2.safetensors
upscale_models|4x-UltraSharpV2.safetensors|Kim2091/UltraSharpV2/4x-UltraSharpV2.safetensors
controlnet|controlnet-union-sdxl-1.0-promax.safetensors|xinsir/controlnet-union-sdxl-1.0/diffusion_pytorch_model_promax.safetensors
checkpoints|NoobAI-XL-v1.1.safetensors|Laxhar/noobai-XL-1.1/NoobAI-XL-v1.1.safetensors
diffusion_models|Anima-2.9B-preview-v1.safetensors|Gazingstars123/Anima-2.9B/Anima-2.9B-preview-v1.safetensors
diffusion_models|qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors|lightx2v/Qwen-Image-Edit-2511-Lightning/qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors
text_encoders|qwen_2.5_vl_7b_fp8_scaled.safetensors|Comfy-Org/Qwen-Image_ComfyUI/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors
text_encoders|clip_l.safetensors|comfyanonymous/flux_text_encoders/clip_l.safetensors
text_encoders|t5xxl_fp8_e4m3fn.safetensors|comfyanonymous/flux_text_encoders/t5xxl_fp8_e4m3fn.safetensors
vae|ae.safetensors|Comfy-Org/Lumina_Image_2.0_Repackaged/split_files/vae/ae.safetensors
diffusion_models|flux1-dev-kontext_fp8_scaled.safetensors|Comfy-Org/flux1-kontext-dev_ComfyUI/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors
diffusion_models|flux1-dev.safetensors|Comfy-Org/flux1-dev/flux1-dev.safetensors
checkpoints|NetaYumev35_pretrained_all_in_one.safetensors|duongve/NetaYume-Lumina-Image-2.0/NetaYumev35_pretrained_all_in_one.safetensors
checkpoints|sd_xl_base_1.0.safetensors|stabilityai/stable-diffusion-xl-base-1.0/sd_xl_base_1.0.safetensors
EOF
)

failed=0
while IFS='|' read -r folder name src; do
  [ -z "$folder" ] && continue
  dest="$MODELS/$folder/$name"
  if [ -s "$dest" ]; then echo "have  $folder/$name"; continue; fi
  repo=$(echo "$src" | cut -d/ -f1-2); path=$(echo "$src" | cut -d/ -f3-)
  echo "get   $folder/$name"
  mkdir -p "$MODELS/$folder" "$STAGE/$folder"
  ok=0
  for attempt in 1 2 3 4 5; do
    if aria2c -q -c -x 8 -s 8 -k 64M --auto-file-renaming=false --allow-overwrite=true \
         --retry-wait=10 --max-tries=5 -d "$STAGE/$folder" -o "$name" "$HF/$repo/resolve/main/$path"; then
      ok=1; break
    fi
    echo "      attempt $attempt failed, retrying"; sleep 15
  done
  if [ "$ok" = 1 ] && [ ! -e "$STAGE/$folder/$name.aria2" ]; then
    mv "$STAGE/$folder/$name" "$dest"
    echo "done  $folder/$name ($(du -h "$dest" | cut -f1))"
  else
    echo "FAIL  $folder/$name"; failed=1
  fi
done <<< "$LIST"

df -h /srv | tail -1
exit $failed
