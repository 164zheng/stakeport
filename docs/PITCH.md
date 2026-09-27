# Pitch scripts

Honesty rules for every pitch: checkpoint 1 in the fork demo is real mainnet beacon data, checkpoint 2 is a
simulated fast-forward; on Hoodi the contracts are deployed and a live third-party consolidation was proven through
checkpoint 1 and the delivery predicate, not a StakePort trade. World is a document credential, not KYC.

## Uniswap Foundation (~3 min)

**Hook.** "What if a Uniswap swap could buy something that isn't a token at all? StakePort uses a v4 hook to buy
native Ethereum validator stake: USDC in, stake delivered to your validator, in one swap."

**Problem (20s).** "New ETH waits about 29 days in the entry queue, earning nothing. Validators who want out
can't hand their active stake to someone who wants in without an LST or a custodian. StakePort is a trustless
market for that stake, and Uniswap is how buyers pay."

**How the hook works (60s)** *(show `StakePortHook.sol` L111, or the buy page)*
- "The hook pool is ETH/USDC with zero liquidity. It is purely an entry point. Adding liquidity reverts."
- "In `beforeSwap`, the hook takes the exact input and swaps it through the **canonical ETH/USDC 0.3% pool**
  inside the same unlock. Flash accounting lets us take the ETH and return a `BeforeSwapDelta` that consumes the
  whole input, so the core pool swap is a no-op."
- "With that ETH, it calls our market: the payment is escrowed as WETH, SSZ proofs of both validators are
  checked against an EIP-4788 beacon root, and an EIP-7251 consolidation is submitted from the seller's
  EIP-7702-delegated address. If any proof fails, the whole swap reverts."
- "Leftover ETH is refunded. The swapper gets no output token: the output is stake on the consensus layer."

**Pricing (20s).** "Sellers can price relative to the LST market. We read a 30-minute TWAP from the v3
wstETH/WETH 0.01% pool through `observe()`, and the market evaluates it at fill time, so the price can't be moved
within a block."

**Demo (40s)** *(buy page)*: "Pay with USDC via Uniswap v4" → Buy → trade page. "One transaction: swap, escrow,
proof verification, consolidation request."

**Close (20s).** "Everything runs against the real mainnet PoolManager, canonical pool, V4Quoter and StateView on a
fork, with fork tests. Our feedback is in FEEDBACK.md. The single biggest ask: ship BaseHook and HookMiner in one
importable package with a BeforeSwapDelta sign table."

**Likely questions**
- *Why a hook, not a router?* "The buyer's entry point is a normal v4 swap: any v4-aware wallet or aggregator can
  route into it with hookData, and the purchase is atomic with the price it got."
- *MEV / slippage?* "The swapper sets the minimum; the stake price is fixed by the order or the TWAP, and the
  consolidation can't be front-run into another target because the order binds the source and the proofs bind
  the target."
- *Why v3 for the TWAP?* "v4 has no built-in oracle; the v3 pool has deep wstETH liquidity and `observe()`."

## 1inch (~3 min)

**Hook.** "Standing bids for native stake, where the buyer's money never leaves their wallet until the stake is
actually bought. That's 1inch Aqua plus a SwapVM Dutch auction."

**Problem (20s).** "Stake is illiquid and lumpy: a seller shows up with 32 or 2048 ETH at a random time. Buyers
want to wait at a price without locking capital in escrow for days. Aqua's shared-liquidity model fits exactly."

**How it works (70s)** *(show `AquaStakeBidApp.sol`)*
- "A buyer **ships** a StakeBid strategy to the **official Aqua registry**: their target validator, a size range,
  a hard price cap, and a SwapVM pricing program. The WETH budget stays in their wallet."
- "The price comes from a **SwapVM program**: StaticBalances, then DutchAuctionBalanceOut, then LimitSwap. In the
  demo it raises the offer from 99% to 101% of face over about 18 hours. We quote it onchain with a static call
  to SwapVM's `quote`, so the app never re-implements pricing."
- "When the bid price crosses a listing, **anyone** can call `matchBid`. It checks the price and size, Aqua
  **pulls exactly the listing's price** from the buyer's wallet into escrow, and the market verifies the beacon
  proofs and submits the consolidation. All atomic."
- "Aqua keys balances by the shipper, so an impostor's bid pulls nothing, and the target validator is fixed in
  the strategy, so a matcher can't redirect the stake."

**Demo (40s)** *(`/bids`)*: Ship bid to Aqua → "+1 hour" a few times → "Matchable now" → Match → show the WETH
pull with `pnpm -s tx --last`.

**Close (20s).** "One honest note: the mainnet SwapVM deployment is the AMM-only Aqua router without the auction
opcodes, so on the fork we deploy the official, unmodified SwapVMRouter v1.0.2 from source. Opcode numbers are
checked against its table in tests."

**Likely questions**
- *Why Aqua, not a limit order?* "A limit order is a fixed price; here the price is a program that moves with
  time, and the funds are shared across the buyer's strategies instead of locked per order."
- *What if the buyer spends the WETH?* "Then `pull` fails and the match reverts; `available()` shows the live
  budget, so matchers skip it."
- *Who runs the matcher?* "It's permissionless: the seller, the buyer or a keeper. In the demo I click Match."

## World (~3 min)

**Hook.** "Some sellers can't sell their stake to just anyone. A fund must avoid counterparties in sanctioned
jurisdictions. StakePort lets them list in a Verified Market that only World ID document holders can buy from,
enforced onchain."

**Why this credential (30s).** "The rule a seller really needs is nationality. That's World ID Identity Check,
which is in preview. The best credential available today is the **NFC document credential**: a real
government-issued passport or My Number Card, one account per document, no personal data revealed. It's not KYC,
and the UI says so. When Identity Check ships, it replaces this: the policy is a pluggable contract."

**How it works (60s)**
- "IDKit requests a World ID 4.0 proof with `any(passport, mnc)`, legacy proofs disabled, and the buyer's address
  as the signal, with an RP signature from our backend."
- "The backend checks the action, the credential type and that the signal is the buyer, verifies the proof with
  the Developer Portal `/api/v4/verify`, and signs an EIP-712 attestation."
- "`WorldIdEligibility` records it onchain and binds one nullifier to one account. The market checks the listing's
  policy at fill time **for every route**: WETH, the Uniswap hook and Aqua bids."
- "World ID 4.0 proofs verify onchain only on World Chain, and our market is on Ethereum, so the backend carries
  the result as a signed attestation."

**Demo (40s).** Unverified buyer on the Verified listing → "Try to buy without verification" → "Rejected onchain
(BuyerNotEligible)". Then, if time allows, verify live with World App and buy.

**Close (20s).** "We verified this end to end in production with a real World App and a My Number Card. Our
debrief covers what we hit: the passport preset returning a legacy proof, My Number Card being a separate `mnc`
identifier, and staging actions."

**Likely questions**
- *Isn't this KYC?* "No. It proves a real document holder and uniqueness. It can't check nationality until
  Identity Check is available."
- *Can a verified user sell their eligibility?* "One nullifier binds to one account onchain, so a credential can't
  be spread across addresses. Handing over a whole account is outside what any credential can stop."
- *Why a backend attester?* "4.0 proofs verify onchain only on World Chain. The attester only forwards
  Portal-verified results, and its key is the one trust assumption, documented in QA.md."

## Finalist (~4 min + Q&A)

**Opening (20s).** "Right now 1.67 million ETH is waiting about 29 days to become active, earning nothing. At the
same time, validators who want to leave have no way to hand their active stake to someone who wants in. Not
without an LST, a custodian or trusting someone with keys. StakePort is a trustless market for native Ethereum
stake."

**The idea (40s).** "Pectra quietly made this possible.
- **EIP-7251** consolidation moves a validator's whole balance into another validator on the consensus layer.
- **EIP-7702** lets the seller's withdrawal address run our contract, so the consolidation can be triggered only
  when the buyer's payment is escrowed.
- **EIP-4788** gives the EVM the beacon block root, so a contract can verify, with Merkle proofs and no oracle,
  that the stake actually moved.
Put together, that's delivery-versus-payment for native stake."

**Why buyers pay a premium (20s).** "Bought stake starts earning weeks sooner than a new deposit. So the buyer can
rationally pay up to their break-even: today about +0.18%. That's the seller's reason to use StakePort instead of
exiting."

**Demo (120s)** *(fork of mainnet)*
1. Seller: a real mainnet validator lists at fair value.
2. Buyer pays in USDC through **one Uniswap v4 swap**. The hook escrows WETH, verifies proofs of both validators
   and submits the consolidation in the same transaction.
3. **Checkpoint 1**: the consensus layer accepted it. "This is not simulated: it's the real mainnet beacon state
   where this exact consolidation happened."
4. **Checkpoint 2** (fast-forwarded): the source is drained and not slashed, and the payment goes to the seller.
5. Terminal: `hoodi-check`. "Deployed on Hoodi. A live consolidation from today's Hoodi state proven against our
   oracle, and after it was processed, the delivery check passes too."

**Trust model (30s).** "Every step ends in a proof. If the consensus layer ignores the request, a proof refunds the
buyer. If the source is slashed, a proof refunds the buyer. The seller is paid only on a delivery proof. No oracle,
no custodian, no keys change hands. We also hardened it: exact epochs from the header slot, and a 6-hour delay
before 'not accepted' refunds so a buyer can't game the EIP-7251 request queue."

**More ways to trade (20s).** "Buyers can post standing bids on **1inch Aqua** with a SwapVM Dutch auction, funds
staying in their wallet. Sellers can require **World ID**, enforced onchain."

**Close (10s).** "StakePort turns native stake into a liquid, trustless asset without leaving Ethereum's consensus
layer."

**Likely questions**
- *What's real vs simulated?* "Checkpoint 1 in the demo is real mainnet data. Delivery takes at least ~27 hours
  on mainnet, so the fork fast-forwards it with a simulated state, which the contract verifies the same way. On
  Hoodi, both checks pass on a live consolidation, though not one traded through StakePort."
- *Why not just use an LST?* "An LST gives you a token with its own risks and fees. This gives the buyer native
  stake in their own validator, and the seller an exit without the exit queue."
- *Who is the buyer?* "Operators already running a compounding (0x02) validator who want more stake. Top-up
  deposits wait in the same queue as new validators."
- *What if nobody relays checkpoint 1?* "Anyone can, and our relayer does it automatically. The accept window is
  capped at 2 days, while acceptance stays provable for at least ~55 hours, so it can't expire while the proof is
  unavailable."
- *Is it audited?* "No, it's hackathon code, with 136 Foundry tests including mainnet-fork and real-data tests."

## Q&A bank (any judge)

### Product and economics
- *Who is the buyer?* "An operator already running a compounding (0x02) validator who wants more stake. A top-up
  deposit waits in the same entry queue as a new validator, so buying active stake is the faster way to grow."
- *Who is the seller?* "Anyone who wants out: exiting takes the exit queue plus the withdrawability delay and
  forfeits the entry-queue value their stake has. Selling captures that value as a premium."
- *Only +0.18%? Why would anyone bother?* "On 32 ETH that's small, but the premium scales with the queue: 29 days
  today, over 40 at the 2025 peaks, and a consolidation can carry up to 2048 ETH. The fair value is the buyer's
  break-even, so sellers can ask anything up to it."
- *What if the entry queue is empty?* "Then the premium is zero and StakePort is simply an exit route that skips
  the exit queue for the seller. The formula floors the gain at zero."
- *Why not just use an LST?* "An LST is a token with its own smart-contract, peg and fee risks. Here the buyer ends
  up with native stake in their own validator, and no protocol sits between them and the beacon chain."
- *Who earns the rewards between the fill and delivery?* "The seller's validator keeps earning until the
  consolidation is processed; only the effective balance moves, and any excess is swept to the seller. The fair
  value already prices in the delivery wait."
- *Business model?* "None in the hackathon build: no fee. A protocol fee on the escrowed payment would be one line."
- *How is this different from OTC validator sales?* "OTC today means transferring validator keys or trusting an
  intermediary. Here keys never change hands and payment is released only on a consensus-layer proof."

### Protocol mechanics
- *Why is a proof needed at all?* "The EIP-7251 predeploy accepts any request and charges the fee; whether the
  consensus layer accepted it and moved the stake is only visible in the beacon state, and the only trustless way
  to read that from the EVM is a Merkle proof against the EIP-4788 root."
- *How long does delivery take?* "At least ~27 hours (a 256-epoch withdrawability delay after the exit epoch),
  plus the consolidation churn queue: about 2.8 days on mainnet today."
- *What if nobody relays checkpoint 1?* "Anyone can, and the relayer does it automatically. The accept window is
  capped at 2 days, and acceptance stays provable for at least ~55 hours, so the window never closes while the
  proof is unavailable."
- *How much gas?* "A fill is about 570k gas including both validator proofs and the consolidation request; each
  checkpoint is one state-root proof plus one or two branches."
- *Which sources can be sold?* "Active, non-exiting, not slashed, 0x01 or 0x02 credentials pointing to the
  seller's address, and active for at least 256 epochs (the protocol's own rule for consolidation sources)."
- *What about a 0x02 source with pending partial withdrawals?* "The consensus layer ignores the request, the
  source never starts exiting, and the buyer is refunded with `proveNotAccepted`."
- *How many consolidations fit per block?* "The predeploy dequeues two per block and prices extra requests
  exponentially, which is also what bounds the queue-delay attack."
- *Does it work after the next fork?* "The generalized indices are for the Fulu BeaconState layout and are checked
  against lodestar in tests. A fork that changes the layout means new constants, like every beacon-proof protocol."

### Security
- *Can the seller take the money without delivering?* "No. Payment needs checkpoint 1, which proves the queue
  holds exactly (source, target), and then a delivery proof. Once queued, the source is exiting and can't be
  redirected or withdrawn."
- *Can the buyer get the stake and a refund?* "That was our biggest review finding. A buyer could queue junk
  EIP-7251 requests ahead of the fill and prove 'not accepted' before its request was dequeued. The fix: that
  refund needs a state at least 6 hours after the fill. Queueing 1,800 blocks of requests would cost about e^211 wei
  each."
- *Can the seller sell the same validator twice?* "No, a source with an open trade can't be filled again until it
  settles or fails."
- *What if the seller's validator is slashed?* "Before processing, the consolidation is skipped and `proveFailed`
  refunds the buyer. After processing, the source can no longer be slashed, because the withdrawable epoch has
  passed."
- *Could the seller slash themselves on purpose?* "Only to lose their own stake: the buyer is refunded in full."
- *What if the proof data is wrong or the beacon node lies?* "Nothing is trusted: every branch must hash to the
  EIP-4788 root. A lying node can only make a proof fail."
- *What about missed slots?* "The header slot is bound inside the state-root proof, so epochs are exact, not
  derived from timestamps."
- *Is it audited?* "No. It's hackathon code with 136 Foundry tests, including mainnet-fork tests on real beacon
  data. The threat model is in docs/QA.md."

### UX and deployment
- *Why does the seller paste a private key?* "Only on testnet. Wallets block arbitrary EIP-7702 delegations today.
  For production: a Safe module for institutional sellers, or a wallet delegation framework (ERC-7710) with a
  caveat that checks the escrow; short term, a signed authorization from Foundry or a Ledger instead of the key."
- *Is it live?* "The contracts are on Hoodi and the frontend is at stakeport.vercel.app. A full trade needs
  your own Hoodi validators, so the complete flow is shown on a mainnet fork, where checkpoint 1 uses real mainnet
  beacon data."
- *What's simulated?* "On the fork, only the delivery state (checkpoint 2), because it happens days later. On
  Hoodi we proved both checks on a live third-party consolidation, not one traded through StakePort."
- *What would it take to go to mainnet?* "An audit, a production signing path for the seller (Safe module or
  ERC-7710), a monitored relayer, and Identity Check instead of the document credential for the Verified Market."
