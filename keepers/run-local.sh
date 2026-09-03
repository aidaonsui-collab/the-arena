#!/bin/bash
# One tick of home-Mac keepers. launchd calls this every 5 minutes.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SUI_RPC="${SUI_RPC:-https://mainnet.suiet.app}"
export ARENA_KEEPER_ADDRESS="${ARENA_KEEPER_ADDRESS:-0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b}"
if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

LOG="${ARENA_KEEPER_LOG:-$HOME/Library/Logs/arena-keepers.log}"
LOCK="${TMPDIR:-/tmp}/arena-keepers.lock"
mkdir -p "$(dirname "$LOG")"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") skip: already running" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") fail: tsx missing; run npm install in $ROOT" >> "$LOG"
  exit 1
fi

run_job() {
  local job="$1"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $job start" >> "$LOG"
  if "$TSX" src/cli.ts "$job" >> "$LOG" 2>&1; then
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $job ok" >> "$LOG"
    return 0
  else
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $job fail $?" >> "$LOG"
    return 1
  fi
}

# Instant trade tape: SQLite on this Mac, then POST /api/trades for the UI.
run_job trades

# Cheap GET: writes the 24h MC bell when the round is over. Buy/burn only if a
# winner is waiting (ticker, no digest, not skipped). Idle ticks stay off-chain.
APP_URL="${ARENA_APP_URL:-https://the-arena-vert.vercel.app}"
PIT_JSON="$(curl -fsS --max-time 25 "${APP_URL%/}/api/pit-state" 2>/dev/null || true)"
if [ -z "$PIT_JSON" ]; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") instadex idle: pit-state unreachable" >> "$LOG"
elif printf '%s' "$PIT_JSON" | python3 -c '
import json, sys
j = json.load(sys.stdin)
for b in j.get("bells") or []:
    if b and b.get("t") and not b.get("digest") and not b.get("skipped"):
        sys.exit(0)
sys.exit(1)
' 2>/dev/null; then
  run_job instadex
else
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") instadex idle: no 24h winner yet" >> "$LOG"
fi
# Leftover curve ring/settle. Off by default — Instant 24h MC is the product winner.
if [ "${ARENA_KEEPER_CURVE:-}" = "1" ]; then
  run_job settle
  run_job ring
fi

# LP collect (burn A, 60/10/30 creator/platform/pit) then AdminCap withdraw into the platform wallet.
# Default every hour so the SUI pit and creator bags actually move. Override with ARENA_COLLECT_EVERY_S.
STAMP="$HOME/Library/Logs/arena-keepers-fees.stamp"
EVERY="${ARENA_COLLECT_EVERY_S:-3600}"
now="$(date +%s)"
last=0
[ -f "$STAMP" ] && last="$(cat "$STAMP" 2>/dev/null || echo 0)"
if [ $((now - last)) -ge "$EVERY" ]; then
  run_job collect
  if run_job withdraw; then
    echo "$now" > "$STAMP"
  fi
fi
