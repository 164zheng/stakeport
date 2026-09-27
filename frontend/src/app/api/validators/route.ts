// Public (Hoodi) deployment only: validator info from the public Lodestar node (no proofs).
const BEACON = process.env.BEACON_URL ?? "https://lodestar-hoodi.chainsafe.io";
const FAR = "18446744073709551615";

interface V {
  index: string;
  balance: string;
  validator: {
    pubkey: string;
    withdrawal_credentials: string;
    effective_balance: string;
    slashed: boolean;
    activation_epoch: string;
    exit_epoch: string;
    withdrawable_epoch: string;
  };
}

export async function GET(req: Request) {
  const indices = (new URL(req.url).searchParams.get("indices") ?? "").split(",").filter(Boolean).slice(0, 64);
  const h = await fetch(`${BEACON}/eth/v1/beacon/headers/head`, { cache: "no-store" }).then((r) => r.json());
  const epoch = Math.floor(Number(h.data.header.message.slot) / 32);
  const out = [];
  for (const i of indices) {
    const r = await fetch(`${BEACON}/eth/v1/beacon/states/head/validators/${Number(i)}`, { cache: "no-store" });
    if (!r.ok) continue;
    const v = ((await r.json()) as { data: V }).data;
    const exiting = v.validator.exit_epoch !== FAR;
    out.push({
      index: Number(v.index),
      pubkey: v.validator.pubkey,
      credentials: v.validator.withdrawal_credentials.slice(0, 4),
      withdrawalCredentials: v.validator.withdrawal_credentials,
      effectiveBalanceGwei: Number(v.validator.effective_balance),
      balanceGwei: Number(v.balance),
      activationEpoch: Number(v.validator.activation_epoch),
      exitEpoch: exiting ? Number(v.validator.exit_epoch) : null,
      withdrawableEpoch: exiting ? Number(v.validator.withdrawable_epoch) : null,
      slashed: v.validator.slashed,
      status: v.validator.slashed
        ? "slashed"
        : exiting
          ? Number(v.validator.withdrawable_epoch) <= epoch
            ? "withdrawable"
            : "exiting"
          : Number(v.validator.activation_epoch) <= epoch
            ? "active"
            : "pending",
    });
  }
  return Response.json(out);
}
