#!/usr/bin/env bash
# Starts the full local demo: anvil mainnet fork, contracts, proof service, frontend.
#   ./scripts/dev.sh        (Ctrl-C stops everything)
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=${LOG_DIR:-/tmp/stakeport}
mkdir -p "$LOG"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

./scripts/anvil.sh >"$LOG/anvil.log" 2>&1 &
pids+=($!)
until cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; do sleep 1; done
echo "✓ anvil fork"

(cd contracts && forge build -q)
./scripts/deploy.sh >"$LOG/deploy.log" 2>&1
./scripts/export-frontend.sh >/dev/null
echo "✓ contracts deployed ($(jq -r .market deployments/local.json))"

(cd proof-generator && set -a && . ../.env && set +a && exec node --max-old-space-size=12000 src/server.ts) >"$LOG/proof-service.log" 2>&1 &
pids+=($!)
echo "… proof service loading the mainnet beacon state (~1 min)"
until curl -sf http://localhost:8788/api/info >/dev/null; do sleep 2; done
echo "✓ proof service"

(cd frontend && exec pnpm dev --port 3000) >"$LOG/frontend.log" 2>&1 &
pids+=($!)
until curl -sf -o /dev/null http://localhost:3000; do sleep 1; done
echo "✓ frontend: http://localhost:3000   (logs in $LOG)"
wait
