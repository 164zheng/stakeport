// Proof server for a real network (e.g. Hoodi): no state download, no simulation.
//
//   RPC_URL=<execution rpc> BEACON_PROOF_URL=https://lodestar-hoodi.chainsafe.io node src/realServer.ts
//
// Serves the subset of the demo proof service API the frontend needs for fills:
//   GET /api/info, /api/validators?indices=..., /api/fill-proofs?source=&target=
// Checkpoints are settled by the relayer (src/relayer.ts, MODE=real).
import { createServer, type ServerResponse } from "node:http";
import { createPublicClient, http } from "viem";
import { RemoteBeacon, provableBlockId, remoteProofs, type ValidatorJson } from "./remote.ts";
import { encodeStateRootProof, encodeValidatorProof } from "./abi.ts";

const PORT = Number(process.env.PORT ?? 8788);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const beacon = new RemoteBeacon(
  process.env.BEACON_PROOF_URL ?? "https://lodestar-hoodi.chainsafe.io",
  createPublicClient({ transport: http(RPC_URL) }) as never,
);
const FAR = "18446744073709551615";

function describe(v: ValidatorJson, epoch: number) {
  const exiting = v.validator.exit_epoch !== FAR;
  return {
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
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/info") {
      const h = await beacon.header("head");
      return send(res, 200, {
        demo: "real",
        baseSlot: Number(h.message.slot),
        currentSlot: Number(h.message.slot),
        currentEpoch: Math.floor(Number(h.message.slot) / 32),
        genesisTime: await beacon.genesisTime(),
        personas: null,
        replay: null,
        simulated: [],
      });
    }
    if (url.pathname === "/api/validators") {
      const indices = (url.searchParams.get("indices") ?? "").split(",").filter(Boolean).map(Number).slice(0, 64);
      const h = await beacon.header("head");
      const epoch = Math.floor(Number(h.message.slot) / 32);
      const out = [];
      for (const i of indices) out.push(describe(await beacon.validator(Number(h.message.slot), i), epoch));
      return send(res, 200, out);
    }
    if (url.pathname === "/api/fill-proofs") {
      const source = Number(url.searchParams.get("source"));
      const target = Number(url.searchParams.get("target"));
      const p = await remoteProofs(beacon, await provableBlockId(beacon), { validators: [source, target] });
      return send(res, 200, {
        simulated: false,
        slot: p.slot,
        stateRootProof: encodeStateRootProof(p.stateRootProof),
        sourceProof: encodeValidatorProof(p.validators[0]),
        targetProof: encodeValidatorProof(p.validators[1]),
      });
    }
    send(res, 404, { error: "not available on a real network (queues/checkpoints: see the relayer)" });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, () => console.log(`real proof server on http://localhost:${PORT} (${beacon.baseUrl})`));
