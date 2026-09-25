// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @notice Finds a CREATE2 salt whose address encodes the hook permission flags.
/// Adapted from Uniswap v4-periphery test/shared/HookMiner.sol (MIT).
library HookMiner {
    uint160 constant FLAG_MASK = Hooks.ALL_HOOK_MASK;
    uint256 constant MAX_LOOP = 200_000;

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory args)
        internal
        pure
        returns (address hook, bytes32 salt)
    {
        flags = flags & FLAG_MASK;
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, args));
        for (uint256 i; i < MAX_LOOP; ++i) {
            hook = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xFF), deployer, bytes32(i), initCodeHash))))
            );
            if (uint160(hook) & FLAG_MASK == flags) return (hook, bytes32(i));
        }
        revert("HookMiner: no salt");
    }
}
