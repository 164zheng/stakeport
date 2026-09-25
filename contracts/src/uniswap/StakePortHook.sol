// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {NativeStakeMarket} from "../NativeStakeMarket.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

/// @title StakePortHook
/// @notice Turns a Uniswap v4 swap into a purchase of native validator stake.
///
/// The hooked pool (ETH / token, no liquidity) only exists as an entry point. On an exact-input
/// swap of `token` for ETH, `beforeSwap`:
///   1. takes the swapper's input (custom accounting, the pool's own curve is skipped),
///   2. swaps it for ETH through the canonical ETH/token v4 pool inside the same unlock,
///   3. escrows the stake price in the StakePort market, which submits the EIP-7251
///      consolidation from the seller's EIP-7702 delegated withdrawal address,
///   4. returns leftover ETH to the buyer.
/// The swapper receives no output token: what they buy is delivered on the beacon chain.
contract StakePortHook is IHooks {
    IPoolManager public immutable poolManager;
    NativeStakeMarket public immutable market;
    IWETH9 public immutable weth;

    // Canonical pool used for liquidity (ETH / token).
    Currency public immutable token;
    uint24 public immutable liquidityFee;
    int24 public immutable liquidityTickSpacing;
    IHooks public immutable liquidityHooks;

    /// @notice Encoded as the swap's hookData.
    struct Purchase {
        NativeStakeMarket.StakeOrder order;
        bytes signature;
        bytes targetPubkey;
        NativeStakeMarket.FillProofs proofs;
        address buyer;
    }

    event StakePurchased(
        uint256 indexed tradeId, address indexed buyer, uint256 tokenIn, uint256 ethOut, uint256 payment, uint256 refund
    );

    error NotPoolManager();
    error HookNotImplemented();
    error UnsupportedPool();
    error ExactInputTokenForEthOnly();
    error PartialFill();
    error InsufficientOutput(uint256 ethOut, uint256 payment);
    error RefundFailed();

    constructor(IPoolManager poolManager_, NativeStakeMarket market_, PoolKey memory liquidityKey_) {
        poolManager = poolManager_;
        market = market_;
        weth = IWETH9(address(market_.weth()));
        if (!liquidityKey_.currency0.isAddressZero()) revert UnsupportedPool();
        token = liquidityKey_.currency1;
        liquidityFee = liquidityKey_.fee;
        liquidityTickSpacing = liquidityKey_.tickSpacing;
        liquidityHooks = liquidityKey_.hooks;

        Hooks.validateHookPermissions(
            this,
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        weth.approve(address(market_), type(uint256).max);
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function liquidityKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: token,
            fee: liquidityFee,
            tickSpacing: liquidityTickSpacing,
            hooks: liquidityHooks
        });
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!key.currency0.isAddressZero() || !(key.currency1 == token)) revert UnsupportedPool();
        if (params.zeroForOne || params.amountSpecified >= 0) revert ExactInputTokenForEthOnly();
        uint256 amountIn = uint256(-params.amountSpecified);

        // Route the input through the canonical pool. Its token debt is offset by the credit
        // from the BeforeSwapDelta returned below, so the hook never holds the input token.
        BalanceDelta d = poolManager.swap(
            liquidityKey(),
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        if (uint256(uint128(-d.amount1())) != amountIn) revert PartialFill();
        uint256 ethOut = uint256(uint128(d.amount0()));
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), ethOut);

        Purchase memory p = abi.decode(hookData, (Purchase));
        (uint256 tradeId, uint256 payment, uint256 refund) = _purchase(p, ethOut);
        emit StakePurchased(tradeId, p.buyer, amountIn, ethOut, payment, refund);

        // specified = input token taken from the swapper; unspecified = 0 ETH to the swapper
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(amountIn)), 0), 0);
    }

    function _purchase(Purchase memory p, uint256 ethOut)
        internal
        returns (uint256 tradeId, uint256 payment, uint256 refund)
    {
        payment = market.quote(p.order, p.proofs.source.validator.effectiveBalance);
        if (ethOut <= payment) revert InsufficientOutput(ethOut, payment);
        weth.deposit{value: payment}();
        // the remaining ETH pays the EIP-7251 fee; the market returns what is unused
        tradeId = market.fill{value: ethOut - payment}(p.order, p.signature, p.targetPubkey, p.proofs, p.buyer);
        refund = address(this).balance;
        (bool ok,) = p.buyer.call{value: refund}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev Liquidity cannot be added: the pool is an entry point, not a market.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    // --- unused hooks ----------------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    /// @dev Receives ETH from the PoolManager and the market's unused-fee refund.
    receive() external payable {}
}
