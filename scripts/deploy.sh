#!/usr/bin/env bash
#
# Build locally, ship to the Pi, and install/upgrade the scene-setter service.
# The same command does a first-time install and every later update.
#
# Usage:  scripts/deploy.sh [user@host]
#         (default target: pi@ac-production-pi-1.local, or $DEPLOY_TARGET)
#
# What it does:
#   1. builds the web UI here (ui/dist) and the Companion module (companion/lightit.tgz)
#   2. bundles the app (source, lockfile, built UI) and copies it to the Pi
#   3. runs scripts/deploy-remote.sh on the Pi as root, which installs the
#      release, keeps config + data untouched, runs migrations (if any), switches
#      over, restarts the service and rolls back if it doesn't come up healthy.
#
# Auth: you'll be asked for the SSH password (once) and the sudo password on the
# Pi. Set up an SSH key to skip the first. For unattended runs, DEPLOY_SUDO_PASSWORD
# can supply the sudo password.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-${DEPLOY_TARGET:-pi@ac-production-pi-1.local}}"

cd "$ROOT"

# Release id: timestamp + git commit (+ "-dirty" if there are uncommitted changes).
REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then REV="$REV-dirty"; fi
RELEASE="$(date +%Y%m%d-%H%M%S)-$REV"
REMOTE_STAGE="/tmp/scene-setter-deploy-$RELEASE"

echo "==> Deploying release $RELEASE to $TARGET"

# ---- 1. Build the UI ---------------------------------------------------------
echo "==> Building web UI"
if [ ! -f ui/node_modules/.package-lock.json ] || [ ui/package-lock.json -nt ui/node_modules/.package-lock.json ]; then
  npm --prefix ui ci --no-audit --no-fund
fi
npm --prefix ui run build

echo "==> Building Companion module"
node scripts/build-companion.js

# ---- 2. Bundle + copy --------------------------------------------------------
# One SSH connection shared by every step, so the password is only asked once.
CTL_DIR="$(mktemp -d /tmp/deploy.XXXXXX)" # short path: macOS caps socket paths at 104 bytes
SSH_OPTS=(-o "ControlPath=$CTL_DIR/ctl")
cleanup() {
  ssh "${SSH_OPTS[@]}" -O exit "$TARGET" >/dev/null 2>&1 || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT
# Open the shared master connection up front (background, no command).
ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o ConnectTimeout=15 -fN "$TARGET"

FILES=(src package.json package-lock.json config.example.jsonc artnet-monitor.js README.md LICENSE ui/dist companion/package.json companion/lightit.tgz scripts/deploy-remote.sh scripts/find-devices.js)

echo "==> Copying bundle to $TARGET:$REMOTE_STAGE"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --exclude .DS_Store -czf - "${FILES[@]}" \
  | ssh "${SSH_OPTS[@]}" "$TARGET" \
      "rm -rf '$REMOTE_STAGE' && mkdir -p '$REMOTE_STAGE' && tar --warning=no-unknown-keyword -xzf - -C '$REMOTE_STAGE' && echo '$RELEASE' > '$REMOTE_STAGE/RELEASE'"

# ---- 3. Install on the Pi ----------------------------------------------------
REMOTE_CMD="bash '$REMOTE_STAGE/scripts/deploy-remote.sh' '$REMOTE_STAGE' '$RELEASE'"
echo "==> Installing on $TARGET"
if [ -n "${DEPLOY_SUDO_PASSWORD:-}" ]; then
  printf '%s\n' "$DEPLOY_SUDO_PASSWORD" | ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -S -p '' $REMOTE_CMD"
elif [ -t 0 ]; then
  ssh "${SSH_OPTS[@]}" -t "$TARGET" "sudo $REMOTE_CMD"
else
  ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n $REMOTE_CMD"
fi
