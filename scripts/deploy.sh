#!/usr/bin/env bash
# Deploys StakePort to the local fork. The deployer is a fresh address (anvil's default dev
# accounts are 7702-delegated to a sweeper on mainnet and must not be used on a fork).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
RPC=${ANVIL_RPC_URL:-http://127.0.0.1:8545}
DEPLOYER=0x57a4e00000000000000000000000000000000001
# World ID attester: the frontend backend signs eligibility attestations with this key.
ENV_LOCAL=../frontend/.env.local
if ! grep -q '^WORLD_ATTESTER_PRIVATE_KEY=' "$ENV_LOCAL" 2>/dev/null; then
  echo "WORLD_ATTESTER_PRIVATE_KEY=$(cast wallet new --json | jq -r '.[0].private_key')" >>"$ENV_LOCAL"
fi
export WORLD_ATTESTER=$(cast wallet address "$(grep '^WORLD_ATTESTER_PRIVATE_KEY=' "$ENV_LOCAL" | cut -d= -f2)")

cast rpc anvil_setBalance "$DEPLOYER" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null
forge script script/Deploy.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast -q
cat ../deployments/${DEPLOYMENT_NAME:-local}.json
