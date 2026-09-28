#!/bin/bash
# One tick of home-Mac keepers. launchd ticks often; collect/distribute runs every ARENA_COLLECT_EVERY_S (default 30m).
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

# Fight Night standing (pit) and Instant buy/burn (instadex) are sunset.
# Pit objects remain on-chain for dust; fees must never route to a pit.
# Do not re-enable without an explicit product decision.
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") pit skipped: pit-sunset" >> "$LOG"
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") instadex skipped: pit-sunset" >> "$LOG"

# Instant tape indexers. Chain work stays on this Mac; Vercel only stores blobs.
run_job hop || true
run_job trades
run_job index-rewards || true

# Leftover curve ring/settle. Off by default — Instant 24h MC is the product winner.
if [ "${ARENA_KEEPER_CURVE:-}" = "1" ]; then
  run_job settle
  run_job ring
fi

# LP collect (burn A, 60/5/25/10 creator/platform/holder-or-basket/VICE) then AdminCap
# withdraw into the platform wallet. Plain Instant (pit) collect is unreachable after
# pit-sunset — migrate locks to holder_yield first. Default every 30 minutes.
# Override with ARENA_COLLECT_EVERY_S.
STAMP="$HOME/Library/Logs/arena-keepers-fees.stamp"
EVERY="${ARENA_COLLECT_EVERY_S:-1800}"
now="$(date +%s)"
last=0
[ -f "$STAMP" ] && last="$(cat "$STAMP" 2>/dev/null || echo 0)"
if [ $((now - last)) -ge "$EVERY" ]; then
  run_job collect
  # Convert staged basket-yield quote (SUI) → RWAs after collect funds staging.
  run_job convert-basket || true
  # Push holder-yield pot to coin holders (option A). Off unless ARENA_YIELD_PUSH=1.
  if [ "${ARENA_YIELD_PUSH:-}" = "1" ]; then
    run_job push-yield || true
  fi
  # VICE buyback & burn: Config buyback bag → VICEFUN (7k) → burn via InstadexMintLock.
  # Off unless ARENA_VICE_BURN=1; simulate-only unless ARENA_VICE_BURN_LIVE=1 too.
  if [ "${ARENA_VICE_BURN:-}" = "1" ]; then
    run_job burn-vice || true
  fi
  # Basket-yield RWA pots → coin holders (push mode). Off unless ARENA_BASKET_PUSH=1.
  # Set ARENA_BASKET_PUSH_VAULT + ARENA_BASKET_PUSH_LIVE=1 for live payouts.
  if [ "${ARENA_BASKET_PUSH:-}" = "1" ]; then
    run_job push-basket || true
  fi
  if run_job withdraw; then
    echo "$now" > "$STAMP"
  fi
fi
