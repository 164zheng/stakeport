// Proof service for the local demo (anvil mainnet fork).
//
//   BEACON_API_URL=... ANVIL_RPC_URL=http://127.0.0.1:8545 node --max-old-space-size=12000 src/server.ts
//
// Serves real fill proofs from a real mainnet BeaconState, and simulated checkpoint proofs whose
// beacon roots it injects into the fork's EIP-4788 buffer (see simulate.ts).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createTestClient, getAddress, http, numberToHex, pad } from "viem";
import { mainnet } from "viem/chains";
import { getHeader, getStateSsz } from "./beacon.ts";
import { BeaconSim, SECONDS_PER_SLOT } from "./simulate.ts";
import { queueStats, totalActiveBalance } from "./queues.ts";
import {
  balanceProof,
  pendingConsolidationProof,
  stateRootProof,
  validatorFields,
  validatorProof,
} from "./proofs.ts";
import {
  encodeBalanceProof,
  encodePendingConsolidationProof,
  encodeStateRootProof,
  encodeValidatorProof,
} from "./abi.ts";

const PORT = Number(process.env.PORT ?? 8788);
const ANVIL = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const FIXTURE = new URL("../../contracts/test/fixtures/mainnet.json", import.meta.url).pathname;
const DATA = new URL("../data/", import.meta.url).pathname;

const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02" as const;
const HISTORY_BUFFER_LENGTH = 8191n;

const anvilPublic = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const anvilTest = createTestClient({ chain: mainnet, mode: "anvil", transport: http(ANVIL) });

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const baseSlot: number = fixture.beaconSlot;
const baseTimestamp: number = fixture.elTimestamp;

// ------------------------------------------------------------------------------------------------
// Load the real base state
// ------------------------------------------------------------------------------------------------

async function loadHeader() {
  const file = `${DATA}header-${baseSlot}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const h = await getHeader(baseSlot);
  writeFileSync(file, JSON.stringify(h));
  return h;
}

console.log(`loading mainnet state at slot ${baseSlot} ...`);
const t0 = Date.now();
const sim = new BeaconSim(await getStateSsz(baseSlot), await loadHeader());
sim.state.commit();
console.log(`state root ${Buffer.from(sim.state.hashTreeRoot()).toString("hex")} (${Date.now() - t0} ms)`);

/** Fill proofs must use the real (unmodified) base state, whose root is natively in the fork's 4788. */
const baseHeader = { ...sim.header };
const baseStateRootProof = stateRootProof(
  {
    slot: baseHeader.slot,
    proposer_index: baseHeader.proposer_index,
    parent_root: baseHeader.parent_root,
    state_root: baseHeader.state_root,
    body_root: baseHeader.body_root,
  },
  baseTimestamp,
);

// Index validators by withdrawal address once.
const byAddress = new Map<string, number[]>();
{
  const creds = sim.state.validators.getAllReadonlyValues();
  creds.forEach((v, i) => {
    if (v.withdrawalCredentials[0] === 0) return;
    const a = `0x${Buffer.from(v.withdrawalCredentials.subarray(12)).toString("hex")}`;
    const list = byAddress.get(a);
    if (list) list.push(i);
    else byAddress.set(a, [i]);
  });
}
console.log(`indexed ${byAddress.size} withdrawal addresses`);

// Queue lengths come from the REAL base state (computed once, before any simulated transition).
const baseQueues = queueStats(sim.state as never, totalActiveBalance(sim.state as never));
console.log("queues", JSON.stringify(baseQueues));

// Base-state proofs are cached per validator: they only depend on the unmodified base state.
const baseValidatorProofs = new Map<number, string>();
function baseValidatorProof(index: number) {
  let p = baseValidatorProofs.get(index);
  if (!p) throw new Error(`validator ${index} not snapshotted`);
  return p;
}

/** Captures base-state proofs for a set of validators before the simulation mutates the state. */
function snapshot(indices: number[]) {
  for (const i of indices) {
    if (!baseValidatorProofs.has(i)) baseValidatorProofs.set(i, encodeValidatorProof(validatorProof(sim.state as never, i)));
  }
}

// ------------------------------------------------------------------------------------------------
// Demo personas: a seller with several 0x01 validators and a buyer with a 0x02 validator.
// ------------------------------------------------------------------------------------------------

const epoch = sim.epoch;
function describe(i: number) {
  const v = validatorFields(sim.state as never, i);
  const exiting = v.exitEpoch !== 2n ** 64n - 1n;
  const status = v.slashed
    ? "slashed"
    : exiting
      ? Number(v.withdrawableEpoch) <= sim.epoch
        ? "withdrawable"
        : "exiting"
      : Number(v.activationEpoch) <= epoch
        ? "active"
        : "pending";
  return {
    index: i,
    pubkey: v.pubkey,
    credentials: `0x0${v.withdrawalCredentials[3]}`,
    withdrawalCredentials: v.withdrawalCredentials,
    effectiveBalanceGwei: Number(v.effectiveBalance),
    balanceGwei: sim.state.balances.get(i),
    activationEpoch: Number(v.activationEpoch),
    exitEpoch: exiting ? Number(v.exitEpoch) : null,
    withdrawableEpoch: exiting ? Number(v.withdrawableEpoch) : null,
    slashed: v.slashed,
    status,
  };
}

async function isEoa(a: string) {
  const code = await anvilPublic.getCode({ address: a as `0x${string}` }).catch(() => undefined);
  return !code || code === "0x";
}

async function pickPersonas() {
  const sellers: { address: string; validators: number[] }[] = [];
  const buyers: { address: string; validators: number[] }[] = [];
  for (const [address, indices] of byAddress) {
    const active = indices.filter((i) => {
      const v = sim.state.validators.getReadonly(i);
      return !v.slashed && v.exitEpoch === Infinity && v.activationEpoch + 256 <= epoch;
    });
    if (active.length === 0) continue;
    const prefixes = new Set(active.map((i) => sim.state.validators.getReadonly(i).withdrawalCredentials[0]));
    if (sellers.length < 20 && prefixes.has(1) && active.length >= 3 && active.length <= 8) sellers.push({ address, validators: active });
    const compounding = active.filter((i) => {
      const v = sim.state.validators.getReadonly(i);
      return v.withdrawalCredentials[0] === 2 && v.effectiveBalance <= 1_500_000_000_000;
    });
    if (buyers.length < 20 && compounding.length >= 1 && compounding.length <= 4) buyers.push({ address, validators: compounding });
    if (sellers.length >= 20 && buyers.length >= 20) break;
  }
  const seller = await (async () => {
    for (const s of sellers) if (await isEoa(s.address)) return s;
  })();
  const buyer = await (async () => {
    for (const b of buyers) if (b.address !== seller?.address && (await isEoa(b.address))) return b;
  })();
  if (!seller || !buyer) throw new Error("no personas found");
  return {
    seller: { address: getAddress(seller.address), validators: seller.validators },
    buyer: { address: getAddress(buyer.address), validators: buyer.validators },
  };
}

const personasFile = `${DATA}personas-${baseSlot}.json`;
const personas = existsSync(personasFile) ? JSON.parse(readFileSync(personasFile, "utf8")) : await pickPersonas();
writeFileSync(personasFile, JSON.stringify(personas, null, 2));
snapshot([...personas.seller.validators, ...personas.buyer.validators]);
console.log("personas", personas);

// ------------------------------------------------------------------------------------------------
// Simulation + EIP-4788 injection
// ------------------------------------------------------------------------------------------------

async function injectBeaconRoot(timestamp: bigint, root: `0x${string}`) {
  const idx = timestamp % HISTORY_BUFFER_LENGTH;
  await anvilTest.setStorageAt({ address: BEACON_ROOTS, index: numberToHex(idx, { size: 32 }), value: pad(numberToHex(timestamp), { size: 32 }) });
  await anvilTest.setStorageAt({ address: BEACON_ROOTS, index: numberToHex(idx + HISTORY_BUFFER_LENGTH, { size: 32 }), value: root });
}

/** Mines a block so the injected root's timestamp is strictly after any previous transaction. */
async function nextTimestamp(advanceSeconds = SECONDS_PER_SLOT) {
  const latest = await anvilPublic.getBlock();
  const ts = latest.timestamp + BigInt(advanceSeconds);
  await anvilTest.setNextBlockTimestamp({ timestamp: ts });
  await anvilTest.mine({ blocks: 1 });
  return ts;
}

async function sealAndInject(ts: bigint) {
  const header = sim.seal(Number(ts));
  await injectBeaconRoot(ts, header.root as `0x${string}`);
  return {
    header,
    stateRootProof: encodeStateRootProof(stateRootProof(header, Number(ts))),
  };
}

const simulated: { kind: string; tradeId?: string; slot: number; root: string; timestamp: string }[] = [];

async function checkpointAccepted(body: { tradeId: string; source: number; target: number }) {
  const { withdrawableEpoch } = sim.queueConsolidation(body.source, body.target);
  const ts = await nextTimestamp();
  const { header, stateRootProof } = await sealAndInject(ts);
  simulated.push({ kind: "accepted", tradeId: body.tradeId, slot: Number(header.slot), root: header.root, timestamp: ts.toString() });
  const queueIndex = sim.state.pendingConsolidations.length - 1;
  return {
    simulated: true,
    header,
    timestamp: ts.toString(),
    withdrawableEpoch,
    stateRootProof,
    pendingConsolidationProof: encodePendingConsolidationProof(pendingConsolidationProof(sim.state as never, queueIndex)),
    sourceProof: encodeValidatorProof(validatorProof(sim.state as never, body.source)),
  };
}

async function checkpointDelivered(body: { tradeId: string; source: number; target: number }) {
  const v = sim.state.validators.getReadonly(body.source);
  if (v.withdrawableEpoch === Infinity) throw new Error("consolidation not queued");
  // Fast-forward the fork to the source's withdrawable epoch (the real wait is >27 hours).
  const latest = await anvilPublic.getBlock();
  const withdrawableTime = BigInt(sim.genesisTime + v.withdrawableEpoch * 32 * SECONDS_PER_SLOT);
  const advance = withdrawableTime > latest.timestamp ? Number(withdrawableTime - latest.timestamp) + SECONDS_PER_SLOT : SECONDS_PER_SLOT;
  const { movedGwei } = sim.processConsolidation(body.source, body.target);
  const ts = await nextTimestamp(advance);
  const { header, stateRootProof } = await sealAndInject(ts);
  simulated.push({ kind: "delivered", tradeId: body.tradeId, slot: Number(header.slot), root: header.root, timestamp: ts.toString() });
  return {
    simulated: true,
    header,
    timestamp: ts.toString(),
    movedGwei,
    stateRootProof,
    sourceProof: encodeValidatorProof(validatorProof(sim.state as never, body.source)),
    sourceBalanceProof: encodeBalanceProof(balanceProof(sim.state as never, body.source)),
  };
}

// ------------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

// Serialize state mutations.
let queue = Promise.resolve<unknown>(undefined);
const serial = <T>(fn: () => Promise<T>) => (queue = queue.then(fn, fn)) as Promise<T>;

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, null);
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/info") {
      return send(res, 200, {
        baseSlot,
        baseBlockRoot: fixture.beaconBlockRoot,
        baseTimestamp,
        forkBlock: fixture.elBlockNumber,
        currentSlot: sim.slot,
        currentEpoch: sim.epoch,
        genesisTime: sim.genesisTime,
        personas,
        simulated,
      });
    }
    if (url.pathname === "/api/queues") {
      return send(res, 200, { ...baseQueues, baseSlot, source: "real mainnet beacon state" });
    }
    if (url.pathname === "/api/validators") {
      const address = url.searchParams.get("address")?.toLowerCase();
      const indices = url.searchParams.get("indices");
      const list = indices
        ? indices.split(",").map(Number)
        : address
          ? (byAddress.get(address) ?? [])
          : [];
      return send(res, 200, list.slice(0, 64).map(describe));
    }
    if (url.pathname === "/api/fill-proofs") {
      const source = Number(url.searchParams.get("source"));
      const target = Number(url.searchParams.get("target"));
      if (simulated.length > 0 && !(baseValidatorProofs.has(source) && baseValidatorProofs.has(target))) {
        throw new Error("fill proofs are only available for snapshotted validators once simulation started");
      }
      snapshot([source, target]);
      // The real base root may be overwritten by locally mined blocks; restore it.
      await injectBeaconRoot(BigInt(baseTimestamp), fixture.beaconBlockRoot);
      return send(res, 200, {
        simulated: false,
        stateRootProof: encodeStateRootProof(baseStateRootProof),
        sourceProof: baseValidatorProof(source),
        targetProof: baseValidatorProof(target),
      });
    }
    if (url.pathname === "/api/checkpoint/accepted" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, await serial(() => checkpointAccepted(body)));
    }
    if (url.pathname === "/api/checkpoint/delivered" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, await serial(() => checkpointDelivered(body)));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, () => console.log(`proof service on http://localhost:${PORT}`));
