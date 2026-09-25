// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BeaconOracle} from "../src/BeaconOracle.sol";
import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";
import {StakePortHook} from "../src/uniswap/StakePortHook.sol";
import {StakePortSwapRouter} from "../src/uniswap/StakePortSwapRouter.sol";
import {IUniswapV3PoolOracle, IWstETH, UniswapStakePriceOracle} from "../src/uniswap/UniswapStakePriceOracle.sol";
import {UniswapSetup as U} from "../test/utils/UniswapSetup.sol";
import {HookMiner} from "./utils/HookMiner.sol";

/// @notice Deploys StakePort to a mainnet fork and writes deployments/<name>.json.
contract Deploy is Script {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 constant MAINNET_GENESIS = 1606824023;

    function run() external {
        // Demo defaults: fill proofs come from one pinned beacon state and the demo fast-forwards
        // time, so the proof age limit is generous. Production would use ~1 hour.
        uint256 maxProofAge = vm.envOr("MAX_PROOF_AGE", uint256(30 days));
        uint256 acceptWindow = vm.envOr("ACCEPT_WINDOW", uint256(1 days));
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("local"));

        vm.startBroadcast();
        BeaconOracle beaconOracle = new BeaconOracle();
        UniswapStakePriceOracle priceOracle = new UniswapStakePriceOracle(
            IUniswapV3PoolOracle(U.WSTETH_WETH_V3), IWstETH(U.WSTETH), WETH, U.TWAP_WINDOW
        );
        NativeStakeMarket market = new NativeStakeMarket(
            IERC20(WETH), beaconOracle, priceOracle, MAINNET_GENESIS, maxProofAge, acceptWindow
        );

        bytes memory args = abi.encode(U.POOL_MANAGER, market, U.liquidityKey());
        (, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, U.HOOK_FLAGS, type(StakePortHook).creationCode, args);
        StakePortHook hook = new StakePortHook{salt: salt}(U.POOL_MANAGER, market, U.liquidityKey());
        U.POOL_MANAGER.initialize(U.stakeKey(address(hook)), TickMath.getSqrtPriceAtTick(0));
        StakePortSwapRouter router = new StakePortSwapRouter(U.POOL_MANAGER);
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "weth", WETH);
        vm.serializeAddress(obj, "usdc", U.USDC);
        vm.serializeAddress(obj, "beaconOracle", address(beaconOracle));
        vm.serializeAddress(obj, "stakePriceOracle", address(priceOracle));
        vm.serializeAddress(obj, "delegate", address(market.delegate()));
        vm.serializeAddress(obj, "poolManager", address(U.POOL_MANAGER));
        vm.serializeAddress(obj, "hook", address(hook));
        vm.serializeAddress(obj, "router", address(router));
        vm.serializeUint(obj, "stakePoolFee", U.stakeKey(address(hook)).fee);
        vm.serializeInt(obj, "stakePoolTickSpacing", U.stakeKey(address(hook)).tickSpacing);
        vm.serializeUint(obj, "liquidityPoolFee", U.liquidityKey().fee);
        vm.serializeInt(obj, "liquidityPoolTickSpacing", U.liquidityKey().tickSpacing);
        vm.serializeUint(obj, "deployBlock", block.number);
        string memory json = vm.serializeAddress(obj, "market", address(market));
        vm.writeJson(json, string.concat("../deployments/", name, ".json"));
        console.log("market", address(market));
        console.log("hook", address(hook));
    }
}
