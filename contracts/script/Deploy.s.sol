// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconOracle} from "../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";
import {IStakePriceOracle} from "../src/interfaces/IStakePriceOracle.sol";

/// @notice Deploys StakePort core to a mainnet fork and writes deployments/<name>.json.
contract Deploy is Script {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant MAINNET_GENESIS = 1606824023;

    function run() external {
        // Demo defaults: fill proofs come from one pinned beacon state and the demo fast-forwards
        // time, so the proof age limit is generous. Production would use ~1 hour.
        uint256 maxProofAge = vm.envOr("MAX_PROOF_AGE", uint256(30 days));
        uint256 acceptWindow = vm.envOr("ACCEPT_WINDOW", uint256(1 days));
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("local"));

        vm.startBroadcast();
        BeaconOracle beaconOracle = new BeaconOracle();
        NativeStakeMarket market = new NativeStakeMarket(
            IERC20(WETH), beaconOracle, IStakePriceOracle(address(0)), MAINNET_GENESIS, maxProofAge, acceptWindow
        );
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "weth", WETH);
        vm.serializeAddress(obj, "beaconOracle", address(beaconOracle));
        vm.serializeAddress(obj, "delegate", address(market.delegate()));
        vm.serializeUint(obj, "deployBlock", block.number);
        string memory json = vm.serializeAddress(obj, "market", address(market));
        vm.writeJson(json, string.concat("../deployments/", name, ".json"));
        console.log("market", address(market));
        console.log("delegate", address(market.delegate()));
    }
}
