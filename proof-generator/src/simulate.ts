// Simulated future beacon states for the local demo.
//
// Real consolidations take >27 hours (plus the mainnet churn queue) to go from request to
// delivery. For the demo we start from a REAL mainnet BeaconState, apply exactly the state
// transitions the consensus layer would apply, and inject the resulting (synthetic) beacon block
// root into the EIP-4788 buffer of the local anvil fork. The contracts verify these proofs with
// the same code path as real ones. Everything produced here is labelled as simulated.
import { ssz } from "@lodestar/types";
import type { HeaderMessage } from "./beacon.ts";
import { BeaconState } from "./proofs.ts";

export const SLOTS_PER_EPOCH = 32;
export const SECONDS_PER_SLOT = 12;
export const MIN_VALIDATOR_WITHDRAWABILITY_DELAY = 256;
export const MAX_SEED_LOOKAHEAD = 4;
export const FAR_FUTURE = Infinity;
export const EFFECTIVE_BALANCE_INCREMENT = 1_000_000_000;
export const MIN_ACTIVATION_BALANCE = 32_000_000_000;
export const MAX_EFFECTIVE_BALANCE_ELECTRA = 2_048_000_000_000;

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

export type StateViewDU = ReturnType<typeof BeaconState.deserializeToViewDU>;

export interface SimHeader extends HeaderMessage {
  root: string;
  simulated: boolean;
}

export class BeaconSim {
  readonly state: StateViewDU;
  /** Header of the block whose post-state is `state`. */
  header: SimHeader;
  readonly baseSlot: number;
  readonly genesisTime: number;

  constructor(stateBytes: Uint8Array, header: { root: string; message: HeaderMessage }) {
    this.state = BeaconState.deserializeToViewDU(stateBytes);
    this.header = { ...header.message, root: header.root, simulated: false };
    this.baseSlot = this.state.slot;
    this.genesisTime = Number(this.state.genesisTime);
  }

  get slot() {
    return this.state.slot;
  }

  get epoch() {
    return Math.floor(this.state.slot / SLOTS_PER_EPOCH);
  }

  slotAt(timestamp: number) {
    return Math.floor((timestamp - this.genesisTime) / SECONDS_PER_SLOT);
  }

  /** CL transition of a valid consolidation request (process_consolidation_request, empty churn queue). */
  queueConsolidation(sourceIndex: number, targetIndex: number) {
    const v = this.state.validators.get(sourceIndex);
    const exitEpoch = this.epoch + 1 + MAX_SEED_LOOKAHEAD;
    v.exitEpoch = exitEpoch;
    v.withdrawableEpoch = exitEpoch + MIN_VALIDATOR_WITHDRAWABILITY_DELAY;
    this.state.pendingConsolidations.push(
      ssz.electra.PendingConsolidation.toViewDU({ sourceIndex, targetIndex }),
    );
    return { exitEpoch, withdrawableEpoch: exitEpoch + MIN_VALIDATOR_WITHDRAWABILITY_DELAY };
  }

  /** CL transition of process_pending_consolidations for one entry. */
  processConsolidation(sourceIndex: number, targetIndex: number) {
    const source = this.state.validators.getReadonly(sourceIndex);
    const moved = Math.min(this.state.balances.get(sourceIndex), source.effectiveBalance);
    this.state.balances.set(sourceIndex, this.state.balances.get(sourceIndex) - moved);
    this.state.balances.set(targetIndex, this.state.balances.get(targetIndex) + moved);
    // process_effective_balance_updates at the epoch boundary (hysteresis ignored)
    for (const i of [sourceIndex, targetIndex]) {
      const v = this.state.validators.get(i);
      const cap = v.withdrawalCredentials[0] === 2 ? MAX_EFFECTIVE_BALANCE_ELECTRA : MIN_ACTIVATION_BALANCE;
      const bal = this.state.balances.get(i);
      v.effectiveBalance = Math.min(bal - (bal % EFFECTIVE_BALANCE_INCREMENT), cap);
    }
    // the queue entry is removed by the CL; keeping it does not affect any proof we use
    return { movedGwei: moved };
  }

  /** Advances to the slot of `timestamp` and seals a synthetic block header over the new state. */
  seal(timestamp: number): SimHeader {
    this.state.slot = Math.max(this.state.slot + 1, this.slotAt(timestamp));
    this.state.commit();
    const stateRoot = this.state.hashTreeRoot();
    const message = {
      slot: this.state.slot,
      proposerIndex: Number(this.header.proposer_index),
      parentRoot: Buffer.from(this.header.root.slice(2), "hex"),
      stateRoot,
      bodyRoot: new Uint8Array(32).fill(0x5e), // simulated block body
    };
    const root = ssz.phase0.BeaconBlockHeader.hashTreeRoot(message);
    this.header = {
      slot: String(message.slot),
      proposer_index: String(message.proposerIndex),
      parent_root: this.header.root,
      state_root: hex(stateRoot),
      body_root: hex(message.bodyRoot),
      root: hex(root),
      simulated: true,
    };
    return this.header;
  }
}
