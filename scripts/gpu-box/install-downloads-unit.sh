#!/usr/bin/env bash
# Make the ComfyUI model download a boot-time unit of the touchsphere-ai distro:
# every time the AI is switched on it resumes where it stopped, and once every
# file is there it finishes in a second.
set -euo pipefail
tr -d '\r' < /mnt/e/ai/scripts/comfy-models.sh > /usr/local/bin/comfy-models.sh
chmod +x /usr/local/bin/comfy-models.sh
cat > /etc/systemd/system/comfy-models.service <<'UNIT'
[Unit]
Description=Download TouchSphere ComfyUI models (resumable)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=simple
ExecStart=/bin/bash -c '/usr/local/bin/comfy-models.sh > /mnt/e/ai/scripts/comfy-models.log 2>&1'
Restart=on-failure
RestartSec=60
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable comfy-models.service
ls -la /srv/touchsphere/rvc-models/ /srv/touchsphere/comfy/models/checkpoints/ /srv/touchsphere/comfy/incoming/* 2>&1 | head -30
