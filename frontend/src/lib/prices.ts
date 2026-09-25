import { publicClient } from "./chain";

const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** ETH/USD from the Chainlink mainnet feed on the fork. */
export async function ethUsd(): Promise<number> {
  const [, answer] = await publicClient.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData" });
  return Number(answer) / 1e8;
}

/** Rough consensus-layer staking yield used for projections (labelled as an estimate in the UI). */
export const EST_STAKING_APR = 0.029;
