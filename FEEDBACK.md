# Uniswap Developer Feedback

Project: StakePort, a secondary market for native Ethereum stake (ETHGlobal Tokyo 2026).
Submitted via https://developers.uniswap.org/hackathon-feedback

## What we used

- **v4 PoolManager on a mainnet fork**: a custom-accounting hook (`beforeSwap` + `beforeSwapReturnDelta`) on a
  zero-liquidity ETH/USDC pool that swaps the input through the canonical ETH/USDC 0.3% pool *inside its own
  `beforeSwap`*, then uses the ETH to buy native validator stake. The swapper receives no output token.
- A minimal `IUnlockCallback` router that passes hookData.
- **V4Quoter** (`quoteExactOutputSingle`) and **StateView** (`getLiquidity`, `getSlot0`) to find and quote the
  canonical pool.
- **v3 wstETH/WETH 0.01% pool `observe()`** as a 30-minute TWAP price oracle for staked ETH.

## What worked well

- Nested swaps from a hook just work: calling `poolManager.swap` on another pool inside `beforeSwap`, taking the
  output and offsetting the input debt with the returned `BeforeSwapDelta` settled on the first try. Flash
  accounting makes "a pool that is only an entry point" very natural.
- `Pool.swap` returning early for `amountSpecified == 0` means a hook that consumes the whole input needs no
  liquidity and no special price limits.
- `CustomRevert.WrappedError` keeps the hook's own error and the hook function selector, which made precise
  revert assertions possible in tests.
- Deterministic mainnet addresses (PoolManager, StateView, V4Quoter) made fork testing easy.

## Friction / bugs

- `BaseHook` is no longer in `v4-periphery`, but many guides and examples still import
  `v4-periphery/src/utils/BaseHook.sol`. We implemented `IHooks` directly instead of adding another dependency.
- `HookMiner` lives in `v4-periphery/test/shared/`, so it is not importable as a normal dependency; we copied it.
- The sign conventions of `BeforeSwapDelta` (which side is "specified", what a positive value means for the
  hook vs. the swapper) took reading `Hooks.sol` and `PoolManager.sol` to be sure. A table for the four
  exact-in/exact-out × zeroForOne cases would save time.
- Finding the "canonical" v4 pool for a pair means computing `PoolId`s for each fee tier and querying StateView;
  there is no onchain way to discover which pools exist.
- `V4Quoter` functions are `nonpayable` (they revert internally), so viem needs `simulateContract` rather than
  `readContract`; worth a line in the docs.
- `PoolManager` is pinned to `=0.8.26` while we compile with 0.8.30; importing only interfaces and libraries
  works, but deploying v4-core in tests would force a second compiler version.

## Missing docs or capabilities

- A reference TWAP/oracle hook for v4 (or guidance on the recommended way to get a manipulation-resistant price
  from v4 pools). We used a v3 pool because it has `observe()`.
- An end-to-end example of a custom-accounting hook that routes to another pool (the "router hook" pattern).

## Single most impactful improvement

Ship `BaseHook` and `HookMiner` in one maintained, importable package that the docs reference consistently,
together with a `BeforeSwapDelta` sign-convention table.
