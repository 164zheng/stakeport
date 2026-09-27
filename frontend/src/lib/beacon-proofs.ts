// Server-only: beacon-state proofs from a public Lodestar node for the public (Hoodi) deployment, mirroring
// proof-generator/src/remote.ts without the lodestar type library. Nothing here is trusted: the multiproof is
// rebuilt and checked against the header's state_root, and the contracts check everything against EIP-4788
// (a wrong validator JSON only makes the onchain proof fail).
import { createHash } from "node:crypto";
import {
  computeDescriptor,
  createNodeFromProof,
  createProof,
  ProofType,
  type Node,
  type SingleProof,
} from "@chainsafe/persistent-merkle-tree";
import { encodeAbiParameters, numberToHex, pad, type Hex } from "viem";
import {
  balanceProofAbi,
  pendingConsolidationProofAbi,
  stateRootProofAbi,
  validatorProofAbi,
} from "@/generated/proofAbi";
import { publicClient } from "./chain";
import { GENESIS_TIME } from "./config";

const BEACON = process.env.BEACON_URL ?? "https://lodestar-hoodi.chainsafe.io";
const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";

const gindex = {
  validator: (i: number) => (150n << 40n) | BigInt(i),
  balance: (i: number) => (152n << 38n) | BigInt(i >> 2),
  pending: (j: number) => (200n << 18n) | BigInt(j),
};

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;
const sha256 = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const le64 = (n: string | bigint) => {
  const b = Buffer.alloc(32);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const bytes32 = (h: string) => Buffer.from(h.slice(2), "hex");

async function get<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${BEACON}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`beacon ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

interface Header {
  slot: string;
  proposer_index: string;
  parent_root: string;
  state_root: string;
  body_root: string;
}
interface ValidatorJson {
  pubkey: string;
  withdrawal_credentials: string;
  effective_balance: string;
  slashed: boolean;
  activation_eligibility_epoch: string;
  activation_epoch: string;
  exit_epoch: string;
  withdrawable_epoch: string;
}

/** state_root (gindex 11) proof: siblings are parent_root, hash(slot, proposer), hash(body_root, 0, 0, 0). */
function stateRootProof(h: Header, timestamp: number) {
  const zero = Buffer.alloc(32);
  const node4 = sha256(le64(h.slot), le64(h.proposer_index));
  const node3 = sha256(sha256(bytes32(h.body_root), zero), sha256(zero, zero));
  return {
    timestamp: BigInt(timestamp),
    slot: BigInt(h.slot),
    proposerIndex: BigInt(h.proposer_index),
    stateRoot: h.state_root as Hex,
    branch: [h.parent_root as Hex, hex(node4), hex(node3)],
  };
}

/** EIP-4788 key of a block root: the timestamp of the next non-empty slot's execution block. */
async function fourEightyEightTimestamp(slot: number, root: string) {
  for (let s = slot + 1; s < slot + 16; s++) {
    const ts = BigInt(GENESIS_TIME + s * 12);
    const stored = await publicClient
      .call({ to: BEACON_ROOTS, data: pad(numberToHex(ts), { size: 32 }) })
      .then((r) => r.data)
      .catch(() => undefined);
    if (stored?.toLowerCase() === root.toLowerCase()) return Number(ts);
  }
  throw new Error(`EIP-4788 has no entry for slot ${slot} yet`);
}

async function stateTree(slot: number, stateRoot: string, gindices: bigint[]): Promise<Node> {
  const r = await get<{ data: { leaves: string[]; descriptor: string } }>(
    `/eth/v0/beacon/proof/state/${slot}?format=${hex(computeDescriptor(gindices))}`,
  );
  const node = createNodeFromProof({
    type: ProofType.compactMulti,
    leaves: r.data.leaves.map((l) => Buffer.from(l.slice(2), "hex")),
    descriptor: Buffer.from(r.data.descriptor.slice(2), "hex"),
  });
  if (hex(node.root) !== stateRoot.toLowerCase()) throw new Error("remote proof does not match the header state_root");
  return node;
}

const branch = (node: Node, g: bigint) => {
  const p = createProof(node, { type: ProofType.single, gindex: g }) as SingleProof;
  return { leaf: hex(p.leaf), branch: p.witnesses.map(hex) };
};

const validatorFields = (v: ValidatorJson) => ({
  pubkey: v.pubkey as Hex,
  withdrawalCredentials: v.withdrawal_credentials as Hex,
  effectiveBalance: BigInt(v.effective_balance),
  slashed: v.slashed,
  activationEligibilityEpoch: BigInt(v.activation_eligibility_epoch),
  activationEpoch: BigInt(v.activation_epoch),
  exitEpoch: BigInt(v.exit_epoch),
  withdrawableEpoch: BigInt(v.withdrawable_epoch),
});

/** Proofs from the newest block whose root is already in EIP-4788 (the parent of head). */
export async function remoteProofs(want: { validators?: number[]; balances?: number[]; pending?: { source: number; target: number } }) {
  const head = await get<{ data: { header: { message: Header } } }>("/eth/v1/beacon/headers/head");
  const parent = await get<{ data: { root: string; header: { message: Header } } }>(
    `/eth/v1/beacon/headers/${head.data.header.message.parent_root}`,
  );
  const h = parent.data.header.message;
  const slot = Number(h.slot);
  const timestamp = await fourEightyEightTimestamp(slot, parent.data.root);

  let pendingIndex: number | undefined;
  if (want.pending) {
    const list = (
      await get<{ data: { source_index: string; target_index: string }[] }>(`/eth/v1/beacon/states/${slot}/pending_consolidations`)
    ).data;
    for (let j = list.length - 1; j >= 0; j--) {
      if (Number(list[j].source_index) === want.pending.source && Number(list[j].target_index) === want.pending.target) {
        pendingIndex = j;
        break;
      }
    }
  }

  const gindices = [
    ...(want.validators ?? []).map(gindex.validator),
    ...(want.balances ?? []).map(gindex.balance),
    ...(pendingIndex !== undefined ? [gindex.pending(pendingIndex)] : []),
  ];
  const tree = await stateTree(slot, h.state_root, gindices);

  const validators = [];
  for (const i of want.validators ?? []) {
    const v = (await get<{ data: { validator: ValidatorJson } }>(`/eth/v1/beacon/states/${slot}/validators/${i}`)).data.validator;
    validators.push({ index: BigInt(i), validator: validatorFields(v), branch: branch(tree, gindex.validator(i)).branch });
  }
  const balances = (want.balances ?? []).map((i) => {
    const b = branch(tree, gindex.balance(i));
    return { index: BigInt(i), chunk: b.leaf, branch: b.branch };
  });
  const pending =
    pendingIndex !== undefined
      ? {
          queueIndex: BigInt(pendingIndex),
          sourceIndex: BigInt(want.pending!.source),
          targetIndex: BigInt(want.pending!.target),
          branch: branch(tree, gindex.pending(pendingIndex)).branch,
        }
      : undefined;

  return {
    header: { slot: h.slot, root: parent.data.root, state_root: h.state_root },
    timestamp,
    stateRootProof: stateRootProof(h, timestamp),
    validators,
    balances,
    pending,
  };
}

export const encode = {
  stateRoot: (p: ReturnType<typeof stateRootProof>) => encodeAbiParameters([stateRootProofAbi], [p]),
  validator: (p: Awaited<ReturnType<typeof remoteProofs>>["validators"][number]) => encodeAbiParameters([validatorProofAbi], [p]),
  balance: (p: Awaited<ReturnType<typeof remoteProofs>>["balances"][number]) => encodeAbiParameters([balanceProofAbi], [p]),
  pending: (p: NonNullable<Awaited<ReturnType<typeof remoteProofs>>["pending"]>) =>
    encodeAbiParameters([pendingConsolidationProofAbi], [p]),
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });
