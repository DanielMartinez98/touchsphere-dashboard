#!/usr/bin/env bash
# Install the TouchSphere AI power agent on a Linux GPU box (loklo-pc) as a
# systemd service, so the dashboard's Settings → AI box card gets an On/Off
# switch for it. Run from the repo checkout that runs docker-compose.voice.yml:
#
#   sudo bash scripts/gpu-box/install-agent-linux.sh
#
# The service runs as root because on/off is `docker compose up -d` / `stop`
# and `systemctl start/stop ollama`. It listens on 127.0.0.1:8190; put it on
# the tailnet afterwards with
#   tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190
# (or write "bind": "<this box's tailnet IP>" in agent.json beside agent.js).
#
# The dashboard has ONE token for every agent (AI_BOX_AGENT_TOKEN), so a box
# joining one that already has an agent must use the same token.txt — copy it
# here first and this script keeps it. With none, a new one is written.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is not installed (apt install nodejs, or nodesource)" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }

if [ ! -s "$DIR/token.txt" ]; then
  "$NODE" -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" > "$DIR/token.txt"
  echo "wrote a new token to $DIR/token.txt"
fi
chmod 600 "$DIR/token.txt"

cat > /etc/systemd/system/touchsphere-ai-agent.service <<UNIT
[Unit]
Description=TouchSphere AI power agent
Wants=network-online.target
After=network-online.target docker.service

[Service]
ExecStart=$NODE $DIR/agent.js
WorkingDirectory=$DIR
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now touchsphere-ai-agent.service
sleep 2
systemctl --no-pager --lines=3 status touchsphere-ai-agent.service || true

cat <<MSG

Agent installed. Next:
  1. tailscale serve --bg --tcp=8190 tcp://127.0.0.1:8190
  2. On the dashboard's host, in .env, add this box to AI_BOX_AGENTS, e.g.
       AI_BOX_AGENTS=loklo-pc=http://<this box's tailnet IP>:8190, lokloComputer=http://100.112.40.40:8190
     and make sure AI_BOX_AGENT_TOKEN is the token in $DIR/token.txt
     (the same one on every box), then docker compose up -d app.
The agent's log is $DIR/agent.log.
MSG
