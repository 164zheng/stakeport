// Server-only World ID configuration (Next.js route handlers).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * World ID action. World ID 4.0 uniqueness proofs are one-time per (user, action), so every fresh demo
 * deployment uses its own action (scripts/export-frontend.sh writes `worldAction` into deployment.json).
 */
export function worldAction(): string {
  return process.env.WORLD_ACTION ?? deployment().worldAction ?? "stakeport-verified-market";
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

export function deployment(): { worldEligibility?: `0x${string}`; worldAction?: string } {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "deployment.json"), "utf8"));
}
