// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Buyer eligibility check attached to a listing (see NativeStakeMarket.listOrderWithPolicy).
interface IEligibilityPolicy {
    function isEligible(address buyer) external view returns (bool);
}
