import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, parseEther, type Address, type Hex } from "viem";
import { aquaStakeBidAppAbi, nativeStakeMarketAbi } from "@/generated/abis";
import { validatorsOf } from "./api";
import { publicClient, write } from "./chain";
import { INDEXER_URL, getDeployment } from "./config";
import { fillProofs, fundPersona, quote, type Listing } from "./market";

const aquaAbi = [
  {
    type: "event",
    name: "Shipped",
    inputs: [
      { name: "maker", type: "address", indexed: false },
      { name: "app", type: "address", indexed: false },
      { name: "strategyHash", type: "bytes32", indexed: false },
      { name: "strategy", type: "bytes", indexed: false },
    ],
  },
  {
    type: "function",
    name: "ship",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [{ name: "strategyHash", type: "bytes32" }],
  },
  {
    type: "function",
    name: "dock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
] as const;

const wethAbi = [...erc20Abi, { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

/** 1inch SwapVM order (v1.0.2) pricing 1 wei of stake in WETH. Empty `data` = fixed cap only. */
export interface SwapVmOrder {
  maker: Address;
  traits: bigint;
  data: Hex;
}

export interface StakeBid {
  maker: Address;
  targetPubkey: Hex;
  maxPriceWad: bigint;
  minStakeGwei: bigint;
  maxStakeGwei: bigint;
  salt: Hex;
  pricing: SwapVmOrder;
}

export interface DutchParams {
  startPriceWad: bigint;
  endPriceWad: bigint;
  /** seconds, at most 65535 (SwapVM DutchAuction uses a uint16 duration) */
  duration: number;
}

export interface BidInfo {
  bid: StakeBid;
  hash: Hex;
  available: bigint;
  budget: bigint;
  /** what the bid pays right now for 32 ETH (SwapVM quote, capped); undefined if expired */
  priceFor32?: bigint;
  dutch: boolean;
}

const bidAbi = aquaStakeBidAppAbi.find((x) => x.type === "function" && x.name === "matchBid")!.inputs[0];
const encodeBid = (b: StakeBid) => encodeAbiParameters([bidAbi], [b]);

export async function listBids(): Promise<BidInfo[]> {
  const d = await getDeployment();
  if (!d.aqua || !d.aquaBidApp) return [];
  const logs = INDEXER_URL
    ? ((await fetch(`${INDEXER_URL}/api/index/bids`, { cache: "no-store" }).then((r) => r.json())) as {
        maker: Address;
        app: Address;
        strategyHash: Hex;
        strategy: Hex;
        shipped: { tx: Hex };
      }[])
        .reverse()
        .map((b) => ({ args: b, transactionHash: b.shipped.tx }))
    : await publicClient.getContractEvents({ address: d.aqua, abi: aquaAbi, eventName: "Shipped", fromBlock: BigInt(d.deployBlock) });
  const out: BidInfo[] = [];
  for (const l of logs) {
    if (l.args.app?.toLowerCase() !== d.aquaBidApp.toLowerCase()) continue;
    const bid = decodeAbiParameters([bidAbi], l.args.strategy as Hex)[0] as unknown as StakeBid;
    // Aqua keys balances by the shipper: ignore bids shipped by someone other than the named maker
    if (bid.maker.toLowerCase() !== l.args.maker?.toLowerCase()) continue;
    const available = (await publicClient.readContract({ address: d.aquaBidApp, abi: aquaStakeBidAppAbi, functionName: "available", args: [bid] })) as bigint;
    const priceFor32 = (await publicClient
      .readContract({ address: d.aquaBidApp, abi: aquaStakeBidAppAbi, functionName: "limit", args: [bid, 32n * 10n ** 9n] })
      .catch(() => undefined)) as bigint | undefined;
    const tx = await publicClient.getTransaction({ hash: l.transactionHash });
    const { args } = decodeFunctionData({ abi: aquaAbi, data: tx.input });
    const budget = (args as readonly [Address, Hex, readonly Address[], readonly bigint[]])[3][0];
    out.push({ bid, hash: l.args.strategyHash as Hex, available, budget, priceFor32, dutch: bid.pricing.data !== "0x" });
  }
  return out.reverse();
}

export function bidLimit(bid: StakeBid, amountGwei: bigint) {
  return (amountGwei * 10n ** 9n * bid.maxPriceWad) / 10n ** 18n;
}

/** Current bid limit from the contract: SwapVM price capped by maxPriceWad. */
export async function liveLimit(bid: StakeBid, amountGwei: bigint) {
  const d = await getDeployment();
  return (await publicClient.readContract({
    address: d.aquaBidApp!,
    abi: aquaStakeBidAppAbi,
    functionName: "limit",
    args: [bid, amountGwei],
  })) as bigint;
}

export async function createBid(
  p: { maker: Address; targetPubkey: Hex; priceWad: bigint; budget: bigint; dutch?: DutchParams },
  onStep?: (s: string) => void,
) {
  const d = await getDeployment();
  await fundPersona(p.maker);
  const saltNum = BigInt(Date.now());
  let pricing: SwapVmOrder = { maker: p.maker, traits: 0n, data: "0x" };
  if (p.dutch) {
    onStep?.("Building a SwapVM Dutch-auction program");
    const start = (await publicClient.getBlock()).timestamp;
    // raise the offer from start to end price over `duration` seconds: balanceOut /= decay^elapsed
    const ratio = Number(p.dutch.startPriceWad) / Number(p.dutch.endPriceWad);
    const decay = BigInt(Math.floor(Math.pow(ratio, 1 / p.dutch.duration) * 1e18));
    pricing = (await publicClient.readContract({
      address: d.aquaBidApp!,
      abi: aquaStakeBidAppAbi,
      functionName: "buildDutchBid",
      args: [p.maker, p.dutch.startPriceWad, Number(start), p.dutch.duration, decay, saltNum & 0xffffffffffffffffn],
    })) as unknown as SwapVmOrder;
  }
  const bid: StakeBid = {
    maker: p.maker,
    targetPubkey: p.targetPubkey,
    maxPriceWad: p.priceWad,
    minStakeGwei: 32n * 10n ** 9n,
    maxStakeGwei: 2048n * 10n ** 9n,
    salt: keccak256(encodeAbiParameters([{ type: "uint256" }], [saltNum])),
    pricing,
  };
  const bal = await publicClient.readContract({ address: d.weth, abi: wethAbi, functionName: "balanceOf", args: [p.maker] });
  if (bal < p.budget) {
    onStep?.("Wrapping ETH (funds stay in your wallet)");
    await write({ account: p.maker, address: d.weth, abi: wethAbi, functionName: "deposit", value: p.budget - bal });
  }
  const allowance = await publicClient.readContract({ address: d.weth, abi: wethAbi, functionName: "allowance", args: [p.maker, d.aqua!] });
  if (allowance < p.budget) {
    onStep?.("Approving Aqua");
    await write({ account: p.maker, address: d.weth, abi: wethAbi, functionName: "approve", args: [d.aqua!, 2n ** 256n - 1n] });
  }
  onStep?.("Shipping the bid strategy to Aqua");
  await write({ account: p.maker, address: d.aqua!, abi: aquaAbi, functionName: "ship", args: [d.aquaBidApp!, encodeBid(bid), [d.weth], [p.budget]] });
  return bid;
}

export async function dockBid(b: BidInfo) {
  const d = await getDeployment();
  return write({ account: b.bid.maker, address: d.aqua!, abi: aquaAbi, functionName: "dock", args: [d.aquaBidApp!, b.hash, [d.weth]] });
}

/** Payment the listing would require and whether the bid covers it. */
export async function matchQuote(b: BidInfo, l: Listing, amountGwei: bigint) {
  const payment = await quote(l.order, amountGwei);
  const limit = await liveLimit(b.bid, amountGwei);
  return { payment, limit, ok: payment <= limit && payment <= b.available };
}

export async function matchBid(b: BidInfo, l: Listing, caller: Address) {
  const d = await getDeployment();
  await fundPersona(caller);
  const targets = await validatorsOf(b.bid.maker);
  const t = targets.find((v) => v.pubkey.toLowerCase() === b.bid.targetPubkey.toLowerCase());
  if (!t) throw new Error("bid target not found");
  const proofs = await fillProofs(Number(l.order.sourceIndex), t.index);
  await write({
    account: caller,
    address: d.aquaBidApp!,
    abi: aquaStakeBidAppAbi,
    functionName: "matchBid",
    args: [b.bid, l.order, "0x", proofs as never],
    value: parseEther("0.01"),
  });
  const next = (await publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "nextTradeId" })) as bigint;
  return next - 1n;
}
