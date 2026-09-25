// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice EIP-7702 delegate for a validator's withdrawal EOA.
/// @dev The seller's EOA delegates to this code. Because the code runs in the EOA's context, the
/// call it makes to the EIP-7251 predeploy has `msg.sender == seller`, which the consensus layer
/// matches against the source validator's withdrawal credentials. Only the market (which checks
/// the seller's signed order and escrows the payment) can trigger a consolidation.
contract Stake7702Delegate {
    /// @dev EIP-7251 consolidation request predeploy.
    address public constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    address public immutable market;

    event ConsolidationRequested(bytes sourcePubkey, bytes targetPubkey, uint256 fee);

    error OnlyMarket();
    error InvalidPubkeyLength();
    error FeeReadFailed();
    error InsufficientFee(uint256 required, uint256 provided);
    error RequestFailed();
    error RefundFailed();

    constructor(address market_) {
        market = market_;
    }

    /// @notice Current consolidation request fee (reading with empty calldata).
    function consolidationFee() public view returns (uint256) {
        (bool ok, bytes memory data) = CONSOLIDATION_REQUEST.staticcall("");
        if (!ok || data.length != 32) revert FeeReadFailed();
        return abi.decode(data, (uint256));
    }

    /// @notice Submits `source_pubkey || target_pubkey` to the EIP-7251 predeploy from this EOA.
    /// Any ETH above the fee is returned to the market.
    function requestConsolidation(bytes calldata sourcePubkey, bytes calldata targetPubkey) external payable {
        if (msg.sender != market) revert OnlyMarket();
        if (sourcePubkey.length != 48 || targetPubkey.length != 48) revert InvalidPubkeyLength();

        uint256 fee = consolidationFee();
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        (bool ok,) = CONSOLIDATION_REQUEST.call{value: fee}(abi.encodePacked(sourcePubkey, targetPubkey));
        if (!ok) revert RequestFailed();
        emit ConsolidationRequested(sourcePubkey, targetPubkey, fee);

        if (msg.value > fee) {
            (ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev A delegated EOA must keep accepting plain ETH transfers.
    receive() external payable {}
}
