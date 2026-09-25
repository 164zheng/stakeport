// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice Mainnet Uniswap addresses and pool keys used by StakePort.
library UniswapSetup {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    /// Uniswap v3 wstETH/WETH 0.01% pool
    address internal constant WSTETH_WETH_V3 = 0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa;
    uint32 internal constant TWAP_WINDOW = 30 minutes;

    uint160 internal constant HOOK_FLAGS =
        Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG;

    /// Canonical v4 ETH/USDC 0.3% pool (deepest ETH/USDC v4 liquidity at the fixture block).
    function liquidityKey() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 3000, 60, IHooks(address(0)));
    }

    /// Zero-liquidity entry pool routed by the StakePort hook.
    function stakeKey(address hook) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 0, 60, IHooks(hook));
    }
}
