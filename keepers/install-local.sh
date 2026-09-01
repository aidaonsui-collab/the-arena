#!/bin/bash
# Install Arena keepers as a LaunchAgent on this Mac (no Vercel cron).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="ai.arena.keepers"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(/usr/bin/id -u)"
DOMAIN="gui/${UID_NUM}"

if [ ! -x "$ROOT/node_modules/.bin/tsx" ]; then
  echo "Installing keepers deps…"
  (cd "$ROOT" && npm install)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__KEEPERS__|$ROOT|g" -e "s|__HOME__|$HOME|g" \
  "$ROOT/launchd/ai.arena.keepers.plist.tmpl" > "$DEST"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
fi
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$DOMAIN/$LABEL" || true
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed $DEST"
echo "Runs Instant settle every 5 min, LP collect + platform-wallet withdraw every 24h."
echo "Logs: $HOME/Library/Logs/arena-keepers.log"
echo "Stop:  launchctl bootout $DOMAIN/$LABEL"
echo "Keep the Mac awake and online at bell time (plug in; prevent sleep on adapter)."
