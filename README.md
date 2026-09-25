# StakePort

> A trustless secondary market for native Ethereum stake: trade active validator stake directly between validators with EIP-7251 consolidation, no exit and no LST.

Built at ETHGlobal Tokyo 2026.

## How it works

| Leg | Mechanism |
|---|---|
| Stake transfer | **EIP-7251** consolidation: seller validator S → buyer's 0x02 validator T |
| Programmable seller account | **EIP-7702** delegate on the seller's withdrawal EOA calls the consolidation predeploy |
| Trustless verification | **EIP-4788** beacon block root + SSZ proofs of validator / pending consolidation / balance |
| Payment | **Uniswap** routes the buyer's token into the settlement escrow |

Settlement state machine:

```
OPEN → FUNDED → REQUEST_SUBMITTED → CONSOLIDATION_ACCEPTED ─┬→ DELIVERED (payment → seller)
                                                            └→ FAILED    (refund → buyer)
```

## Repository layout

```
contracts/         Foundry project (market, escrow, beacon verifier, 7702 delegate, Uniswap adapter)
proof-generator/   TypeScript: fetch beacon state, build SSZ proofs
frontend/          Sell / buy / trade status / portfolio dashboard
```

## Setup

```bash
git clone --recurse-submodules https://github.com/164zheng/stakeport
cd stakeport
cp .env.example .env   # fill MAINNET_RPC_URL, BEACON_API_URL

cd contracts
forge build
forge test
```

## Prize integrations

- **Uniswap Foundation**: _TODO: link to contracts and line numbers_
- **Curvegrid (Digital Asset Dashboard)**: _TODO_

## Team

_TODO: names and social handles_
