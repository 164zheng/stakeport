// Public (Hoodi) deployment only: fill proofs for a (source, target) pair from the public Lodestar node.
import { encode, json, remoteProofs } from "@/lib/beacon-proofs";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const source = Number(q.get("source"));
  const target = Number(q.get("target"));
  try {
    const p = await remoteProofs({ validators: [source, target] });
    return json({
      simulated: false,
      slot: Number(p.header.slot),
      stateRootProof: encode.stateRoot(p.stateRootProof),
      sourceProof: encode.validator(p.validators[0]),
      targetProof: encode.validator(p.validators[1]),
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
