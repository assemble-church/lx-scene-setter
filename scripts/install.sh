#!/usr/bin/env bash
#
# Installs the Scene Setter as a systemd service on a Raspberry Pi (or any
# systemd Linux box). Idempotent: safe to re-run after a git pull to upgrade.
#
# Usage:  ./scripts/install.sh
#
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="scene-setter"
RUN_USER="${SUDO_USER:-$USER}"

echo "==> Installing $SERVICE_NAME"
echo "    app dir: $APPDIR"
echo "    user:    $RUN_USER"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install Node 18+ first." >&2
  echo "       e.g.  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "==> Using node: $NODE_BIN ($(node --version))"

# 2. Dependencies (production only)
echo "==> Installing npm dependencies"
cd "$APPDIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# 2a. Ensure 7-Zip (needed only for importing an Avolites fixture library)
if command -v 7zz >/dev/null 2>&1 || command -v 7z >/dev/null 2>&1; then
  echo "==> 7-Zip present (fixture-library import available)"
elif command -v apt-get >/dev/null 2>&1; then
  echo "==> Installing 7-Zip (for fixture-library import)"
  sudo apt-get update -qq || true
  if ! (sudo apt-get install -y 7zip 2>/dev/null || sudo apt-get install -y p7zip-full); then
    echo "WARNING: couldn't install 7-Zip — fixture-library import won't work until you install p7zip-full." >&2
  fi
else
  echo "WARNING: 7-Zip not found and no apt-get — install it manually for fixture-library import." >&2
fi

# 2b. Build the web UI (non-fatal — the engine still runs without it)
echo "==> Building web UI"
if npm --prefix "$APPDIR/ui" install && npm --prefix "$APPDIR/ui" run build; then
  echo "==> Web UI built"
else
  echo "WARNING: UI build failed — the engine will run but the web panel won't be served." >&2
fi

# 3. Config (don't overwrite an existing one)
if [ ! -f "$APPDIR/config.jsonc" ] && [ ! -f "$APPDIR/config.json" ]; then
  cp "$APPDIR/config.example.jsonc" "$APPDIR/config.jsonc"
  echo "==> Created config.jsonc from example — EDIT IT to match your network:"
  echo "      $APPDIR/config.jsonc"
else
  echo "==> config already exists, leaving it untouched"
fi

# 4. Runtime data dir
mkdir -p "$APPDIR/data"

# 5. systemd unit
UNIT_SRC="$APPDIR/systemd/$SERVICE_NAME.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"
echo "==> Installing systemd unit to $UNIT_DST (sudo)"
sed -e "s|__APPDIR__|$APPDIR|g" \
    -e "s|__USER__|$RUN_USER|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$UNIT_SRC" | sudo tee "$UNIT_DST" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo
echo "==> Done."
sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
echo
echo "Follow logs with:  journalctl -u $SERVICE_NAME -f"
