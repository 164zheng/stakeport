// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BeaconProofs} from "../libraries/BeaconProofs.sol";

/// @notice Trust-minimized access to consensus-layer state. Every call reverts on an invalid proof.
interface IBeaconOracle {
    /// @notice Resolves the EIP-4788 beacon block root at `p.timestamp` and proves `p.stateRoot` in it.
    function verifiedStateRoot(BeaconProofs.StateRootProof calldata p) external view returns (bytes32);

    function verifyValidator(bytes32 stateRoot, BeaconProofs.ValidatorProof calldata p) external view;

    function verifyBalance(bytes32 stateRoot, BeaconProofs.BalanceProof calldata p)
        external
        view
        returns (uint64 balanceGwei);

    function verifyPendingConsolidation(
        bytes32 stateRoot,
        BeaconProofs.PendingConsolidationProof calldata p
    ) external view;

    function verifySlot(bytes32 stateRoot, BeaconProofs.SlotProof calldata p) external view;
}
