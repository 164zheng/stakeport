import { decodeAbiParameters, erc20Abi, parseEther, type Address, type Hex } from "viem";
import { nativeStakeMarketAbi } from "@/generated/abis";
import {
  balanceProofAbi,
  pendingConsolidationProofAbi,
  stateRootProofAbi,
  validatorProofAbi,
} from "@/generated/proofAbi";
import { api } from "./api";
import { publicClient, testClient, write } from "./chain";
import { INDEXER_URL, IS_FORK, getDeployment } from "./config";

export interface StakeOrder {
  seller: Address;
  sourcePubkey: Hex;
  sourceIndex: bigint;
  priceMode: number;
  price: bigint;
  minPayment: bigint;
  expiry: bigint;
  nonce: bigint;
}

export type OrderState = "open" | "filled" | "cancelled" | "expired" | "trading";

export interface Listing {
  hash: Hex;
  order: StakeOrder;
  state: OrderState;
  blockNumber: bigint;
  /** eligibility policy (e.g. World ID Verified Market); zero address = open to everyone */
  policy: Address;
}

export const TradeStatus = ["None", "RequestSubmitted", "Accepted", "Delivered", "Failed"] as const;
export type TradeStatusName = (typeof TradeStatus)[number];

export interface Trade {
  id: bigint;
  seller: Address;
  buyer: Address;
  sourceIndex: bigint;
  targetIndex: bigint;
  amountGwei: bigint;
  filledAt: bigint;
  withdrawableEpoch: bigint;
  status: TradeStatusName;
  payment: bigint;
  fillTx?: Hex;
}

const dec = <T>(abi: unknown, data: Hex) => decodeAbiParameters([abi as never], data)[0] as T;
const wethAbi = [
  ...erc20Abi,
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

interface IndexedListing {
  hash: Hex;
  order: Record<string, string | number>;
  policy: Address | null;
  cancelled: boolean;
  listed: { block: string };
}

const toOrder = (o: Record<string, string | number>): StakeOrder => ({
  seller: o.seller as Address,
  sourcePubkey: o.sourcePubkey as Hex,
  sourceIndex: BigInt(o.sourceIndex),
  priceMode: Number(o.priceMode),
  price: BigInt(o.price),
  minPayment: BigInt(o.minPayment),
  expiry: BigInt(o.expiry),
  nonce: BigInt(o.nonce),
});

/** Listed orders, from the indexer when configured (free RPC tiers cap eth_getLogs ranges). */
async function listedOrders(): Promise<{ hash: Hex; order: StakeOrder; blockNumber: bigint; cancelled?: boolean }[]> {
  if (INDEXER_URL) {
    const rows = (await fetch(`${INDEXER_URL}/api/index/listings`, { cache: "no-store" }).then((r) => r.json())) as IndexedListing[];
    return rows
      .map((r) => ({ hash: r.hash, order: toOrder(r.order), blockNumber: BigInt(r.listed.block), cancelled: r.cancelled }))
      .reverse();
  }
  const d = await getDeployment();
  const logs = await publicClient.getContractEvents({
    address: d.market,
    abi: nativeStakeMarketAbi,
    eventName: "OrderListed",
    fromBlock: BigInt(d.deployBlock),
  });
  return logs.map((l) => ({ hash: l.args.orderHash as Hex, order: l.args.order as unknown as StakeOrder, blockNumber: l.blockNumber }));
}

export async function listings(): Promise<Listing[]> {
  const d = await getDeployment();
  const orders = await listedOrders();
  const now = (await publicClient.getBlock()).timestamp;
  const out: Listing[] = [];
  for (const log of orders) {
    const order = log.order;
    const [used, active, policy] = await Promise.all([
      publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "nonceUsed", args: [order.seller, order.nonce] }),
      publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "activeTradeBySource", args: [order.sourceIndex] }),
      publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "policyOf", args: [log.hash] }),
    ]);
    const state: OrderState = used ? "filled" : order.expiry < now ? "expired" : active !== 0n ? "trading" : "open";
    out.push({ hash: log.hash, order, state: log.cancelled ? "cancelled" : state, blockNumber: log.blockNumber, policy: policy as Address });
  }
  if (!INDEXER_URL) {
    // A used nonce may also be a cancellation; mark those via the cancel event.
    const cancels = await publicClient.getContractEvents({
      address: d.market,
      abi: nativeStakeMarketAbi,
      eventName: "OrderCancelled",
      fromBlock: BigInt(d.deployBlock),
    });
    for (const c of cancels) {
      for (const l of out) if (l.order.seller === c.args.seller && l.order.nonce === c.args.nonce) l.state = "cancelled";
    }
  }
  return out.reverse();
}

export async function getTrade(id: bigint): Promise<Trade> {
  const d = await getDeployment();
  const t = (await publicClient.readContract({
    address: d.market,
    abi: nativeStakeMarketAbi,
    functionName: "getTrade",
    args: [id],
  })) as unknown as Omit<Trade, "id" | "status"> & { status: number };
  return { ...t, id, status: TradeStatus[t.status] };
}

export async function trades(): Promise<Trade[]> {
  const d = await getDeployment();
  if (INDEXER_URL) {
    const rows = (await fetch(`${INDEXER_URL}/api/index/trades`, { cache: "no-store" }).then((r) => r.json())) as {
      tradeId: string;
      filled: { tx: Hex };
    }[];
    // statuses are read from the contract; the indexer only supplies ids and transactions
    return Promise.all(rows.map(async (r) => ({ ...(await getTrade(BigInt(r.tradeId))), fillTx: r.filled.tx })));
  }
  const logs = await publicClient.getContractEvents({
    address: d.market,
    abi: nativeStakeMarketAbi,
    eventName: "OrderFilled",
    fromBlock: BigInt(d.deployBlock),
  });
  const out = await Promise.all(
    logs.map(async (l) => ({ ...(await getTrade(l.args.tradeId as bigint)), fillTx: l.transactionHash })),
  );
  return out.reverse();
}

export async function isDelegated(eoa: Address) {
  const d = await getDeployment();
  const code = await publicClient.getCode({ address: eoa });
  return code?.toLowerCase() === `0xef0100${d.delegate.slice(2)}`.toLowerCase();
}

export async function wethBalance(a: Address) {
  const d = await getDeployment();
  return publicClient.readContract({ address: d.weth, abi: wethAbi, functionName: "balanceOf", args: [a] });
}

export async function quote(order: StakeOrder, amountGwei: bigint) {
  const d = await getDeployment();
  return publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "quote", args: [order, amountGwei] });
}

// ------------------------------------------------------------------------------------------------
// Demo helpers (anvil only)
// ------------------------------------------------------------------------------------------------

/**
 * In production the seller's wallet signs an EIP-7702 authorization for the StakePort delegate.
 * On the fork we do not hold the real seller's key, so we set the delegation designator directly.
 */
export async function enableDelegation(eoa: Address) {
  if (!IS_FORK) throw new Error("On a real network the seller signs an EIP-7702 authorization (see Delegate7702)");
  const d = await getDeployment();
  await testClient.setCode({ address: eoa, bytecode: `0xef0100${d.delegate.slice(2)}` as Hex });
}

export async function fundPersona(a: Address, ethAmount = "100") {
  if (!IS_FORK) return; // real networks: the user's own funds
  const bal = await publicClient.getBalance({ address: a });
  if (bal < parseEther("1")) await testClient.setBalance({ address: a, value: parseEther(ethAmount) });
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export async function listOrder(order: StakeOrder, verifiedOnly = false) {
  const d = await getDeployment();
  await fundPersona(order.seller);
  if (verifiedOnly) {
    if (!d.worldEligibility) throw new Error("WorldIdEligibility not deployed");
    return write({
      account: order.seller,
      address: d.market,
      abi: nativeStakeMarketAbi,
      functionName: "listOrderWithPolicy",
      args: [order, d.worldEligibility],
    });
  }
  return write({ account: order.seller, address: d.market, abi: nativeStakeMarketAbi, functionName: "listOrder", args: [order] });
}

export const isVerifiedMarket = (l: Listing) => l.policy !== "0x0000000000000000000000000000000000000000";

export async function cancelOrder(seller: Address, nonce: bigint) {
  const d = await getDeployment();
  return write({ account: seller, address: d.market, abi: nativeStakeMarketAbi, functionName: "cancelOrder", args: [nonce] });
}

export async function fillProofs(source: number, target: number) {
  const p = await api.fillProofs(source, target);
  return {
    state: dec(stateRootProofAbi, p.stateRootProof),
    source: dec<{ index: bigint; validator: { pubkey: Hex } }>(validatorProofAbi, p.sourceProof),
    target: dec<{ index: bigint; validator: { pubkey: Hex } }>(validatorProofAbi, p.targetProof),
  };
}

/** Buys with WETH (wrapping ETH if needed). Returns the new trade id. */
export async function fillWithWeth(listing: Listing, buyer: Address, targetIndex: number, onStep?: (s: string) => void) {
  const d = await getDeployment();
  await fundPersona(buyer);
  onStep?.("Generating beacon state proofs");
  const proofs = await fillProofs(Number(listing.order.sourceIndex), targetIndex);
  const payment = await quote(listing.order, BigInt((proofs.source.validator as unknown as { effectiveBalance: bigint }).effectiveBalance));

  const bal = await wethBalance(buyer);
  if (bal < payment) {
    onStep?.("Wrapping ETH");
    await write({ account: buyer, address: d.weth, abi: wethAbi, functionName: "deposit", value: payment - bal });
  }
  const allowance = await publicClient.readContract({ address: d.weth, abi: wethAbi, functionName: "allowance", args: [buyer, d.market] });
  if (allowance < payment) {
    onStep?.("Approving WETH");
    await write({ account: buyer, address: d.weth, abi: wethAbi, functionName: "approve", args: [d.market, 2n ** 256n - 1n] });
  }
  onStep?.("Escrowing payment and submitting EIP-7251 consolidation");
  await write({
    account: buyer,
    address: d.market,
    abi: nativeStakeMarketAbi,
    functionName: "fill",
    args: [listing.order, "0x", proofs.target.validator.pubkey, proofs, buyer],
    value: parseEther("0.01"),
  });
  const next = (await publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "nextTradeId" })) as bigint;
  return next - 1n;
}

/** Buys with native ETH in one transaction: the market wraps the payment into WETH escrow. */
export async function fillWithEth(listing: Listing, buyer: Address, targetIndex: number, onStep?: (s: string) => void) {
  const d = await getDeployment();
  await fundPersona(buyer);
  onStep?.("Generating beacon state proofs");
  const proofs = await fillProofs(Number(listing.order.sourceIndex), targetIndex);
  const payment = await quote(listing.order, BigInt((proofs.source.validator as unknown as { effectiveBalance: bigint }).effectiveBalance));
  onStep?.("One transaction: escrow ETH as WETH and submit the EIP-7251 consolidation");
  await write({
    account: buyer,
    address: d.market,
    abi: nativeStakeMarketAbi,
    functionName: "fillWithEth",
    args: [listing.order, "0x", proofs.target.validator.pubkey, proofs, buyer],
    value: payment + parseEther("0.01"), // unused fee is refunded
  });
  const next = (await publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "nextTradeId" })) as bigint;
  return next - 1n;
}

export async function relayAccepted(trade: Trade, from: Address) {
  const d = await getDeployment();
  const p = await api.accepted(trade.id, Number(trade.sourceIndex), Number(trade.targetIndex));
  const tx = await write({
    account: from,
    address: d.market,
    abi: nativeStakeMarketAbi,
    functionName: "proveAccepted",
    args: [
      trade.id,
      dec(stateRootProofAbi, p.stateRootProof),
      dec(pendingConsolidationProofAbi, p.pendingConsolidationProof),
      dec(validatorProofAbi, p.sourceProof),
    ],
  });
  return { ...p, tx };
}

export async function relayDelivered(trade: Trade, from: Address) {
  const d = await getDeployment();
  const p = await api.delivered(trade.id, Number(trade.sourceIndex), Number(trade.targetIndex));
  const tx = await write({
    account: from,
    address: d.market,
    abi: nativeStakeMarketAbi,
    functionName: "proveDelivered",
    args: [
      trade.id,
      dec(stateRootProofAbi, p.stateRootProof),
      dec(validatorProofAbi, p.sourceProof),
      dec(balanceProofAbi, p.sourceBalanceProof),
    ],
  });
  return { ...p, tx };
}

export async function refundExpired(trade: Trade, from: Address) {
  const d = await getDeployment();
  return write({ account: from, address: d.market, abi: nativeStakeMarketAbi, functionName: "refundExpired", args: [trade.id] });
}
