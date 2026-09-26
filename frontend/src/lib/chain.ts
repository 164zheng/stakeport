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
import { mainnet } from "viem/chains";
import { RPC_URL } from "./config";

// The demo runs on an anvil mainnet fork started with --auto-impersonate, so personas can send
// transactions without private keys.
export const publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
export const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport: http(RPC_URL) });
export const walletClient = createWalletClient({ chain: mainnet, transport: http(RPC_URL) });

export async function write(params: {
  account: Address;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}): Promise<{ hash: Hash; gasUsed: bigint }> {
  // simulate first so a revert surfaces its custom error instead of a mined failed transaction
  await publicClient.simulateContract({ ...params, chain: mainnet } as never);
  const hash = await walletClient.writeContract({ ...params, chain: mainnet } as never);
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
