// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";

/// @notice Loads test/fixtures/mainnet.json (real mainnet beacon data, see proof-generator).
library Fixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant PATH = "test/fixtures/mainnet.json";

    function json() internal view returns (string memory) {
        return vm.readFile(PATH);
    }

    function elBlockNumber() internal view returns (uint256) {
        return vm.parseJsonUint(json(), ".elBlockNumber");
    }

    function elTimestamp() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(json(), ".elTimestamp"));
    }

    function beaconBlockRoot() internal view returns (bytes32) {
        return vm.parseJsonBytes32(json(), ".beaconBlockRoot");
    }

    function beaconSlot() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(json(), ".beaconSlot"));
    }

    function stateRootProof() internal view returns (BeaconProofs.StateRootProof memory) {
        return abi.decode(vm.parseJsonBytes(json(), ".encoded.stateRootProof"), (BeaconProofs.StateRootProof));
    }

    function slotProof() internal view returns (BeaconProofs.SlotProof memory) {
        return abi.decode(vm.parseJsonBytes(json(), ".encoded.slotProof"), (BeaconProofs.SlotProof));
    }

    function pendingConsolidationProof() internal view returns (BeaconProofs.PendingConsolidationProof memory) {
        return abi.decode(
            vm.parseJsonBytes(json(), ".encoded.pendingConsolidationProof"),
            (BeaconProofs.PendingConsolidationProof)
        );
    }

    /// @param role sellableSource | target | pendingSource | pendingTarget
    function validatorProof(string memory role) internal view returns (BeaconProofs.ValidatorProof memory) {
        return abi.decode(
            vm.parseJsonBytes(json(), string.concat(".encoded.validatorProofs.", role)),
            (BeaconProofs.ValidatorProof)
        );
    }

    /// @param role sellableSource | target
    function balanceProof(string memory role) internal view returns (BeaconProofs.BalanceProof memory) {
        return abi.decode(
            vm.parseJsonBytes(json(), string.concat(".encoded.balanceProofs.", role)), (BeaconProofs.BalanceProof)
        );
    }

    function withdrawalAddress(string memory role) internal view returns (address) {
        return vm.parseJsonAddress(json(), string.concat(".withdrawalAddresses.", role));
    }
}
