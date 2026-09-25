export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const PROOF_SERVICE_URL = process.env.NEXT_PUBLIC_PROOF_SERVICE_URL ?? "http://localhost:8788";
export const MAINNET_GENESIS = 1606824023;
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
}

let cached: Promise<Deployment> | undefined;
export function getDeployment(): Promise<Deployment> {
  cached ??= fetch("/deployment.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("deployment.json missing: run scripts/deploy.sh");
    return r.json();
  });
  return cached;
}
