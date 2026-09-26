// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {IStakePriceOracle} from "../../src/interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @notice Replays a REAL mainnet consolidation (test/fixtures/replay.json): StakePort fills the same
/// (source, target) pair one block before mainnet did, then proves checkpoint 1 with the real beacon
/// state that processed the request. No simulated consensus data is involved.
contract ReplayForkTest is Test {
    string constant PATH = "test/fixtures/replay.json";
    address constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    uint256 constant HISTORY_BUFFER_LENGTH = 8191;
    IWETH constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    string json;
    NativeStakeMarket market;
    address seller;
    address buyer;
    NativeStakeMarket.FillProofs fillProofs;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        json = vm.readFile(PATH);
        vm.createSelectFork(rpc, vm.parseJsonUint(json, ".forkBlock"));
        // the fill lands at the timestamp of the mainnet block that carried the original request
        vm.warp(vm.parseJsonUint(json, ".fillTimestamp"));

        market = new NativeStakeMarket(WETH, new BeaconOracle(), IStakePriceOracle(address(0)), 1606824023, 1 hours, 1 days);
        seller = vm.parseJsonAddress(json, ".seller");
        buyer = vm.parseJsonAddress(json, ".buyer");
        vm.etch(seller, abi.encodePacked(hex"ef0100", address(market.delegate())));

        BeaconProofs.StateRootProof memory st =
            abi.decode(vm.parseJsonBytes(json, ".encoded.fill.stateRootProof"), (BeaconProofs.StateRootProof));
        fillProofs.state = st;
        fillProofs.source =
            abi.decode(vm.parseJsonBytes(json, ".encoded.fill.source"), (BeaconProofs.ValidatorProof));
        fillProofs.target =
            abi.decode(vm.parseJsonBytes(json, ".encoded.fill.target"), (BeaconProofs.ValidatorProof));

        vm.deal(buyer, 100 ether);
        vm.startPrank(buyer);
        WETH.deposit{value: 40 ether}();
        WETH.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function _fill() internal returns (uint256 id) {
        NativeStakeMarket.StakeOrder memory o = NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: fillProofs.source.validator.pubkey,
            sourceIndex: fillProofs.source.index,
            priceMode: NativeStakeMarket.PriceMode.Fixed,
            price: 32.03 ether,
            minPayment: 0,
            expiry: vm.getBlockTimestamp() + 1 days,
            nonce: 1
        });
        vm.prank(seller);
        market.listOrder(o);
        vm.prank(buyer);
        id = market.fill{value: 0.01 ether}(o, "", fillProofs.target.validator.pubkey, fillProofs, buyer);
    }

    /// @dev Writes the real post-request beacon block root where mainnet's EIP-4788 stored it.
    function _injectPostRoot() internal returns (uint64 ts) {
        ts = uint64(vm.parseJsonUint(json, ".post.timestamp"));
        bytes32 root = vm.parseJsonBytes32(json, ".post.root");
        uint256 idx = ts % HISTORY_BUFFER_LENGTH;
        vm.store(BEACON_ROOTS, bytes32(idx), bytes32(uint256(ts)));
        vm.store(BEACON_ROOTS, bytes32(idx + HISTORY_BUFFER_LENGTH), root);
        vm.warp(ts);
    }

    function _accepted()
        internal
        view
        returns (
            BeaconProofs.StateRootProof memory st,
            BeaconProofs.PendingConsolidationProof memory pc,
            BeaconProofs.ValidatorProof memory src
        )
    {
        st = abi.decode(vm.parseJsonBytes(json, ".encoded.accepted.stateRootProof"), (BeaconProofs.StateRootProof));
        pc = abi.decode(
            vm.parseJsonBytes(json, ".encoded.accepted.pendingConsolidationProof"),
            (BeaconProofs.PendingConsolidationProof)
        );
        src = abi.decode(vm.parseJsonBytes(json, ".encoded.accepted.sourceProof"), (BeaconProofs.ValidatorProof));
    }

    function test_realCheckpoint1() public {
        uint256 id = _fill();
        assertEq(uint8(market.getTrade(id).status), uint8(NativeStakeMarket.Status.RequestSubmitted));

        _injectPostRoot();
        (BeaconProofs.StateRootProof memory st, BeaconProofs.PendingConsolidationProof memory pc, BeaconProofs.ValidatorProof memory src) =
            _accepted();
        market.proveAccepted(id, st, pc, src);

        NativeStakeMarket.Trade memory t = market.getTrade(id);
        assertEq(uint8(t.status), uint8(NativeStakeMarket.Status.Accepted));
        assertEq(t.sourceIndex, vm.parseJsonUint(json, ".sourceIndex"));
        assertEq(t.targetIndex, vm.parseJsonUint(json, ".targetIndex"));
        // the real consensus layer set the source's exit: withdrawable 256 epochs later
        assertEq(t.withdrawableEpoch, src.validator.exitEpoch + 256);
    }

    function test_realState_refutesNotAcceptedClaim() public {
        uint256 id = _fill();
        _injectPostRoot();
        (BeaconProofs.StateRootProof memory st,, BeaconProofs.ValidatorProof memory src) = _accepted();
        // the buyer cannot claim the request was ignored: the real source exit is initiated
        vm.expectRevert(NativeStakeMarket.NotFailed.selector);
        market.proveNotAccepted(id, st, src);
    }

    function test_realState_rejectsWrongTarget() public {
        uint256 id = _fill();
        _injectPostRoot();
        (BeaconProofs.StateRootProof memory st, BeaconProofs.PendingConsolidationProof memory pc, BeaconProofs.ValidatorProof memory src) =
            _accepted();
        pc.targetIndex += 1;
        vm.expectRevert(NativeStakeMarket.IndexMismatch.selector);
        market.proveAccepted(id, st, pc, src);
    }
}
