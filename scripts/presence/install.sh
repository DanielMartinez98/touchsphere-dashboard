#!/usr/bin/env bash
# Install the desk-presence reader on the Raspberry Pi.
#
#   sudo bash scripts/presence/install.sh https://lokloserver.taileefe4.ts.net [PRESENCE_TOKEN]
#
# Wires up nothing — see presence.py's header for the HC-SR04 wiring — but
# installs the packages, the script, its config and a systemd unit, then
# starts it and shows the first lines of its log. Re-run to change the URL
# or token; edit /etc/touchsphere-presence.conf for pins and the threshold.

set -euo pipefail
URL="${1:-}"
TOKEN="${2:-}"
if [[ -z "$URL" ]]; then
  echo "usage: sudo bash $0 <dashboard url> [presence token]" >&2
  exit 64
fi
if [[ $EUID -ne 0 ]]; then echo "run with sudo" >&2; exit 77; fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

apt-get install -y -q python3-gpiozero python3-lgpio >/dev/null
install -o root -g root -m 0755 "$HERE/presence.py" /usr/local/bin/touchsphere-presence.py
install -o root -g root -m 0644 "$HERE/touchsphere-presence.service" /etc/systemd/system/touchsphere-presence.service

if [[ ! -f /etc/touchsphere-presence.conf ]]; then
  cat > /etc/touchsphere-presence.conf <<EOF
# Desk presence sensor — see /usr/local/bin/touchsphere-presence.py
SERVER_URL=$URL
TOKEN=$TOKEN
TRIG=23
ECHO=24
THRESHOLD_CM=90
INTERVAL_S=0.5
HEARTBEAT_S=30
EOF
else
  sed -i "s#^SERVER_URL=.*#SERVER_URL=$URL#; s#^TOKEN=.*#TOKEN=$TOKEN#" /etc/touchsphere-presence.conf
fi
chmod 0600 /etc/touchsphere-presence.conf

systemctl daemon-reload
systemctl enable --now touchsphere-presence.service
sleep 3
echo
echo "Installed. Log:"
journalctl -u touchsphere-presence -n 8 --no-pager
echo
echo "Wave a hand in front of the sensor; the dashboard's Settings → Hardware shows the reading."
