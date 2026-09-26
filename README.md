# StakePort

**A trustless secondary market for native Ethereum stake: buy and sell a validator's active stake without exiting and without an LST.**

Built at ETHGlobal Tokyo 2026 (Classic Track).

```
                     Native stake delivery-versus-payment

  Seller validator S ──── EIP-7251 consolidation ────▶ Buyer's 0x02 validator T
        ▲                                                        │
        │ EIP-7702: the seller's withdrawal EOA runs              │ EIP-4788 beacon root
        │ the StakePort delegate, so the market can               │ + SSZ proofs
        │ trigger the consolidation from that address             ▼
  Buyer ── WETH / USDC (Uniswap v4) / Aqua bid ──▶ Escrow ──▶ Seller (after delivery proof)
```

| Leg | Mechanism |
|---|---|
| Stake transfer | **EIP-7251** consolidation of the seller's validator into the buyer's compounding (0x02) validator |
| Programmable withdrawal account | **EIP-7702** delegate on the seller's withdrawal EOA calls the consolidation predeploy, so `msg.sender` is the seller |
| Trustless verification | **EIP-4788** beacon block roots + SSZ Merkle proofs of validators, balances and `pending_consolidations` (Fulu) |
| Price discovery | **Uniswap** wstETH/WETH TWAP: orders can be priced relative to the LST market |
| Payment | **ETH in one transaction** (`fillWithEth`), WETH, USDC in **one Uniswap v4 swap** through the StakePort hook, or a self-custodial **1inch Aqua** standing bid priced by a **SwapVM** Dutch auction |
| Counterparty policy | Optional **Verified Market** listings: buyer must hold a **World ID NFC document** credential (passport or My Number Card), enforced onchain at fill |

No LST, no custodian, no validator key transfer.

## Why now: active stake is worth a premium

At the demo's mainnet slot, **1.67M ETH waits ~29 days in the entry queue** earning nothing, while a StakePort
purchase is delivered through the consolidation queue in **~2.8 days**. Bought stake therefore starts earning ~26 days
sooner than a new deposit, and the buyer's break-even price is the fair value StakePort shows:

```
fair = amount × (1 + APR × max(0, entry_wait − delivery_wait) / 365)
     = 32 × (1 + 2.50% × 26.2 / 365) ≈ 32.0575 ETH   (+0.18%)
```

Queue waits come from the real beacon state under Electra churn rules
([`proof-generator/src/queues.ts`](proof-generator/src/queues.ts)); the APR is Lido's public stETH 7-day APR grossed up
for its 10% fee ([`frontend/src/app/api/apr/route.ts`](frontend/src/app/api/apr/route.ts)).

## How a trade settles

```
fill()            payment escrowed, EIP-7251 request sent from the seller's address   RequestSubmitted
proveAccepted()   checkpoint 1: pending_consolidations contains (source, target)       Accepted
proveDelivered()  checkpoint 2: source not slashed, past withdrawable epoch, balance   Delivered → seller paid
                  has left the source
refund paths      request ignored (source exit never initiated), source slashed, or    Failed → buyer refunded
                  no acceptance proof within the accept window
```

Two checkpoints are needed because the EIP-4788 ring buffer holds ~27 hours of roots, while delivery takes at
least `MIN_VALIDATOR_WITHDRAWABILITY_DELAY` (256 epochs, ~27 hours) plus the consolidation churn queue.
Settlement is permissionless: anyone can relay a proof.

At fill time the market checks, against a recent beacon root, that:
- the source validator's withdrawal credentials (0x01 or 0x02) point to the seller, it is active, not slashed,
  not exiting and past the shard committee period;
- the target is an active 0x02 validator whose effective balance stays within 2048 ETH;
- the seller's EOA is delegated to the StakePort delegate (EIP-7702 designator);
- the order is signed by the seller (EIP-712) or listed onchain by the seller; the source is not already in a trade.

## Repository layout

```
contracts/          Foundry
  src/
    NativeStakeMarket.sol         escrow, order checks, two-checkpoint settlement
    Stake7702Delegate.sol         EIP-7702 delegate for the seller's withdrawal EOA
    BeaconOracle.sol              EIP-4788 root lookup + proof verification
    libraries/BeaconProofs.sol    SSZ proofs for Fulu BeaconState (validators, balances, pending consolidations)
    uniswap/StakePortHook.sol     v4 hook: buy native stake with one swap
    uniswap/StakePortSwapRouter.sol
    uniswap/UniswapStakePriceOracle.sol   v3 TWAP staked-ETH reference price
    aqua/AquaStakeBidApp.sol      1inch Aqua app: self-custodial standing bids priced by SwapVM programs
    world/WorldIdEligibility.sol  World ID Passport eligibility registry (Verified Market policy)
  test/             unit tests (mocks) + mainnet fork tests (real beacon proofs, real predeploy, real pools)
proof-generator/    TypeScript: Beacon API client, SSZ proofs (lodestar), proof service for the demo
frontend/           Next.js: market, sell, buy, bids, trades, portfolio; /api/world/* World ID backend
scripts/            dev.sh (whole demo), anvil.sh, deploy.sh, export-frontend.sh
docs/PLAN.md        plan, decisions and environment findings
```

## Run it

Requirements: Foundry, Node 24, pnpm, an Ethereum mainnet RPC and a Beacon API that serves
`/eth/v2/debug/beacon/states/{slot}` as SSZ (e.g. Alchemy).

```bash
git clone --recurse-submodules https://github.com/164zheng/stakeport && cd stakeport
cp .env.example .env                     # MAINNET_RPC_URL, BEACON_API_URL
cp frontend/.env.example frontend/.env.local   # optional: World ID app_id / rp_id / signing key
(cd proof-generator && pnpm install) && (cd frontend && pnpm install)

./scripts/dev.sh                         # anvil fork + deploy + proof service + frontend
open http://localhost:3000
```

The demo forks mainnet **one block before a real consolidation request** (tx `0xb94605dc…1c06f6`, block 26058400,
`contracts/test/fixtures/replay.json`, built by `proof-generator/src/replay.ts`). The seller persona is the operator
that made that request; the buyer is an independent address with a 0x02 validator (the fork runs with
`--auto-impersonate`). `DEMO_FIXTURE=mainnet ./scripts/dev.sh` uses the older `mainnet.json` fixture instead.

Guided demo: open **`/demo`** and click through the four steps (script: [`docs/DEMO.md`](docs/DEMO.md), Q&A and
threat model: [`docs/QA.md`](docs/QA.md)). Free exploration: **Sell** (enable 7702, list fixed or LST-relative, optional
Verified Market) → **Market** → **Buy** (WETH or USDC via Uniswap v4) or **Bids** (ship an Aqua bid, match) →
**Trades** (relay checkpoints) → **Portfolio**.

CLI version of the same flow: `cd proof-generator && node scripts/e2e.ts` (with the stack running).

### What is real and what is simulated

- **Real:** mainnet beacon states (Fulu), validators, fill-time SSZ proofs, the EIP-4788 root they verify
  against, the EIP-7251 predeploy, queue lengths, Uniswap v3/v4 pools and liquidity, Chainlink ETH/USD, the
  official Aqua deployment, World ID (production World App).
- **Checkpoint 1 of the replayed pair is real:** the proof comes from the mainnet beacon state (slot 15296898)
  that processed the same request. Its root is written into the fork's EIP-4788 buffer because it is newer than
  the fork block (`test/fork/Replay.fork.t.sol` proves it at mainnet's own 4788 timestamp).
- **Simulated (labelled in the UI):** checkpoint 2 (delivery is ~3 days after acceptance on mainnet) and
  checkpoint 1 for any other pair. The proof service applies the consensus-layer transitions to the real state,
  seals a block header and injects its root; the contracts verify these with the same code path.
- On the fork the seller's EIP-7702 delegation is set with `anvil_setCode` because we do not hold the real
  seller's key; in production the wallet signs a 7702 authorization (covered by `test_fill_withRealEip7702Authorization`).

## Tests

```bash
cd contracts && forge test                 # 97 unit tests; fork tests are skipped without MAINNET_RPC_URL
set -a; . ../.env; set +a; forge test      # + 32 mainnet fork tests (129 total)
cd proof-generator && pnpm test            # gindex parity with Solidity, proof/ABI checks, queue math
```

- `BeaconProofs.t.sol`: SSZ verification against **real mainnet proofs** (validators, balances, pending
  consolidation, slot), tampering and malformed-proof cases.
- `NativeStakeMarket.t.sol`: fill checks, native ETH fills (wrap into escrow, fee refund), (signature, delegation, every validator condition, capacity, double
  sale, fee), LST-relative pricing (fuzz), both checkpoints and every refund path.
- `WorldIdEligibility.t.sol`: attestations (attester signature, credential, expiry, one passport = one
  account), Verified Market listings reject unverified buyers and check the buyer, not the payer.
- `fork/Market.fork.t.sol`: fills a real validator's stake with real proofs; the real predeploy queues the
  request with the seller as source address.
- `fork/Replay.fork.t.sol`: **checkpoint 1 with real mainnet data**: fills the pair of a real consolidation one
  block before mainnet did and proves acceptance with the real post-request beacon state; the same state
  refutes a false "not accepted" claim.
- `fork/Uniswap.fork.t.sol`: TWAP oracle; USDC → native stake in one v4 swap; hook guards.
- `fork/Aqua.fork.t.sol`: bids on the official Aqua registry; wallet-to-escrow pull; price, budget, dock,
  impostor and redirect protections.

## Partner integrations

### Uniswap Foundation

Uniswap does two jobs: **it prices the stake and it settles the payment.**

1. **v4 hook: one swap buys native stake** ([`StakePortHook.sol`](contracts/src/uniswap/StakePortHook.sol)).
   The StakePort pool (ETH/USDC, no liquidity) is only an entry point. In
   [`beforeSwap` (L111)](contracts/src/uniswap/StakePortHook.sol#L111) the hook
   routes the input through the canonical ETH/USDC v4 pool inside the same unlock
   ([`poolManager.swap` L122](contracts/src/uniswap/StakePortHook.sol#L122),
   [`take` L133](contracts/src/uniswap/StakePortHook.sol#L133)), escrows the price in the market, which submits
   the EIP-7251 consolidation ([L151](contracts/src/uniswap/StakePortHook.sol#L151)), refunds leftover ETH, and
   returns a `BeforeSwapDelta` that takes the swapper's input so the pool curve is skipped
   ([L140](contracts/src/uniswap/StakePortHook.sol#L140)). Adding liquidity is disabled
   ([L158](contracts/src/uniswap/StakePortHook.sol#L158)). The hook address is mined with CREATE2
   ([`Deploy.s.sol` L42](contracts/script/Deploy.s.sol#L42)).
2. **Router** ([`StakePortSwapRouter.sol`](contracts/src/uniswap/StakePortSwapRouter.sol)): `unlockCallback`
   ([L38](contracts/src/uniswap/StakePortSwapRouter.sol#L38)) swaps with hookData and settles the input.
3. **TWAP price oracle** ([`UniswapStakePriceOracle.sol`](contracts/src/uniswap/UniswapStakePriceOracle.sol)):
   30-minute TWAP of the v3 wstETH/WETH 0.01% pool ([`observe` L46](contracts/src/uniswap/UniswapStakePriceOracle.sol#L46))
   divided by `stEthPerToken` gives the market price of staked ETH
   ([L61](contracts/src/uniswap/UniswapStakePriceOracle.sol#L61)). Sellers list "LST market − 30 bps"; the
   market evaluates it at fill time ([`quote` L247](contracts/src/NativeStakeMarket.sol#L247)).
4. **Frontend**: V4Quoter for the USDC amount, one-click purchase
   ([`frontend/src/lib/uniswap.ts`](frontend/src/lib/uniswap.ts)).

Tests: [`test/fork/Uniswap.fork.t.sol`](contracts/test/fork/Uniswap.fork.t.sol). Feedback: [`FEEDBACK.md`](FEEDBACK.md).

### 1inch Aqua + SwapVM

[`AquaStakeBidApp.sol`](contracts/src/aqua/AquaStakeBidApp.sol) is an Aqua app for **standing bids on native
stake**, priced by **1inch SwapVM programs**.

- **Aqua (custody):** a buyer ships a `StakeBid` strategy (target validator, size range, hard price cap and a
  SwapVM pricing order) with a WETH budget to the **official Aqua registry** (`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`).
  The WETH stays in the buyer's wallet. When a listing is priced within the bid, anyone calls
  [`matchBid` (L199)](contracts/src/aqua/AquaStakeBidApp.sol#L199) and Aqua pulls exactly the listing's price from
  the buyer's wallet into the StakePort escrow ([L216](contracts/src/aqua/AquaStakeBidApp.sol#L216)).
- **SwapVM (pricing):** the bid's price is a SwapVM program, e.g. a **Dutch auction**
  (`StaticBalances → DutchAuctionBalanceOut → LimitSwap → Salt`, built by
  [`buildDutchBid` L143](contracts/src/aqua/AquaStakeBidApp.sol#L143)) that raises the offer every second from 99.9% of
  face to the entry-queue break-even, so price discovery happens onchain until a seller accepts. Native stake is not
  a token, so the program prices a marker asset (1 unit = 1 wei of stake) against WETH and the app evaluates it
  with SwapVM's `quote` in a static call ([L124](contracts/src/aqua/AquaStakeBidApp.sol#L124)); the bid limit is that
  price, capped ([`limit` L132](contracts/src/aqua/AquaStakeBidApp.sol#L132)). The buyer pays the seller's ask.
- **Router:** the mainnet `0x11111133…` SwapVM deployment is the AMM-only `AquaSwapVMRouter` (no Dutch-auction
  opcodes), so the demo deploys the **official, unmodified `SwapVMRouter` v1.0.2** from source
  ([`Deploy.s.sol` L52](contracts/script/Deploy.s.sol#L52)); opcode numbers are checked against its table in tests.

Tests on a mainnet fork: [`Aqua.fork.t.sol`](contracts/test/fork/Aqua.fork.t.sol) (custody, budget, dock, impostor and
redirect protections) and [`SwapVmBid.fork.t.sol`](contracts/test/fork/SwapVmBid.fork.t.sol) (opcode parity, rising
auction, expiry, match only once the auction crosses the ask, cap).

### World (IDKit): Verified Market

**Trust moment.** Some sellers (funds, companies) must not trade their stake with counterparties in sanctioned
jurisdictions. They list in the **Verified Market**: only buyers who pass the listing's eligibility policy can
fill it, and the market enforces it at fill time for every route (WETH, Uniswap hook, Aqua bid)
([`NativeStakeMarket.sol` L229](contracts/src/NativeStakeMarket.sol#L229),
[`listOrderWithPolicy` L189](contracts/src/NativeStakeMarket.sol#L189)).

**Why this credential.** The credential that expresses the seller's rule is World ID *Identity Check* with a
`nationality` attribute, which is in preview. The minimum sufficient assurance available today is the
**NFC document credential** (passport, or My Number Card in Japan): a real government-issued document holder, one account per passport, no personal
data revealed. Proof of Human or Selfie Check would say nothing about a document; Identity Check will replace it
when available (the policy is a pluggable contract). This is not a KYC or sanctions check, and the UI says so.

**Flow.**
1. IDKit requests a World ID 4.0 NFC document proof, `any(passport, mnc)` bound to the buyer's address as signal
   (legacy proofs disabled: the legacy "document" level is satisfied by any higher level such as Orb), with a
   backend RP signature
   ([`WorldGate.tsx` L111](frontend/src/components/WorldGate.tsx#L111), [`/api/world/rp-signature`](frontend/src/app/api/world/rp-signature/route.ts)).
2. [`/api/world/verify`](frontend/src/app/api/world/verify/route.ts) checks the action, environment, credential
   identifier (L33) and that the signal is the buyer's address (L41), then verifies the proof with the Developer
   Portal `POST /api/v4/verify/{rp_id}` (L45) and signs an EIP-712 attestation (L69).
3. [`WorldIdEligibility.attest`](contracts/src/world/WorldIdEligibility.sol#L53) records it; a World ID nullifier
   can be bound to only one account (L58). World ID 4.0 proofs can only be verified onchain on World Chain, so the
   Ethereum-side registry relies on the backend attester.

**Verified end to end** with World App in production: My Number Card credential → Developer Portal verification
→ onchain attestation → purchase in the Verified Market.

**Alternative paths (demoed).** Unverified buyer → "Try to buy without verification" → rejected onchain with
`BuyerNotEligible`. Cancelled request, missing Passport credential or a proof rejected by the backend → clear
message, nothing recorded, open listings remain available. Debrief: [`docs/WORLD_DEBRIEF.md`](docs/WORLD_DEBRIEF.md).

### Curvegrid (Digital Asset Dashboard)

The [Portfolio](frontend/src/app/portfolio/page.tsx) page is a dashboard for native stake: stake and USD value
(Chainlink), estimated rewards, receiving capacity across 0x02 validators, validators with fill level and status,
trades with settlement ETA and discount, and **action items** (relay a checkpoint proof, claim a refund,
validators near the 2048 ETH cap, idle WETH, listings about to expire). MultiBaas was not used.

## Security notes and limitations

- Hackathon code, not audited.
- The demo deployment uses a 30-day fill proof age (the demo fast-forwards time); production would use ~1 hour.
- A 0x02 source with pending partial withdrawals is rejected by the consensus layer; the buyer is refunded via
  `proveNotAccepted` / `refundExpired`.
- The delivery proof relies on the source being processed once withdrawable (pending consolidations are
  processed in queue order before the withdrawal sweep).
- Validator keys stay with the seller until the consolidation is processed; slashing in that window refunds the
  buyer (`proveFailed`).

## AI usage

Claude Code (Anthropic) was used as a coding assistant. Most of the code (contracts, tests, proof generator,
frontend) and the documentation were written with it, under the direction and review of the team.

What the team (Hiroshi Tei) did:
- Product and design decisions: the native-stake DvP concept, the build order, which partner integrations to
  build and how (Uniswap v4 hook instead of a plain swap integration, Aqua standing bids, native ETH payment).
- Pricing model: the insight that active stake should trade at a premium equal to the buyer's entry-queue
  break-even, and the decision to keep only the buyer-side model.
- World ID: Developer Portal app and RP setup, end-to-end verification with a real World App and My Number Card,
  and the debugging that found that the passport preset fell back to legacy Orb proofs and that Japanese users
  hold an `mnc` credential.
- Reviewing and testing every feature in the running demo, and the demo and pitch.

AI-assisted files: everything under `contracts/src`, `contracts/test`, `contracts/script`, `proof-generator/`,
`frontend/src`, `scripts/` and `docs/`. Planning notes: [`docs/PLAN.md`](docs/PLAN.md).

## Team

- **Hiroshi Tei**: GitHub [@164zheng](https://github.com/164zheng) · X [@164zheng](https://x.com/164zheng)
