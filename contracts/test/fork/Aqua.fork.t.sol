// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {AquaStakeBidApp} from "../../src/aqua/AquaStakeBidApp.sol";
import {IAqua} from "../../src/aqua/IAqua.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {IUniswapV3PoolOracle, IWstETH, UniswapStakePriceOracle} from "../../src/uniswap/UniswapStakePriceOracle.sol";
import {Fixture} from "../utils/Fixture.sol";
import {ForkTest} from "../utils/ForkTest.sol";
import {UniswapSetup as U} from "../utils/UniswapSetup.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Standing native-stake bids on the official 1inch Aqua deployment (mainnet fork).
contract AquaForkTest is ForkTest {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    IWETH constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    NativeStakeMarket market;
    AquaStakeBidApp app;
    UniswapStakePriceOracle oracle;

    address maker = makeAddr("maker");
    address keeper = makeAddr("keeper");
    address seller;
    BeaconProofs.ValidatorProof source;
    BeaconProofs.ValidatorProof target;

    function setUp() public {
        _fork();
        oracle = new UniswapStakePriceOracle(
            IUniswapV3PoolOracle(U.WSTETH_WETH_V3), IWstETH(U.WSTETH), address(WETH), U.TWAP_WINDOW
        );
        market = new NativeStakeMarket(WETH, new BeaconOracle(), oracle, 1606824023, 1 days, 1 days);
        app = new AquaStakeBidApp(AQUA, market);

        source = Fixture.validatorProof("sellableSource");
        target = Fixture.validatorProof("target");
        seller = Fixture.withdrawalAddress("sellableSource");
        vm.etch(seller, abi.encodePacked(hex"ef0100", address(market.delegate())));

        // The maker keeps WETH in their wallet and only approves Aqua.
        vm.deal(maker, 200 ether);
        vm.startPrank(maker);
        WETH.deposit{value: 100 ether}();
        WETH.approve(address(AQUA), type(uint256).max);
        vm.stopPrank();
        vm.deal(keeper, 1 ether);
    }

    function _bid(uint256 maxPriceWad) internal view returns (AquaStakeBidApp.StakeBid memory) {
        return AquaStakeBidApp.StakeBid({
            maker: maker,
            targetPubkey: target.validator.pubkey,
            maxPriceWad: maxPriceWad,
            minStakeGwei: 32 gwei,
            maxStakeGwei: 64 gwei,
            salt: bytes32(uint256(1))
        });
    }

    function _ship(AquaStakeBidApp.StakeBid memory bid, uint256 budget) internal returns (bytes32 hash) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(WETH);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = budget;
        vm.prank(maker);
        hash = AQUA.ship(address(app), abi.encode(bid), tokens, amounts);
    }

    function _list(NativeStakeMarket.PriceMode mode, uint256 price) internal returns (NativeStakeMarket.StakeOrder memory o) {
        o = NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: source.validator.pubkey,
            sourceIndex: source.index,
            priceMode: mode,
            price: price,
            minPayment: 0,
            expiry: vm.getBlockTimestamp() + 1 days,
            nonce: 1
        });
        vm.prank(seller);
        market.listOrder(o);
    }

    function _proofs() internal view returns (NativeStakeMarket.FillProofs memory) {
        return NativeStakeMarket.FillProofs({state: Fixture.stateRootProof(), source: source, target: target});
    }

    function test_matchBid_pullsFromMakerWalletIntoEscrow() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18); // up to 31.84 WETH for 32 ETH
        bytes32 hash = _ship(bid, 64 ether);
        assertEq(hash, app.strategyHash(bid));
        // shipping moves no tokens
        assertEq(WETH.balanceOf(maker), 100 ether);
        assertEq(app.available(bid), 64 ether);

        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        uint256 tail = uint256(vm.load(CONSOLIDATION_REQUEST, bytes32(uint256(3))));

        uint256 keeperEth = keeper.balance;
        vm.prank(keeper);
        uint256 id = app.matchBid{value: 0.01 ether}(bid, o, "", _proofs());

        NativeStakeMarket.Trade memory t = market.getTrade(id);
        assertEq(t.buyer, maker, "maker is the buyer and refund recipient");
        assertEq(t.targetIndex, target.index);
        assertEq(t.payment, 31.7 ether);
        assertEq(WETH.balanceOf(address(market)), 31.7 ether);
        assertEq(WETH.balanceOf(maker), 100 ether - 31.7 ether, "pulled from the maker's wallet");
        assertEq(app.available(bid), 64 ether - 31.7 ether, "virtual balance reduced");
        assertEq(WETH.balanceOf(address(app)), 0);
        assertEq(uint256(vm.load(CONSOLIDATION_REQUEST, bytes32(uint256(3)))), tail + 1);
        assertEq(keeper.balance, keeperEth - 1, "keeper paid only the 1 wei EIP-7251 fee");
    }

    function test_matchBid_lstRelativeListing() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(1e18);
        _ship(bid, 40 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.LstRelative, 25);
        uint256 id = app.matchBid{value: 1}(bid, o, "", _proofs());
        assertEq(market.getTrade(id).payment, 32 ether * oracle.stakedEthPrice() / 1e18 * 9975 / 10_000);
    }

    function test_revert_priceAboveBid() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.98e18); // limit 31.36
        _ship(bid, 64 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.PriceAboveBid.selector, 31.7 ether, 31.36 ether));
        app.matchBid{value: 1}(bid, o, "", p);
    }

    function test_revert_budgetExhausted() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        _ship(bid, 20 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.InsufficientBidBalance.selector, 20 ether, 31.7 ether));
        app.matchBid{value: 1}(bid, o, "", p);
    }

    function test_revert_dockedBid() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        bytes32 hash = _ship(bid, 64 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(WETH);
        vm.prank(maker);
        AQUA.dock(address(app), hash, tokens);

        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.InsufficientBidBalance.selector, 0, 31.7 ether));
        app.matchBid{value: 1}(bid, o, "", p);
    }

    function test_revert_stakeSizeOutOfRange() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        bid.minStakeGwei = 64 gwei;
        _ship(bid, 64 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.StakeSizeOutOfRange.selector, 32 gwei));
        app.matchBid{value: 1}(bid, o, "", p);
    }

    function test_revert_proofsForAnotherTarget() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        _ship(bid, 64 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        // a matcher cannot redirect the stake: proofs must be for the bid's target pubkey
        p.target = Fixture.validatorProof("pendingTarget");
        vm.expectRevert(NativeStakeMarket.PubkeyMismatch.selector);
        app.matchBid{value: 1}(bid, o, "", p);
    }

    function test_revert_bidShippedByImpostor() public {
        // someone ships a bid naming the maker; Aqua keys balances by the real shipper, so nothing can be pulled
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(WETH);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 64 ether;
        vm.prank(keeper);
        AQUA.ship(address(app), abi.encode(bid), tokens, amounts);

        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        NativeStakeMarket.FillProofs memory p = _proofs();
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.InsufficientBidBalance.selector, 0, 31.7 ether));
        app.matchBid{value: 1}(bid, o, "", p);
        assertEq(WETH.balanceOf(maker), 100 ether);
    }

    function test_failedTradeRefundsMakerWallet() public {
        AquaStakeBidApp.StakeBid memory bid = _bid(0.995e18);
        _ship(bid, 64 ether);
        NativeStakeMarket.StakeOrder memory o = _list(NativeStakeMarket.PriceMode.Fixed, 31.7 ether);
        uint256 id = app.matchBid{value: 1}(bid, o, "", _proofs());
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        market.refundExpired(id);
        assertEq(WETH.balanceOf(maker), 100 ether);
    }
}
