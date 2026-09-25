// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {StakePortHook} from "../../src/uniswap/StakePortHook.sol";
import {StakePortSwapRouter} from "../../src/uniswap/StakePortSwapRouter.sol";
import {IUniswapV3PoolOracle, IWstETH, UniswapStakePriceOracle} from "../../src/uniswap/UniswapStakePriceOracle.sol";
import {HookMiner} from "../../script/utils/HookMiner.sol";
import {Fixture} from "../utils/Fixture.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {UniswapSetup as U} from "../utils/UniswapSetup.sol";

/// @notice Buying native stake with USDC in a single Uniswap v4 swap, on a mainnet fork with real
/// liquidity, real beacon proofs and the real EIP-7251 predeploy.
contract UniswapForkTest is ForkTest {
    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    IERC20 constant WETH = IERC20(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    IERC20 constant USDC = IERC20(U.USDC);

    UniswapStakePriceOracle oracle;
    NativeStakeMarket market;
    StakePortHook hook;
    StakePortSwapRouter router;
    PoolKey stakeKey;

    address seller;
    address buyer = makeAddr("buyer");
    BeaconProofs.ValidatorProof source;
    BeaconProofs.ValidatorProof target;

    function setUp() public {
        _fork();
        oracle = new UniswapStakePriceOracle(
            IUniswapV3PoolOracle(U.WSTETH_WETH_V3), IWstETH(U.WSTETH), address(WETH), U.TWAP_WINDOW
        );
        market = new NativeStakeMarket(WETH, new BeaconOracle(), oracle, 1606824023, 1 days, 1 days);

        bytes memory args = abi.encode(U.POOL_MANAGER, market, U.liquidityKey());
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), U.HOOK_FLAGS, type(StakePortHook).creationCode, args);
        hook = new StakePortHook{salt: salt}(U.POOL_MANAGER, market, U.liquidityKey());
        assertEq(address(hook), predicted);

        stakeKey = U.stakeKey(address(hook));
        U.POOL_MANAGER.initialize(stakeKey, TickMath.getSqrtPriceAtTick(0));
        router = new StakePortSwapRouter(U.POOL_MANAGER);

        source = Fixture.validatorProof("sellableSource");
        target = Fixture.validatorProof("target");
        seller = Fixture.withdrawalAddress("sellableSource");
        vm.etch(seller, abi.encodePacked(hex"ef0100", address(market.delegate())));

        deal(address(USDC), buyer, 200_000e6);
        vm.prank(buyer);
        USDC.approve(address(router), type(uint256).max);
    }

    function _order(NativeStakeMarket.PriceMode mode, uint256 price, uint256 minPayment)
        internal
        returns (NativeStakeMarket.StakeOrder memory o)
    {
        o = NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: source.validator.pubkey,
            sourceIndex: source.index,
            priceMode: mode,
            price: price,
            minPayment: minPayment,
            expiry: vm.getBlockTimestamp() + 1 days,
            nonce: 1
        });
        vm.prank(seller);
        market.listOrder(o);
    }

    function _hookData(NativeStakeMarket.StakeOrder memory o) internal view returns (bytes memory) {
        return abi.encode(
            StakePortHook.Purchase({
                order: o,
                signature: "",
                targetPubkey: target.validator.pubkey,
                proofs: NativeStakeMarket.FillProofs({state: Fixture.stateRootProof(), source: source, target: target}),
                buyer: buyer
            })
        );
    }

    function _queueTail() internal view returns (uint256) {
        return uint256(vm.load(CONSOLIDATION_REQUEST, bytes32(uint256(3))));
    }

    // --- oracle ----------------------------------------------------------------------------------

    function test_oracle_pricesStakedEthNearParity() public view {
        uint256 wst = oracle.wstEthPrice();
        uint256 staked = oracle.stakedEthPrice();
        assertGt(wst, 1.1e18, "wstETH trades above 1 WETH");
        assertLt(wst, 1.4e18);
        assertGt(staked, 0.98e18, "staked ETH near parity");
        assertLt(staked, 1.01e18);
        // consistent with the wstETH exchange rate
        assertApproxEqRel(staked * IWstETH(U.WSTETH).stEthPerToken() / 1e18, wst, 1e12);
    }

    function test_oracle_rejectsWrongPool() public {
        vm.expectRevert(UniswapStakePriceOracle.InvalidPool.selector);
        new UniswapStakePriceOracle(IUniswapV3PoolOracle(U.WSTETH_WETH_V3), IWstETH(U.USDC), address(WETH), 600);
    }

    // --- hook: buy native stake with a swap ------------------------------------------------------

    function test_buyWithUsdc_singleSwap() public {
        NativeStakeMarket.StakeOrder memory o = _order(NativeStakeMarket.PriceMode.Fixed, 31.7 ether, 0);
        uint256 amountIn = 90_000e6;
        uint256 usdcBefore = USDC.balanceOf(buyer);
        uint256 ethBefore = buyer.balance;
        uint256 tailBefore = _queueTail();

        vm.recordLogs();
        vm.prank(buyer);
        router.swapExactTokenForEth(stakeKey, amountIn, _hookData(o));

        // buyer paid exactly amountIn USDC and got the unused ETH back
        assertEq(USDC.balanceOf(buyer), usdcBefore - amountIn);
        uint256 refund = buyer.balance - ethBefore;
        assertGt(refund, 0);

        // payment escrowed, consolidation requested from the seller's address
        NativeStakeMarket.Trade memory t = market.getTrade(1);
        assertEq(t.buyer, buyer);
        assertEq(t.payment, 31.7 ether);
        assertEq(WETH.balanceOf(address(market)), 31.7 ether);
        assertEq(_queueTail(), tailBefore + 1);

        // the hook keeps nothing
        assertEq(address(hook).balance, 0);
        assertEq(WETH.balanceOf(address(hook)), 0);
        assertEq(USDC.balanceOf(address(hook)), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool purchased;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == StakePortHook.StakePurchased.selector) {
                (uint256 tokenIn, uint256 ethOut, uint256 payment, uint256 r) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(tokenIn, amountIn);
                assertEq(payment, 31.7 ether);
                assertEq(r, refund);
                assertGt(ethOut, payment);
                purchased = true;
            }
        }
        assertTrue(purchased);
    }

    function test_buyWithUsdc_lstRelativeOrder() public {
        // price = 32 ETH x Uniswap staked-ETH TWAP x (1 - 0.30%)
        NativeStakeMarket.StakeOrder memory o = _order(NativeStakeMarket.PriceMode.LstRelative, 30, 31 ether);
        uint256 expected = 32 ether * oracle.stakedEthPrice() / 1e18 * 9970 / 10_000;
        vm.prank(buyer);
        router.swapExactTokenForEth(stakeKey, 95_000e6, _hookData(o));
        assertEq(market.getTrade(1).payment, expected);
        assertEq(WETH.balanceOf(address(market)), expected);
    }

    function test_revert_notEnoughInput() public {
        NativeStakeMarket.StakeOrder memory o = _order(NativeStakeMarket.PriceMode.Fixed, 31.7 ether, 0);
        bytes memory data = _hookData(o);
        vm.prank(buyer);
        vm.expectPartialRevert(CustomRevert.WrappedError.selector); // InsufficientOutput inside beforeSwap
        router.swapExactTokenForEth(stakeKey, 1_000e6, data);
        assertEq(market.nextTradeId(), 1);
    }

    function test_revert_invalidProofRollsBackSwap() public {
        NativeStakeMarket.StakeOrder memory o = _order(NativeStakeMarket.PriceMode.Fixed, 31.7 ether, 0);
        target.validator.effectiveBalance += 1;
        bytes memory data = _hookData(o);
        uint256 usdcBefore = USDC.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert();
        router.swapExactTokenForEth(stakeKey, 90_000e6, data);
        assertEq(USDC.balanceOf(buyer), usdcBefore);
    }

    function test_revert_ethForTokenDirection() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(_wrapped(IHooks.beforeSwap.selector, StakePortHook.ExactInputTokenForEthOnly.selector));
        U.POOL_MANAGER.unlock(abi.encode(uint8(1)));
    }

    function test_revert_addLiquidity() public {
        // the entry pool never holds liquidity
        vm.expectRevert(_wrapped(IHooks.beforeAddLiquidity.selector, StakePortHook.HookNotImplemented.selector));
        U.POOL_MANAGER.unlock(abi.encode(uint8(2)));
    }

    function _wrapped(bytes4 hookFn, bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFn,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint8 action = abi.decode(data, (uint8));
        if (action == 1) {
            U.POOL_MANAGER.swap(
                stakeKey, SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), ""
            );
        } else {
            U.POOL_MANAGER.modifyLiquidity(
                stakeKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}), ""
            );
        }
        return "";
    }
}
