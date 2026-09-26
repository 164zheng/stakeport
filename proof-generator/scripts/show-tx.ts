// Human-readable transaction view for the demo.
//
//   node scripts/show-tx.ts <txhash>        one transaction
//   node scripts/show-tx.ts --trade <id>    every transaction of a StakePort trade (fill, checkpoints, payout)
//   node scripts/show-tx.ts --last          the latest trade
//   node scripts/show-tx.ts --watch         live: print every new transaction that touches StakePort
//
// Decodes the call, token transfers (with amounts and labelled addresses), 1inch Aqua pulls, Uniswap v4
// swaps, the EIP-7251 consolidation request and StakePort events.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const ROOT = new URL("../../", import.meta.url).pathname;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const INDEXER = process.env.INDEXER_URL ?? "http://localhost:8789";
const SVC = process.env.PROOF_SERVICE_URL ?? "http://localhost:8788";
const d = JSON.parse(readFileSync(process.env.DEPLOYMENT ?? `${ROOT}deployments/local.json`, "utf8"));
const out = (n: string) => JSON.parse(readFileSync(`${ROOT}contracts/out/${n}.sol/${n}.json`, "utf8")).abi as Abi;
const pub = createPublicClient({ transport: http(RPC) });

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", m: "\x1b[35m", r: "\x1b[0m" };
const PREDEPLOY = "0x0000bbddc7ce488642fb579f8b00f3a590007251";

// ------------------------------------------------------------------------------------------------
// Labels
// ------------------------------------------------------------------------------------------------

const labels = new Map<string, string>();
const label = (a: string | undefined, name: string) => a && labels.set(a.toLowerCase(), name);
label(d.market, "StakePort market (escrow)");
label(d.delegate, "StakePort 7702 delegate");
label(d.beaconOracle, "BeaconOracle");
label(d.hook, "StakePort Uniswap v4 hook");
label(d.router, "StakePort swap router");
label(d.poolManager, "Uniswap v4 PoolManager");
label(d.aqua, "1inch Aqua");
label(d.aquaBidApp, "StakePort Aqua bid app");
label(d.swapVm, "1inch SwapVMRouter");
label(d.worldEligibility, "World ID eligibility");
label(d.weth, "WETH");
label(d.usdc, "USDC");
label(PREDEPLOY, "EIP-7251 consolidation predeploy");
try {
  const info = await fetch(`${SVC}/api/info`).then((r) => r.json());
  if (info.personas) {
    label(info.personas.seller.address, "seller (validator withdrawal EOA)");
    label(info.personas.buyer.address, "buyer");
  }
} catch {
  /* proof service not running */
}
const who = (a: string) => {
  const l = labels.get(a.toLowerCase());
  const s = `${a.slice(0, 6)}…${a.slice(-4)}`;
  return l ? `${C.c}${l}${C.r} ${C.dim}${s}${C.r}` : s;
};

// ------------------------------------------------------------------------------------------------
// ABIs
// ------------------------------------------------------------------------------------------------

const contractAbis: Abi[] = [out("NativeStakeMarket"), out("Stake7702Delegate"), out("StakePortHook"), out("AquaStakeBidApp"), out("WorldIdEligibility")];
const extraEvents = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
  "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
  "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const callAbis: Abi[] = [
  ...contractAbis,
  out("StakePortSwapRouter"),
  erc20Abi,
  parseAbi([
    "function deposit() payable",
    "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts)",
    "function dock(address app, bytes32 strategyHash, address[] tokens)",
  ]),
];

const tokenInfo = new Map<string, { symbol: string; decimals: number }>();
async function token(a: Address) {
  const k = a.toLowerCase();
  if (!tokenInfo.has(k)) {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
      pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    tokenInfo.set(k, { symbol, decimals: Number(decimals) });
  }
  return tokenInfo.get(k)!;
}
const amt = async (tokenAddr: Address, v: bigint) => {
  const t = await token(tokenAddr);
  return `${C.b}${Number(formatUnits(v, t.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t.symbol}${C.r}`;
};

function decodeCall(input: Hex) {
  for (const abi of callAbis) {
    try {
      return decodeFunctionData({ abi, data: input });
    } catch {
      /* next */
    }
  }
}

function decodeLog(l: { address: Address; data: Hex; topics: [Hex, ...Hex[]] | [] }) {
  for (const abi of [...contractAbis, extraEvents]) {
    try {
      return decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as { eventName: string; args: Record<string, unknown> };
    } catch {
      /* next */
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Render
// ------------------------------------------------------------------------------------------------

async function show(hash: Hex, title?: string) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const call = decodeCall(tx.input);
  // label the trade's parties before printing the header
  for (const l of rc.logs) {
    const e = decodeLog(l as never);
    if (e?.eventName === "OrderFilled") {
      label(e.args.seller as string, "seller (validator withdrawal EOA)");
      label(e.args.buyer as string, "buyer");
    }
  }
  console.log(`\n${C.b}${title ?? "Transaction"}${C.r}  ${C.dim}${hash}${C.r}`);
  console.log(`  block ${rc.blockNumber} · ${rc.status === "success" ? `${C.g}success${C.r}` : "reverted"} · gas ${rc.gasUsed}`);
  console.log(
    `  ${who(tx.from)} → ${who(tx.to!)}.${C.y}${call?.functionName ?? tx.input.slice(0, 10)}${C.r}()` +
      (tx.value > 0n ? `  with ${C.b}${formatEther(tx.value)} ETH${C.r}` : ""),
  );
  if (tx.type === "eip7702") console.log(`  ${C.m}EIP-7702 authorization list attached${C.r}`);

  let n = 0;
  for (const l of rc.logs) {
    const step = `  ${String(++n).padStart(2)}.`;
    if (l.address.toLowerCase() === PREDEPLOY) {
      const src = getAddress(`0x${l.data.slice(2, 42)}`);
      console.log(`${step} ${C.m}EIP-7251 consolidation request${C.r} from ${who(src)}`);
      console.log(`      source 0x${l.data.slice(42, 58)}…  →  target 0x${l.data.slice(138, 154)}…`);
      continue;
    }
    const e = decodeLog(l as never);
    if (!e) {
      console.log(`${step} ${C.dim}${who(l.address)} (undecoded event)${C.r}`);
      continue;
    }
    const a = e.args;
    switch (e.eventName) {
      case "Transfer":
        console.log(`${step} ${C.g}transfer${C.r} ${await amt(l.address, a.value as bigint)}  ${who(a.from as string)} → ${who(a.to as string)}`);
        break;
      case "Deposit":
        console.log(`${step} ${C.g}wrap${C.r} ${await amt(l.address, a.wad as bigint)} for ${who(a.dst as string)}`);
        break;
      case "Withdrawal":
        console.log(`${step} ${C.g}unwrap${C.r} ${await amt(l.address, a.wad as bigint)} for ${who(a.src as string)}`);
        break;
      case "Pulled":
        console.log(`${step} ${C.m}1inch Aqua pull${C.r} ${await amt(a.token as Address, a.amount as bigint)} from maker ${who(a.maker as string)} for ${who(a.app as string)}`);
        break;
      case "Pushed":
        console.log(`${step} ${C.m}1inch Aqua push${C.r} ${await amt(a.token as Address, a.amount as bigint)} to maker ${who(a.maker as string)}`);
        break;
      case "Shipped":
        console.log(`${step} ${C.m}1inch Aqua ship${C.r} strategy ${(a.strategyHash as string).slice(0, 10)}… by ${who(a.maker as string)}`);
        break;
      case "Swap":
        console.log(
          `${step} ${C.m}Uniswap v4 swap${C.r} in pool ${(a.id as string).slice(0, 10)}…  Δcurrency0 ${formatEther(a.amount0 as bigint)}  Δcurrency1 ${formatUnits(a.amount1 as bigint, 6)}  (sender ${who(a.sender as string)})`,
        );
        break;
      case "ConsolidationRequested":
        console.log(`${step} ${C.m}7702 delegate${C.r} running in ${who(l.address)} paid the ${a.fee} wei EIP-7251 fee`);
        break;
      case "OrderListed":
        console.log(`${step} ${C.y}StakePort OrderListed${C.r} validator #${(a.order as { sourceIndex: bigint }).sourceIndex} by ${who(a.seller as string)}`);
        break;
      case "OrderFilled":
        label(a.seller as string, "seller (validator withdrawal EOA)");
        label(a.buyer as string, "buyer");
        console.log(
          `${step} ${C.y}StakePort OrderFilled${C.r} trade #${a.tradeId}: validator #${a.sourceIndex} → #${a.targetIndex}, ${Number(a.amountGwei) / 1e9} ETH of stake for ${await amt(d.weth, a.payment as bigint)} escrowed`,
        );
        break;
      case "ConsolidationAccepted":
        console.log(`${step} ${C.y}StakePort checkpoint 1${C.r} trade #${a.tradeId}: consensus layer accepted, withdrawable at epoch ${a.withdrawableEpoch}`);
        break;
      case "StakeDelivered":
        console.log(`${step} ${C.y}StakePort checkpoint 2${C.r} trade #${a.tradeId}: stake delivered, ${await amt(d.weth, a.payment as bigint)} released to the seller`);
        break;
      case "TradeFailed":
        console.log(`${step} ${C.y}StakePort refund${C.r} trade #${a.tradeId}: ${await amt(d.weth, a.refund as bigint)} back to the buyer`);
        break;
      case "StakePurchased":
        console.log(
          `${step} ${C.y}Uniswap hook StakePurchased${C.r} trade #${a.tradeId}: ${await amt(d.usdc, a.tokenIn as bigint)} in → ${formatEther(a.ethOut as bigint)} ETH out, ${formatEther(a.refund as bigint)} ETH refunded`,
        );
        break;
      case "BidMatched":
        console.log(`${step} ${C.y}Aqua BidMatched${C.r} trade #${a.tradeId}: paid ${await amt(d.weth, a.payment as bigint)} (bid limit ${formatEther(a.bidPrice as bigint)})`);
        break;
      case "Attested":
        console.log(`${step} ${C.y}World ID attestation${C.r} for ${who(a.account as string)}`);
        break;
      default:
        console.log(`${step} ${who(l.address)} ${e.eventName}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------

const arg = process.argv[2];
if (arg === "--trade" || arg === "--last") {
  const trades = (await fetch(`${INDEXER}/api/index/trades`).then((r) => r.json())) as {
    tradeId: string;
    filled?: { tx: Hex };
    accepted?: { tx: Hex };
    delivered?: { tx: Hex };
    failed?: { tx: Hex };
  }[];
  const t = arg === "--last" ? trades[0] : trades.find((x) => x.tradeId === process.argv[3]);
  if (!t) throw new Error("trade not found (is the indexer running?)");
  if (t.filled) await show(t.filled.tx, `Trade #${t.tradeId} · fill`);
  if (t.accepted) await show(t.accepted.tx, `Trade #${t.tradeId} · checkpoint 1`);
  if (t.delivered) await show(t.delivered.tx, `Trade #${t.tradeId} · checkpoint 2 and payout`);
  if (t.failed) await show(t.failed.tx, `Trade #${t.tradeId} · refund`);
} else if (arg === "--watch") {
  // every labelled contract plus any address that emits into them (e.g. the 7702-delegated seller)
  const watched = new Set([...labels.keys()]);
  const relevant = (to: string | null, logs: { address: string }[]) =>
    (to && watched.has(to.toLowerCase())) || logs.some((l) => watched.has(l.address.toLowerCase()));
  let next = (await pub.getBlockNumber()) + 1n;
  console.log(`${C.dim}watching new blocks from ${next} (Ctrl-C to stop)…${C.r}`);
  for (;;) {
    const head = await pub.getBlockNumber();
    for (; next <= head; next++) {
      const block = await pub.getBlock({ blockNumber: next, includeTransactions: true });
      for (const tx of block.transactions) {
        const rc = await pub.getTransactionReceipt({ hash: tx.hash });
        if (relevant(tx.to, rc.logs)) await show(tx.hash, `Block ${next}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} else if (arg?.startsWith("0x")) {
  await show(arg as Hex);
} else {
  console.log("usage: node scripts/show-tx.ts <txhash> | --trade <id> | --last | --watch");
}
