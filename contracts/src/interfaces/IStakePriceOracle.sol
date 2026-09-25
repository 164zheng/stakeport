// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Reference price of staked ETH, used by LST-relative orders.
interface IStakePriceOracle {
    /// @return priceWad ETH per 1 staked ETH, 1e18 = parity (e.g. 0.998e18 = 20 bps discount)
    function stakedEthPrice() external view returns (uint256 priceWad);
}
