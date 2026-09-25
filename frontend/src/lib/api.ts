import { PROOF_SERVICE_URL } from "./config";

export interface ValidatorInfo {
  index: number;
  pubkey: `0x${string}`;
  credentials: string;
  withdrawalCredentials: `0x${string}`;
  effectiveBalanceGwei: number;
  balanceGwei: number;
  activationEpoch: number;
  exitEpoch: number | null;
  withdrawableEpoch: number | null;
  slashed: boolean;
  status: "active" | "exiting" | "withdrawable" | "slashed" | "pending";
}

export interface Persona {
  address: `0x${string}`;
  validators: number[];
}

export interface ServiceInfo {
  baseSlot: number;
  baseBlockRoot: string;
  baseTimestamp: number;
  forkBlock: number;
  currentSlot: number;
  currentEpoch: number;
  genesisTime: number;
  personas: { seller: Persona; buyer: Persona };
  simulated: { kind: string; tradeId?: string; slot: number; root: string; timestamp: string }[];
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PROOF_SERVICE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `proof service ${res.status}`);
  return json as T;
}

export const api = {
  info: () => req<ServiceInfo>("/api/info"),
  validators: (q: { address?: string; indices?: number[] }) =>
    req<ValidatorInfo[]>(
      `/api/validators?${q.address ? `address=${q.address}` : `indices=${(q.indices ?? []).join(",")}`}`,
    ),
  fillProofs: (source: number, target: number) =>
    req<{ simulated: boolean; stateRootProof: `0x${string}`; sourceProof: `0x${string}`; targetProof: `0x${string}` }>(
      `/api/fill-proofs?source=${source}&target=${target}`,
    ),
  accepted: (tradeId: bigint, source: number, target: number) =>
    req<{
      simulated: boolean;
      header: { slot: string; root: string; state_root: string };
      timestamp: string;
      withdrawableEpoch: number;
      stateRootProof: `0x${string}`;
      pendingConsolidationProof: `0x${string}`;
      sourceProof: `0x${string}`;
    }>("/api/checkpoint/accepted", { tradeId: tradeId.toString(), source, target }),
  delivered: (tradeId: bigint, source: number, target: number) =>
    req<{
      simulated: boolean;
      header: { slot: string; root: string; state_root: string };
      timestamp: string;
      movedGwei: number;
      stateRootProof: `0x${string}`;
      sourceProof: `0x${string}`;
      sourceBalanceProof: `0x${string}`;
    }>("/api/checkpoint/delivered", { tradeId: tradeId.toString(), source, target }),
};
