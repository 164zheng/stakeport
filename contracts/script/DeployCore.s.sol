// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconOracle} from "../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";
import {IStakePriceOracle} from "../src/interfaces/IStakePriceOracle.sol";
import {WorldIdEligibility} from "../src/world/WorldIdEligibility.sol";
import {WETH9} from "./utils/WETH9.sol";

/// @notice Core StakePort deployment for a real network (e.g. Hoodi): beacon oracle, market and,
/// optionally, the World ID eligibility registry. Partner integrations that do not exist on the
/// target network (Uniswap pools, Aqua, Chainlink) are left out.
///
///   GENESIS_TIME=1742213400 [WETH=0x...] [WORLD_ATTESTER=0x...] forge script script/DeployCore.s.sol \
///     --rpc-url $HOODI_RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract DeployCore is Script {
    function run() external {
        uint256 genesisTime = vm.envUint("GENESIS_TIME");
        uint256 maxProofAge = vm.envOr("MAX_PROOF_AGE", uint256(1 hours));
        uint256 acceptWindow = vm.envOr("ACCEPT_WINDOW", uint256(1 days));
        address weth = vm.envOr("WETH", address(0));
        address attester = vm.envOr("WORLD_ATTESTER", address(0));
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("hoodi"));

        vm.startBroadcast();
        if (weth == address(0)) weth = address(new WETH9());
        BeaconOracle beaconOracle = new BeaconOracle();
        NativeStakeMarket market = new NativeStakeMarket(
            IERC20(weth), beaconOracle, IStakePriceOracle(address(0)), genesisTime, maxProofAge, acceptWindow
        );
        address eligibility = attester == address(0)
            ? address(0)
            : address(new WorldIdEligibility(attester, keccak256("world-id:nfc-document")));
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "weth", weth);
        vm.serializeAddress(obj, "beaconOracle", address(beaconOracle));
        vm.serializeAddress(obj, "delegate", address(market.delegate()));
        if (eligibility != address(0)) vm.serializeAddress(obj, "worldEligibility", eligibility);
        vm.serializeUint(obj, "genesisTime", genesisTime);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployBlock", block.number);
        string memory json = vm.serializeAddress(obj, "market", address(market));
        vm.writeJson(json, string.concat("../deployments/", name, ".json"));
        console.log("market", address(market));
    }
}
