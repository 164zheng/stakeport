import { NextResponse } from "next/server";
import { WORLD_ACTION, worldConfig } from "@/lib/world-server";

/** Public part of the World ID configuration for the client. */
export async function GET() {
  const c = worldConfig();
  return NextResponse.json({
    configured: c.configured,
    appId: c.appId ?? null,
    rpId: c.rpId ?? null,
    environment: c.environment,
    action: WORLD_ACTION,
  });
}
