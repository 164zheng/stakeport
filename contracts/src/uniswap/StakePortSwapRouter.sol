// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Minimal v4 router for exact-input token -> ETH swaps that carry hookData.
/// Used to buy native stake through the StakePort hook pool in a single swap.
contract StakePortSwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error NativeInputUnsupported();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Swaps exactly `amountIn` of `key.currency1` for `key.currency0` (ETH), passing `hookData`.
    /// Any ETH output of the swap is sent to the caller.
    function swapExactTokenForEth(PoolKey calldata key, uint256 amountIn, bytes calldata hookData)
        external
        returns (BalanceDelta delta)
    {
        if (key.currency1.isAddressZero()) revert NativeInputUnsupported();
        delta = abi.decode(poolManager.unlock(abi.encode(msg.sender, key, amountIn, hookData)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address payer, PoolKey memory key, uint256 amountIn, bytes memory hookData) =
            abi.decode(raw, (address, PoolKey, uint256, bytes));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            hookData
        );

        // pay the input token
        uint256 owed = uint256(uint128(-delta.amount1()));
        poolManager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).safeTransferFrom(payer, address(poolManager), owed);
        poolManager.settle();

        // forward any ETH output (zero for the StakePort hook pool)
        if (delta.amount0() > 0) poolManager.take(key.currency0, payer, uint256(uint128(delta.amount0())));
        return abi.encode(delta);
    }
}
