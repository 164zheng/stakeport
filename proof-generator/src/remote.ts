// Beacon state proofs from a remote node, without downloading the state.
//
// Lodestar nodes serve compact multiproofs at `GET /eth/v0/beacon/proof/state/{state_id}?format=<descriptor>`
// (e.g. the public ChainSafe nodes for mainnet and Hoodi). The node is NOT trusted: every proof is rebuilt
// into a partial tree whose root must equal the state_root of the block header, which the contracts then
// check against the EIP-4788 root.
import {
  computeDescriptor,
  createNodeFromProof,
  createProof,
  ProofType,
  type Node,
  type SingleProof,
} from "@chainsafe/persistent-merkle-tree";
import { ssz } from "@lodestar/types";
import { numberToHex, pad, type PublicClient } from "viem";
import type { HeaderMessage } from "./beacon.ts";
import type {
  BalanceProof,
  PendingConsolidationProof,
  SlotProof,
  StateRootProof,
  ValidatorFields,
  ValidatorProof,
} from "./proofs.ts";
import { BeaconState, stateRootProof } from "./proofs.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
const FAR_FUTURE = 2n ** 64n - 1n;

export const gindex = {
  slot: BeaconState.getPathInfo(["slot"]).gindex,
  validator: (i: number) => BeaconState.getPathInfo(["validators", i]).gindex,
  balance: (i: number) => BeaconState.getPathInfo(["balances", i]).gindex,
  pendingConsolidation: (j: number) => BeaconState.getPathInfo(["pendingConsolidations", j]).gindex,
};

export interface ValidatorJson {
  index: string;
  balance: string;
  status: string;
  validator: {
    pubkey: string;
    withdrawal_credentials: string;
    effective_balance: string;
    slashed: boolean;
    activation_eligibility_epoch: string;
    activation_epoch: string;
    exit_epoch: string;
    withdrawable_epoch: string;
  };
}

const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02" as const;

export class RemoteBeacon {
  readonly baseUrl: string;
  /** execution-layer client used to locate EIP-4788 keys (avoids heavy beacon block requests) */
  readonly el: PublicClient;
  private genesis?: number;

  constructor(baseUrl: string, el: PublicClient) {
    this.baseUrl = baseUrl;
    this.el = el;
  }

  async get<T>(path: string, attempt = 0): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, { headers: { accept: "application/json" } });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // public nodes rate-limit
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async genesisTime() {
    this.genesis ??= Number((await this.get<{ data: { genesis_time: string } }>("/eth/v1/beacon/genesis")).data.genesis_time);
    return this.genesis;
  }

  async header(blockId: string | number): Promise<{ root: `0x${string}`; message: HeaderMessage }> {
    const r = await this.get<{ data: { root: `0x${string}`; header: { message: HeaderMessage } } }>(
      `/eth/v1/beacon/headers/${blockId}`,
    );
    return { root: r.data.root, message: r.data.header.message };
  }

  /** Timestamp under which EIP-4788 stores `root` (block of `slot`): the next non-empty slot's execution block. */
  async fourEightyEightTimestamp(slot: number, root: string): Promise<number> {
    const genesis = await this.genesisTime();
    for (let s = slot + 1; s < slot + 16; s++) {
      const ts = BigInt(genesis + s * 12);
      const stored = await this.el
        .call({ to: BEACON_ROOTS, data: pad(numberToHex(ts), { size: 32 }) })
        .then((r) => r.data)
        .catch(() => undefined); // reverts for timestamps without a block
      if (stored?.toLowerCase() === root.toLowerCase()) return Number(ts);
    }
    throw new Error(`EIP-4788 has no entry for slot ${slot} yet`);
  }

  async validator(stateId: string | number, index: number) {
    return (await this.get<{ data: ValidatorJson }>(`/eth/v1/beacon/states/${stateId}/validators/${index}`)).data;
  }

  async pendingConsolidations(stateId: string | number) {
    return (
      await this.get<{ data: { source_index: string; target_index: string }[] }>(
        `/eth/v1/beacon/states/${stateId}/pending_consolidations`,
      )
    ).data.map((p) => ({ source: Number(p.source_index), target: Number(p.target_index) }));
  }

  /** Fetches a compact multiproof for `gindices` and checks it against the header's state root. */
  async stateTree(slot: number, stateRoot: string, gindices: bigint[]): Promise<Node> {
    const descriptor = hex(computeDescriptor(gindices));
    const r = await this.get<{ data: { leaves: string[]; descriptor: string } }>(
      `/eth/v0/beacon/proof/state/${slot}?format=${descriptor}`,
    );
    const node = createNodeFromProof({
      type: ProofType.compactMulti,
      leaves: r.data.leaves.map((l) => Buffer.from(l.slice(2), "hex")),
      descriptor: Buffer.from(r.data.descriptor.slice(2), "hex"),
    });
    if (hex(node.root) !== stateRoot.toLowerCase()) throw new Error("remote proof does not match the header state_root");
    return node;
  }
}

function single(node: Node, g: bigint) {
  const p = createProof(node, { type: ProofType.single, gindex: g }) as SingleProof;
  return { leaf: hex(p.leaf), branch: p.witnesses.map(hex) };
}

const epoch = (s: string) => BigInt(s);

export function validatorFieldsFromJson(v: ValidatorJson["validator"]): ValidatorFields {
  return {
    pubkey: v.pubkey as `0x${string}`,
    withdrawalCredentials: v.withdrawal_credentials as `0x${string}`,
    effectiveBalance: BigInt(v.effective_balance),
    slashed: v.slashed,
    activationEligibilityEpoch: epoch(v.activation_eligibility_epoch),
    activationEpoch: epoch(v.activation_epoch),
    exitEpoch: epoch(v.exit_epoch),
    withdrawableEpoch: epoch(v.withdrawable_epoch),
  };
}

/** Newest block whose root is already in EIP-4788: the parent of head (head's own child may not exist yet). */
export async function provableBlockId(node: RemoteBeacon): Promise<string> {
  return (await node.header("head")).message.parent_root;
}

/**
 * A consistent set of proofs from one beacon state, keyed for the contracts:
 * `stateRootProof.timestamp` is the EIP-4788 key under which that state's block root is stored.
 */
export async function remoteProofs(
  node: RemoteBeacon,
  blockId: string | number,
  want: { validators?: number[]; balances?: number[]; pending?: { source: number; target: number }; slot?: boolean },
) {
  const header = await node.header(blockId);
  const slot = Number(header.message.slot);
  const timestamp = await node.fourEightyEightTimestamp(slot, header.root);
  const srp: StateRootProof = stateRootProof(header.message, timestamp);

  let pendingIndex: number | undefined;
  if (want.pending) {
    const list = await node.pendingConsolidations(slot);
    for (let j = list.length - 1; j >= 0; j--) {
      if (list[j].source === want.pending.source && list[j].target === want.pending.target) {
        pendingIndex = j;
        break;
      }
    }
  }

  const gindices = [
    ...(want.validators ?? []).map(gindex.validator),
    ...(want.balances ?? []).map(gindex.balance),
    ...(pendingIndex !== undefined ? [gindex.pendingConsolidation(pendingIndex)] : []),
    ...(want.slot ? [gindex.slot] : []),
  ];
  const tree = gindices.length ? await node.stateTree(slot, header.message.state_root, gindices) : undefined;

  const validators: ValidatorProof[] = [];
  for (const i of want.validators ?? []) {
    const fields = validatorFieldsFromJson((await node.validator(slot, i)).validator);
    const { leaf, branch } = single(tree!, gindex.validator(i));
    // the node's JSON must describe the proven leaf
    const expected = hex(
      ssz.phase0.Validator.hashTreeRoot({
        pubkey: Buffer.from(fields.pubkey.slice(2), "hex"),
        withdrawalCredentials: Buffer.from(fields.withdrawalCredentials.slice(2), "hex"),
        effectiveBalance: Number(fields.effectiveBalance),
        slashed: fields.slashed,
        activationEligibilityEpoch: fields.activationEligibilityEpoch === FAR_FUTURE ? Infinity : Number(fields.activationEligibilityEpoch),
        activationEpoch: fields.activationEpoch === FAR_FUTURE ? Infinity : Number(fields.activationEpoch),
        exitEpoch: fields.exitEpoch === FAR_FUTURE ? Infinity : Number(fields.exitEpoch),
        withdrawableEpoch: fields.withdrawableEpoch === FAR_FUTURE ? Infinity : Number(fields.withdrawableEpoch),
      }),
    );
    if (expected !== leaf) throw new Error(`validator ${i}: JSON does not match the proven leaf`);
    validators.push({ index: BigInt(i), validator: fields, branch });
  }

  const balances: BalanceProof[] = (want.balances ?? []).map((i) => {
    const { leaf, branch } = single(tree!, gindex.balance(i));
    return { index: BigInt(i), chunk: leaf, branch };
  });

  let pending: PendingConsolidationProof | undefined;
  if (pendingIndex !== undefined) {
    const { branch } = single(tree!, gindex.pendingConsolidation(pendingIndex));
    pending = {
      queueIndex: BigInt(pendingIndex),
      sourceIndex: BigInt(want.pending!.source),
      targetIndex: BigInt(want.pending!.target),
      branch,
    };
  }

  const slotProof: SlotProof | undefined = want.slot
    ? { slot: BigInt(slot), branch: single(tree!, gindex.slot).branch }
    : undefined;

  return { header, slot, timestamp, stateRootProof: srp, validators, balances, pending, slotProof };
}
