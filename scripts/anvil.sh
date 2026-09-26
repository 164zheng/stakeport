#!/usr/bin/env bash
# Starts a mainnet fork pinned to the demo fixture's block (its beacon root is in EIP-4788).
# DEMO_FIXTURE=replay (default when present): one block before a real mainnet consolidation.
# DEMO_FIXTURE=mainnet: the block of contracts/test/fixtures/mainnet.json.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
REPLAY=contracts/test/fixtures/replay.json
DEMO_FIXTURE=${DEMO_FIXTURE:-$([ -f "$REPLAY" ] && echo replay || echo mainnet)}
if [ "$DEMO_FIXTURE" = replay ]; then
  FORK_BLOCK=$(jq -r .forkBlock "$REPLAY")
else
  FORK_BLOCK=$(jq -r .elBlockNumber contracts/test/fixtures/mainnet.json)
fi
echo "forking mainnet at block $FORK_BLOCK ($DEMO_FIXTURE fixture)"
# CHAIN_ID=31337 lets browser wallets (MetaMask) add the fork as a custom network.
exec anvil --fork-url "$MAINNET_RPC_URL" --fork-block-number "$FORK_BLOCK" \
  ${CHAIN_ID:+--chain-id "$CHAIN_ID"} --auto-impersonate --port "${ANVIL_PORT:-8545}" --silent
