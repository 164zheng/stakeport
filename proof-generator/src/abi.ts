// ABI encoding of proofs, mirroring the structs in contracts/src/libraries/BeaconProofs.sol.
import { encodeAbiParameters } from "viem";
import type { BalanceProof, PendingConsolidationProof, SlotProof, StateRootProof, ValidatorProof } from "./proofs.ts";

export const stateRootProofAbi = {
  type: "tuple",
  components: [
    { name: "timestamp", type: "uint64" },
    { name: "stateRoot", type: "bytes32" },
    { name: "branch", type: "bytes32[]" },
  ],
} as const;

export const validatorProofAbi = {
  type: "tuple",
  components: [
    { name: "index", type: "uint64" },
    {
      name: "validator",
      type: "tuple",
      components: [
        { name: "pubkey", type: "bytes" },
        { name: "withdrawalCredentials", type: "bytes32" },
        { name: "effectiveBalance", type: "uint64" },
        { name: "slashed", type: "bool" },
        { name: "activationEligibilityEpoch", type: "uint64" },
        { name: "activationEpoch", type: "uint64" },
        { name: "exitEpoch", type: "uint64" },
        { name: "withdrawableEpoch", type: "uint64" },
      ],
    },
    { name: "branch", type: "bytes32[]" },
  ],
} as const;

export const balanceProofAbi = {
  type: "tuple",
  components: [
    { name: "index", type: "uint64" },
    { name: "chunk", type: "bytes32" },
    { name: "branch", type: "bytes32[]" },
  ],
} as const;

export const pendingConsolidationProofAbi = {
  type: "tuple",
  components: [
    { name: "queueIndex", type: "uint64" },
    { name: "sourceIndex", type: "uint64" },
    { name: "targetIndex", type: "uint64" },
    { name: "branch", type: "bytes32[]" },
  ],
} as const;

export const slotProofAbi = {
  type: "tuple",
  components: [
    { name: "slot", type: "uint64" },
    { name: "branch", type: "bytes32[]" },
  ],
} as const;

export const encodeStateRootProof = (p: StateRootProof) => encodeAbiParameters([stateRootProofAbi], [p]);
export const encodeValidatorProof = (p: ValidatorProof) => encodeAbiParameters([validatorProofAbi], [p]);
export const encodeBalanceProof = (p: BalanceProof) => encodeAbiParameters([balanceProofAbi], [p]);
export const encodePendingConsolidationProof = (p: PendingConsolidationProof) =>
  encodeAbiParameters([pendingConsolidationProofAbi], [p]);
export const encodeSlotProof = (p: SlotProof) => encodeAbiParameters([slotProofAbi], [p]);
