// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fixture} from "./Fixture.sol";

/// @notice Base for tests that run on a mainnet fork pinned to the fixture's execution block.
/// Skipped when MAINNET_RPC_URL is not set.
abstract contract ForkTest is Test {
    bool internal forked;

    function _fork() internal {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, Fixture.elBlockNumber());
        forked = true;
    }
}
