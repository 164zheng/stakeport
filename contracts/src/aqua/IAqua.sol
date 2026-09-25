// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Subset of the 1inch Aqua registry used by StakePort.
/// Aqua is deployed at 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a on Ethereum mainnet.
interface IAqua {
    event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
    event Docked(address maker, address app, bytes32 strategyHash);
    event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount);

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);

    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash);

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;

    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external;
}
