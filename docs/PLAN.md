# StakePort Plan (ETHGlobal Tokyo 2026, Classic Track)

Submission deadline: 2026-09-27 09:00 JST. Finalist judging: 4 min demo + 3 min Q&A.

## Product

Trustless secondary market for native Ethereum stake. A seller's validator is consolidated
(EIP-7251) into the buyer's 0x02 validator; payment is escrowed and released only after
EIP-4788 beacon-state proofs show the consolidation was accepted and delivered. No LST, no
custodian, no validator key transfer.

## Build order

1. **MVP**
   - `Stake7702Delegate`: EIP-7702 delegate on the seller's withdrawal EOA; verifies the order
     and calls the EIP-7251 consolidation predeploy.
   - `NativeStakeEscrow` / `NativeStakeMarket`: OPEN → FUNDED → REQUEST_SUBMITTED →
     CONSOLIDATION_ACCEPTED → DELIVERED | FAILED.
   - `BeaconStateVerifier`: SSZ proofs against EIP-4788 roots (validator fields, pending
     consolidation, balance). Two checkpoints because the 4788 ring buffer (~27h) is shorter
     than the consolidation delay.
   - Payment: direct WETH.
   - Proof generator (TS) and sell / buy / trade-status UI.
   - Demo: mainnet fork with real beacon proofs; checkpoint 2 replayed (real delivery takes 27h+).
2. **Portfolio dashboard** (also the Curvegrid fallback): owned stake, remaining 2048 ETH
   capacity, validator status, pending trades and settlement epochs, pricing/discount,
   and actionable items (e.g. "checkpoint 2 proof can be submitted").
3. **Uniswap v4 DvP hook**: a zero-liquidity pool whose `beforeSwap` routes the buyer's token
   through the canonical mainnet v4 pool, sends ETH to escrow and submits the consolidation.
   Price is checked against the Uniswap wstETH/WETH TWAP ("Uniswap prices it, Ethereum
   consensus delivers it"). Fallback: direct WETH payment path stays available.
4. **1inch Aqua**: self-custodial native-stake bids.
5. **World IDKit**: Verified Market (see below). Implemented: per-listing eligibility policy,
   WorldIdEligibility registry, IDKit backend in the Next.js app.

## Partner prizes (max 3 partners)

Primary: Uniswap Foundation, 1inch, World. Fallback if World is not ready: Curvegrid
(Best Digital Asset Dashboard) instead of World.

Requirements to satisfy:
- Uniswap: public repo, `FEEDBACK.md`, Developer Feedback Form, README pointing to contracts and
  line numbers.
- 1inch: official Aqua/SwapVM contracts, onchain token transfers in demo (fork OK), real commit
  history.
- World: IDKit in a working flow, verification on server or onchain, success + alternative path,
  integration debrief.
- Curvegrid: README with one-line summary, team + socials, setup and test instructions.

## World: trust moment

- Intent: restrict the Verified Market to counterparties outside sanctioned jurisdictions.
- Ideal credential: Identity Check with a `nationality` attribute. It is in preview (access by
  request), so it is not usable during the hackathon.
- Implemented: Passport (NFC) credential as the closest available assurance: a real
  government-issued document holder, one account per document. Not a KYC or sanctions check.
- The eligibility policy is pluggable so a `nationality` condition can be added when Identity
  Check becomes available.
- Alternative path: no credential or failed verification → purchase in the Verified Market is
  rejected.

## Rules to keep in mind

- Commit often; large single commits can be disqualified.
- Document AI tool usage (which files / parts were AI-assisted) in the README.
- Demo video (optional): 2-4 min, >=720p, no speed-up, no AI voiceover.

## Environment findings (2026-09-26)

- Mainnet is on **Fulu** (BeaconState has 38 fields; Gloas not scheduled). Use `ssz.fulu.BeaconState`.
- `@lodestar/types@1.48.0` breaks with `@chainsafe/ssz@1.8.0` ("List limit must be a positive
  integer"). Pin `@chainsafe/ssz` to `1.7.0` via pnpm overrides.
- Full state: ~337 MB SSZ, ~20 s download (Alchemy beacon debug endpoint works), ~2 s deserialize,
  ~30 s hashTreeRoot, ~3 GB RSS. Computed root matches the header `state_root`.
- ~8.2k pending consolidations on mainnet: real delivery would take a long time; the demo replays
  checkpoint 2.
- EIP-7702 on the anvil fork works both with a signed authorization (`cast send --auth`) and with
  `anvil_setCode(eoa, 0xef0100 || delegate)` on a real mainnet withdrawal address. In both cases
  the consolidation predeploy logs the EOA as the source address.
- **Do not use anvil's default dev accounts on a mainnet fork**: they are 7702-delegated to a
  sweeper contract on mainnet. Generate fresh keys and fund them with `anvil_setBalance`.
- EIP-4788 on the fork returns real roots for blocks up to the fork block. Later roots can be
  injected into the ring buffer with `anvil_setStorageAt` (replaying real mainnet roots).
- Uniswap v4 PoolManager is live on the fork (`0x000000000004444c5dc75cB358380D2e3dE08A90`).
- Aqua / SwapVM use source-available Degensoft licenses (fine for the hackathon; check before any
  commercial use).
