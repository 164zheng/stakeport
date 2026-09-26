import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import { defineChain } from "viem";
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
export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const args = reverted.data.args?.map(String).join(", ");
      return args ? `${reverted.data.errorName}(${args})` : reverted.data.errorName;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
