// Public (Hoodi) deployment only: minimal replacement for the proof server's /api/info.
const BEACON = process.env.BEACON_URL ?? "https://lodestar-hoodi.chainsafe.io";

export async function GET() {
  const [h, g] = await Promise.all([
    fetch(`${BEACON}/eth/v1/beacon/headers/head`, { cache: "no-store" }).then((r) => r.json()),
    fetch(`${BEACON}/eth/v1/beacon/genesis`).then((r) => r.json()),
  ]);
  const slot = Number(h.data.header.message.slot);
  return Response.json({
    demo: "real",
    baseSlot: slot,
    currentSlot: slot,
    currentEpoch: Math.floor(slot / 32),
    genesisTime: Number(g.data.genesis_time),
    personas: null,
    replay: null,
    simulated: [],
  });
}
