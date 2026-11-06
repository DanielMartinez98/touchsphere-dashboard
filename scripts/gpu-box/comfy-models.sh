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

# folder | file name ComfyUI sees | source (repo/path on Hugging Face, or a full https URL)
LIST=$(cat <<'EOF'
text_encoders|qwen_3_06b_base.safetensors|circlestone-labs/Anima/split_files/text_encoders/qwen_3_06b_base.safetensors
vae|qwen_image_vae.safetensors|circlestone-labs/Anima/split_files/vae/qwen_image_vae.safetensors
diffusion_models|anima-aesthetic-v1.1.safetensors|circlestone-labs/Anima/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors
diffusion_models|anima-turbo-v1.1.safetensors|circlestone-labs/Anima/split_files/diffusion_models/anima-turbo-v1.1.safetensors
model_patches|anima-lllite-inpainting-v2.safetensors|Comfy-Org/Anima-LLLite/model_patches/anima-lllite-inpainting-v2.safetensors
upscale_models|4x-UltraSharpV2.safetensors|Kim2091/UltraSharpV2/4x-UltraSharpV2.safetensors
controlnet|controlnet-union-sdxl-1.0-promax.safetensors|xinsir/controlnet-union-sdxl-1.0/diffusion_pytorch_model_promax.safetensors
diffusion_models|flux3-image-klein-int8-convrot.safetensors|black-forest-labs/flux-3-image-klein-comfy/diffusion_models/flux3-image-klein-int8-convrot.safetensors
text_encoders|qwen3vl_4b_int8_convrot.safetensors|black-forest-labs/flux-3-image-klein-comfy/text_encoders/qwen3vl_4b_int8_convrot.safetensors
vae|flux2-vae.safetensors|black-forest-labs/flux-3-image-klein-comfy/vae/flux2-vae.safetensors
diffusion_models|qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors|lightx2v/Qwen-Image-Edit-2511-Lightning/qwen_image_edit_2511_fp8_e4m3fn_scaled_lightning_comfyui_4steps_v1.0.safetensors
text_encoders|qwen_2.5_vl_7b_fp8_scaled.safetensors|Comfy-Org/Qwen-Image_ComfyUI/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors
loras|fusal-qwen-image-2.1-v2-exact-r80.safetensors|MicksHF/Qwen-Image-2.1-Anime-Fusal/loras/fusal-qwen-image-2.1-v2-exact-r80.safetensors
diffusion_models|moss_image_sft_int8_convrot.safetensors|Comfy-Org/MOSS-Image/diffusion_models/moss_image_sft_int8_convrot.safetensors
text_encoders|qwen3.5_9b_w4a8_gptq.safetensors|Comfy-Org/MOSS-Image/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
vae|flux2-vae_small.safetensors|Comfy-Org/MOSS-Image/vae/flux2-vae_small.safetensors
text_encoders|umt5_xxl_fp8_e4m3fn_scaled.safetensors|Comfy-Org/Wan_2.1_ComfyUI_repackaged/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
vae|wan_2.1_vae.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files/vae/wan_2.1_vae.safetensors
diffusion_models|Wan2_2-I2V_AniSoraV3_2_HIGH_14B_fp8_e4m3fn_scaled_KJ.safetensors|Kijai/WanVideo_comfy_fp8_scaled/I2V/AniSora/Wan2_2-I2V_AniSoraV3_2_HIGH_14B_fp8_e4m3fn_scaled_KJ.safetensors
diffusion_models|Wan2_2-I2V_AniSoraV3_2_LOW_14B_fp8_e4m3fn_scaled_KJ.safetensors|Kijai/WanVideo_comfy_fp8_scaled/I2V/AniSora/Wan2_2-I2V_AniSoraV3_2_LOW_14B_fp8_e4m3fn_scaled_KJ.safetensors
checkpoints|sd_xl_base_1.0.safetensors|stabilityai/stable-diffusion-xl-base-1.0/sd_xl_base_1.0.safetensors
EOF
)

failed=0
while IFS='|' read -r folder name src; do
  [ -z "$folder" ] && continue
  dest="$MODELS/$folder/$name"
  if [ -s "$dest" ]; then echo "have  $folder/$name"; continue; fi
  case "$src" in
    https://*) url=$src; token= ;;
    *) repo=$(echo "$src" | cut -d/ -f1-2); path=$(echo "$src" | cut -d/ -f3-); url="$HF/$repo/resolve/main/$path"; token=${HF_TOKEN:-} ;;
  esac
  echo "get   $folder/$name"
  mkdir -p "$MODELS/$folder" "$STAGE/$folder"
  ok=0
  for attempt in 1 2 3 4 5; do
    # HF_TOKEN reaches the gated FLUX 3 Klein repo (accept its licence once on huggingface.co).
    if aria2c -q -c -x 8 -s 8 -k 64M --auto-file-renaming=false --allow-overwrite=true \
         ${token:+"--header=Authorization: Bearer $token"} \
         --retry-wait=10 --max-tries=5 -d "$STAGE/$folder" -o "$name" "$url"; then
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
