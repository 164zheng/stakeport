// End-to-end demo flow against the local fork + proof service (no UI).
//
//   node scripts/e2e.ts
//
// seller lists -> 7702 delegation -> buyer fills with real proofs -> checkpoint 1 -> checkpoint 2
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeAbiParameters,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import {
  balanceProofAbi,
  pendingConsolidationProofAbi,
  stateRootProofAbi,
  validatorProofAbi,
} from "../src/abi.ts";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const SVC = process.env.PROOF_SERVICE_URL ?? "http://localhost:8788";
const root = new URL("../../", import.meta.url).pathname;
const deployment = JSON.parse(readFileSync(`${root}deployments/local.json`, "utf8"));
const marketAbi = JSON.parse(readFileSync(`${root}contracts/out/NativeStakeMarket.sol/NativeStakeMarket.json`, "utf8")).abi;
const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
const test = createTestClient({ chain: mainnet, mode: "anvil", transport: http(RPC) });
const wallet = createWalletClient({ chain: mainnet, transport: http(RPC) });

const get = async (p: string) => (await fetch(`${SVC}${p}`)).json();
const post = async (p: string, body: unknown) =>
  (await fetch(`${SVC}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const dec = <T>(abi: unknown, data: Hex) => decodeAbiParameters([abi as never], data)[0] as T;

async function send(from: Address, address: Address, abi: unknown, functionName: string, args: unknown[], value?: bigint) {
  const hash = await wallet.writeContract({ account: from, address, abi: abi as never, functionName, args, value } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

const info = await get("/api/info");
const seller: Address = info.personas.seller.address;
const buyer: Address = info.personas.buyer.address;
const market: Address = deployment.market;
const [sourceIndex] = info.personas.seller.validators as number[];
const [targetIndex] = info.personas.buyer.validators as number[];
console.log({ seller, buyer, sourceIndex, targetIndex });

// Fund personas. In production the seller signs an EIP-7702 authorization; on the fork we set
// the delegation designator directly because we don't hold the real seller's key.
await test.setBalance({ address: seller, value: parseEther("10") });
await test.setBalance({ address: buyer, value: parseEther("100") });
await test.setCode({ address: seller, bytecode: `0xef0100${deployment.delegate.slice(2)}` as Hex });

const fillProofs = await get(`/api/fill-proofs?source=${sourceIndex}&target=${targetIndex}`);
const source = dec<{ index: bigint; validator: { pubkey: Hex } }>(validatorProofAbi, fillProofs.sourceProof);
const target = dec<{ index: bigint; validator: { pubkey: Hex } }>(validatorProofAbi, fillProofs.targetProof);

const latest = await pub.getBlock();
const order = {
  seller,
  sourcePubkey: source.validator.pubkey,
  sourceIndex: BigInt(sourceIndex),
  priceMode: 0,
  price: parseEther("31.7"),
  minPayment: 0n,
  expiry: latest.timestamp + 86400n * 60n,
  nonce: BigInt(Date.now()),
};

await send(seller, market, marketAbi, "listOrder", [order]);
console.log("✓ order listed");

await send(buyer, deployment.weth, wethAbi, "deposit", [], parseEther("40"));
await send(buyer, deployment.weth, wethAbi, "approve", [market, 2n ** 256n - 1n]);
const r = await send(buyer, market, marketAbi, "fill", [
  order,
  "0x",
  target.validator.pubkey,
  {
    state: dec(stateRootProofAbi, fillProofs.stateRootProof),
    source,
    target,
  },
  buyer,
], parseEther("0.01"));
const tradeId = (await pub.readContract({ address: market, abi: marketAbi, functionName: "nextTradeId" })) as bigint - 1n;
console.log(`✓ filled trade #${tradeId} (gas ${r.gasUsed}): payment escrowed, EIP-7251 request submitted`);

const acc = await post("/api/checkpoint/accepted", { tradeId: tradeId.toString(), source: sourceIndex, target: targetIndex });
if (acc.error) throw new Error(acc.error);
await send(buyer, market, marketAbi, "proveAccepted", [
  tradeId,
  dec(stateRootProofAbi, acc.stateRootProof),
  dec(pendingConsolidationProofAbi, acc.pendingConsolidationProof),
  dec(validatorProofAbi, acc.sourceProof),
]);
console.log(`✓ checkpoint 1: consolidation accepted (simulated slot ${acc.header.slot}), withdrawable epoch ${acc.withdrawableEpoch}`);

const del = await post("/api/checkpoint/delivered", { tradeId: tradeId.toString(), source: sourceIndex, target: targetIndex });
if (del.error) throw new Error(del.error);
const before = (await pub.readContract({ address: deployment.weth, abi: wethAbi, functionName: "balanceOf", args: [seller] })) as bigint;
await send(buyer, market, marketAbi, "proveDelivered", [
  tradeId,
  dec(stateRootProofAbi, del.stateRootProof),
  dec(validatorProofAbi, del.sourceProof),
  dec(balanceProofAbi, del.sourceBalanceProof),
]);
const after = (await pub.readContract({ address: deployment.weth, abi: wethAbi, functionName: "balanceOf", args: [seller] })) as bigint;
console.log(`✓ checkpoint 2: ${del.movedGwei / 1e9} ETH delivered to validator ${targetIndex}; seller paid ${formatEther(after - before)} WETH`);
