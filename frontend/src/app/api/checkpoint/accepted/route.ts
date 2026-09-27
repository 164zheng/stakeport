// Public (Hoodi) deployment only: checkpoint 1, a live pending_consolidations entry for (source, target).
import { encode, json, remoteProofs } from "@/lib/beacon-proofs";

export async function POST(req: Request) {
  const { source, target } = (await req.json()) as { source: number; target: number };
  try {
    const p = await remoteProofs({ validators: [source], pending: { source, target } });
    if (!p.pending) {
      return json(
        { error: "Not in pending_consolidations yet: the consensus layer has not accepted this request (or it was already processed)." },
        409,
      );
    }
    return json({
      simulated: false,
      header: p.header,
      timestamp: String(p.timestamp),
      withdrawableEpoch: Number(p.validators[0].validator.withdrawableEpoch),
      stateRootProof: encode.stateRoot(p.stateRootProof),
      pendingConsolidationProof: encode.pending(p.pending),
      sourceProof: encode.validator(p.validators[0]),
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
