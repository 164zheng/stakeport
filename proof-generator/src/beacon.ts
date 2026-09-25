// Minimal Beacon API client. Large states are cached on disk under data/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;

export function beaconUrl(): string {
  const url = process.env.BEACON_API_URL;
  if (!url) throw new Error("BEACON_API_URL is not set");
  return url.replace(/\/$/, "");
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${beaconUrl()}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface HeaderMessage {
  slot: string;
  proposer_index: string;
  parent_root: string;
  state_root: string;
  body_root: string;
}

export async function getHeader(blockId: string | number) {
  const r = await getJson<{ data: { root: string; header: { message: HeaderMessage } } }>(
    `/eth/v1/beacon/headers/${blockId}`,
  );
  return { root: r.data.root, message: r.data.header.message };
}

export interface ExecutionPayloadInfo {
  blockNumber: number;
  timestamp: number;
  parentRoot: string;
}

/** Execution payload of a beacon block: its EL block carries parent_root in the 4788 buffer. */
export async function getExecutionPayloadInfo(blockId: string | number): Promise<ExecutionPayloadInfo> {
  const r = await getJson<{
    data: { message: { parent_root: string; body: { execution_payload: { block_number: string; timestamp: string } } } };
  }>(`/eth/v2/beacon/blocks/${blockId}`);
  const p = r.data.message.body.execution_payload;
  return { blockNumber: Number(p.block_number), timestamp: Number(p.timestamp), parentRoot: r.data.message.parent_root };
}

/** Downloads (or reads from cache) the SSZ-encoded BeaconState at a slot. */
export async function getStateSsz(slot: number): Promise<Uint8Array> {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `state-${slot}.ssz`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(`${beaconUrl()}/eth/v2/debug/beacon/states/${slot}`, {
    headers: { accept: "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`state ${slot} -> ${res.status} ${await res.text()}`);
  const version = res.headers.get("eth-consensus-version");
  if (version && version !== "fulu") throw new Error(`unsupported fork ${version}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
}
