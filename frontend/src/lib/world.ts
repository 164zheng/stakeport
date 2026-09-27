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

/**
 * Local-only (NEXT_PUBLIC_WORLD_IDENTITY_CHECK=1): the Verified Market asks for World ID Identity Check (preview)
 * instead of a plain NFC document proof. World App attests that the document's issuing country matches the one
 * the buyer states, and the backend rejects sanctioned jurisdictions.
 */
export const IDENTITY_CHECK = process.env.NEXT_PUBLIC_WORLD_IDENTITY_CHECK === "1";

export async function rpContext(kind?: "identity"): Promise<RpContext> {
  const r = await fetch("/api/world/rp-signature", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error);
  return { rp_id: r.rp_id, nonce: r.nonce, created_at: r.created_at, expires_at: r.expires_at, signature: r.sig };
}

/** Eligibility under `policy` (a listing's policy address), or the NFC-document policy by default. */
export async function eligibility(account: Address, policy?: Address) {
  const d = await getDeployment();
  const address = policy ?? d.worldEligibility;
  if (!address) return { deployed: false, eligible: false, until: 0n };
  const [eligible, until] = await Promise.all([
    publicClient.readContract({ address, abi: worldIdEligibilityAbi, functionName: "isEligible", args: [account] }),
    publicClient.readContract({ address, abi: worldIdEligibilityAbi, functionName: "eligibleUntil", args: [account] }),
  ]);
  return { deployed: true, eligible: eligible as boolean, until: until as bigint };
}

/** Backend verifies the proof with the Developer Portal; the signed attestation is then recorded onchain. */
export async function verifyAndAttest(account: Address, idkitResponse: IDKitResult, issuingCountry?: string) {
  const r = await fetch("/api/world/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, idkitResponse, issuingCountry }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.detail ? `${r.error}: ${JSON.stringify(r.detail)}` : r.error);
  const d = await getDeployment();
  const a = r.attestation as { account: Address; nullifier: Hex; credential: Hex; expiresAt: string };
  await write({
    account,
    // Identity Check attestations go to the Identity Check policy
    address: (issuingCountry !== undefined ? d.worldIdentityCheck : d.worldEligibility)!,
    abi: worldIdEligibilityAbi,
    functionName: "attest",
    args: [{ ...a, expiresAt: BigInt(a.expiresAt) }, r.signature],
  });
  return r.identifier as string;
}
