import {
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  parseUnits,
  zeroAddress,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { nativeStakeMarketAbi, stakePortSwapRouterAbi, uniswapStakePriceOracleAbi } from "@/generated/abis";
import { publicClient, testClient, write } from "./chain";
import { getDeployment } from "./config";
import { fillProofs, quote, type Listing } from "./market";

const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as const;
const USDC_BALANCE_SLOT = 9n;
/** ETH sent along for the EIP-7251 fee; the unused part is refunded to the buyer. */
const FEE_BUFFER = parseEther("0.01");
const SLIPPAGE_BPS = 50n;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export async function stakeReference() {
  const d = await getDeployment();
  if (!d.stakePriceOracle) return undefined;
  const [staked, wst] = await Promise.all([
    publicClient.readContract({ address: d.stakePriceOracle, abi: uniswapStakePriceOracleAbi, functionName: "stakedEthPrice" }),
    publicClient.readContract({ address: d.stakePriceOracle, abi: uniswapStakePriceOracleAbi, functionName: "wstEthPrice" }),
  ]);
  return { stakedEthPrice: staked as bigint, wstEthPrice: wst as bigint };
}

async function keys() {
  const d = (await getDeployment()) as Awaited<ReturnType<typeof getDeployment>> & {
    liquidityPoolFee: number;
    liquidityPoolTickSpacing: number;
    stakePoolFee: number;
    stakePoolTickSpacing: number;
  };
  const liquidity = { currency0: zeroAddress, currency1: d.usdc!, fee: d.liquidityPoolFee, tickSpacing: d.liquidityPoolTickSpacing, hooks: zeroAddress };
  const stake = { currency0: zeroAddress, currency1: d.usdc!, fee: d.stakePoolFee, tickSpacing: d.stakePoolTickSpacing, hooks: d.hook! };
  return { d, liquidity, stake };
}

/** USDC needed to receive `ethOut` from the canonical ETH/USDC v4 pool (V4Quoter), plus slippage. */
export async function quoteUsdcIn(ethOut: bigint) {
  const { liquidity } = await keys();
  const { result } = await publicClient.simulateContract({
    address: V4_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [{ poolKey: liquidity, zeroForOne: false, exactAmount: ethOut, hookData: "0x" }],
  });
  const exact = result[0];
  return { exact, withSlippage: (exact * (10_000n + SLIPPAGE_BPS)) / 10_000n };
}

/** Demo only: give the persona USDC by writing its balance on the fork. */
export async function fundUsdc(a: Address, amount = parseUnits("250000", 6)) {
  const d = await getDeployment();
  const bal = await publicClient.readContract({ address: d.usdc!, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  if (bal >= amount / 2n) return;
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, USDC_BALANCE_SLOT]));
  await testClient.setStorageAt({ address: d.usdc!, index: slot, value: pad(numberToHex(amount), { size: 32 }) });
}

const fillInputs = nativeStakeMarketAbi.find((x) => x.type === "function" && x.name === "fill")!.inputs as readonly AbiParameter[];
const purchaseAbi = {
  type: "tuple",
  components: [
    { ...fillInputs[0], name: "order" },
    { name: "signature", type: "bytes" },
    { name: "targetPubkey", type: "bytes" },
    { ...fillInputs[3], name: "proofs" },
    { name: "buyer", type: "address" },
  ],
} as const;

export async function usdcQuoteForListing(listing: Listing, amountGwei: bigint) {
  const payment = await quote(listing.order, amountGwei);
  const q = await quoteUsdcIn(payment + FEE_BUFFER);
  return { payment, usdcIn: q.withSlippage, usdcExact: q.exact };
}

/** One Uniswap v4 swap (USDC -> ETH on the StakePort hook pool) buys the stake. */
export async function buyWithUsdc(listing: Listing, buyer: Address, targetIndex: number, onStep?: (s: string) => void) {
  const { d, stake } = await keys();
  onStep?.("Generating beacon state proofs");
  const proofs = await fillProofs(Number(listing.order.sourceIndex), targetIndex);
  const amountGwei = BigInt((proofs.source.validator as unknown as { effectiveBalance: bigint }).effectiveBalance);

  onStep?.("Quoting USDC → ETH on Uniswap v4");
  const { usdcIn } = await usdcQuoteForListing(listing, amountGwei);
  await fundUsdc(buyer);
  const allowance = await publicClient.readContract({ address: d.usdc!, abi: erc20Abi, functionName: "allowance", args: [buyer, d.router!] });
  if (allowance < usdcIn) {
    onStep?.("Approving USDC for the router");
    await write({ account: buyer, address: d.usdc!, abi: erc20Abi, functionName: "approve", args: [d.router!, 2n ** 256n - 1n] });
  }

  const purchase = { order: listing.order, signature: "0x", targetPubkey: proofs.target.validator.pubkey, proofs, buyer };
  const hookData = encodeAbiParameters([purchaseAbi as AbiParameter], [purchase]) as Hex;
  onStep?.("Swapping USDC in the StakePort v4 pool: hook routes liquidity, escrows WETH, submits EIP-7251");
  const tx = await write({
    account: buyer,
    address: d.router!,
    abi: stakePortSwapRouterAbi,
    functionName: "swapExactTokenForEth",
    args: [stake, usdcIn, hookData],
  });
  const next = (await publicClient.readContract({ address: d.market, abi: nativeStakeMarketAbi, functionName: "nextTradeId" })) as bigint;
  return { tradeId: next - 1n, tx, usdcIn };
}
