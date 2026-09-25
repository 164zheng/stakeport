#!/usr/bin/env bash
# Starts a mainnet fork pinned to the block of the proof fixture (its beacon root is in EIP-4788).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
FORK_BLOCK=$(jq -r .elBlockNumber contracts/test/fixtures/mainnet.json)
echo "forking mainnet at block $FORK_BLOCK"
exec anvil --fork-url "$MAINNET_RPC_URL" --fork-block-number "$FORK_BLOCK" \
  --auto-impersonate --port "${ANVIL_PORT:-8545}" --silent
