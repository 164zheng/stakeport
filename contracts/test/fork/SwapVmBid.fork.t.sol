// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {DutchAuction} from "@1inch/swap-vm/instructions/DutchAuction.sol";
import {Opcodes} from "@1inch/swap-vm/opcodes/Opcodes.sol";
import {Controls} from "@1inch/swap-vm/instructions/Controls.sol";
import {Balances} from "@1inch/swap-vm/instructions/Balances.sol";
import {LimitSwap} from "@1inch/swap-vm/instructions/LimitSwap.sol";
import {Program, ProgramBuilder} from "../../lib/swap-vm/test/utils/ProgramBuilder.sol";
import {SwapVMRouter} from "@1inch/swap-vm/routers/SwapVMRouter.sol";

import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {AquaStakeBidApp} from "../../src/aqua/AquaStakeBidApp.sol";
import {IAqua} from "../../src/aqua/IAqua.sol";
import {IStakePriceOracle} from "../../src/interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {Fixture} from "../utils/Fixture.sol";
import {ForkTest} from "../utils/ForkTest.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @dev Exposes the opcode numbers of SwapVM v1.0.2's instruction table.
contract OpcodeProbe is Opcodes {
    using ProgramBuilder for Program;

    constructor() Opcodes(address(0)) {}

    function opcodes() external pure returns (uint8 staticBalances, uint8 limitSwap, uint8 dutchOut, uint8 salt) {
        Program memory p = ProgramBuilder.init(_opcodes());
        staticBalances = p.findOpcode(Balances._staticBalancesXD);
        limitSwap = p.findOpcode(LimitSwap._limitSwap1D);
        dutchOut = p.findOpcode(DutchAuction._dutchAuctionBalanceOut1D);
        salt = p.findOpcode(Controls._salt);
    }
}

/// @notice Native stake bids priced by a 1inch SwapVM Dutch-auction program, quoted by the official
/// SwapVMRouter v1.0.2 (deployed from the unmodified source: the mainnet 0x11111133… router is the
/// AMM-only AquaSwapVMRouter) and settled through the official Aqua registry on a mainnet fork.
contract SwapVmBidForkTest is ForkTest {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    /// Mainnet 0x11111133… is the AquaSwapVMRouter (AMM opcodes only).
    ISwapVM constant AQUA_SWAP_VM = ISwapVM(0x111111338c5091E8440b67B168bAe16a668AC0De);
    ISwapVM swapVm;
    IWETH constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    // Dutch auction: 99.9% of face, rising to ~100.18% (the entry-queue break-even) over 6 hours.
    uint256 constant START_PRICE = 0.999e18;
    uint16 constant DURATION = 6 hours;
    // decay = (0.999 / 1.0018)^(1 / 21600) per second
    uint64 constant DECAY = 999_999_870_422_125_312;

    NativeStakeMarket market;
    AquaStakeBidApp app;
    address maker = makeAddr("maker");
    address seller;
    BeaconProofs.ValidatorProof source;
    BeaconProofs.ValidatorProof target;
    uint40 start;

    function setUp() public {
        _fork();
        market = new NativeStakeMarket(WETH, new BeaconOracle(), IStakePriceOracle(address(0)), 1606824023, 1 days, 1 days);
        swapVm = ISwapVM(address(new SwapVMRouter(address(AQUA), address(WETH), address(this), "1inch SwapVM", "1.0.2")));
        app = new AquaStakeBidApp(AQUA, market, swapVm);
        source = Fixture.validatorProof("sellableSource");
        target = Fixture.validatorProof("target");
        seller = Fixture.withdrawalAddress("sellableSource");
        vm.etch(seller, abi.encodePacked(hex"ef0100", address(market.delegate())));
        start = uint40(vm.getBlockTimestamp());

        vm.deal(maker, 100 ether);
        vm.startPrank(maker);
        WETH.deposit{value: 64 ether}();
        WETH.approve(address(AQUA), type(uint256).max);
        vm.stopPrank();
    }

    function _bid() internal view returns (AquaStakeBidApp.StakeBid memory) {
        return AquaStakeBidApp.StakeBid({
            maker: maker,
            targetPubkey: target.validator.pubkey,
            maxPriceWad: 1.01e18,
            minStakeGwei: 32 gwei,
            maxStakeGwei: 64 gwei,
            salt: bytes32(uint256(7)),
            pricing: app.buildDutchBid(maker, START_PRICE, start, DURATION, DECAY, 7)
        });
    }

    function _ship(AquaStakeBidApp.StakeBid memory bid) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(WETH);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 64 ether;
        vm.prank(maker);
        AQUA.ship(address(app), abi.encode(bid), tokens, amounts);
    }

    function _list(uint256 price) internal returns (NativeStakeMarket.StakeOrder memory o) {
        o = NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: source.validator.pubkey,
            sourceIndex: source.index,
            priceMode: NativeStakeMarket.PriceMode.Fixed,
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

    function test_opcodeConstantsMatchSwapVm102() public {
        (uint8 staticBalances, uint8 limitSwap, uint8 dutchOut, uint8 salt) = new OpcodeProbe().opcodes();
        assertEq(staticBalances, 17);
        assertEq(limitSwap, 25);
        assertEq(dutchOut, 30);
        assertEq(salt, 34);
    }

    function test_dutchBid_priceRisesUntilExpiry() public {
        AquaStakeBidApp.StakeBid memory bid = _bid();
        uint256 p0 = app.swapVmPrice(bid.pricing, 32 gwei);
        assertApproxEqRel(p0, 32 ether * START_PRICE / 1e18, 1e12, "starts at 99.9%");

        vm.warp(start + DURATION / 2);
        uint256 pMid = app.swapVmPrice(bid.pricing, 32 gwei);
        vm.warp(start + DURATION);
        uint256 pEnd = app.swapVmPrice(bid.pricing, 32 gwei);
        assertGt(pMid, p0);
        assertGt(pEnd, pMid);
        assertApproxEqRel(pEnd, 32.0576 ether, 1e14, "ends at the entry-queue break-even");

        vm.warp(start + DURATION + 1);
        vm.expectRevert(); // DutchAuctionExpired inside SwapVM's quote
        app.swapVmPrice(bid.pricing, 32 gwei);
    }

    function test_matchBid_onlyOnceAuctionReachesAsk() public {
        AquaStakeBidApp.StakeBid memory bid = _bid();
        _ship(bid);
        NativeStakeMarket.StakeOrder memory o = _list(32.0355 ether); // seller asks the fair value
        NativeStakeMarket.FillProofs memory p = _proofs();

        uint256 bidNow = app.limit(bid, 32 gwei);
        vm.expectRevert(abi.encodeWithSelector(AquaStakeBidApp.PriceAboveBid.selector, 32.0355 ether, bidNow));
        app.matchBid{value: 1}(bid, o, "", p);

        // the auction raises the bid every second; ~80% into it the offer crosses the ask
        vm.warp(start + uint256(DURATION) * 4 / 5);
        assertGe(app.limit(bid, 32 gwei), 32.0355 ether);
        uint256 id = app.matchBid{value: 1}(bid, o, "", p);

        assertEq(market.getTrade(id).payment, 32.0355 ether, "buyer pays the ask, not the bid");
        assertEq(market.getTrade(id).buyer, maker);
        assertEq(WETH.balanceOf(maker), 64 ether - 32.0355 ether, "pulled from the maker wallet via Aqua");
    }

    function test_mainnetRouterIsAmmOnly() public {
        // the deployed 0x11111133… router maps opcode 17 to XYCSwap, not StaticBalances
        AquaStakeBidApp aquaOnly = new AquaStakeBidApp(AQUA, market, AQUA_SWAP_VM);
        ISwapVM.Order memory order = aquaOnly.buildDutchBid(maker, START_PRICE, start, DURATION, DECAY, 7);
        vm.expectRevert();
        aquaOnly.swapVmPrice(order, 32 gwei);
    }

    function test_hardCapStillApplies() public {
        AquaStakeBidApp.StakeBid memory bid = _bid();
        bid.maxPriceWad = 1e18; // cap at par even if the auction goes higher
        vm.warp(start + DURATION);
        assertEq(app.limit(bid, 32 gwei), 32 ether);
    }

    function test_revert_pricingForAnotherMaker() public {
        AquaStakeBidApp.StakeBid memory bid = _bid();
        bid.pricing = app.buildDutchBid(makeAddr("other"), START_PRICE, start, DURATION, DECAY, 7);
        vm.expectRevert(AquaStakeBidApp.PricingMakerMismatch.selector);
        app.limit(bid, 32 gwei);
    }
}
