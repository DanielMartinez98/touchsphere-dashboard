# Sign-in auto-fix for loklo_pc: Docker Desktop can restart touchsphere-comfyui
# before the D:\touchsphere\comfy\models bind mount is visible, and ComfyUI then
# starts with an empty model list. Waits for the engine, then restarts ComfyUI
# (and re-checks) whenever the container sees no checkpoints while D: has them.
$log = 'C:\ai\agent\comfy-mount-check.log'
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }
$host_dir = 'D:\touchsphere\comfy\models\checkpoints'
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 10
}
for ($i = 1; $i -le 5; $i++) {
  $running = docker inspect -f '{{.State.Running}}' touchsphere-comfyui 2>$null
  if ($running -ne 'true') { Log "comfyui not running (attempt $i)"; Start-Sleep 20; continue }
  $inside = docker exec touchsphere-comfyui sh -c 'ls /root/ComfyUI/models/checkpoints 2>/dev/null | grep -c safetensors'
  $onDisk = @(Get-ChildItem $host_dir -Filter *.safetensors -ErrorAction SilentlyContinue).Count
  if ([int]$inside -gt 0 -or $onDisk -eq 0) { Log "ok: container sees $inside checkpoint(s), disk has $onDisk"; exit 0 }
  Log "container sees no checkpoints but disk has $onDisk; restarting comfyui (attempt $i)"
  docker restart touchsphere-comfyui *> $null
  Start-Sleep 30
}
Log 'gave up after 5 attempts'
exit 1
