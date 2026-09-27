// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {WorldIdEligibility} from "../src/world/WorldIdEligibility.sol";

/// @notice Adds the World ID Identity Check policy (second WorldIdEligibility, credential
/// "world-id:identity-check") to an existing deployment and records it in deployments/<DEPLOYMENT_NAME>.json.
///   WORLD_ATTESTER=0x... forge script script/DeployIdentityCheckPolicy.s.sol --rpc-url $HOODI_RPC_URL \
///     --account <keystore> --sender <addr> --broadcast
contract DeployIdentityCheckPolicy is Script {
    function run() external {
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("hoodi"));
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", name, ".json");
        string memory json = vm.readFile(path);
        address attester = vm.envAddress("WORLD_ATTESTER");

        vm.startBroadcast();
        WorldIdEligibility policy = new WorldIdEligibility(attester, keccak256("world-id:identity-check"));
        vm.stopBroadcast();

        string memory obj = "deployment";
        string[8] memory addrs = ["market", "delegate", "beaconOracle", "weth", "worldEligibility", "aqua", "swapVm", "aquaBidApp"];
        for (uint256 i; i < addrs.length; ++i) {
            string memory key = string.concat(".", addrs[i]);
            if (vm.keyExistsJson(json, key)) vm.serializeAddress(obj, addrs[i], vm.parseJsonAddress(json, key));
        }
        vm.serializeUint(obj, "chainId", vm.parseJsonUint(json, ".chainId"));
        vm.serializeUint(obj, "genesisTime", vm.parseJsonUint(json, ".genesisTime"));
        vm.serializeUint(obj, "deployBlock", vm.parseJsonUint(json, ".deployBlock"));
        vm.writeJson(vm.serializeAddress(obj, "worldIdentityCheck", address(policy)), path);
        console.log("worldIdentityCheck", address(policy));
    }
}
