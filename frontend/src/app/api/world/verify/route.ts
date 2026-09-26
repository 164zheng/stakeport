import { NextResponse } from "next/server";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { createPublicClient, getAddress, http, isAddress, keccak256, pad, toHex } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCEPTED_IDENTIFIERS,
  CREDENTIAL_LABEL,
  ELIGIBILITY_TTL_SECONDS,
  WORLD_ACTION,
  deployment,
  worldConfig,
} from "@/lib/world-server";

const fail = (status: number, error: string, detail?: unknown) => NextResponse.json({ error, detail }, { status });

/**
 * Verifies a World ID Passport proof and returns a signed eligibility attestation for
 * WorldIdEligibility.attest(). The proof must be bound to the buyer's address via its signal.
 */
export async function POST(request: Request) {
  const c = worldConfig();
  if (!c.configured) return fail(503, "World ID is not configured");
  const { account, idkitResponse } = (await request.json()) as { account: string; idkitResponse: IDKitResult };
  if (!isAddress(account)) return fail(400, "invalid account");

  // 1. The proof must be for our action and environment.
  if (!("action" in idkitResponse) || idkitResponse.action !== WORLD_ACTION) return fail(400, "wrong action");
  if (idkitResponse.environment !== c.environment) return fail(400, `expected ${c.environment} proof`);

  // 2. Only a passport credential (or its legacy document fallback) qualifies.
  const item = idkitResponse.responses.find((r) => ACCEPTED_IDENTIFIERS.has(r.identifier));
  if (!item) {
    return fail(403, "credential_not_accepted", idkitResponse.responses.map((r) => r.identifier));
  }

  // 3. The proof's signal must be the buyer's address, so it cannot be replayed for another account.
  const expectedSignal = hashSignal(getAddress(account).toLowerCase());
  if (!item.signal_hash || BigInt(item.signal_hash) !== BigInt(expectedSignal)) return fail(400, "signal mismatch");

  // 4. Cryptographic verification by the World Developer Portal.
  const res = await fetch(c.verifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(idkitResponse),
  });
  const verified = await res.json().catch(() => ({}));
  if (!res.ok || verified.success !== true) return fail(403, "world_verification_failed", verified);
  if (verified.environment && verified.environment !== c.environment) return fail(403, "environment mismatch");

  // 5. Sign the attestation for the onchain eligibility registry.
  const { worldEligibility } = deployment();
  if (!worldEligibility) return fail(500, "WorldIdEligibility not deployed");
  const nullifierHex = ("nullifier" in item ? item.nullifier : verified.nullifier) as string;
  const attestation = {
    account: getAddress(account),
    nullifier: pad(toHex(BigInt(nullifierHex)), { size: 32 }),
    credential: keccak256(toHex(CREDENTIAL_LABEL)),
    // chain time: the demo fork fast-forwards during settlement
    expiresAt: (await chainTime()) + BigInt(ELIGIBILITY_TTL_SECONDS),
  };
  const signer = privateKeyToAccount(c.attesterKey!);
  const signature = await signer.signTypedData({
    domain: { name: "StakePort WorldIdEligibility", version: "1", chainId: 1, verifyingContract: worldEligibility },
    types: {
      Attestation: [
        { name: "account", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "credential", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "Attestation",
    message: attestation,
  });
  return NextResponse.json({
    identifier: item.identifier,
    attestation: { ...attestation, expiresAt: attestation.expiresAt.toString() },
    signature,
  });
}

async function chainTime() {
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545") });
  return (await client.getBlock()).timestamp;
}
