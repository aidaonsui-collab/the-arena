#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SUI_RPC="${SUI_RPC:-https://mainnet.suiet.app}"
export RH_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
export RH_REDEEM_LOOP=1
export RH_REDEEM_POLL_MS="${RH_REDEEM_POLL_MS:-15000}"
export RH_RELEASER_ADDRESS=0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc

# Dry-run by default, on every machine, every checkout, straight from git.
# Going live is a per-machine, out-of-band decision, never something this
# checked-in script defaults to:
#   - WATCH_REDEEM_GO_LIVE=1 must be set OUTSIDE this file (e.g. in that
#     machine's own LaunchAgent plist EnvironmentVariables, or the caller's
#     shell) — never hardcoded here, so a fresh clone/pull can't silently
#     inherit a live setup.
#   - RH_RELEASER_KEY must be in a gitignored, 0600 .env.local next to this
#     script — never in the plist (readable via `launchctl print`), never
#     typed into an AI chat/agent prompt.
if [ "${WATCH_REDEEM_GO_LIVE:-}" = "1" ]; then
  ENV_FILE="$(dirname "$0")/.env.local"
  if [ ! -f "$ENV_FILE" ]; then
    echo "WATCH_REDEEM_GO_LIVE=1 but missing $ENV_FILE (RH_RELEASER_KEY required for live)" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
  if [ -z "${RH_RELEASER_KEY:-}" ]; then
    echo "RH_RELEASER_KEY empty after sourcing .env.local" >&2
    exit 1
  fi
  export STOCKS_RELEASE_LIVE=1
  exec /opt/homebrew/bin/npx tsx src/cli.ts watch-redeem --live
fi

exec /opt/homebrew/bin/npx tsx src/cli.ts watch-redeem
