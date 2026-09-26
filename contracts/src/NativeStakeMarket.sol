// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBeaconOracle} from "./interfaces/IBeaconOracle.sol";
import {IEligibilityPolicy} from "./interfaces/IEligibilityPolicy.sol";
import {IStakePriceOracle} from "./interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "./libraries/BeaconProofs.sol";
import {Stake7702Delegate} from "./Stake7702Delegate.sol";

/// @title NativeStakeMarket
/// @notice Delivery-versus-payment for native validator stake.
///
/// Stake leg:   seller validator --(EIP-7251 consolidation)--> buyer's 0x02 validator
/// Payment leg: payer --(WETH)--> escrow --(after EIP-4788 proofs)--> seller
///
/// Lifecycle:
///   fill()            OPEN -> REQUEST_SUBMITTED   payment escrowed, consolidation requested
///   proveAccepted()   -> ACCEPTED                 pending_consolidations contains (source, target)
///   proveDelivered()  -> DELIVERED                source processed, payment released to seller
///   proveNotAccepted() / refundExpired() / proveFailed()  -> FAILED, payment refunded to buyer
contract NativeStakeMarket is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum PriceMode {
        Fixed, // price = total payment in WETH wei
        LstRelative // price = discount in bps below the staked ETH reference price
    }

    /// @notice Signed by the seller (the source validator's withdrawal EOA).
    struct StakeOrder {
        address seller;
        bytes sourcePubkey;
        uint64 sourceIndex;
        PriceMode priceMode;
        uint256 price;
        uint256 minPayment;
        uint256 expiry;
        uint256 nonce;
    }

    struct FillProofs {
        BeaconProofs.StateRootProof state;
        BeaconProofs.ValidatorProof source;
        BeaconProofs.ValidatorProof target;
    }

    enum Status {
        None,
        RequestSubmitted,
        Accepted,
        Delivered,
        Failed
    }

    struct Trade {
        address seller;
        address buyer;
        uint64 sourceIndex;
        uint64 targetIndex;
        uint64 amountGwei;
        uint64 filledAt;
        uint64 withdrawableEpoch;
        Status status;
        uint256 payment;
        bytes32 sourcePubkeyHash;
        bytes32 targetPubkeyHash;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants / immutables
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant STAKE_ORDER_TYPEHASH = keccak256(
        "StakeOrder(address seller,bytes sourcePubkey,uint64 sourceIndex,uint8 priceMode,uint256 price,uint256 minPayment,uint256 expiry,uint256 nonce)"
    );

    uint256 internal constant SECONDS_PER_SLOT = 12;
    uint256 internal constant SLOTS_PER_EPOCH = 32;
    uint64 internal constant SHARD_COMMITTEE_PERIOD = 256;
    uint64 internal constant MAX_EFFECTIVE_BALANCE_ELECTRA = 2048 gwei; // in gwei units: 2048e9
    uint64 internal constant MAX_DUST_BALANCE = 1 gwei; // 1 ETH in gwei
    uint256 internal constant BPS = 10_000;

    IERC20 public immutable weth;
    IBeaconOracle public immutable beaconOracle;
    IStakePriceOracle public immutable priceOracle;
    Stake7702Delegate public immutable delegate;
    /// @dev Beacon chain genesis time, used to map EIP-4788 timestamps to epochs.
    uint256 public immutable genesisTime;
    /// @notice Maximum age of the beacon state used to check a fill.
    uint256 public immutable maxProofAge;
    /// @notice Time the seller side has to prove the request was accepted.
    uint256 public immutable acceptWindow;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    uint256 public nextTradeId = 1;
    mapping(uint256 => Trade) public trades;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    /// @notice Open trade per source validator (0 = none). Prevents selling the same stake twice.
    mapping(uint64 => uint256) public activeTradeBySource;
    /// @notice Orders listed onchain by the seller (alternative to an off-chain signature).
    mapping(bytes32 => bool) public listed;
    /// @notice Optional buyer eligibility policy per listed order (e.g. World ID Verified Market).
    mapping(bytes32 => IEligibilityPolicy) public policyOf;

    // ---------------------------------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------------------------------

    event OrderFilled(
        uint256 indexed tradeId,
        address indexed seller,
        address indexed buyer,
        uint64 sourceIndex,
        uint64 targetIndex,
        uint64 amountGwei,
        uint256 payment
    );
    event ConsolidationAccepted(uint256 indexed tradeId, uint64 withdrawableEpoch);
    event StakeDelivered(uint256 indexed tradeId, uint256 payment);
    event TradeFailed(uint256 indexed tradeId, uint256 refund);
    event OrderCancelled(address indexed seller, uint256 nonce);
    event OrderListed(bytes32 indexed orderHash, address indexed seller, uint64 indexed sourceIndex, StakeOrder order);
    event OrderPolicySet(bytes32 indexed orderHash, IEligibilityPolicy policy);

    error OrderExpired();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error SellerNotDelegated();
    error StaleProof();
    error ProofBeforeFill();
    error IndexMismatch();
    error PubkeyMismatch();
    error WithdrawalAddressMismatch();
    error SourceNotSellable();
    error TargetNotEligible();
    error TargetCapacityExceeded();
    error SourceAlreadyTrading();
    error PriceBelowMinimum(uint256 payment, uint256 minPayment);
    error NoPriceOracle();
    error BadStatus(Status status);
    error NotDelivered();
    error NotFailed();
    error AcceptWindowOpen();
    error EthRefundFailed();
    error NotSeller();
    error BuyerNotEligible(address buyer);

    constructor(
        IERC20 weth_,
        IBeaconOracle beaconOracle_,
        IStakePriceOracle priceOracle_,
        uint256 genesisTime_,
        uint256 maxProofAge_,
        uint256 acceptWindow_
    ) EIP712("StakePort", "1") {
        weth = weth_;
        beaconOracle = beaconOracle_;
        priceOracle = priceOracle_;
        genesisTime = genesisTime_;
        maxProofAge = maxProofAge_;
        acceptWindow = acceptWindow_;
        delegate = new Stake7702Delegate(address(this));
    }

    // ---------------------------------------------------------------------------------------------
    // Seller
    // ---------------------------------------------------------------------------------------------

    /// @notice Lists an order onchain; it can then be filled with an empty signature.
    function listOrder(StakeOrder calldata order) external returns (bytes32 orderHash) {
        orderHash = _list(order);
    }

    /// @notice Lists an order that only buyers accepted by `policy` can fill.
    function listOrderWithPolicy(StakeOrder calldata order, IEligibilityPolicy policy)
        external
        returns (bytes32 orderHash)
    {
        orderHash = _list(order);
        policyOf[orderHash] = policy;
        emit OrderPolicySet(orderHash, policy);
    }

    function _list(StakeOrder calldata order) internal returns (bytes32 orderHash) {
        if (msg.sender != order.seller) revert NotSeller();
        orderHash = hashOrder(order);
        listed[orderHash] = true;
        emit OrderListed(orderHash, order.seller, order.sourceIndex, order);
    }

    function cancelOrder(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------------------------------------
    // Fill
    // ---------------------------------------------------------------------------------------------

    /// @notice Buys the stake of `order.sourceIndex` into the validator `targetPubkey`.
    /// @dev Pulls the WETH payment from `msg.sender` (buyer, Uniswap hook or Aqua app) and
    /// triggers the consolidation from the seller's delegated EOA. `msg.value` pays the EIP-7251
    /// fee; any excess is returned to `msg.sender`.
    /// @param signature seller's EIP-712 signature, or empty if the order was listed onchain
    /// @param buyer receives the refund if the trade fails
    function fill(
        StakeOrder calldata order,
        bytes calldata signature,
        bytes calldata targetPubkey,
        FillProofs calldata proofs,
        address buyer
    ) external payable nonReentrant returns (uint256 tradeId) {
        bytes32 orderHash = _checkOrder(order, signature);
        IEligibilityPolicy policy = policyOf[orderHash];
        if (address(policy) != address(0) && !policy.isEligible(buyer)) revert BuyerNotEligible(buyer);
        (uint64 amountGwei, uint64 targetIndex) = _checkValidators(order, targetPubkey, proofs);

        uint256 payment = quote(order, amountGwei);
        if (payment < order.minPayment) revert PriceBelowMinimum(payment, order.minPayment);

        nonceUsed[order.seller][order.nonce] = true;
        tradeId = nextTradeId++;
        activeTradeBySource[order.sourceIndex] = tradeId;
        trades[tradeId] = Trade({
            seller: order.seller,
            buyer: buyer,
            sourceIndex: order.sourceIndex,
            targetIndex: targetIndex,
            amountGwei: amountGwei,
            filledAt: uint64(block.timestamp),
            withdrawableEpoch: 0,
            status: Status.RequestSubmitted,
            payment: payment,
            sourcePubkeyHash: keccak256(order.sourcePubkey),
            targetPubkeyHash: keccak256(targetPubkey)
        });

        weth.safeTransferFrom(msg.sender, address(this), payment);

        uint256 balanceBefore = address(this).balance - msg.value;
        Stake7702Delegate(payable(order.seller)).requestConsolidation{value: msg.value}(
            order.sourcePubkey, targetPubkey
        );
        uint256 excess = address(this).balance - balanceBefore;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert EthRefundFailed();
        }

        emit OrderFilled(tradeId, order.seller, buyer, order.sourceIndex, targetIndex, amountGwei, payment);
    }

    /// @notice Payment for `amountGwei` of stake under `order`'s pricing.
    function quote(StakeOrder calldata order, uint64 amountGwei) public view returns (uint256) {
        if (order.priceMode == PriceMode.Fixed) return order.price;
        if (address(priceOracle) == address(0)) revert NoPriceOracle();
        uint256 value = uint256(amountGwei) * 1 gwei * priceOracle.stakedEthPrice() / 1e18;
        return value * (BPS - order.price) / BPS;
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement (permissionless: anyone can relay proofs)
    // ---------------------------------------------------------------------------------------------

    /// @notice Checkpoint 1: the consensus layer queued (source -> target).
    function proveAccepted(
        uint256 tradeId,
        BeaconProofs.StateRootProof calldata state,
        BeaconProofs.PendingConsolidationProof calldata pending,
        BeaconProofs.ValidatorProof calldata source
    ) external {
        Trade storage t = trades[tradeId];
        if (t.status != Status.RequestSubmitted) revert BadStatus(t.status);
        bytes32 stateRoot = _stateAfterFill(t, state);

        if (pending.sourceIndex != t.sourceIndex || pending.targetIndex != t.targetIndex) revert IndexMismatch();
        beaconOracle.verifyPendingConsolidation(stateRoot, pending);

        _verifySource(t, stateRoot, source);
        t.withdrawableEpoch = source.validator.withdrawableEpoch;
        t.status = Status.Accepted;
        emit ConsolidationAccepted(tradeId, t.withdrawableEpoch);
    }

    /// @notice Checkpoint 2: the source was processed and its balance moved to the target.
    function proveDelivered(
        uint256 tradeId,
        BeaconProofs.StateRootProof calldata state,
        BeaconProofs.ValidatorProof calldata source,
        BeaconProofs.BalanceProof calldata sourceBalance
    ) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.Accepted) revert BadStatus(t.status);
        bytes32 stateRoot = _stateAfterFill(t, state);

        _verifySource(t, stateRoot, source);
        if (sourceBalance.index != t.sourceIndex) revert IndexMismatch();
        uint64 balance = beaconOracle.verifyBalance(stateRoot, sourceBalance);

        bool processed = !source.validator.slashed && source.validator.withdrawableEpoch <= epochAt(state.timestamp)
            && balance < MAX_DUST_BALANCE;
        if (!processed) revert NotDelivered();

        t.status = Status.Delivered;
        delete activeTradeBySource[t.sourceIndex];
        weth.safeTransfer(t.seller, t.payment);
        emit StakeDelivered(tradeId, t.payment);
    }

    /// @notice Refund: a state after the fill shows the source exit was never initiated, so the
    /// consensus layer ignored the request (e.g. seller front-ran it, churn limit, invalid target).
    function proveNotAccepted(
        uint256 tradeId,
        BeaconProofs.StateRootProof calldata state,
        BeaconProofs.ValidatorProof calldata source
    ) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.RequestSubmitted) revert BadStatus(t.status);
        bytes32 stateRoot = _stateAfterFill(t, state);
        _verifySource(t, stateRoot, source);
        if (source.validator.exitEpoch != BeaconProofs.FAR_FUTURE_EPOCH) revert NotFailed();
        _fail(tradeId, t);
    }

    /// @notice Refund: the source was slashed, so the consolidation will be skipped.
    function proveFailed(
        uint256 tradeId,
        BeaconProofs.StateRootProof calldata state,
        BeaconProofs.ValidatorProof calldata source
    ) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.RequestSubmitted && t.status != Status.Accepted) revert BadStatus(t.status);
        bytes32 stateRoot = _stateAfterFill(t, state);
        _verifySource(t, stateRoot, source);
        if (!source.validator.slashed) revert NotFailed();
        _fail(tradeId, t);
    }

    /// @notice Refund: nobody proved acceptance within the accept window.
    function refundExpired(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.RequestSubmitted) revert BadStatus(t.status);
        if (block.timestamp <= t.filledAt + acceptWindow) revert AcceptWindowOpen();
        _fail(tradeId, t);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function hashOrder(StakeOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STAKE_ORDER_TYPEHASH,
                    order.seller,
                    keccak256(order.sourcePubkey),
                    order.sourceIndex,
                    uint8(order.priceMode),
                    order.price,
                    order.minPayment,
                    order.expiry,
                    order.nonce
                )
            )
        );
    }

    function epochAt(uint256 timestamp) public view returns (uint64) {
        return uint64((timestamp - genesisTime) / SECONDS_PER_SLOT / SLOTS_PER_EPOCH);
    }

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _checkOrder(StakeOrder calldata order, bytes calldata signature)
        internal
        view
        returns (bytes32 orderHash)
    {
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (nonceUsed[order.seller][order.nonce]) revert NonceAlreadyUsed();
        orderHash = hashOrder(order);
        if (signature.length == 0) {
            if (!listed[orderHash]) revert InvalidSignature();
        } else if (ECDSA.recover(orderHash, signature) != order.seller) {
            revert InvalidSignature();
        }
        // The seller EOA must run our delegate; otherwise the consolidation call would be a no-op.
        if (keccak256(order.seller.code) != keccak256(abi.encodePacked(hex"ef0100", address(delegate)))) {
            revert SellerNotDelegated();
        }
        if (activeTradeBySource[order.sourceIndex] != 0) revert SourceAlreadyTrading();
    }

    function _checkValidators(StakeOrder calldata order, bytes calldata targetPubkey, FillProofs calldata p)
        internal
        view
        returns (uint64 amountGwei, uint64 targetIndex)
    {
        if (p.state.timestamp + maxProofAge < block.timestamp) revert StaleProof();
        bytes32 stateRoot = beaconOracle.verifiedStateRoot(p.state);
        uint64 epoch = epochAt(p.state.timestamp);

        // Source: the seller's active, non-exiting validator.
        BeaconProofs.Validator calldata s = p.source.validator;
        if (p.source.index != order.sourceIndex) revert IndexMismatch();
        if (keccak256(s.pubkey) != keccak256(order.sourcePubkey)) revert PubkeyMismatch();
        beaconOracle.verifyValidator(stateRoot, p.source);
        bytes1 prefix = s.withdrawalCredentials[0];
        if (prefix != 0x01 && prefix != 0x02) revert SourceNotSellable();
        if (address(uint160(uint256(s.withdrawalCredentials))) != order.seller) revert WithdrawalAddressMismatch();
        if (!_isActiveNotExiting(s, epoch) || s.activationEpoch + SHARD_COMMITTEE_PERIOD > epoch) {
            revert SourceNotSellable();
        }

        // Target: an active, non-exiting 0x02 (compounding) validator with room for the stake.
        BeaconProofs.Validator calldata tg = p.target.validator;
        if (keccak256(tg.pubkey) != keccak256(targetPubkey)) revert PubkeyMismatch();
        if (p.target.index == p.source.index) revert TargetNotEligible();
        beaconOracle.verifyValidator(stateRoot, p.target);
        if (tg.withdrawalCredentials[0] != 0x02 || !_isActiveNotExiting(tg, epoch)) revert TargetNotEligible();
        if (tg.effectiveBalance + s.effectiveBalance > MAX_EFFECTIVE_BALANCE_ELECTRA) {
            revert TargetCapacityExceeded();
        }
        return (s.effectiveBalance, p.target.index);
    }

    function _isActiveNotExiting(BeaconProofs.Validator calldata v, uint64 epoch) internal pure returns (bool) {
        return !v.slashed && v.activationEpoch <= epoch && v.exitEpoch == BeaconProofs.FAR_FUTURE_EPOCH;
    }

    /// @dev A 4788 root keyed by a timestamp after the fill block is a beacon block at or after the
    /// one that processed the fill's execution requests.
    function _stateAfterFill(Trade storage t, BeaconProofs.StateRootProof calldata state)
        internal
        view
        returns (bytes32)
    {
        if (state.timestamp <= t.filledAt) revert ProofBeforeFill();
        return beaconOracle.verifiedStateRoot(state);
    }

    function _verifySource(Trade storage t, bytes32 stateRoot, BeaconProofs.ValidatorProof calldata source)
        internal
        view
    {
        if (source.index != t.sourceIndex) revert IndexMismatch();
        if (keccak256(source.validator.pubkey) != t.sourcePubkeyHash) revert PubkeyMismatch();
        beaconOracle.verifyValidator(stateRoot, source);
    }

    function _fail(uint256 tradeId, Trade storage t) internal {
        t.status = Status.Failed;
        delete activeTradeBySource[t.sourceIndex];
        weth.safeTransfer(t.buyer, t.payment);
        emit TradeFailed(tradeId, t.payment);
    }

    /// @dev Receives the unused EIP-7251 fee back from the seller's delegate during `fill`.
    receive() external payable {}
}
