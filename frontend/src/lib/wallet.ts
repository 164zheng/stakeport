import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type WalletClient } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

let connected: { address: Address; client: WalletClient } | undefined;

/** Connects the browser wallet (EIP-1193) and switches it to `chainId`. */
export async function connectWallet(chainId: number): Promise<Address> {
  const provider = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!provider) throw new Error("No browser wallet found");
  const [account] = await provider.request({ method: "eth_requestAccounts" });
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
  } catch {
    /* the wallet may not know the chain yet; transactions will fail with a clear error */
  }
  const address = getAddress(account);
  connected = { address, client: createWalletClient({ account: address, transport: custom(provider) }) };
  return address;
}

export function disconnectWallet() {
  connected = undefined;
}

export const connectedAddress = () => connected?.address;

/** The connected wallet's client if it controls `account`. */
export function walletFor(account: Address): WalletClient | undefined {
  return connected && connected.address.toLowerCase() === account.toLowerCase() ? connected.client : undefined;
}
