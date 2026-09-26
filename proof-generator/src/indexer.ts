// StakePort indexer: follows market, Aqua and bid-app events and serves them over HTTP.
//
//   RPC_URL=... DEPLOYMENT=../deployments/local.json LOG_RANGE=10 node src/indexer.ts
//
// LOG_RANGE is the eth_getLogs block span per request (10 on Alchemy's free tier). Progress and
// events are persisted, so restarts resume where they stopped.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type Log } from "viem";

const ROOT = new URL("../../", import.meta.url).pathname;
const RPC_URL = process.env.RPC_URL ?? process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYMENT = process.env.DEPLOYMENT ?? `${ROOT}deployments/local.json`;
const LOG_RANGE = BigInt(process.env.LOG_RANGE ?? "10");
const POLL_MS = Number(process.env.POLL_MS ?? 4000);
const PORT = Number(process.env.INDEXER_PORT ?? 8789);

const abi = (name: string) => JSON.parse(readFileSync(`${ROOT}contracts/out/${name}.sol/${name}.json`, "utf8")).abi as Abi;
const marketAbi = abi("NativeStakeMarket");
const bidAppAbi = abi("AquaStakeBidApp");
const aquaAbi: Abi = [
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
    type: "event",
    name: "Docked",
    inputs: [
      { name: "maker", type: "address", indexed: false },
      { name: "app", type: "address", indexed: false },
      { name: "strategyHash", type: "bytes32", indexed: false },
    ],
  },
];

const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const market: Address = deployment.market;
const aqua: Address | undefined = deployment.aqua;
const bidApp: Address | undefined = deployment.aquaBidApp;
const client = createPublicClient({ transport: http(RPC_URL) });

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
interface IndexState {
  market: Address;
  nextBlock: string;
  listings: Record<Hex, Json>;
  trades: Record<string, Json>;
  bids: Record<Hex, Json>;
}

const chainId = await client.getChainId();
const STORE = `${ROOT}proof-generator/data/index-${chainId}-${market.toLowerCase()}.json`;
const state: IndexState = existsSync(STORE)
  ? JSON.parse(readFileSync(STORE, "utf8"))
  : { market, nextBlock: String(deployment.deployBlock ?? 0), listings: {}, trades: {}, bids: {} };

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const save = () => writeFileSync(STORE, JSON.stringify(state, big));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, big));

function apply(log: Log) {
  const ref = { block: log.blockNumber?.toString(), tx: log.transactionHash };
  const addr = log.address.toLowerCase();
  if (addr === market.toLowerCase()) {
    const e = decodeEventLog({ abi: marketAbi, data: log.data, topics: log.topics }) as { eventName: string; args: Json };
    const a = plain(e.args) as Json;
    switch (e.eventName) {
      case "OrderListed":
        state.listings[a.orderHash as Hex] = { hash: a.orderHash, order: a.order, policy: null, cancelled: false, listed: ref };
        break;
      case "OrderPolicySet":
        if (state.listings[a.orderHash as Hex]) state.listings[a.orderHash as Hex].policy = a.policy;
        break;
      case "OrderCancelled":
        for (const l of Object.values(state.listings)) {
          const o = l.order as Json;
          if (String(o.seller).toLowerCase() === String(a.seller).toLowerCase() && o.nonce === a.nonce) l.cancelled = true;
        }
        break;
      case "OrderFilled":
        state.trades[a.tradeId as string] = { ...a, status: "RequestSubmitted", filled: ref };
        break;
      case "ConsolidationAccepted":
        Object.assign(state.trades[a.tradeId as string] ?? {}, { status: "Accepted", withdrawableEpoch: a.withdrawableEpoch, accepted: ref });
        break;
      case "StakeDelivered":
        Object.assign(state.trades[a.tradeId as string] ?? {}, { status: "Delivered", delivered: ref });
        break;
      case "TradeFailed":
        Object.assign(state.trades[a.tradeId as string] ?? {}, { status: "Failed", failed: ref });
        break;
    }
  } else if (aqua && addr === aqua.toLowerCase()) {
    const e = decodeEventLog({ abi: aquaAbi, data: log.data, topics: log.topics }) as { eventName: string; args: Json };
    const a = plain(e.args) as Json;
    if (!bidApp || String(a.app).toLowerCase() !== bidApp.toLowerCase()) return;
    if (e.eventName === "Shipped") state.bids[a.strategyHash as Hex] = { ...a, docked: false, shipped: ref };
    if (e.eventName === "Docked" && state.bids[a.strategyHash as Hex]) state.bids[a.strategyHash as Hex].docked = true;
  } else if (bidApp && addr === bidApp.toLowerCase()) {
    const e = decodeEventLog({ abi: bidAppAbi, data: log.data, topics: log.topics }) as { eventName: string; args: Json };
    if (e.eventName === "BidMatched") {
      const a = plain(e.args) as Json;
      Object.assign(state.trades[a.tradeId as string] ?? {}, { viaBid: a.strategyHash });
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Sync loop
// ------------------------------------------------------------------------------------------------

let head = 0n;
async function syncOnce() {
  head = await client.getBlockNumber();
  const addresses = [market, aqua, bidApp].filter(Boolean) as Address[];
  let from = BigInt(state.nextBlock);
  while (from <= head) {
    const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head;
    const logs = await client.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    for (const l of logs) {
      try {
        apply(l);
      } catch {
        /* unrelated event from a watched contract (e.g. Aqua Pushed/Pulled) */
      }
    }
    from = to + 1n;
    state.nextBlock = from.toString();
  }
  save();
}

async function loop() {
  try {
    await syncOnce();
  } catch (e) {
    console.error("sync error:", (e as Error).message);
  }
  setTimeout(loop, POLL_MS);
}

// ------------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------------

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = (() => {
    switch (url.pathname) {
      case "/api/index/status":
        return { chainId, market, head: head.toString(), nextBlock: state.nextBlock, synced: BigInt(state.nextBlock) > head };
      case "/api/index/listings":
        return Object.values(state.listings).reverse();
      case "/api/index/trades":
        return Object.values(state.trades).reverse();
      case "/api/index/bids":
        return Object.values(state.bids).reverse();
      default:
        return undefined;
    }
  })();
  res.writeHead(body ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body ?? { error: "not found" }));
}).listen(PORT, () => console.log(`indexer on http://localhost:${PORT} (chain ${chainId}, from block ${state.nextBlock}, range ${LOG_RANGE})`));

loop();
