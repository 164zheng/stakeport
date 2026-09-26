# StakePort: threat model and judge Q&A

## Trust assumptions

| Component | Trusted for | Not trusted for |
|---|---|---|
| Ethereum consensus + EIP-4788 | beacon block roots | — |
| StakePort contracts | escrow and settlement logic (immutable, no admin) | — |
| Proof relayers (anyone) | liveness only | correctness: every proof is verified onchain |
| Seller | nothing: payment is released only on a delivery proof | — |
| Buyer | nothing: refunds need a proof or an expired accept window | — |
| World ID attester (Verified Market only) | that it forwarded a Developer Portal-verified proof | fills of open listings |
| Uniswap wstETH TWAP (LST-relative orders only) | reference price over 30 min | single-block manipulation |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Seller sells the same validator twice | `activeTradeBySource` blocks a second fill until the first settles or fails. |
| Seller front-runs with its own consolidation or exit | The request is ignored by the CL; anyone proves the source exit was never initiated (`proveNotAccepted`) or waits out `acceptWindow` (`refundExpired`); the buyer is refunded. |
| Source slashed before delivery | The consolidation is skipped by the CL; `proveFailed` refunds the buyer. `proveDelivered` also requires `slashed == false`. |
| Fake delivery | Delivery requires a proof that the source is past `withdrawable_epoch`, not slashed and its balance is < 1 ETH; pending consolidations are processed in queue order before the withdrawal sweep. |
| Buyer griefs by claiming failure | A refund needs a proof from a state after the fill showing no exit (or slashing); the real post-state refutes it (`test_realState_refutesNotAcceptedClaim`). |
| Stale or forged beacon data | Roots come from the EIP-4788 contract; fills require a proof no older than `maxProofAge`; SSZ branches are checked against fixed generalized indices (Fulu layout, tested against lodestar). |
| Anyone triggers a consolidation from the seller's address | The 7702 delegate only accepts calls from the market, and the market only for a signed or seller-listed order with escrowed payment. |
| Target over capacity | Fill requires `target.effective_balance + source.effective_balance <= 2048 ETH`. |
| Hook abuse (Uniswap) | The hook pool holds no liquidity (adding liquidity reverts), only accepts exact-input token→ETH swaps, and keeps no funds; an invalid proof reverts the whole swap. |
| Aqua bid drained or redirected | Aqua keys balances by the shipper (an impostor's bid pulls nothing); the stake target is fixed in the bid strategy; price and size limits are checked before `pull`. |
| World ID replay / account sharing | Proof signal = buyer address; the attestation binds one nullifier to one account; credential type and expiry are enforced onchain. |

## Known limitations (say them before the judges do)

- Hackathon code, not audited.
- The demo runs on a mainnet fork: the EL is real, but no consensus layer processes our fork's own request. Checkpoint 1 of the replayed pair uses the real post-request beacon state; checkpoint 2 is simulated (delivery is ~3 days away on mainnet).
- The delivery predicate relies on consolidation processing order; a production version would also prove the target's balance increase.
- 0x02 sources with pending partial withdrawals are rejected by the CL; the buyer is refunded, but the UI does not pre-check it.
- The seller keeps the validator keys until the consolidation is processed (slashing risk is on the refund path, not insured).
- World ID 4.0 proofs are verified by the World Developer Portal; the Ethereum-side registry trusts the backend attester.

## Likely questions

**Why not just use an LST?** An LST is a claim on a pool. StakePort moves the validator's own active stake: no issuer,
no depeg, no custody, and the buyer ends up with native stake on their own validator.

**Why would anyone pay a premium?** New stake waits ~29 days in the entry queue earning nothing (1.67M ETH pending at
the demo slot). Bought stake arrives in ~2.8 days and earns from then, so paying up to ~0.2% more is rational. The
seller's alternative (exit) is fast right now, so sellers won't discount. The fair band is computed from the real
beacon state.

**What if the queues flip?** Then exits are slow and sellers pay for liquidity (discount). Pricing is market-driven;
the UI shows the band for whatever the current queues are.

**Why two checkpoints?** The EIP-4788 buffer keeps ~27 hours of roots, but delivery takes at least 256 epochs plus the
consolidation queue. Checkpoint 1 locks in the acceptance; checkpoint 2 proves delivery later.

**Who relays proofs?** Anyone: settlement is permissionless and proofs are verified onchain. The seller is
incentivised to prove delivery; the buyer to prove failure.

**What is real in the demo?** Validators, beacon states, fill proofs, the EIP-4788 root, the EIP-7251 predeploy,
Uniswap liquidity, Aqua, Chainlink, World ID (production World App). Checkpoint 1 of the replayed pair is real mainnet
data (tx `0xb94605dc…1c06f6`, block 26058400). Checkpoint 2 is simulated and labelled.

**Why does the seller need EIP-7702?** EIP-7251 authenticates the request by `msg.sender == withdrawal address`. A
plain EOA cannot run escrow logic; 7702 lets it run the StakePort delegate so the consolidation fires only together
with an escrowed payment.

**Why World ID Passport and not KYC?** The seller's rule (no sanctioned jurisdictions) needs nationality, which World
ID Identity Check will provide; today the minimum sufficient assurance is an NFC government document credential. We
say explicitly that it is not a sanctions check.
