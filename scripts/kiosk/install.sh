#!/usr/bin/env bash
# Set the Raspberry Pi up as the TouchSphere kiosk screen.
#
#   bash scripts/kiosk/install.sh https://lokloserver.taileefe4.ts.net
#
# Run as the DESKTOP user (the one whose session owns the screen), NOT with
# sudo — the service is a user service so it inherits the graphical session,
# and sudo is asked for only where it is genuinely needed. See the unit file
# for why a user service rather than a system one.
#
# Installs TouchKio if it is missing, writes the URL, installs the runner and
# the unit, enables lingering so it starts at boot with nobody logged in, and
# starts it. Safe to re-run: it replaces its own files and nothing else.

set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: bash $0 <dashboard url>    e.g. https://lokloserver.taileefe4.ts.net" >&2
  exit 64
fi
if [[ $EUID -eq 0 ]]; then
  echo "run as the desktop user, WITHOUT sudo — this installs a user service." >&2
  echo "(it will ask for sudo only for the two files that need it)" >&2
  exit 77
fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "== checking the dashboard is reachable"
if curl -sfk --max-time 8 "$URL/api/system/version" -o /dev/null; then
  echo "   $URL answers"
else
  echo "   WARNING: $URL did not answer. Carrying on — the kiosk waits for it at boot —" >&2
  echo "   but check the URL if the screen stays blank." >&2
fi

echo "== TouchKio"
if command -v touchkio >/dev/null; then
  echo "   already installed ($(command -v touchkio))"
else
  # The published .deb is arm64; a Pi 5 on 64-bit Raspberry Pi OS matches.
  ARCH=$(dpkg --print-architecture)
  echo "   not installed — fetching the latest release for $ARCH"
  URL_DEB=$(curl -sf https://api.github.com/repos/leukipp/touchkio/releases/latest \
    | grep -o "https://[^\"]*_${ARCH}\.deb" | head -1 || true)
  if [[ -z "$URL_DEB" ]]; then
    echo "   could not find a .deb for $ARCH. Install TouchKio by hand:" >&2
    echo "     https://github.com/leukipp/touchkio/releases" >&2
    exit 78
  fi
  TMPDEB=$(mktemp --suffix=.deb)
  curl -fL "$URL_DEB" -o "$TMPDEB"
  sudo apt-get install -y "$TMPDEB"
  rm -f "$TMPDEB"
  echo "   installed"
fi

echo "== the runner and its settings"
sudo install -o root -g root -m 0755 "$HERE/touchsphere-kiosk" /usr/local/bin/touchsphere-kiosk
sudo tee /etc/touchsphere-kiosk.conf >/dev/null <<EOF
# Written by scripts/kiosk/install.sh — edit freely, then:
#   systemctl --user restart touchsphere-kiosk
URL=$URL
ZOOM=1.0
THEME=dark
WAIT_SECONDS=180
EOF
echo "   /usr/local/bin/touchsphere-kiosk and /etc/touchsphere-kiosk.conf"

echo "== the user service"
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 "$HERE/touchsphere-kiosk.service" "$HOME/.config/systemd/user/touchsphere-kiosk.service"
systemctl --user daemon-reload
# Without lingering the service only exists while someone is logged in, which
# is not how a wall panel works.
sudo loginctl enable-linger "$USER"
systemctl --user enable --now touchsphere-kiosk.service
echo "   enabled and started"

sleep 4
echo
systemctl --user --no-pager status touchsphere-kiosk.service | head -12 || true
echo
echo "Done. The screen should show the dashboard within a few seconds."
echo "  logs:    journalctl --user -u touchsphere-kiosk -f"
echo "  restart: systemctl --user restart touchsphere-kiosk"
echo "  stop:    systemctl --user stop touchsphere-kiosk"
