// Server-only World ID configuration (Next.js route handlers).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * World ID action. World ID 4.0 uniqueness proofs are one-time per (user, action), so every fresh demo
 * deployment uses its own action (scripts/export-frontend.sh writes `worldAction` into deployment.json).
 */
export function worldAction(kind?: "identity"): string {
  const base = process.env.WORLD_ACTION ?? deployment().worldAction ?? "stakeport-verified-market";
  // Identity Check uses its own action: a World ID proof is one-time per (user, action)
  return kind === "identity" ? `${base}-idcheck` : base;
}
/** Credential the Verified Market policy requires (must match WorldIdEligibility.requiredCredential). */
export const CREDENTIAL_LABEL = "world-id:nfc-document";
/** IDKit response identifiers accepted as a passport (World ID 4.0) or its legacy document fallback. */
/** World ID 4.0 NFC document credentials: passport (9303) or Japanese My Number Card (9310). Legacy (3.0)
 * levels are not accepted: their "document" request is satisfied by any higher level such as Orb. */
export const ACCEPTED_IDENTIFIERS = new Set(["passport", "mnc"]);
export const ELIGIBILITY_TTL_SECONDS = 30 * 24 * 3600;

export function worldConfig() {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const rpId = process.env.WORLD_RP_ID;
  const signingKey = process.env.WORLD_RP_SIGNING_KEY;
  const environment = (process.env.WORLD_ENVIRONMENT ?? "staging") as "production" | "staging";
  const attesterKey = process.env.WORLD_ATTESTER_PRIVATE_KEY as `0x${string}` | undefined;
  return {
    appId,
    rpId,
    signingKey,
    environment,
    attesterKey,
    configured: Boolean(appId && rpId && signingKey && attesterKey),
    // one endpoint for both environments; the proof payload carries its environment
    verifyUrl: `https://developer.world.org/api/v4/verify/${rpId}`,
  };
}

export function deployment(): { worldEligibility?: `0x${string}`; worldIdentityCheck?: `0x${string}`; worldAction?: string } {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "deployment.json"), "utf8"));
}

/**
 * Jurisdictions the Verified Market rejects in Identity Check mode (ISO 3166-1 alpha-3). Demo list modelled on
 * comprehensive sanctions programs; a real deployment would take the seller's own list.
 */
/** Credential of the Identity Check policy (script/Deploy.s.sol deploys a second WorldIdEligibility for it). */
export const IDENTITY_CHECK_LABEL = "world-id:identity-check";

export const SANCTIONED_COUNTRIES = new Set(["CUB", "IRN", "PRK", "SYR", "RUS", "BLR"]);
