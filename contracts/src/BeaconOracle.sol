// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IBeaconOracle} from "./interfaces/IBeaconOracle.sol";
import {BeaconProofs} from "./libraries/BeaconProofs.sol";

/// @notice Verifies beacon state proofs against block roots from the EIP-4788 contract.
contract BeaconOracle is IBeaconOracle {
    /// @dev EIP-4788 beacon roots contract (same address on every chain that activated Cancun).
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    error BeaconRootNotFound(uint64 timestamp);

    /// @notice Returns the parent beacon block root stored for an execution block timestamp.
    function beaconBlockRoot(uint64 timestamp) public view returns (bytes32 root) {
        (bool ok, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(uint256(timestamp)));
        if (!ok || data.length != 32) revert BeaconRootNotFound(timestamp);
        root = abi.decode(data, (bytes32));
    }

    function verifiedStateRoot(BeaconProofs.StateRootProof calldata p) external view returns (bytes32) {
        BeaconProofs.verifyStateRoot(beaconBlockRoot(p.timestamp), p);
        return p.stateRoot;
    }

    function verifyValidator(bytes32 stateRoot, BeaconProofs.ValidatorProof calldata p) external view {
        BeaconProofs.verifyValidator(stateRoot, p);
    }

    function verifyBalance(bytes32 stateRoot, BeaconProofs.BalanceProof calldata p)
        external
        view
        returns (uint64)
    {
        return BeaconProofs.verifyBalance(stateRoot, p);
    }

    function verifyPendingConsolidation(
        bytes32 stateRoot,
        BeaconProofs.PendingConsolidationProof calldata p
    ) external view {
        BeaconProofs.verifyPendingConsolidation(stateRoot, p);
    }

    function verifySlot(bytes32 stateRoot, BeaconProofs.SlotProof calldata p) external view {
        BeaconProofs.verifySlot(stateRoot, p);
    }
}
