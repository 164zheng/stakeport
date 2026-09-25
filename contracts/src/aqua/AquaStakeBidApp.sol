// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {NativeStakeMarket} from "../NativeStakeMarket.sol";
import {IAqua} from "./IAqua.sol";

/// @title AquaStakeBidApp
/// @notice Self-custodial standing bids for native validator stake, built on 1inch Aqua.
///
/// A buyer ships a `StakeBid` strategy to Aqua with a WETH budget. The WETH stays in the buyer's
/// wallet; Aqua only records a virtual balance for this app. When a StakePort listing is priced at
/// or below the bid, anyone can `matchBid`: the app pulls exactly the payment from the buyer's
/// wallet through Aqua into the StakePort escrow, and the seller's validator is consolidated into
/// the buyer's target validator. One budget can fill many listings until it is used up or docked.
contract AquaStakeBidApp is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Aqua strategy. Immutable once shipped; re-price with dock + ship.
    struct StakeBid {
        address maker;
        /// @dev 0x02 validator that receives the stake
        bytes targetPubkey;
        /// @dev maximum WETH per 1 ETH of stake (1e18 = par)
        uint256 maxPriceWad;
        /// @dev accepted stake size per fill, in gwei
        uint64 minStakeGwei;
        uint64 maxStakeGwei;
        bytes32 salt;
    }

    IAqua public immutable aqua;
    NativeStakeMarket public immutable market;
    IERC20 public immutable weth;

    event BidMatched(
        bytes32 indexed strategyHash,
        address indexed maker,
        uint256 indexed tradeId,
        uint64 sourceIndex,
        uint64 amountGwei,
        uint256 payment
    );

    error NotMaker();
    error StakeSizeOutOfRange(uint64 amountGwei);
    error PriceAboveBid(uint256 payment, uint256 limit);
    error InsufficientBidBalance(uint256 available, uint256 payment);
    error EthRefundFailed();

    constructor(IAqua aqua_, NativeStakeMarket market_) {
        aqua = aqua_;
        market = market_;
        weth = market_.weth();
        weth.approve(address(market_), type(uint256).max);
    }

    function strategyHash(StakeBid calldata bid) public pure returns (bytes32) {
        return keccak256(abi.encode(bid));
    }

    /// @notice WETH still available to this bid (virtual Aqua balance).
    function available(StakeBid calldata bid) public view returns (uint256 balance) {
        (balance,) = aqua.rawBalances(bid.maker, address(this), strategyHash(bid), address(weth));
    }

    /// @notice Highest payment the bid accepts for `amountGwei` of stake.
    function limit(StakeBid calldata bid, uint64 amountGwei) public pure returns (uint256) {
        return uint256(amountGwei) * 1 gwei * bid.maxPriceWad / 1e18;
    }

    /// @notice Fills a StakePort listing against a standing Aqua bid. Permissionless: the seller,
    /// the buyer or a keeper can call it. `msg.value` pays the EIP-7251 fee (excess refunded).
    function matchBid(
        StakeBid calldata bid,
        NativeStakeMarket.StakeOrder calldata order,
        bytes calldata signature,
        NativeStakeMarket.FillProofs calldata proofs
    ) external payable nonReentrant returns (uint256 tradeId) {
        bytes32 hash = strategyHash(bid);
        uint64 amountGwei = proofs.source.validator.effectiveBalance;
        if (amountGwei < bid.minStakeGwei || amountGwei > bid.maxStakeGwei) revert StakeSizeOutOfRange(amountGwei);

        uint256 payment = market.quote(order, amountGwei);
        uint256 max = limit(bid, amountGwei);
        if (payment > max) revert PriceAboveBid(payment, max);
        uint256 balance = available(bid);
        if (balance < payment) revert InsufficientBidBalance(balance, payment);

        // Funds move from the buyer's wallet only now, straight through Aqua.
        aqua.pull(bid.maker, hash, address(weth), payment, address(this));

        uint256 ethBefore = address(this).balance - msg.value;
        tradeId = market.fill{value: msg.value}(order, signature, bid.targetPubkey, proofs, bid.maker);
        uint256 refund = address(this).balance - ethBefore;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthRefundFailed();
        }
        emit BidMatched(hash, bid.maker, tradeId, order.sourceIndex, amountGwei, payment);
    }

    /// @dev Receives the market's unused EIP-7251 fee refund.
    receive() external payable {}
}
