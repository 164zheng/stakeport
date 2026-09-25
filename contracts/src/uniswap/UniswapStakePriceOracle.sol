// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IStakePriceOracle} from "../interfaces/IStakePriceOracle.sol";

interface IUniswapV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IWstETH {
    function stEthPerToken() external view returns (uint256);
}

/// @notice Prices staked ETH off the Uniswap wstETH/WETH market.
/// @dev staked ETH price (WETH per stETH) = TWAP(WETH per wstETH) / stEthPerToken.
/// The time-weighted average makes the price costly to manipulate within a fill transaction.
contract UniswapStakePriceOracle is IStakePriceOracle {
    IUniswapV3PoolOracle public immutable pool;
    IWstETH public immutable wstETH;
    uint32 public immutable twapWindow;
    bool internal immutable wstEthIsToken0;

    error InvalidPool();

    constructor(IUniswapV3PoolOracle pool_, IWstETH wstETH_, address weth, uint32 twapWindow_) {
        pool = pool_;
        wstETH = wstETH_;
        twapWindow = twapWindow_;
        address t0 = pool_.token0();
        address t1 = pool_.token1();
        if (!((t0 == address(wstETH_) && t1 == weth) || (t1 == address(wstETH_) && t0 == weth))) revert InvalidPool();
        wstEthIsToken0 = t0 == address(wstETH_);
    }

    /// @notice Arithmetic mean tick over `twapWindow` (rounded towards negative infinity).
    function twapTick() public view returns (int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        tick = int24(delta / int56(uint56(twapWindow)));
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) tick--;
    }

    /// @notice WETH per wstETH, 1e18 = 1.
    function wstEthPrice() public view returns (uint256) {
        uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(twapTick());
        // price of token0 in token1, as a Q128 number
        uint256 priceX128 = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 64);
        return wstEthIsToken0 ? FullMath.mulDiv(priceX128, 1e18, 1 << 128) : FullMath.mulDiv(1 << 128, 1e18, priceX128);
    }

    /// @inheritdoc IStakePriceOracle
    function stakedEthPrice() external view returns (uint256) {
        return wstEthPrice() * 1e18 / wstETH.stEthPerToken();
    }
}
