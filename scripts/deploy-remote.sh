#!/usr/bin/env bash
#
# Pi side of scripts/deploy.sh — run as root with the uploaded bundle. Don't run
# this by hand; use scripts/deploy.sh from a dev machine.
#
# Layout on the Pi:
#   /opt/scene-setter/releases/<id>/   code + node_modules (root-owned, read-only to the service)
#   /opt/scene-setter/current          symlink to the live release
#   /opt/scene-setter/shared/          everything that survives updates (service-owned):
#       config.jsonc                   venue config (created from the example on first install only)
#       data/                          scenes, state, patch, fixture map, fixtures.db
#       tmp/                           temp space for fixture-library imports (kept off the RAM-backed /tmp)
#   /opt/scene-setter/backups/<id>/    config + JSON data snapshot taken before each update
#
# Each release has data -> shared/data, so the app's default "./data" resolves to
# the shared copy; the config path is passed via SCENE_SETTER_CONFIG.
#
set -euo pipefail

STAGE="$1"
RELEASE="$2"

APP=/opt/scene-setter
SHARED="$APP/shared"
SERVICE=scene-setter
SVC_USER=scene-setter
NODE_MAJOR=22
KEEP_RELEASES=5
KEEP_BACKUPS=10
UNIT="/etc/systemd/system/$SERVICE.service"
CONFIG="$SHARED/config.jsonc"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "must run as root"
[ -f "$STAGE/package.json" ] || die "no bundle at $STAGE"
trap 'rm -rf "$STAGE"' EXIT

export DEBIAN_FRONTEND=noninteractive

# ---- Prerequisites -----------------------------------------------------------
current_node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(current_node_major)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js $NODE_MAJOR (NodeSource)"
  apt-get install -y -qq curl ca-certificates >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "    node: $NODE_BIN $(node --version)"

if ! command -v 7zz >/dev/null && ! command -v 7z >/dev/null; then
  log "Installing 7-Zip (fixture-library import)"
  apt-get install -y -qq 7zip >/dev/null || apt-get install -y -qq p7zip-full >/dev/null
fi

# tcpdump: lets scripts/find-devices.js --listen spot devices that pick their own
# address (the Botex) the moment they power up. Optional — never fails the deploy.
if ! command -v tcpdump >/dev/null; then
  apt-get install -y -qq tcpdump >/dev/null 2>&1 && echo "    tcpdump installed" || echo "    tcpdump not installed (no package source?) — find-devices --listen unavailable"
fi

# ---- Link-local address for self-addressed Art-Net devices --------------------
# Some nodes (e.g. Botex DPX NET dimmers) give themselves a 169.254.x.x address and
# only accept Art-Net sent to 169.254.255.255, which needs an address in that range
# on the port they're cabled to. Added ALONGSIDE the DHCP address, never replacing
# it: persisted in NetworkManager for the next boot (no reapply, so no network blip)
# and added live now. LINK_LOCAL_ADDR=none skips this.
LINK_LOCAL_ADDR="${LINK_LOCAL_ADDR:-169.254.50.50/16}"
if [ "$LINK_LOCAL_ADDR" != "none" ]; then
  LL_DEV="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
  LL_IP="${LINK_LOCAL_ADDR%/*}"
  if ip -4 addr show 2>/dev/null | grep -q "inet 169\.254\."; then
    # Already has one somewhere (e.g. on the Art-Net VLAN interface, eth0.20):
    # never add a second on the production network.
    echo "    link-local: a 169.254.x.x address is already configured — skipped"
  elif [ -z "$LL_DEV" ]; then
    echo "    link-local: no default-route interface found — skipped"
  else
    if command -v nmcli >/dev/null; then
      LL_CON="$(nmcli -g GENERAL.CONNECTION device show "$LL_DEV" 2>/dev/null | head -1)"
      if [ -n "$LL_CON" ] && ! nmcli -g ipv4.addresses connection show "$LL_CON" 2>/dev/null | grep -q "$LL_IP/"; then
        nmcli connection modify "$LL_CON" +ipv4.addresses "$LINK_LOCAL_ADDR" \
          && log "Link-local: $LINK_LOCAL_ADDR saved on '$LL_CON' ($LL_DEV) for future boots" \
          || echo "WARNING: couldn't save $LINK_LOCAL_ADDR in NetworkManager (continuing)" >&2
      fi
    fi
    if ! ip -4 addr show dev "$LL_DEV" | grep -q "inet $LL_IP/"; then
      ip addr add "$LINK_LOCAL_ADDR" brd + dev "$LL_DEV" \
        && echo "    link-local: $LINK_LOCAL_ADDR added to $LL_DEV now" \
        || echo "WARNING: couldn't add $LINK_LOCAL_ADDR to $LL_DEV (continuing)" >&2
    fi
  fi
fi

# ---- Service user + directories ----------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  log "Creating system user $SVC_USER"
  useradd --system --home-dir "$SHARED" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

install -d -o root -g root -m 755 "$APP" "$APP/releases" "$APP/backups"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$SHARED" "$SHARED/data" "$SHARED/tmp"

FIRST_INSTALL=0
if [ ! -f "$CONFIG" ]; then
  FIRST_INSTALL=1
  log "First install: creating $CONFIG from the example"
  install -o "$SVC_USER" -g "$SVC_USER" -m 640 "$STAGE/config.example.jsonc" "$CONFIG"
fi

# ---- Build the release -------------------------------------------------------
REL="$APP/releases/$RELEASE"
PREV="$(readlink -f "$APP/current" 2>/dev/null || true)"
[ -d "$PREV" ] || PREV=""

log "Installing release $RELEASE"
rm -rf "$REL"
cp -a "$STAGE" "$REL"
rm -rf "$REL/data"
ln -s "$SHARED/data" "$REL/data"

# Dependencies: reuse the previous release's node_modules when the lockfile and
# Node version are unchanged (fast updates); otherwise a clean npm ci.
NODE_STAMP="$(node --version) $(uname -m)"
if [ -n "$PREV" ] && [ -d "$PREV/node_modules" ] \
   && cmp -s "$PREV/package-lock.json" "$REL/package-lock.json" \
   && [ "$(cat "$PREV/node_modules/.deploy-stamp" 2>/dev/null)" = "$NODE_STAMP" ]; then
  echo "    dependencies unchanged — reusing from previous release"
  cp -a "$PREV/node_modules" "$REL/node_modules"
else
  echo "    npm ci (production deps)"
  npm_ci() { (cd "$REL" && npm ci --omit=dev --no-audit --no-fund --update-notifier=false --cache "$APP/.npm-cache" --loglevel=error); }
  if ! npm_ci; then
    echo "    npm ci failed — installing build tools for native modules and retrying"
    apt-get install -y -qq build-essential python3 >/dev/null
    npm_ci
  fi
  echo "$NODE_STAMP" > "$REL/node_modules/.deploy-stamp"
fi
chown -R root:root "$REL"
chown -h root:root "$REL/data"

# Pre-flight on the new code, before touching the running service.
(cd "$REL" && node -e 'new (require("better-sqlite3"))(":memory:").close()') \
  || die "better-sqlite3 native module failed to load in the new release"
WEB_PORT="$(cd "$REL" && SCENE_SETTER_CONFIG="$CONFIG" node -p 'require("./src/config").loadConfig().webPort')" \
  || die "config at $CONFIG is not valid for this release — fix it and redeploy (service untouched)"

# Don't restart in the middle of a fixture-library import (it would be lost).
if systemctl is-active --quiet "$SERVICE" \
   && curl -fsS -m 3 "http://127.0.0.1:$WEB_PORT/api/fixtures/status" 2>/dev/null | grep -q '"running":true'; then
  rm -rf "$REL"
  die "a fixture-library import is running on the Pi — wait for it to finish, then deploy again (service untouched)"
fi

# ---- Backup (updates only) ---------------------------------------------------
if [ "$FIRST_INSTALL" = 0 ]; then
  BACKUP="$APP/backups/$RELEASE"
  log "Backing up config + app database to $BACKUP"
  install -d -m 750 "$BACKUP"
  cp -a "$CONFIG" "$BACKUP/"
  # SQLite online backup: a consistent copy even while the service is writing.
  if [ -f "$SHARED/data/scene-setter.db" ]; then
    (cd "$REL" && node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});db.backup(process.argv[2]).then(()=>db.close())' \
      "$SHARED/data/scene-setter.db" "$BACKUP/scene-setter.db") || die "database backup failed — service untouched"
  fi
  # Pre-SQLite installs: keep the legacy JSON too (imported on first start of this release).
  find "$SHARED/data" -maxdepth 1 -type f -name '*.json' -exec cp -a {} "$BACKUP/" \;
  # fixtures.db is a re-importable reference library (~700MB) — not backed up.
  ls -1dt "$APP"/backups/*/ 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf
fi

# ---- systemd unit ------------------------------------------------------------
log "Writing $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=Light It (Assembly Rooms house lighting)
After=network-online.target
Wants=network-online.target
# Keep restarting however often it crashes (no start-rate limit).
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP/current
ExecStart=$NODE_BIN src/index.js
Environment=NODE_ENV=production
Environment=SCENE_SETTER_CONFIG=$CONFIG
Environment=TMPDIR=$SHARED/tmp
Restart=always
RestartSec=2
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE

# Hardening: the service can only write to its shared dir.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$SHARED

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1

# ---- Switch over -------------------------------------------------------------
switch_to() {
  ln -sfn "$1" "$APP/current.new"
  mv -Tf "$APP/current.new" "$APP/current"
}

HAS_MIGRATE="$(cd "$REL" && node -p 'Boolean(require("./package.json").scripts?.migrate)')"

if [ "$HAS_MIGRATE" = true ]; then
  log "Running migrations"
  systemctl stop "$SERVICE" 2>/dev/null || true
  if ! (cd "$REL" && runuser -u "$SVC_USER" -- env HOME="$SHARED" TMPDIR="$SHARED/tmp" \
        NODE_ENV=production SCENE_SETTER_CONFIG="$CONFIG" npm run --silent migrate); then
    [ -n "$PREV" ] && systemctl start "$SERVICE"
    die "migrations failed — previous release left running; backup in $APP/backups/$RELEASE"
  fi
fi

log "Switching to $RELEASE and restarting $SERVICE"
switch_to "$REL"
systemctl restart "$SERVICE"

# ---- Health check (+ automatic rollback) -------------------------------------
healthy() {
  local restarts_before="$1"
  for _ in $(seq 1 30); do
    sleep 1
    if systemctl is-active --quiet "$SERVICE" \
       && curl -fsS -o /dev/null -m 2 "http://127.0.0.1:$WEB_PORT/"; then
      # Must also stay up (not crash-looping) for a few seconds.
      sleep 5
      systemctl is-active --quiet "$SERVICE" \
        && [ "$(systemctl show -p NRestarts --value "$SERVICE")" = "$restarts_before" ] \
        && return 0
    fi
  done
  return 1
}

log "Waiting for the service to come up on :$WEB_PORT"
if ! healthy "$(systemctl show -p NRestarts --value "$SERVICE")"; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  if [ -n "$PREV" ]; then
    echo "==> New release unhealthy — rolling back to $(basename "$PREV")" >&2
    switch_to "$PREV"
    systemctl restart "$SERVICE"
    rm -rf "$REL"
    [ "$HAS_MIGRATE" = true ] && echo "    NOTE: migrations already ran; data backup is in $APP/backups/$RELEASE" >&2
  fi
  die "release $RELEASE failed its health check"
fi

# ---- Tidy up -----------------------------------------------------------------
ls -1dt "$APP"/releases/*/ | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$APP/current")" ] || rm -rf "$old"
done

log "Deployed $RELEASE — service healthy"
echo "    web UI:  http://$(hostname).local:$WEB_PORT"
echo "    config:  $CONFIG"
echo "    data:    $SHARED/data"
echo "    logs:    journalctl -u $SERVICE -f"
if [ "$FIRST_INSTALL" = 1 ]; then
  echo
  echo "    First install: config.jsonc is the example — set your network via the web UI"
  echo "    Config page (or edit $CONFIG) and restart."
fi
