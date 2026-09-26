import type { IDKitResult, RpContext } from "@worldcoin/idkit";
import type { Address, Hex } from "viem";
import { worldIdEligibilityAbi } from "@/generated/abis";
import { publicClient, write } from "./chain";
import { getDeployment } from "./config";

export interface WorldConfig {
  configured: boolean;
  appId: `app_${string}` | null;
  rpId: string | null;
  environment: "production" | "staging";
  action: string;
}

export const worldConfig = (): Promise<WorldConfig> => fetch("/api/world/config").then((r) => r.json());

/** The proof is bound to the buyer's address through the IDKit signal. */
export const signalFor = (account: Address) => account.toLowerCase();

export async function rpContext(): Promise<RpContext> {
  const r = await fetch("/api/world/rp-signature", { method: "POST" }).then((x) => x.json());
  if (r.error) throw new Error(r.error);
  return { rp_id: r.rp_id, nonce: r.nonce, created_at: r.created_at, expires_at: r.expires_at, signature: r.sig };
}

export async function eligibility(account: Address) {
  const d = await getDeployment();
  if (!d.worldEligibility) return { deployed: false, eligible: false, until: 0n };
  const [eligible, until] = await Promise.all([
    publicClient.readContract({ address: d.worldEligibility, abi: worldIdEligibilityAbi, functionName: "isEligible", args: [account] }),
    publicClient.readContract({ address: d.worldEligibility, abi: worldIdEligibilityAbi, functionName: "eligibleUntil", args: [account] }),
  ]);
  return { deployed: true, eligible: eligible as boolean, until: until as bigint };
}

/** Backend verifies the proof with the Developer Portal; the signed attestation is then recorded onchain. */
export async function verifyAndAttest(account: Address, idkitResponse: IDKitResult) {
  const r = await fetch("/api/world/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, idkitResponse }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.detail ? `${r.error}: ${JSON.stringify(r.detail)}` : r.error);
  const d = await getDeployment();
  const a = r.attestation as { account: Address; nullifier: Hex; credential: Hex; expiresAt: string };
  await write({
    account,
    address: d.worldEligibility!,
    abi: worldIdEligibilityAbi,
    functionName: "attest",
    args: [{ ...a, expiresAt: BigInt(a.expiresAt) }, r.signature],
  });
  return r.identifier as string;
}
