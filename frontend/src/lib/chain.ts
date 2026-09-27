import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { defineChain } from "viem";
import {
  aquaStakeBidAppAbi,
  beaconOracleAbi,
  nativeStakeMarketAbi,
  stake7702DelegateAbi,
  stakePortHookAbi,
  stakePortSwapRouterAbi,
  worldIdEligibilityAbi,
} from "@/generated/abis";
import { CHAIN_ID, RPC_URL } from "./config";
import { walletFor } from "./wallet";

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 1 ? "Ethereum (fork)" : CHAIN_ID === 560048 ? "Hoodi" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// On the local fork (anvil --auto-impersonate) demo personas send transactions without keys.
// With a connected wallet, its own account signs instead (see write()).
export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
export const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC_URL) });
export const walletClient = createWalletClient({ chain, transport: http(RPC_URL) });

export async function write(params: {
  account: Address;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}): Promise<{ hash: Hash; gasUsed: bigint }> {
  // simulate first so a revert surfaces its custom error instead of a mined failed transaction
  await publicClient.simulateContract({ ...params, chain } as never);
  const signer = walletFor(params.account) ?? walletClient;
  const hash = await signer.writeContract({ ...params, chain } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${params.functionName} reverted`);
  return { hash, gasUsed: receipt.gasUsed };
}

/** Surfaces the custom error name (and args) of a reverted call. */
// Every custom error our contracts can raise, plus Uniswap v4's WrappedError, which wraps a hook's revert
// (e.g. the market's BuyerNotEligible inside a USDC swap). A call's own ABI misses errors raised deeper in the
// call chain (router -> hook -> market, Aqua app -> market), so revert data is decoded against all of them.
const wrappedErrorAbi = [
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
] as const;
const knownErrors = [
  ...[
    nativeStakeMarketAbi,
    stakePortHookAbi,
    stakePortSwapRouterAbi,
    aquaStakeBidAppAbi,
    worldIdEligibilityAbi,
    stake7702DelegateAbi,
    beaconOracleAbi,
  ].flatMap((abi) => (abi as Abi).filter((x) => x.type === "error")),
  ...wrappedErrorAbi,
] as Abi;

function decodeRevert(data: Hex, depth = 0): string | undefined {
  try {
    const r = decodeErrorResult({ abi: knownErrors, data });
    const args = (r.args ?? []) as readonly unknown[];
    if (r.errorName === "WrappedError" && depth < 3) {
      const inner = decodeRevert(args[2] as Hex, depth + 1);
      if (inner) return inner;
    }
    return args.length ? `${r.errorName}(${args.map(String).join(", ")})` : r.errorName;
  } catch {
    return undefined;
  }
}

/** Raw revert data anywhere in a viem error chain. */
function revertData(e: BaseError): Hex | undefined {
  let found: Hex | undefined;
  e.walk((x) => {
    const c = x as { raw?: unknown; data?: unknown };
    const d = typeof c.raw === "string" ? c.raw : typeof c.data === "string" ? c.data : (c.data as { data?: unknown })?.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      found = d as Hex;
      return true;
    }
    return false;
  });
  return found;
}

export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const data = revertData(e);
    const decoded = data && decodeRevert(data);
    if (decoded) return decoded;
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const args = reverted.data.args?.map(String).join(", ");
      return args ? `${reverted.data.errorName}(${args})` : reverted.data.errorName;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
