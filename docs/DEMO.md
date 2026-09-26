# 4-minute demo script

Setup (before judging): `./scripts/dev.sh`, wait for "frontend: http://localhost:3000", open `/demo` in one tab and
`/` in another, and keep a terminal beside the browser running `cd proof-generator && pnpm -s tx --watch`. Keep World App ready for the optional World ID segment (each restart uses a fresh World ID action, so
re-verify after restarting). Restart `dev.sh` between runs.

To show MetaMask signing instead of impersonated personas: `CHAIN_ID=31337 ./scripts/dev.sh`, connect the wallet
(it plays the buyer), press **+100 ETH**, and buy with ETH (see the README section "With a browser wallet").
To show the real transactions in a terminal (labelled addresses, token transfers, Aqua pulls, Uniswap swaps, the
EIP-7251 request, StakePort events):

```bash
cd proof-generator
pnpm -s tx --watch         # live: prints every new StakePort transaction as you click through the UI
pnpm -s tx --last          # every transaction of the latest trade: fill, checkpoint 1, checkpoint 2 + payout
pnpm -s tx --trade 3       # a specific trade
pnpm -s hoodi-check        # live Hoodi: prove a real pending consolidation against the deployed BeaconOracle
pnpm -s hoodi-check --delivered <source>   # checkpoint 2 once that consolidation is processed
pnpm -s tx 0x<txhash>      # any transaction (e.g. an Aqua bid match: WETH pulled from the buyer's wallet via Aqua)
```

| Time | Screen | Say |
|---|---|---|
| 0:00–0:30 | `/demo`, queue panel | "Today, new ETH stake waits **29 days** in the entry queue earning nothing: 1.67 million ETH pending. Validators that want out can't hand their active stake to someone who wants in. StakePort is a trustless market for native stake: no LST, no custodian, no key transfer." |
| 0:30–0:50 | fair value card | "Bought stake earns 26 days sooner than a new deposit, so its fair value is the buyer's break-even: 32 × (1 + APR × 26 days / 365) — here +0.18%, with queues from the real beacon state and APR from Lido's public API." |
| 0:50–1:20 | Step 1 | "The seller is a real mainnet validator operator. Its withdrawal address delegates via **EIP-7702** to our contract and lists at the fair price." Click *Enable 7702 and list*. |
| 1:20–2:00 | Step 2 | (Or *Buy with ETH*: one transaction, no approval.) "The buyer pays with USDC. **One Uniswap v4 swap**: our hook routes through the canonical pool, escrows WETH, verifies **SSZ proofs of both validators against an EIP-4788 root**, and submits an **EIP-7251** consolidation from the seller's address." Click *Buy with USDC*. |
| 2:00–2:40 | Step 3 | "Checkpoint 1: the consensus layer accepted it. This proof is not simulated — it's the **real mainnet beacon state** from block 26058400, where this exact consolidation happened." Click *Relay checkpoint 1*; point at the green **real** badge. |
| 2:40–3:10 | Step 4 | "Delivery is ~3 days later on mainnet, so we fast-forward a simulated state; the contract verifies it the same way and releases the payment." Click *Fast-forward*. |
| 3:10–3:25 | terminal: `pnpm -s hoodi-check` | "And it's live on **Hoodi**. This takes a real consolidation waiting in today's Hoodi beacon state and proves it against our deployed oracle, the exact checkpoint-1 check: proofs fetched from a public Lodestar node, no state download, and forged claims revert." |
| 3:25–3:45 | `/bids`, `/` (Verified Market) | "Buyers can also post self-custodial standing bids on **1inch Aqua**, priced by a **SwapVM Dutch auction** that raises the offer from 99% to 101% of face over 18 hours until it crosses a listing (click *+1 hour* a few times, then *Match*); funds stay in the wallet until then. And sellers can require a **World ID** document credential: unverified buyers are rejected onchain." |
| 3:45–4:00 | `/portfolio` | "A dashboard tells operators what to do next. Native stake becomes a liquid, trustless asset — without leaving Ethereum's consensus layer." |

## Q&A cheat sheet

See [QA.md](QA.md). Top three: why a premium (entry queue), what's real (checkpoint 1 is real mainnet data), what if
the seller cheats (every path ends in a proof-based refund).

## 3-minute video script (~380 spoken words, plus clicks)

| Time | Screen / action | Say |
|---|---|---|
| 0:00–0:15 | `/`, page header | "Hi, I'm Hiroshi. This is StakePort, a marketplace where Ethereum validators sell their active stake directly to other validators. The stake moves on the consensus layer, and the payment is released only when beacon-chain proofs show it arrived." |
| 0:15–0:35 | queue panel | "Why would anyone buy stake? Right now, new ETH waits about 29 days in the entry queue, earning nothing. Meanwhile, validators who want out have no way to hand their active stake to someone who wants in. StakePort connects them: no LST, no custodian, no key transfer." |
| 0:35–0:55 | fair value card | "Because bought stake starts earning 26 days sooner than a new deposit, a buyer can rationally pay a premium, up to their break-even. Here that's +0.18%, computed from the real beacon-state queues and Lido's APR." |
| 0:55–1:15 | `/demo`, Step 1: click *Enable 7702 and list* | "The seller is a real mainnet validator on a mainnet fork. Its withdrawal address delegates via EIP-7702 to our contract, which can only trigger a consolidation for an order the seller listed, and only once the payment is escrowed." |
| 1:15–1:45 | Step 2: click *Buy with USDC* | "The buyer already runs a compounding validator and wants more stake. They pay in USDC with a single Uniswap v4 swap. Our hook routes the USDC through the canonical ETH/USDC pool, escrows the WETH, verifies SSZ proofs of both validators against an EIP-4788 beacon root, and submits an EIP-7251 consolidation from the seller's address, all in one transaction." |
| 1:45–2:10 | Step 3: click *Relay checkpoint 1*, point at the **real** badge | "Checkpoint 1 proves the consensus layer accepted the request. This isn't simulated: it's the real mainnet beacon state from the block where this exact consolidation happened." |
| 2:10–2:25 | Step 4: click *Fast-forward* | "The stake arrives about a day later, so we fast-forward. The contract checks the source was drained without being slashed, and releases the payment to the seller. If anything fails, a proof refunds the buyer." |
| 2:25–2:45 | terminal: `pnpm -s hoodi-check` | "It's also deployed on Hoodi. This takes a consolidation waiting in today's Hoodi beacon state and proves it against our deployed oracle, the same check as checkpoint 1. Forged claims revert." |
| 2:45–3:10 | `/bids`: *+1 hour* a few times, then *Match* | "Buyers can also post standing bids with 1inch Aqua. Funds stay in their wallet. A SwapVM Dutch auction raises the offer from 99 to 101% of face value until it crosses a listing, and the match pulls exactly the payment." |
| 3:10–3:25 | `/`: Verified Market listing, then `/portfolio` | "Sellers who must avoid sanctioned counterparties can require a World ID document credential, enforced onchain. With StakePort, native stake becomes a liquid, trustless asset without leaving Ethereum's consensus layer." |

## Video script without `/demo` (~3:40, page by page)

Before recording: restart the stack and pre-list #205611 (plain) and #205612 (Verified Market) at fair value from
`/sell`. Record with a buyer that has no World ID attestation.

| Time | Screen / action | Say |
|---|---|---|
| 0:00–0:15 | `/`, page header | "Hi, I'm Hiroshi. This is StakePort, a marketplace where Ethereum validators sell their active stake directly to other validators. The stake moves on the consensus layer, and the payment is released only when beacon-chain proofs show it arrived." |
| 0:15–0:35 | `/`, queue panel | "Why would anyone buy stake? Right now, new ETH waits about 29 days in the entry queue, earning nothing. Meanwhile, validators who want out have no way to hand their active stake to someone who wants in. StakePort connects them: no LST, no custodian, no key transfer." |
| 0:35–0:50 | `/`, fair value card | "Because bought stake starts earning 26 days sooner than a new deposit, a buyer can rationally pay a premium, up to their break-even. Here that's +0.18%, computed from the real beacon-state queues and Lido's APR." |
| 0:50–1:15 | *Acting as: Seller* → **Sell**: pick #2102426 (real mainnet replay), show Delegate *active*, *Use it*, *List validator #2102426* | "Now I'm the seller, a real mainnet validator on a mainnet fork. Its withdrawal address is delegated via EIP-7702 to our contract, which can only trigger a consolidation for an order the seller listed, and only after the payment is escrowed. I list it at fair value." |
| 1:15–1:50 | *Acting as: Buyer* → **Market** → #2102426 *Buy stake*: pick the *real mainnet target*, *USDC via Uniswap v4*, *Buy 32 ETH of native stake* | "Now the buyer, who already runs a compounding validator and wants more stake. They pay in USDC with a single Uniswap v4 swap. Our hook routes the USDC through the canonical ETH/USDC pool, escrows the WETH, verifies SSZ proofs of both validators against an EIP-4788 beacon root, and submits an EIP-7251 consolidation from the seller's address, all in one transaction." |
| 1:50–2:10 | trade page (opens after the buy): *Relay beacon proof* | "This is the trade page. Checkpoint 1 proves the consensus layer accepted the request. And this isn't simulated: it's the real mainnet beacon state from the block where this exact consolidation happened." |
| 2:10–2:25 | *Fast-forward to delivery & relay proof* | "The stake arrives about a day later, so we fast-forward. The contract checks the source was drained without being slashed, and releases the payment to the seller. If anything fails, a proof refunds the buyer." |
| 2:25–2:45 | terminal: `pnpm -s hoodi-check` | "It's also deployed on Hoodi. This takes a consolidation waiting in today's Hoodi beacon state and proves it against our deployed oracle, the same check as checkpoint 1. Forged claims revert." |
| 2:45–3:15 | **Bids**: *Dutch auction (SwapVM)*, *Ship bid to Aqua*, *⏩ +1 hour (fork clock)* until #205611 shows under *Matchable now*, *Match* | "Buyers can also post standing bids with 1inch Aqua. Funds stay in their wallet. A SwapVM Dutch auction raises the offer from 99 to 101% of face value over time. Once it crosses a listing, anyone can match it, and Aqua pulls exactly the payment." |
| 3:15–3:30 | **Market** → #205612 (World ID badge) → *Try to buy without verification* | "Some sellers must avoid counterparties in sanctioned jurisdictions, so they can require a World ID document credential. A buyer without it is rejected onchain, not just in the UI." |
| 3:30–3:40 | **Portfolio** | "Finally, a dashboard tells operators what to do next. With StakePort, native stake becomes a liquid, trustless asset without leaving Ethereum's consensus layer." |

## Recording the demo video (2–4 min, ≥720p, own voice, no speed-up)

Record the table above with screen capture (QuickTime → New Screen Recording). Cut the waits between clicks instead
of speeding up.
