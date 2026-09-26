// Proves a live Hoodi consolidation against the deployed BeaconOracle (read-only, no gas).
//
//   pnpm -s hoodi-check                      checkpoint 1 for a live pending consolidation
//   pnpm -s hoodi-check --delivered 1412898  checkpoint 2 for a source whose consolidation was processed
//   (HOODI_RPC_URL from ../.env)
//
// Takes the newest provable beacon block, picks a real entry of pending_consolidations, fetches Merkle proofs
// from the public Lodestar proof API (no state download) and checks them with eth_call against the contracts in
// deployments/hoodi.json: the same checks NativeStakeMarket runs for checkpoint 1 (consolidation accepted).
import { readFileSync } from "node:fs";
import { createPublicClient, http, type Abi, type Address } from "viem";
import { RemoteBeacon, provableBlockId, remoteProofs } from "../src/remote.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
for (const line of readFileSync(`${ROOT}.env`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const RPC = process.env.HOODI_RPC_URL;
if (!RPC) throw new Error("set HOODI_RPC_URL in .env");

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", red: "\x1b[31m", r: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${C.g}✓${C.r} ${s}`);
const kv = (k: string, v: unknown) => console.log(`    ${C.dim}${k.padEnd(20)}${C.r}${v}`);

const deployment = JSON.parse(readFileSync(`${ROOT}deployments/hoodi.json`, "utf8"));
const oracle = deployment.beaconOracle as Address;
const oracleAbi = JSON.parse(readFileSync(`${ROOT}contracts/out/BeaconOracle.sol/BeaconOracle.json`, "utf8")).abi as Abi;
const el = createPublicClient({ transport: http(RPC) });
const beacon = new RemoteBeacon(process.env.BEACON_PROOF_URL ?? "https://lodestar-hoodi.chainsafe.io", el as never);
const call = (functionName: string, args: unknown[]) =>
  el.readContract({ address: oracle, abi: oracleAbi, functionName, args } as never) as Promise<unknown>;

console.log(`\n${C.b}StakePort on Hoodi${C.r} ${C.dim}chain ${await el.getChainId()}, BeaconOracle ${oracle}${C.r}\n`);

const blockId = await provableBlockId(beacon);

// checkpoint 2: the delivery predicate of NativeStakeMarket.proveDelivered for a processed source
const deliveredArg = process.argv.indexOf("--delivered");
if (deliveredArg > 0) {
  const source = Number(process.argv[deliveredArg + 1]);
  const d = await remoteProofs(beacon, blockId, { validators: [source], balances: [source] });
  const epoch = d.stateRootProof.slot / 32n;
  console.log(`${C.c}Checkpoint 2 for source ${source}${C.r} ${C.dim}(slot ${d.slot}, epoch ${epoch})${C.r}`);
  const root = (await call("verifiedStateRoot", [d.stateRootProof])) as `0x${string}`;
  ok(`state root under EIP-4788 (timestamp ${d.timestamp})`);
  const v = d.validators[0].validator;
  await call("verifyValidator", [root, d.validators[0]]);
  ok(`source validator: slashed=${v.slashed}, withdrawable epoch ${v.withdrawableEpoch}`);
  const balance = (await call("verifyBalance", [root, d.balances[0]])) as bigint;
  ok(`source balance ${Number(balance) / 1e9} ETH`);
  const delivered = !v.slashed && v.withdrawableEpoch <= epoch && balance < 1_000_000_000n;
  console.log(
    delivered
      ? `\n  ${C.g}${C.b}delivered${C.r}: not slashed, past withdrawable, balance < 1 ETH -> the market would release the payment\n`
      : `\n  ${C.y}not delivered yet${C.r}: withdrawable at epoch ${v.withdrawableEpoch} (now ${epoch}), balance ${Number(balance) / 1e9} ETH\n`,
  );
  process.exit(0);
}

// 1. a real consolidation waiting in the beacon state
const header = await beacon.header(blockId);
const slot = Number(header.message.slot);
const queue = await beacon.pendingConsolidations(slot);
if (!queue.length) throw new Error(`pending_consolidations is empty at slot ${slot}; try again later`);
const pair = queue[queue.length - 1];
console.log(`${C.c}1. Beacon state${C.r} ${C.dim}(newest block whose root is in EIP-4788)${C.r}`);
kv("slot / epoch", `${slot} / ${Math.floor(slot / 32)}`);
kv("pending consolidations", `${queue.length} in queue, proving ${pair.source} -> ${pair.target}`);

const t0 = Date.now();
const p = await remoteProofs(beacon, blockId, {
  validators: [pair.source, pair.target],
  balances: [pair.source],
  pending: pair,
});
kv("proofs fetched", `${Date.now() - t0} ms from ${beacon.baseUrl} (untrusted: rebuilt against the header)`);

// 2. onchain verification, exactly the calls the market makes
console.log(`\n${C.c}2. Verified onchain${C.r} ${C.dim}(eth_call to the deployed BeaconOracle)${C.r}`);
const stateRoot = (await call("verifiedStateRoot", [p.stateRootProof])) as `0x${string}`;
ok(`state root under the EIP-4788 root keyed by timestamp ${p.timestamp} (slot ${p.stateRootProof.slot} bound in the same branch)`);
kv("state_root", stateRoot);
await call("verifyPendingConsolidation", [stateRoot, p.pending]);
ok(`pending_consolidations[${p.pending!.queueIndex}] = (${pair.source} -> ${pair.target})   ${C.dim}<- checkpoint 1${C.r}`);
const [src, tgt] = p.validators;
await call("verifyValidator", [stateRoot, src]);
ok(`source validator ${src.index}`);
kv("exit / withdrawable", `epoch ${src.validator.exitEpoch} / ${src.validator.withdrawableEpoch}`);
await call("verifyValidator", [stateRoot, tgt]);
ok(`target validator ${tgt.index} ${C.dim}(credentials 0x${tgt.validator.withdrawalCredentials.slice(2, 4)})${C.r}`);
const bal = (await call("verifyBalance", [stateRoot, p.balances[0]])) as bigint;
ok(`source balance ${Number(bal) / 1e9} ETH`);
const at = deployment.genesisTime + Number(src.validator.withdrawableEpoch) * 384;
kv("delivery", `after epoch ${src.validator.withdrawableEpoch} (~${new Date(at * 1000).toISOString().slice(0, 16)}Z), when the balance moves to ${tgt.index}`);

// 3. forged claims fail
console.log(`\n${C.c}3. Forgeries rejected${C.r}`);
const expectRevert = async (what: string, f: () => Promise<unknown>) => {
  try {
    await f();
    console.log(`  ${C.red}✗ ${what} was accepted${C.r}`);
    process.exitCode = 1;
  } catch {
    ok(`${what} reverts`);
  }
};
await expectRevert("same consolidation into another target", () =>
  call("verifyPendingConsolidation", [stateRoot, { ...p.pending!, targetIndex: p.pending!.targetIndex + 1n }]),
);
await expectRevert("state claimed at an earlier slot", () =>
  call("verifiedStateRoot", [{ ...p.stateRootProof, slot: p.stateRootProof.slot - 32n }]),
);
await expectRevert("source reported as not exiting", () =>
  call("verifyValidator", [stateRoot, { ...src, validator: { ...src.validator, exitEpoch: 2n ** 64n - 1n } }]),
);
console.log();
