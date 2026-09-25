// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {Fixture} from "../utils/Fixture.sol";
import {ForkTest} from "../utils/ForkTest.sol";

/// @notice Verifies real proofs against the real EIP-4788 contract on a mainnet fork.
contract BeaconOracleForkTest is ForkTest {
    BeaconOracle oracle;

    function setUp() public {
        _fork();
        oracle = new BeaconOracle();
    }

    function test_4788_returnsFixtureBlockRoot() public view {
        assertEq(oracle.beaconBlockRoot(Fixture.elTimestamp()), Fixture.beaconBlockRoot());
    }

    function test_verifiedStateRoot_thenValidator() public view {
        bytes32 stateRoot = oracle.verifiedStateRoot(Fixture.stateRootProof());
        oracle.verifyValidator(stateRoot, Fixture.validatorProof("sellableSource"));
        oracle.verifyPendingConsolidation(stateRoot, Fixture.pendingConsolidationProof());
    }

    function test_unknownTimestamp_reverts() public {
        uint64 ts = Fixture.elTimestamp() + 1; // not a slot boundary
        vm.expectRevert(abi.encodeWithSelector(BeaconOracle.BeaconRootNotFound.selector, ts));
        oracle.beaconBlockRoot(ts);
    }
}
