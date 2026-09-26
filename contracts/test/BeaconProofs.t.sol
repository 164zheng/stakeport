// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BeaconOracle} from "../src/BeaconOracle.sol";
import {BeaconProofs} from "../src/libraries/BeaconProofs.sol";
import {Fixture} from "./utils/Fixture.sol";

contract BeaconProofsHarness {
    function verifyStateRoot(bytes32 blockRoot, BeaconProofs.StateRootProof calldata p) external pure {
        BeaconProofs.verifyStateRoot(blockRoot, p);
    }

    function toLittleEndian(uint64 v) external pure returns (bytes32) {
        return BeaconProofs.toLittleEndian(v);
    }

    function fromLittleEndian(bytes32 c, uint256 slot) external pure returns (uint64) {
        return BeaconProofs.fromLittleEndian(c, slot);
    }
}

/// @dev Returns a fixed root for any timestamp, standing in for the EIP-4788 contract offline.
contract MockBeaconRoots {
    bytes32 immutable root;

    constructor(bytes32 r) {
        root = r;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(root);
    }
}

/// @notice Offline tests of the SSZ verifier against real mainnet beacon state proofs.
contract BeaconProofsTest is Test {
    BeaconOracle oracle;
    BeaconProofsHarness harness;
    bytes32 stateRoot;

    function setUp() public {
        oracle = new BeaconOracle();
        harness = new BeaconProofsHarness();
        stateRoot = Fixture.stateRootProof().stateRoot;
    }

    // --- little endian ---------------------------------------------------------------------------

    function test_toLittleEndian() public view {
        assertEq(harness.toLittleEndian(1), bytes32(uint256(1) << 248));
        assertEq(harness.toLittleEndian(0x0102), bytes32(uint256(0x0201) << 240));
        assertEq(harness.toLittleEndian(type(uint64).max), bytes32(uint256(type(uint64).max) << 192));
    }

    function testFuzz_littleEndianRoundTrip(uint64 v) public view {
        assertEq(harness.fromLittleEndian(harness.toLittleEndian(v), 0), v);
    }

    function test_fromLittleEndian_packedSlots() public view {
        bytes32 chunk = bytes32(
            (uint256(harness.toLittleEndian(11))) | (uint256(harness.toLittleEndian(22)) >> 64)
                | (uint256(harness.toLittleEndian(33)) >> 128) | (uint256(harness.toLittleEndian(44)) >> 192)
        );
        assertEq(harness.fromLittleEndian(chunk, 0), 11);
        assertEq(harness.fromLittleEndian(chunk, 1), 22);
        assertEq(harness.fromLittleEndian(chunk, 2), 33);
        assertEq(harness.fromLittleEndian(chunk, 3), 44);
    }

    // --- state root ------------------------------------------------------------------------------

    function test_stateRoot_underBlockRoot() public view {
        harness.verifyStateRoot(Fixture.beaconBlockRoot(), Fixture.stateRootProof());
    }

    function test_stateRoot_revertsOnWrongBlockRoot() public {
        BeaconProofs.StateRootProof memory p = Fixture.stateRootProof();
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        harness.verifyStateRoot(keccak256("wrong"), p);
    }

    function test_stateRoot_bindsHeaderSlot() public {
        BeaconProofs.StateRootProof memory p = Fixture.stateRootProof();
        assertEq(p.slot, vm.parseJsonUint(Fixture.json(), ".beaconSlot"));
        p.slot -= 32; // claim an older epoch
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        harness.verifyStateRoot(Fixture.beaconBlockRoot(), p);
    }

    function test_stateRoot_bindsProposerIndex() public {
        BeaconProofs.StateRootProof memory p = Fixture.stateRootProof();
        p.proposerIndex += 1;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        harness.verifyStateRoot(Fixture.beaconBlockRoot(), p);
    }

    function test_verifiedStateRoot_via4788() public {
        vm.etch(oracle.BEACON_ROOTS(), address(new MockBeaconRoots(Fixture.beaconBlockRoot())).code);
        assertEq(oracle.verifiedStateRoot(Fixture.stateRootProof()), stateRoot);
    }

    function test_verifiedStateRoot_revertsWhenRootMissing() public {
        vm.etch(oracle.BEACON_ROOTS(), hex"60006000fd"); // always reverts, like an unknown timestamp
        BeaconProofs.StateRootProof memory p = Fixture.stateRootProof();
        vm.expectRevert(abi.encodeWithSelector(BeaconOracle.BeaconRootNotFound.selector, p.timestamp));
        oracle.verifiedStateRoot(p);
    }

    // --- validators ------------------------------------------------------------------------------

    function test_validator_allRoles() public view {
        oracle.verifyValidator(stateRoot, Fixture.validatorProof("sellableSource"));
        oracle.verifyValidator(stateRoot, Fixture.validatorProof("target"));
        oracle.verifyValidator(stateRoot, Fixture.validatorProof("pendingSource"));
        oracle.verifyValidator(stateRoot, Fixture.validatorProof("pendingTarget"));
    }

    function test_validator_fixtureSemantics() public view {
        BeaconProofs.ValidatorProof memory s = Fixture.validatorProof("sellableSource");
        assertEq(uint8(s.validator.withdrawalCredentials[0]), 0x01);
        assertEq(s.validator.effectiveBalance, 32 gwei);
        assertEq(s.validator.exitEpoch, BeaconProofs.FAR_FUTURE_EPOCH);
        assertEq(address(uint160(uint256(s.validator.withdrawalCredentials))), Fixture.withdrawalAddress("sellableSource"));

        BeaconProofs.ValidatorProof memory t = Fixture.validatorProof("target");
        assertEq(uint8(t.validator.withdrawalCredentials[0]), 0x02);

        // a source in the pending consolidation queue has its exit initiated
        BeaconProofs.ValidatorProof memory ps = Fixture.validatorProof("pendingSource");
        assertTrue(ps.validator.exitEpoch != BeaconProofs.FAR_FUTURE_EPOCH);
    }

    function test_validator_revertsOnTamperedField() public {
        BeaconProofs.ValidatorProof memory p = Fixture.validatorProof("sellableSource");
        p.validator.exitEpoch = 1;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyValidator(stateRoot, p);

        p = Fixture.validatorProof("sellableSource");
        p.validator.slashed = true;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyValidator(stateRoot, p);

        p = Fixture.validatorProof("sellableSource");
        p.validator.withdrawalCredentials = bytes32(uint256(p.validator.withdrawalCredentials) ^ 1);
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyValidator(stateRoot, p);
    }

    function test_validator_revertsOnWrongIndex() public {
        BeaconProofs.ValidatorProof memory p = Fixture.validatorProof("sellableSource");
        p.index += 1;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyValidator(stateRoot, p);
    }

    function test_validator_revertsOnShortBranch() public {
        BeaconProofs.ValidatorProof memory p = Fixture.validatorProof("target");
        bytes32[] memory b = new bytes32[](p.branch.length - 1);
        for (uint256 i; i < b.length; ++i) b[i] = p.branch[i];
        p.branch = b;
        vm.expectRevert(BeaconProofs.InvalidProofLength.selector);
        oracle.verifyValidator(stateRoot, p);
    }

    function test_validator_revertsOnBadPubkeyLength() public {
        BeaconProofs.ValidatorProof memory p = Fixture.validatorProof("target");
        p.validator.pubkey = hex"00";
        vm.expectRevert(BeaconProofs.InvalidPubkeyLength.selector);
        oracle.verifyValidator(stateRoot, p);
    }

    function test_validator_revertsOnIndexOutOfRange() public {
        BeaconProofs.ValidatorProof memory p = Fixture.validatorProof("target");
        p.index = uint64(1 << 40);
        vm.expectRevert(BeaconProofs.IndexOutOfRange.selector);
        oracle.verifyValidator(stateRoot, p);
    }

    // --- balances --------------------------------------------------------------------------------

    function test_balance() public view {
        uint64 b = oracle.verifyBalance(stateRoot, Fixture.balanceProof("sellableSource"));
        assertGe(b, 31 gwei);
        assertLe(b, 34 gwei);
        assertGt(oracle.verifyBalance(stateRoot, Fixture.balanceProof("target")), 32 gwei);
    }

    function test_balance_revertsOnWrongIndexInSameChunkFamily() public {
        BeaconProofs.BalanceProof memory p = Fixture.balanceProof("target");
        p.index += 4; // different chunk
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyBalance(stateRoot, p);
    }

    // --- pending consolidations ------------------------------------------------------------------

    function test_pendingConsolidation() public view {
        BeaconProofs.PendingConsolidationProof memory p = Fixture.pendingConsolidationProof();
        oracle.verifyPendingConsolidation(stateRoot, p);
        assertEq(p.sourceIndex, Fixture.validatorProof("pendingSource").index);
        assertEq(p.targetIndex, Fixture.validatorProof("pendingTarget").index);
    }

    function test_pendingConsolidation_revertsOnWrongTarget() public {
        BeaconProofs.PendingConsolidationProof memory p = Fixture.pendingConsolidationProof();
        p.targetIndex = Fixture.validatorProof("target").index;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifyPendingConsolidation(stateRoot, p);
    }

    // --- slot ------------------------------------------------------------------------------------

    function test_slot() public view {
        BeaconProofs.SlotProof memory p = Fixture.slotProof();
        oracle.verifySlot(stateRoot, p);
        assertEq(p.slot, Fixture.beaconSlot());
    }

    function test_slot_revertsOnWrongSlot() public {
        BeaconProofs.SlotProof memory p = Fixture.slotProof();
        p.slot += 1;
        vm.expectRevert(BeaconProofs.InvalidProof.selector);
        oracle.verifySlot(stateRoot, p);
    }
}
