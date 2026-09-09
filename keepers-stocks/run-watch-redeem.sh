#!/bin/bash
set -euo pipefail
cd /Users/hex/code/the-arena/keepers-stocks
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SUI_RPC="${SUI_RPC:-https://mainnet.suiet.app}"
export RH_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
export RH_REDEEM_LOOP=1
export RH_REDEEM_POLL_MS="${RH_REDEEM_POLL_MS:-15000}"
export HOME=/Users/hex
export STOCKS_RELEASE_LIVE=1
export RH_RELEASER_ADDRESS=0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc

# Key lives in gitignored 0600 .env.local — never in the plist (launchctl print).
ENV_FILE=/Users/hex/code/the-arena/keepers-stocks/.env.local
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE (RH_RELEASER_KEY required for live)" >&2
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

exec /opt/homebrew/bin/npx tsx src/cli.ts watch-redeem --live
