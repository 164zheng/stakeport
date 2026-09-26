// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BeaconOracle} from "../../src/BeaconOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";

/// @notice Proofs fetched from a public Lodestar node's proof API (no state download) verify onchain
/// against the real EIP-4788 root (test/fixtures/remote.json, proof-generator/scripts/remote-probe.ts).
contract RemoteProofsForkTest is Test {
    string json;
    BeaconOracle oracle;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        json = vm.readFile("test/fixtures/remote.json");
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, vm.parseJsonUint(json, ".elBlockNumber"));
        oracle = new BeaconOracle();
    }

    function _b(string memory key) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, string.concat(".encoded.", key));
    }

    function test_remoteProofsVerifyOnchain() public view {
        bytes32 stateRoot = oracle.verifiedStateRoot(abi.decode(_b("stateRootProof"), (BeaconProofs.StateRootProof)));
        oracle.verifySlot(stateRoot, abi.decode(_b("slotProof"), (BeaconProofs.SlotProof)));
        oracle.verifyValidator(stateRoot, abi.decode(_b("validator0"), (BeaconProofs.ValidatorProof)));
        oracle.verifyValidator(stateRoot, abi.decode(_b("pendingSource"), (BeaconProofs.ValidatorProof)));
        oracle.verifyBalance(stateRoot, abi.decode(_b("balance0"), (BeaconProofs.BalanceProof)));
        oracle.verifyPendingConsolidation(
            stateRoot, abi.decode(_b("pendingConsolidation"), (BeaconProofs.PendingConsolidationProof))
        );
    }
}
