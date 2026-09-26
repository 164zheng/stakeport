#!/usr/bin/env bash
# Runs StakePort against the Hoodi deployment (deployments/hoodi.json): proof server, indexer, relayer, frontend.
#   ./scripts/hoodi.sh        (Ctrl-C stops everything)
# Needs HOODI_RPC_URL and RELAYER_PRIVATE_KEY in .env. Shares frontend/public/deployment.json with dev.sh,
# so run one or the other.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a && . ./.env && set +a
: "${HOODI_RPC_URL:?set HOODI_RPC_URL in .env}"
: "${RELAYER_PRIVATE_KEY:?set RELAYER_PRIVATE_KEY in .env}"
BEACON=${BEACON_PROOF_URL:-https://lodestar-hoodi.chainsafe.io}
GENESIS=$(jq -r .genesisTime deployments/hoodi.json)
LOG=${LOG_DIR:-/tmp/stakeport-hoodi}
mkdir -p "$LOG"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

DEPLOYMENT_NAME=hoodi ./scripts/export-frontend.sh >/dev/null
echo "✓ frontend points at market $(jq -r .market deployments/hoodi.json)"

(cd proof-generator && RPC_URL=$HOODI_RPC_URL BEACON_PROOF_URL=$BEACON PORT=8788 exec node src/realServer.ts) >"$LOG/proof-server.log" 2>&1 &
pids+=($!)
until curl -sf http://localhost:8788/api/info >/dev/null; do sleep 1; done
echo "✓ proof server ($BEACON)"

# The index persists per chain and market, so restarts resume from where they stopped.
(cd proof-generator && RPC_URL=$HOODI_RPC_URL DEPLOYMENT=../deployments/hoodi.json LOG_RANGE=${LOG_RANGE:-10} exec node src/indexer.ts) >"$LOG/indexer.log" 2>&1 &
pids+=($!)
until curl -sf http://localhost:8789/api/index/status >/dev/null; do sleep 1; done
echo "✓ indexer"

(cd proof-generator && MODE=real RPC_URL=$HOODI_RPC_URL DEPLOYMENT=../deployments/hoodi.json BEACON_PROOF_URL=$BEACON exec node src/relayer.ts) >"$LOG/relayer.log" 2>&1 &
pids+=($!)
echo "✓ relayer (real)"

(cd frontend && NEXT_PUBLIC_FORK=0 NEXT_PUBLIC_CHAIN_ID=560048 NEXT_PUBLIC_GENESIS_TIME=$GENESIS \
  NEXT_PUBLIC_RPC_URL=$HOODI_RPC_URL NEXT_PUBLIC_PROOF_SERVICE_URL=http://localhost:8788 \
  NEXT_PUBLIC_INDEXER_URL=http://localhost:8789 exec pnpm dev --port 3000) >"$LOG/frontend.log" 2>&1 &
pids+=($!)
until curl -sf -o /dev/null http://localhost:3000; do sleep 1; done
echo "✓ frontend: http://localhost:3000   (logs in $LOG)"
wait
