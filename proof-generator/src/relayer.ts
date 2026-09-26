// StakePort relayer: settles trades automatically by relaying beacon proofs.
//
//   MODE=real RPC_URL=<testnet rpc> BEACON_PROOF_URL=https://lodestar-hoodi.chainsafe.io \
//     RELAYER_PRIVATE_KEY=0x... INDEXER_URL=http://localhost:8789 node src/relayer.ts
//   MODE=sim  (local fork demo: checkpoint states from the proof service, sender impersonated)
//
// Checkpoint 1 must land while the EIP-4788 buffer still holds a post-request root (~27 hours), so a
// human clicking a button is not enough on a real network. Settlement is permissionless; the relayer
// only needs gas.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  defineChain,
  http,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RemoteBeacon, remoteProofs } from "./remote.ts";
import {
  balanceProofAbi,
  pendingConsolidationProofAbi,
  stateRootProofAbi,
  validatorProofAbi,
} from "./abi.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const MODE = (process.env.MODE ?? "sim") as "sim" | "real";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:8789";
const PROOF_SERVICE_URL = process.env.PROOF_SERVICE_URL ?? "http://localhost:8788";
const BEACON_PROOF_URL = process.env.BEACON_PROOF_URL ?? "https://lodestar-hoodi.chainsafe.io";
const POLL_MS = Number(process.env.POLL_MS ?? 12_000);
const DEPLOYMENT = JSON.parse(readFileSync(process.env.DEPLOYMENT ?? `${ROOT}deployments/local.json`, "utf8"));
const marketAbi = JSON.parse(readFileSync(`${ROOT}contracts/out/NativeStakeMarket.sol/NativeStakeMarket.json`, "utf8")).abi as Abi;
const market = DEPLOYMENT.market as Address;
const FAR_FUTURE = 2n ** 64n - 1n;

// the chain is whatever RPC_URL serves (a testnet or a local fork)
const chainId = await createPublicClient({ transport: http(RPC_URL) }).getChainId();
const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const account: Account | Address = process.env.RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex)
  : ((process.env.RELAYER_ADDRESS ?? "0x5e1a7e0000000000000000000000000000000001") as Address); // impersonated on a fork
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
const beacon = new RemoteBeacon(BEACON_PROOF_URL, pub as never);

const dec = <T>(abi: unknown, data: Hex) => decodeAbiParameters([abi as never], data)[0] as T;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

interface Trade {
  seller: Address;
  buyer: Address;
  sourceIndex: bigint;
  targetIndex: bigint;
  amountGwei: bigint;
  filledAt: bigint;
  withdrawableEpoch: bigint;
  status: number;
  payment: bigint;
}
const STATUS = ["None", "RequestSubmitted", "Accepted", "Delivered", "Failed"];

async function send(functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account, address: market, abi: marketAbi, functionName, args } as never);
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  log(`  ${functionName} -> ${r.status} (${hash})`);
}

// ------------------------------------------------------------------------------------------------
// Real network: proofs from the latest beacon state (Lodestar proof API)
// ------------------------------------------------------------------------------------------------

async function settleReal(id: bigint, t: Trade, now: bigint) {
  const source = Number(t.sourceIndex);
  const target = Number(t.targetIndex);
  const genesis = BigInt(await beacon.genesisTime());
  const epochNow = (now - genesis) / 384n;

  if (t.status === 1) {
    const p = await remoteProofs(beacon, "head", { validators: [source], pending: { source, target } });
    if (BigInt(p.timestamp) <= t.filledAt) return log(`  #${id}: waiting for a beacon state after the fill`);
    const src = p.validators[0];
    if (p.pending) {
      log(`  #${id}: consolidation accepted at slot ${p.slot}`);
      return send("proveAccepted", [id, p.stateRootProof, p.pending, src]);
    }
    if (src.validator.exitEpoch === FAR_FUTURE && BigInt(p.timestamp) > t.filledAt + 64n * 12n) {
      log(`  #${id}: request ignored by the consensus layer`);
      return send("proveNotAccepted", [id, p.stateRootProof, src]);
    }
    return;
  }

  if (t.status === 2) {
    if (epochNow < t.withdrawableEpoch) return log(`  #${id}: delivery at epoch ${t.withdrawableEpoch} (now ${epochNow})`);
    const p = await remoteProofs(beacon, "head", { validators: [source], balances: [source] });
    const src = p.validators[0];
    if (src.validator.slashed) {
      log(`  #${id}: source slashed`);
      return send("proveFailed", [id, p.stateRootProof, src]);
    }
    // the market checks the source is past withdrawable and its balance is below 1 ETH
    log(`  #${id}: proving delivery`);
    return send("proveDelivered", [id, p.stateRootProof, src, p.balances[0]]);
  }
}

// ------------------------------------------------------------------------------------------------
// Local fork demo: checkpoint 1 from the proof service (real for the replayed pair, else simulated)
// ------------------------------------------------------------------------------------------------

async function settleSim(id: bigint, t: Trade) {
  if (t.status !== 1) return; // delivery needs a fast-forward; the demo UI does it explicitly
  const r = await fetch(`${PROOF_SERVICE_URL}/api/checkpoint/accepted`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tradeId: id.toString(), source: Number(t.sourceIndex), target: Number(t.targetIndex) }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error);
  log(`  #${id}: checkpoint 1 (${r.simulated ? "simulated" : "real"} slot ${r.header.slot})`);
  return send("proveAccepted", [
    id,
    dec(stateRootProofAbi, r.stateRootProof),
    dec(pendingConsolidationProofAbi, r.pendingConsolidationProof),
    dec(validatorProofAbi, r.sourceProof),
  ]);
}

// ------------------------------------------------------------------------------------------------

const acceptWindow = (await pub.readContract({ address: market, abi: marketAbi, functionName: "acceptWindow" })) as bigint;
const inFlight = new Set<string>();

async function tick() {
  const rows = (await fetch(`${INDEXER_URL}/api/index/trades`).then((r) => r.json())) as { tradeId: string }[];
  const now = (await pub.getBlock()).timestamp;
  for (const row of rows) {
    const id = BigInt(row.tradeId);
    if (inFlight.has(row.tradeId)) continue;
    const t = (await pub.readContract({ address: market, abi: marketAbi, functionName: "getTrade", args: [id] })) as Trade;
    if (t.status !== 1 && t.status !== 2) continue;
    inFlight.add(row.tradeId);
    try {
      log(`trade #${id} ${STATUS[t.status]} ${t.sourceIndex} -> ${t.targetIndex}`);
      if (t.status === 1 && now > t.filledAt + acceptWindow) {
        await send("refundExpired", [id]);
      } else if (MODE === "real") {
        await settleReal(id, t, now);
      } else {
        await settleSim(id, t);
      }
    } catch (e) {
      log(`  #${id} error: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      inFlight.delete(row.tradeId);
    }
  }
}

log(`relayer (${MODE}) for market ${market} as ${typeof account === "string" ? account : account.address}`);
async function loop() {
  try {
    await tick();
  } catch (e) {
    log("tick error:", (e as Error).message);
  }
  setTimeout(loop, POLL_MS);
}
loop();
