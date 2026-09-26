import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { WORLD_ACTION, worldConfig } from "@/lib/world-server";

/** Signs the IDKit request so the World ID App knows it comes from StakePort (RP signature). */
export async function POST() {
  const c = worldConfig();
  if (!c.configured) return NextResponse.json({ error: "World ID is not configured" }, { status: 503 });
  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: c.signingKey!, action: WORLD_ACTION });
  return NextResponse.json({ sig, nonce, created_at: createdAt, expires_at: expiresAt, rp_id: c.rpId });
}
