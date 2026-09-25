// Fast checks that the TS proof layout matches the Solidity verifier (no network, no full state).
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ssz } from "@lodestar/types";
import { decodeAbiParameters } from "viem";
import { BeaconState, stateRootProof } from "../src/proofs.ts";
import { encodeStateRootProof, stateRootProofAbi, validatorProofAbi } from "../src/abi.ts";

const sol = readFileSync(new URL("../../contracts/src/libraries/BeaconProofs.sol", import.meta.url), "utf8");
const constant = (name: string) => {
  const m = sol.match(new RegExp(`${name} = (\\d+)(?: << (\\d+))?;`));
  assert.ok(m, `constant ${name} not found`);
  return BigInt(m[1]) << BigInt(m[2] ?? 0);
};

test("generalized indices match BeaconProofs.sol (Fulu layout)", () => {
  assert.equal(Object.keys(BeaconState.fields).length, 38);
  assert.equal(constant("STATE_ROOT_GINDEX"), ssz.phase0.BeaconBlockHeader.getPathInfo(["stateRoot"]).gindex);
  assert.equal(constant("SLOT_GINDEX"), BeaconState.getPathInfo(["slot"]).gindex);
  assert.equal(constant("VALIDATORS_BASE_GINDEX"), BeaconState.getPathInfo(["validators", 0]).gindex);
  assert.equal(constant("BALANCES_BASE_GINDEX"), BeaconState.getPathInfo(["balances", 0]).gindex);
  assert.equal(constant("PENDING_CONSOLIDATIONS_BASE_GINDEX"), BeaconState.getPathInfo(["pendingConsolidations", 0]).gindex);
  // index i is OR-ed into the base gindex
  assert.equal(BeaconState.getPathInfo(["validators", 12345]).gindex, constant("VALIDATORS_BASE_GINDEX") | 12345n);
  assert.equal(BeaconState.getPathInfo(["balances", 12345]).gindex, constant("BALANCES_BASE_GINDEX") | (12345n >> 2n));
});

test("state root proof verifies against the header root", () => {
  const header = {
    slot: "15294304",
    proposer_index: "42",
    parent_root: `0x${"11".repeat(32)}`,
    state_root: `0x${"22".repeat(32)}`,
    body_root: `0x${"33".repeat(32)}`,
  };
  const p = stateRootProof(header, 1790355683);
  const root = ssz.phase0.BeaconBlockHeader.hashTreeRoot(ssz.phase0.BeaconBlockHeader.fromJson(header));
  // recompute bottom-up with gindex 11 = 0b1011
  let node = Buffer.from(p.stateRoot.slice(2), "hex");
  let g = 11;
  for (const sib of p.branch) {
    const s = Buffer.from(sib.slice(2), "hex");
    node = sha256(g & 1 ? Buffer.concat([s, node]) : Buffer.concat([node, s]));
    g >>= 1;
  }
  assert.equal(g, 1);
  assert.equal(`0x${node.toString("hex")}`, `0x${Buffer.from(root).toString("hex")}`);
});

test("abi encoding round-trips", () => {
  const p = stateRootProof(
    { slot: "1", proposer_index: "2", parent_root: `0x${"aa".repeat(32)}`, state_root: `0x${"bb".repeat(32)}`, body_root: `0x${"cc".repeat(32)}` },
    123,
  );
  const decoded = decodeAbiParameters([stateRootProofAbi], encodeStateRootProof(p))[0];
  assert.equal(decoded.timestamp, 123n);
  assert.equal(decoded.stateRoot, p.stateRoot);
  assert.deepEqual(decoded.branch, p.branch);
  assert.equal(validatorProofAbi.components.length, 3);
});

function sha256(b: Buffer) {
  return createHash("sha256").update(b).digest();
}
