// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {AquaRouter} from "@1inch/aqua/src/AquaRouter.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {SwapVMRouter} from "@1inch/swap-vm/routers/SwapVMRouter.sol";
import {AquaStakeBidApp} from "../src/aqua/AquaStakeBidApp.sol";
import {IAqua} from "../src/aqua/IAqua.sol";
import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";

/// @notice Adds Aqua standing bids to an existing core deployment on a network without the official 1inch
/// contracts (e.g. Hoodi): deploys the unmodified AquaRouter and SwapVMRouter v1.0.2 from source, then the
/// StakePort bid app, and adds their addresses to deployments/<DEPLOYMENT_NAME>.json.
///   forge script script/DeployAquaHoodi.s.sol --rpc-url $HOODI_RPC_URL --account <keystore> --sender <addr> --broadcast
contract DeployAquaHoodi is Script {
    function run() external {
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("hoodi"));
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", name, ".json");
        string memory json = vm.readFile(path);
        NativeStakeMarket market = NativeStakeMarket(payable(vm.parseJsonAddress(json, ".market")));
        address weth = vm.parseJsonAddress(json, ".weth");

        vm.startBroadcast();
        AquaRouter aqua = new AquaRouter();
        SwapVMRouter swapVm = new SwapVMRouter(address(aqua), weth, msg.sender, "1inch SwapVM", "1.0.2");
        AquaStakeBidApp bidApp = new AquaStakeBidApp(IAqua(address(aqua)), market, ISwapVM(address(swapVm)));
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "market", address(market));
        vm.serializeAddress(obj, "delegate", vm.parseJsonAddress(json, ".delegate"));
        vm.serializeAddress(obj, "beaconOracle", vm.parseJsonAddress(json, ".beaconOracle"));
        vm.serializeAddress(obj, "weth", weth);
        vm.serializeAddress(obj, "worldEligibility", vm.parseJsonAddress(json, ".worldEligibility"));
        vm.serializeUint(obj, "chainId", vm.parseJsonUint(json, ".chainId"));
        vm.serializeUint(obj, "genesisTime", vm.parseJsonUint(json, ".genesisTime"));
        vm.serializeUint(obj, "deployBlock", vm.parseJsonUint(json, ".deployBlock"));
        vm.serializeAddress(obj, "aqua", address(aqua));
        vm.serializeAddress(obj, "swapVm", address(swapVm));
        string memory out = vm.serializeAddress(obj, "aquaBidApp", address(bidApp));
        vm.writeJson(out, path);
        console.log("aqua", address(aqua));
        console.log("swapVm", address(swapVm));
        console.log("aquaBidApp", address(bidApp));
    }
}
