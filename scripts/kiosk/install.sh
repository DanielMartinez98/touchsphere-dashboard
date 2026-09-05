#!/usr/bin/env bash
# Set the Raspberry Pi up as the TouchSphere kiosk screen.
#
#   bash scripts/kiosk/install.sh https://lokloserver.taileefe4.ts.net
#
# Run as the DESKTOP user (the one whose session owns the screen), NOT with
# sudo — this installs a *user* service so it inherits the graphical session.
#
# It needs root for exactly two things, and skips both when they are already
# done: installing the TouchKio .deb, and enabling lingering so the service
# starts at boot with nobody logged in. Everything else lives under $HOME.
# That matters more than it sounds: on a Pi where sudo wants a password, an
# installer that put its runner in /usr/local/bin could not re-run at all,
# and re-running is how a fix gets applied.

set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: bash $0 <dashboard url>    e.g. https://lokloserver.taileefe4.ts.net" >&2
  exit 64
fi
if [[ $EUID -eq 0 ]]; then
  echo "run as the desktop user, WITHOUT sudo — this installs a user service." >&2
  exit 77
fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN="$HOME/.local/bin"
CONF="$HOME/.config/touchsphere-kiosk.conf"

# Whether we can become root without a prompt. Everything that needs it is
# optional, so this decides what to skip rather than whether to continue.
if sudo -n true 2>/dev/null; then ROOT=yes; else ROOT=no; fi

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
elif [[ $ROOT == no ]]; then
  echo "   NOT installed, and sudo needs a password here. Install it yourself, then re-run:" >&2
  echo "     sudo apt install ./touchkio_<version>_$(dpkg --print-architecture).deb" >&2
  echo "     https://github.com/leukipp/touchkio/releases" >&2
  exit 78
else
  ARCH=$(dpkg --print-architecture)
  echo "   not installed — fetching the latest release for $ARCH"
  URL_DEB=$(curl -sf https://api.github.com/repos/leukipp/touchkio/releases/latest \
    | grep -o "https://[^\"]*_${ARCH}\.deb" | head -1 || true)
  if [[ -z "$URL_DEB" ]]; then
    echo "   could not find a .deb for $ARCH — install it by hand:" >&2
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
mkdir -p "$BIN" "$(dirname "$CONF")"
install -m 0755 "$HERE/touchsphere-kiosk" "$BIN/touchsphere-kiosk"
cat > "$CONF" <<EOF
# Written by scripts/kiosk/install.sh — edit freely, then:
#   systemctl --user restart touchsphere-kiosk
URL=$URL
ZOOM=1.0
THEME=dark
WAIT_SECONDS=180
EOF
echo "   $BIN/touchsphere-kiosk and $CONF"

echo "== the user service"
mkdir -p "$HOME/.config/systemd/user"
sed "s#^ExecStart=.*#ExecStart=$BIN/touchsphere-kiosk#" \
  "$HERE/touchsphere-kiosk.service" > "$HOME/.config/systemd/user/touchsphere-kiosk.service"
systemctl --user daemon-reload

# Without lingering the user manager only exists while someone is logged in,
# which is not how a wall panel works. Already-on is the common case on a
# re-run, so check before asking for root.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == "yes" ]]; then
  echo "   lingering already on"
elif [[ $ROOT == yes ]]; then
  sudo loginctl enable-linger "$USER"
  echo "   lingering enabled"
else
  echo "   WARNING: lingering is off and sudo needs a password. The kiosk will not" >&2
  echo "   start until someone logs in. Fix with: sudo loginctl enable-linger $USER" >&2
fi

systemctl --user reenable touchsphere-kiosk.service >/dev/null 2>&1 || systemctl --user enable touchsphere-kiosk.service
systemctl --user restart touchsphere-kiosk.service
echo "   enabled and started"

sleep 4
echo
systemctl --user --no-pager status touchsphere-kiosk.service | head -10 || true
echo
echo "Done. The screen should show the dashboard within a few seconds."
echo "  logs:    journalctl --user -u touchsphere-kiosk -f"
echo "  restart: systemctl --user restart touchsphere-kiosk"
echo "  settings: $CONF"
