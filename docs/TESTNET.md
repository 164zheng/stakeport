# Running StakePort on a testnet (Hoodi)

Everything below uses free infrastructure: an Alchemy (or any) execution RPC and the public ChainSafe Lodestar
beacon node, whose proof API (`/eth/v0/beacon/proof/state`) returns Merkle proofs without downloading the state.
Every remote proof is checked against the block header's state root before use, and onchain against EIP-4788.

## Live deployment (Hoodi, chain 560048)

| Contract | Address |
|---|---|
| NativeStakeMarket | `0x7AB903314E07A68320C0CC157113Ad293A37b2C5` |
| Stake7702Delegate | `0xc1902A85406F290daa4631519370A821e5b6D79C` |
| BeaconOracle | `0x37223365EbDA73D3e3eaEAa4Dac879848564a289` |
| WETH9 | `0x1259859978c1709E2403B00589B1D07c667E4c7B` |
| WorldIdEligibility | `0xd02D8c4cFE51413F72Aa1D43826E1fF8aC6D4fCB` |

Deployed at block 3698658 with a 1-hour fill proof age and a 2-day accept window (`deployments/hoodi.json`).
With `HOODI_RPC_URL` and `RELAYER_PRIVATE_KEY` in `.env`, `./scripts/hoodi.sh` starts the proof server, indexer,
relayer and frontend against it (steps 2 and 3 below in one command).

`cd proof-generator && pnpm -s hoodi-check` proves a live entry of Hoodi's `pending_consolidations` (checkpoint 1)
against the deployed `BeaconOracle` with read-only calls; `--delivered <source>` checks the delivery predicate once
it is processed.

## 1. Deploy the core contracts

```bash
cd contracts
GENESIS_TIME=1742213400 \            # Hoodi beacon genesis
WORLD_ATTESTER=0x... \               # optional: backend key address for the Verified Market
forge script script/DeployCore.s.sol --rpc-url $HOODI_RPC_URL --account <keystore> --sender <address> --broadcast
# -> deployments/hoodi.json (a WETH9 is deployed when WETH is not given)
DEPLOYMENT_NAME=hoodi ../scripts/export-frontend.sh
```

Uniswap pools, Aqua/SwapVM and Chainlink are mainnet integrations and are not deployed here; the frontend hides
those routes when their addresses are missing.

## 2. Services

```bash
cd proof-generator
# fill proofs + validator info (no state download)
RPC_URL=$HOODI_RPC_URL BEACON_PROOF_URL=https://lodestar-hoodi.chainsafe.io PORT=8788 node src/realServer.ts
# events (10-block eth_getLogs chunks fit the Alchemy free tier)
RPC_URL=$HOODI_RPC_URL DEPLOYMENT=../deployments/hoodi.json LOG_RANGE=10 node src/indexer.ts
# settlement: checkpoint 1 within the ~27h EIP-4788 window, delivery, refunds
MODE=real RPC_URL=$HOODI_RPC_URL DEPLOYMENT=../deployments/hoodi.json \
  BEACON_PROOF_URL=https://lodestar-hoodi.chainsafe.io RELAYER_PRIVATE_KEY=0x... node src/relayer.ts
```

## 3. Frontend

```bash
cd frontend
NEXT_PUBLIC_FORK=0 NEXT_PUBLIC_CHAIN_ID=560048 NEXT_PUBLIC_GENESIS_TIME=1742213400 \
NEXT_PUBLIC_RPC_URL=$HOODI_RPC_URL NEXT_PUBLIC_PROOF_SERVICE_URL=http://localhost:8788 \
NEXT_PUBLIC_INDEXER_URL=http://localhost:8789 pnpm dev
```

- **Connect wallet** (EIP-1193) signs listings, purchases and refunds.
- Register your validators by index (the Beacon API cannot search by withdrawal address).
- **EIP-7702:** wallets do not yet let dapps request a delegation to an arbitrary contract, so the seller signs
  the authorization in the page with the withdrawal address key (testnet only; the key is used once in memory).

## 4. Validators

You need an active source validator with 0x01/0x02 credentials pointing to your withdrawal EOA (active for at least
256 epochs, ~27 hours) and an active 0x02 target with room below 2048 ETH. Delivery happens after the source's
withdrawable epoch (256 epochs after its exit epoch, plus the consolidation queue).

## Verified so far

- Remote proofs from the Lodestar proof API verify onchain on mainnet (`test/fork/RemoteProofs.fork.t.sol`) and on a
  Hoodi fork (fill proofs from `realServer.ts`).
- `DeployCore.s.sol` deploys on Hoodi (above); live Lodestar proofs (state root with slot, validators) verify
  against the deployed `BeaconOracle`.
- The relayer settles checkpoint 1 automatically in the local demo (`MODE=sim`); `MODE=real` needs a live testnet
  trade to be exercised end to end.
