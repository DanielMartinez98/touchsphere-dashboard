#!/usr/bin/env bash
# One-time setup of the touchsphere-ai WSL distro: systemd, Docker Engine and
# the NVIDIA container toolkit, so docker-compose.voice.yml --profile gpu runs
# here exactly as it does on loklo-pc.
#   wsl -d touchsphere-ai -u root -- bash /mnt/e/ai/scripts/wsl-setup.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

nvidia-smi -L || { echo "GPU not visible inside WSL"; exit 1; }

# systemd, so dockerd starts with the distro and containers come back on their own.
if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '[boot]\nsystemd=true\n\n[user]\ndefault=root\n' > /etc/wsl.conf
fi

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git dbus-x11

# Docker Engine from Docker's own apt repo.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

# NVIDIA container toolkit.
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nvidia-container-toolkit

nvidia-ctk runtime configure --runtime=docker
echo "setup done"
