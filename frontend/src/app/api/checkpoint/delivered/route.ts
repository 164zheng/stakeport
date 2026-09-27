// Public (Hoodi) deployment only: checkpoint 2, the source's validator record and balance from the latest state.
import { encode, json, remoteProofs } from "@/lib/beacon-proofs";

export async function POST(req: Request) {
  const { source } = (await req.json()) as { source: number; target: number };
  try {
    const p = await remoteProofs({ validators: [source], balances: [source] });
    const v = p.validators[0].validator;
    const epoch = BigInt(p.header.slot) / 32n;
    if (v.withdrawableEpoch > epoch) {
      return json({ error: `Not delivered yet: the source becomes withdrawable at epoch ${v.withdrawableEpoch} (now ${epoch}).` }, 409);
    }
    return json({
      simulated: false,
      header: p.header,
      timestamp: String(p.timestamp),
      movedGwei: 0,
      stateRootProof: encode.stateRoot(p.stateRootProof),
      sourceProof: encode.validator(p.validators[0]),
      sourceBalanceProof: encode.balance(p.balances[0]),
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
