# 4-minute demo script

Setup (before judging): `./scripts/dev.sh`, wait for "frontend: http://localhost:3000", open `/demo` in one tab and
`/` in another. Keep World App ready for the optional World ID segment. Restart `dev.sh` between runs.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:30 | `/demo`, queue panel | "Today, new ETH stake waits **29 days** in the entry queue earning nothing: 1.67 million ETH pending. Validators that want out can't hand their active stake to someone who wants in. StakePort is a trustless market for native stake: no LST, no custodian, no key transfer." |
| 0:30–0:50 | fair value card | "Bought stake earns 26 days sooner than a new deposit, so its fair value is the buyer's break-even: 32 × (1 + APR × 26 days / 365) — here +0.18%, with queues from the real beacon state and APR from Lido's public API." |
| 0:50–1:20 | Step 1 | "The seller is a real mainnet validator operator. Its withdrawal address delegates via **EIP-7702** to our contract and lists at the fair price." Click *Enable 7702 and list*. |
| 1:20–2:00 | Step 2 | (Or *Buy with ETH*: one transaction, no approval.) "The buyer pays with USDC. **One Uniswap v4 swap**: our hook routes through the canonical pool, escrows WETH, verifies **SSZ proofs of both validators against an EIP-4788 root**, and submits an **EIP-7251** consolidation from the seller's address." Click *Buy with USDC*. |
| 2:00–2:40 | Step 3 | "Checkpoint 1: the consensus layer accepted it. This proof is not simulated — it's the **real mainnet beacon state** from block 26058400, where this exact consolidation happened." Click *Relay checkpoint 1*; point at the green **real** badge. |
| 2:40–3:10 | Step 4 | "Delivery is ~3 days later on mainnet, so we fast-forward a simulated state; the contract verifies it the same way and releases the payment." Click *Fast-forward*. |
| 3:10–3:40 | `/bids`, `/` (Verified Market) | "Buyers can also post self-custodial standing bids on **1inch Aqua**, priced by a **SwapVM Dutch auction** that raises the offer every second until it crosses a listing (click *+1 hour* a few times, then *Match*); funds stay in the wallet until then. And sellers can require a **World ID** document credential: unverified buyers are rejected onchain." |
| 3:40–4:00 | `/portfolio` | "A dashboard tells operators what to do next. Native stake becomes a liquid, trustless asset — without leaving Ethereum's consensus layer." |

## Q&A cheat sheet

See [QA.md](QA.md). Top three: why a premium (entry queue), what's real (checkpoint 1 is real mainnet data), what if
the seller cheats (every path ends in a proof-based refund).

## Recording the demo video (2–4 min, ≥720p, own voice, no speed-up)

Record the table above with screen capture (QuickTime → New Screen Recording). Cut the waits between clicks instead
of speeding up.
