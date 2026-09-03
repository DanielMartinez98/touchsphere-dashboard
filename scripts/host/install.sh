#!/usr/bin/env bash
# Set up Settings → Server on the machine the dashboard runs on.
#
#   sudo bash scripts/host/install.sh 'ssh-ed25519 AAAA… touchsphere-host'
#
# The public key is shown in Settings → Server the first time the tab is
# opened (the container generates it on its own volume; nothing to copy off
# the box). Run this as the user who owns the docker stacks — it installs:
#
#   /usr/local/bin/touchsphere-host   the only command that key can run
#   /etc/touchsphere-host.conf        where the dashboard and compose files are
#   /etc/sudoers.d/touchsphere-host   that user may run exactly its verbs as root
#   ~/.ssh/authorized_keys            the key, restricted to that command
#
# Then set HOST_UPDATE_SSH=<this user>@<the docker bridge gateway> in the
# dashboard's .env (172.18.0.1 on a default install — the installer prints
# the line) and `docker compose up -d app`. Safe to re-run: it replaces its
# own lines and nothing else.

set -euo pipefail

KEY="${1:-}"
if [[ -z "$KEY" || "$KEY" != ssh-* ]]; then
  echo "usage: sudo bash $0 '<the public key shown in Settings → Server>'" >&2
  exit 64
fi
if [[ $EUID -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 77
fi

USER_NAME="${SUDO_USER:-}"
if [[ -z "$USER_NAME" || "$USER_NAME" == root ]]; then
  echo "run as the user who owns the docker stacks, via sudo (not as root directly)" >&2
  exit 78
fi
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DASH=$(cd "$HERE/../.." && pwd)

# 1. The command itself. Root-owned so the sudoers rule below can't be turned
#    into "run anything as root" by editing the file it points at.
install -o root -g root -m 0755 "$HERE/touchsphere-host" /usr/local/bin/touchsphere-host
echo "installed /usr/local/bin/touchsphere-host"

# 2. What it should update. Every compose file behind a running container,
#    except the dashboard's own — that one is rebuilt by self-update, detached,
#    because a container can't watch itself being replaced.
COMPOSE=$(docker ps --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null \
  | tr ',' '\n' | grep -v '^$' | grep -v "^$DASH/" | sort -u | tr '\n' ' ' | sed 's/ $//' || true)
cat > /etc/touchsphere-host.conf <<EOF
# Written by scripts/host/install.sh — edit freely, re-running the installer rewrites it.
DASHBOARD_DIR=$DASH
DASHBOARD_USER=$USER_NAME
COMPOSE_FILES="$COMPOSE"
EOF
chmod 0644 /etc/touchsphere-host.conf
echo "wrote /etc/touchsphere-host.conf (compose files: ${COMPOSE:-none found})"

# 3. sudo for exactly these verbs — the list is the script's, not a wildcard.
VERBS=$(grep -m1 '^VERBS=' "$HERE/touchsphere-host" | cut -d'"' -f2)
RULE=""
for v in $VERBS; do RULE+="/usr/local/bin/touchsphere-host $v, "; done
RULE=${RULE%, }
printf '%s ALL=(root) NOPASSWD: %s\n' "$USER_NAME" "$RULE" > /etc/sudoers.d/touchsphere-host
chmod 0440 /etc/sudoers.d/touchsphere-host
visudo -cf /etc/sudoers.d/touchsphere-host >/dev/null
echo "wrote /etc/sudoers.d/touchsphere-host"

# 4. The key, pinned to the command. `restrict` turns off forwarding, pty and
#    everything else a shell would want; the command is all that runs.
mkdir -p "$HOME_DIR/.ssh"
AK="$HOME_DIR/.ssh/authorized_keys"
touch "$AK"
TMP=$(mktemp)
grep -v 'touchsphere-host' "$AK" > "$TMP" || true
printf 'restrict,command="/usr/local/bin/touchsphere-host" %s\n' "$KEY" >> "$TMP"
cat "$TMP" > "$AK"
rm -f "$TMP"
chmod 700 "$HOME_DIR/.ssh"
chmod 600 "$AK"
chown -R "$USER_NAME" "$HOME_DIR/.ssh"
echo "added the key to $AK"

GW=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)
# The app's own compose network is the one that matters, if it exists.
NET=$(docker inspect touchsphere --format '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Gateway}}{{end}}' 2>/dev/null || true)
[[ -n "$NET" ]] && GW="$NET"

cat <<EOF

Done. Now put this in $DASH/.env and run 'docker compose up -d app' there:

  HOST_UPDATE_SSH=$USER_NAME@$GW

EOF
