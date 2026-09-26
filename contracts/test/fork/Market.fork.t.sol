// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {IStakePriceOracle} from "../../src/interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {Fixture} from "../utils/Fixture.sol";
import {ForkTest} from "../utils/ForkTest.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Fills a real mainnet validator's stake with real beacon proofs, the real EIP-4788
/// contract and the real EIP-7251 predeploy on a mainnet fork.
contract MarketForkTest is ForkTest {
    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    IWETH constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    uint256 constant MAINNET_GENESIS = 1606824023;

    NativeStakeMarket market;
    address seller;
    address buyer = makeAddr("buyer");
    BeaconProofs.ValidatorProof source;
    BeaconProofs.ValidatorProof target;

    function setUp() public {
        _fork();
        market = new NativeStakeMarket(
            WETH, new BeaconOracle(), IStakePriceOracle(address(0)), MAINNET_GENESIS, 1 days, 1 days
        );
        source = Fixture.validatorProof("sellableSource");
        target = Fixture.validatorProof("target");
        seller = Fixture.withdrawalAddress("sellableSource");

        // Seller's withdrawal EOA delegates to the StakePort delegate (EIP-7702 designator).
        vm.etch(seller, abi.encodePacked(hex"ef0100", address(market.delegate())));

        vm.deal(buyer, 100 ether);
        vm.startPrank(buyer);
        WETH.deposit{value: 50 ether}();
        WETH.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function _order() internal view returns (NativeStakeMarket.StakeOrder memory) {
        return NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: source.validator.pubkey,
            sourceIndex: source.index,
            priceMode: NativeStakeMarket.PriceMode.Fixed,
            price: 31.7 ether,
            minPayment: 0,
            expiry: vm.getBlockTimestamp() + 1 days,
            nonce: 1
        });
    }

    function _queueTail() internal view returns (uint256) {
        return uint256(vm.load(CONSOLIDATION_REQUEST, bytes32(uint256(3))));
    }

    function test_fill_realValidators_realPredeploy() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(seller);
        market.listOrder(o);

        NativeStakeMarket.FillProofs memory p = NativeStakeMarket.FillProofs({
            state: Fixture.stateRootProof(),
            source: source,
            target: target
        });
        uint256 tailBefore = _queueTail();

        vm.recordLogs();
        vm.prank(buyer);
        uint256 id = market.fill{value: 0.01 ether}(o, "", target.validator.pubkey, p, buyer);

        assertEq(_queueTail(), tailBefore + 1, "request queued in the EIP-7251 predeploy");
        assertEq(WETH.balanceOf(address(market)), 31.7 ether);
        NativeStakeMarket.Trade memory t = market.getTrade(id);
        assertEq(t.sourceIndex, source.index);
        assertEq(t.targetIndex, target.index);
        assertEq(t.amountGwei, 32 gwei);

        // The predeploy logs source_address || source_pubkey || target_pubkey.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == CONSOLIDATION_REQUEST) {
                assertEq(logs[i].data, abi.encodePacked(seller, source.validator.pubkey, target.validator.pubkey));
                found = true;
            }
        }
        assertTrue(found, "predeploy log");
    }

    function test_fillWithEth_realWeth() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(seller);
        market.listOrder(o);
        NativeStakeMarket.FillProofs memory p =
            NativeStakeMarket.FillProofs({state: Fixture.stateRootProof(), source: source, target: target});
        address ethBuyer = makeAddr("ethBuyer");
        vm.deal(ethBuyer, 40 ether);
        vm.prank(ethBuyer);
        market.fillWithEth{value: 31.71 ether}(o, "", target.validator.pubkey, p, ethBuyer);
        assertEq(WETH.balanceOf(address(market)), 31.7 ether);
        assertEq(ethBuyer.balance, 40 ether - 31.7 ether - 1);
    }

    function test_fill_rejectsTamperedRealProof() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(seller);
        market.listOrder(o);
        BeaconProofs.ValidatorProof memory t = target;
        t.validator.effectiveBalance = 1 gwei;
        NativeStakeMarket.FillProofs memory p =
            NativeStakeMarket.FillProofs({state: Fixture.stateRootProof(), source: source, target: t});
        vm.prank(buyer);
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        market.fill{value: 0.01 ether}(o, "", target.validator.pubkey, p, buyer);
    }
}
