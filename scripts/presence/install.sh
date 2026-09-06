#!/usr/bin/env bash
# Install the desk-presence reader on the Raspberry Pi.
#
#   bash scripts/presence/install.sh https://lokloserver.taileefe4.ts.net [PRESENCE_TOKEN]
#
# Run as the DESKTOP user, NOT with sudo. Like the kiosk installer, this needs
# no root: reading the GPIO only needs membership of the `gpio` group (which
# the default Raspberry Pi OS user already has), and the reader talks to
# lgpio, which the OS ships. An installer that needed a password could not be
# re-run on a Pi where sudo prompts, and re-running is how a fix is applied.
#
# Wires nothing — the pin-out is in presence.py's header, and the ECHO line
# MUST go through a divider or it puts 5 V on a 3.3 V input.

set -euo pipefail

URL="${1:-}"
TOKEN="${2:-}"
if [[ -z "$URL" ]]; then
  echo "usage: bash $0 <dashboard url> [presence token]" >&2
  exit 64
fi
if [[ $EUID -eq 0 ]]; then
  echo "run as the desktop user, WITHOUT sudo — this installs a user service." >&2
  exit 77
fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN="$HOME/.local/bin"
CONF="$HOME/.config/touchsphere-presence.conf"

echo "== prerequisites"
if ! python3 -c 'import lgpio' 2>/dev/null; then
  echo "   python3-lgpio is missing. Install it, then re-run:" >&2
  echo "     sudo apt install python3-lgpio" >&2
  exit 78
fi
echo "   lgpio: yes"
if id -nG | tr ' ' '\n' | grep -qx gpio; then
  echo "   gpio group: yes"
else
  echo "   WARNING: $USER is not in the 'gpio' group, so claiming the pins will fail." >&2
  echo "   Fix with:  sudo usermod -aG gpio $USER   (then log out and back in)" >&2
fi
if curl -sfk --max-time 8 "$URL/api/presence" -o /dev/null; then
  echo "   dashboard: $URL answers"
else
  echo "   WARNING: $URL/api/presence did not answer — check the URL." >&2
fi

echo "== the reader and its settings"
mkdir -p "$BIN" "$(dirname "$CONF")"
install -m 0755 "$HERE/presence.py" "$BIN/touchsphere-presence"
cat > "$CONF" <<EOF
# Written by scripts/presence/install.sh — edit freely, then:
#   systemctl --user restart touchsphere-presence
SERVER_URL=$URL
TOKEN=$TOKEN
# BCM numbers. TRIG=23 is header pin 16, ECHO=24 is header pin 18.
CHIP=0
TRIG=23
ECHO=24
# Nearer than this counts as being at the desk.
THRESHOLD_CM=90
INTERVAL_S=0.5
HEARTBEAT_S=30
MAX_CM=250
EOF
chmod 600 "$CONF"
echo "   $BIN/touchsphere-presence and $CONF"

echo "== the user service"
mkdir -p "$HOME/.config/systemd/user"
sed "s#^ExecStart=.*#ExecStart=$BIN/touchsphere-presence#" \
  "$HERE/touchsphere-presence.service" > "$HOME/.config/systemd/user/touchsphere-presence.service"
systemctl --user daemon-reload
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "   NOTE: lingering is off, so this only runs while someone is logged in." >&2
  echo "   Fix with: sudo loginctl enable-linger $USER" >&2
fi
systemctl --user reenable touchsphere-presence.service >/dev/null 2>&1 || systemctl --user enable touchsphere-presence.service
systemctl --user restart touchsphere-presence.service
echo "   enabled and started"

sleep 5
echo
journalctl --user -u touchsphere-presence -n 6 --no-pager -o cat 2>/dev/null || \
  systemctl --user --no-pager status touchsphere-presence | head -8
echo
echo "Wave a hand in front of the sensor; Settings → Hardware shows the reading."
echo "  logs:     journalctl --user -u touchsphere-presence -f"
echo "  settings: $CONF"
