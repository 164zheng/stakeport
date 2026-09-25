// Builds single-leaf SSZ Merkle proofs in the layout expected by contracts/src/libraries/BeaconProofs.sol.
import { ssz } from "@lodestar/types";
import { createProof, ProofType, type SingleProof } from "@chainsafe/persistent-merkle-tree";
import type { HeaderMessage } from "./beacon.ts";

export const BeaconState = ssz.fulu.BeaconState;
export type BeaconStateView = ReturnType<typeof BeaconState.deserializeToView>;

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;

function branch(root: Parameters<typeof createProof>[0], gindex: bigint): `0x${string}`[] {
  const p = createProof(root, { type: ProofType.single, gindex }) as SingleProof;
  // witnesses are ordered bottom-up (leaf sibling first)
  return p.witnesses.map(hex);
}

export interface StateRootProof {
  timestamp: bigint;
  stateRoot: `0x${string}`;
  branch: `0x${string}`[];
}

/** Proof of state_root inside BeaconBlockHeader (gindex 11). */
export function stateRootProof(header: HeaderMessage, timestamp: number): StateRootProof {
  const h = ssz.phase0.BeaconBlockHeader.fromJson(header);
  const view = ssz.phase0.BeaconBlockHeader.toViewDU(h);
  return {
    timestamp: BigInt(timestamp),
    stateRoot: hex(h.stateRoot),
    branch: branch(view.node, ssz.phase0.BeaconBlockHeader.getPathInfo(["stateRoot"]).gindex),
  };
}

export interface ValidatorFields {
  pubkey: `0x${string}`;
  withdrawalCredentials: `0x${string}`;
  effectiveBalance: bigint;
  slashed: boolean;
  activationEligibilityEpoch: bigint;
  activationEpoch: bigint;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
}

export interface ValidatorProof {
  index: bigint;
  validator: ValidatorFields;
  branch: `0x${string}`[];
}

const FAR_FUTURE = 2n ** 64n - 1n;
const epoch = (n: number) => (n === Infinity ? FAR_FUTURE : BigInt(n));

export function validatorFields(state: BeaconStateView, index: number): ValidatorFields {
  const v = state.validators.getReadonly(index);
  return {
    pubkey: hex(v.pubkey),
    withdrawalCredentials: hex(v.withdrawalCredentials),
    effectiveBalance: BigInt(v.effectiveBalance),
    slashed: v.slashed,
    activationEligibilityEpoch: epoch(v.activationEligibilityEpoch),
    activationEpoch: epoch(v.activationEpoch),
    exitEpoch: epoch(v.exitEpoch),
    withdrawableEpoch: epoch(v.withdrawableEpoch),
  };
}

export function validatorProof(state: BeaconStateView, index: number): ValidatorProof {
  const gindex = BeaconState.getPathInfo(["validators", index]).gindex;
  return { index: BigInt(index), validator: validatorFields(state, index), branch: branch(state.node, gindex) };
}

export interface BalanceProof {
  index: bigint;
  chunk: `0x${string}`;
  branch: `0x${string}`[];
}

/** Balances are packed 4 per 32-byte chunk. */
export function balanceProof(state: BeaconStateView, index: number): BalanceProof {
  const gindex = BeaconState.getPathInfo(["balances", index]).gindex;
  const p = createProof(state.node, { type: ProofType.single, gindex }) as SingleProof;
  return { index: BigInt(index), chunk: hex(p.leaf), branch: p.witnesses.map(hex) };
}

export interface PendingConsolidationProof {
  queueIndex: bigint;
  sourceIndex: bigint;
  targetIndex: bigint;
  branch: `0x${string}`[];
}

export function pendingConsolidationProof(state: BeaconStateView, queueIndex: number): PendingConsolidationProof {
  const pc = state.pendingConsolidations.getReadonly(queueIndex);
  const gindex = BeaconState.getPathInfo(["pendingConsolidations", queueIndex]).gindex;
  return {
    queueIndex: BigInt(queueIndex),
    sourceIndex: BigInt(pc.sourceIndex),
    targetIndex: BigInt(pc.targetIndex),
    branch: branch(state.node, gindex),
  };
}

export interface SlotProof {
  slot: bigint;
  branch: `0x${string}`[];
}

export function slotProof(state: BeaconStateView): SlotProof {
  return { slot: BigInt(state.slot), branch: branch(state.node, BeaconState.getPathInfo(["slot"]).gindex) };
}
