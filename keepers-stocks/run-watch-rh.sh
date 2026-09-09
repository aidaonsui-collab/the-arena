#!/bin/bash
set -euo pipefail
cd /Users/hex/code/the-arena/keepers-stocks
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SUI_RPC="${SUI_RPC:-https://mainnet.suiet.app}"
export RH_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
unset STOCKS_MINT_DRY_RUN || true
export RH_WATCH_LOOP=1
export RH_WATCH_POLL_MS="${RH_WATCH_POLL_MS:-15000}"
export RH_WATCH_LOOKBACK="${RH_WATCH_LOOKBACK:-50}"
export HOME=/Users/hex
exec /opt/homebrew/bin/npx tsx src/cli.ts watch-rh
