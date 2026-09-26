export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const PROOF_SERVICE_URL = process.env.NEXT_PUBLIC_PROOF_SERVICE_URL ?? "http://localhost:8788";
/** Optional StakePort indexer (proof-generator/src/indexer.ts); falls back to eth_getLogs when unset. */
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL;
/** Chain served by RPC_URL: 1 for the local mainnet fork, 560048 for Hoodi. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 1);
/** Beacon chain genesis time of that chain (mainnet default). */
export const GENESIS_TIME = Number(process.env.NEXT_PUBLIC_GENESIS_TIME ?? 1606824023);
/** Local anvil fork: enables demo helpers (impersonation, balances, fast-forward). */
export const IS_FORK = (process.env.NEXT_PUBLIC_FORK ?? "1") === "1";
/** @deprecated use GENESIS_TIME */
export const MAINNET_GENESIS = GENESIS_TIME;
export const SECONDS_PER_EPOCH = 384;
export const BEACONCHAIN_URL = "https://beaconcha.in/validator/";

export interface Deployment {
  market: `0x${string}`;
  delegate: `0x${string}`;
  beaconOracle: `0x${string}`;
  weth: `0x${string}`;
  deployBlock: number;
  stakePriceOracle?: `0x${string}`;
  hook?: `0x${string}`;
  router?: `0x${string}`;
  usdc?: `0x${string}`;
  aqua?: `0x${string}`;
  aquaBidApp?: `0x${string}`;
  worldEligibility?: `0x${string}`;
}

let cached: Promise<Deployment> | undefined;
export function getDeployment(): Promise<Deployment> {
  cached ??= fetch("/deployment.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("deployment.json missing: run scripts/deploy.sh");
    return r.json();
  });
  return cached;
}
